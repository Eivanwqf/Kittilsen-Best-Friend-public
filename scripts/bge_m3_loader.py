#!/usr/bin/env python3
"""bge-m3 GPU embedding loader（fastembed 不支持 bge-m3，手动加载 ONNX + CUDA）。

用法（后续 M1 会做成 stdio sidecar 服务）：
  from bge_m3_loader import BgeM3Embedder
  emb = BgeM3Embedder(model_dir)
  vecs = emb.embed(['文本1', '文本2'])   # list[list[float]], 1024 维, L2 归一化
"""
from __future__ import annotations

import json
import os

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer


class BgeM3Embedder:
    def __init__(
        self,
        model_dir: str,
        providers: list[str] | None = None,
        max_length: int = 8192,
    ):
        self.model_dir = model_dir
        onnx_dir = os.path.join(model_dir, 'onnx')
        self.tokenizer = AutoTokenizer.from_pretrained(onnx_dir)
        self.max_length = max_length
        self.session = ort.InferenceSession(
            os.path.join(onnx_dir, 'model.onnx'),
            providers=providers or ['CUDAExecutionProvider', 'CPUExecutionProvider'],
            sess_options=self._sess_options(),
        )
        # 输出名：bge-m3 onnx 输出 token_embeddings，需外部 [CLS] pooling
        self.output_name = self.session.get_outputs()[0].name
        self.output_shape = self.session.get_outputs()[0].shape
        print(f'[bge-m3] session ready: outputs={self.output_name} shape={self.output_shape}')
        print(f'[bge-m3] active providers: {self.session.get_providers()}')

    @staticmethod
    def _sess_options():
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        return opts

    def _encode_batch(self, texts: list[str]) -> np.ndarray:
        # bge-m3 无 query/document 前缀，统一 tokenize + cls pooling
        enc = self.tokenizer(
            texts,
            padding=True,
            truncation=True,
            max_length=self.max_length,
            return_tensors='np',
        )
        feed = {
            'input_ids': enc['input_ids'],
            'attention_mask': enc['attention_mask'],
            'token_type_ids': enc.get('token_type_ids'),
        }
        if feed['token_type_ids'] is None:
            feed.pop('token_type_ids')
        out = self.session.run([self.output_name], feed)[0]
        # bge-m3 onnx 输出 token_embeddings (batch, seq, dim) → 取 [CLS]（第 0 token）
        if out.ndim == 3:
            out = out[:, 0, :]
        # 归一化（bge-m3 官方推荐）
        norms = np.linalg.norm(out, axis=1, keepdims=True)
        return out / norms

    def embed(self, texts: list[str], batch_size: int = 32, max_tokens_per_batch: int = 4000) -> list[list[float]]:
        """按 token 总量动态分批。

        坑（2026-08-01 实测）：onnxruntime 每 run 的激活显存 ≈ batch × 最长序列 × 维度，
        且 attention 矩阵是 O(batch × seq²)——固定 batch 但文本一长（日志 1899 tokens），
        40 篇一次性 run 报 CUDA OOM（单 buffer 7.4GB）；max_tokens 8000 时仍要 3GB。
        累计实际 token 数，每批 ≤ 4000（长文最多 2 条/批），attention 张量 ~460MB，安全。
        """
        results: list[np.ndarray] = []
        cur: list[str] = []
        cur_tokens = 0
        for t in texts:
            n = len(self.tokenizer.encode(t, add_special_tokens=True))
            n = min(n, self.max_length)
            if cur and cur_tokens + n > max_tokens_per_batch:
                results.append(self._encode_batch(cur))
                cur, cur_tokens = [], 0
            cur.append(t)
            cur_tokens += n
        if cur:
            results.append(self._encode_batch(cur))
        merged = np.concatenate(results, axis=0)
        return [row.tolist() for row in merged]


if __name__ == '__main__':
    import sys
    import time

    model_dir = sys.argv[1] if len(sys.argv) > 1 else '.python/models/BAAI--bge-m3'
    emb = BgeM3Embedder(model_dir)

    texts = [
        '课题分离：把别人的课题和我的课题分开',
        '我最近在想课题分离这件事',
        '健身计划：胸+肩+背轮流训练',
        '窗外在下雨，很适合睡觉',
        '实习结束了，和学生时代告别',
        '投资逻辑：新能源取代燃油车是长期趋势',
        '东方 Project 的音乐影响很深，初中就玩红魔乡',
        '我喜欢 Trance 和 Eurodance 风格',
        '死亡意识：转瞬即逝，早晚会到土里',
        '记忆库像图书馆一样，分类越细越好',
    ]
    # 预热
    emb.embed(['预热'])
    t0 = time.perf_counter()
    vecs = emb.embed(texts)
    t1 = time.perf_counter()
    per_item = (t1 - t0) / len(texts)
    dims = {len(v) for v in vecs}
    print(f'encoded {len(texts)} items in {t1 - t0:.2f}s → {per_item * 1000:.1f}ms/item, dims={dims}')


    def cos(a, b):
        a, b = np.array(a), np.array(b)
        return float(a @ b)


    # 注：中文 embedding 空间无关句 cos 基线 ~0.4-0.5（bge-m3 特性），阈值据此设定
    sim_same = cos(vecs[0], vecs[1])
    sim_diff = cos(vecs[0], vecs[3])
    print(f'cos(课题分离, 同义句) = {sim_same:.3f}')
    print(f'cos(课题分离, 无关句) = {sim_diff:.3f}')
    gpu_active = 'CUDAExecutionProvider' in emb.session.get_providers()
    ok = (
        gpu_active
        and per_item < 0.05
        and dims == {1024}
        and sim_same > 0.7
        and sim_diff < 0.6
        and sim_same > sim_diff
    )
    print('SPIKE PASS' if ok else 'SPIKE FAIL')
    sys.exit(0 if ok else 1)
