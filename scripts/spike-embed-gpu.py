#!/usr/bin/env python3
"""M0 spike ②：fastembed + onnxruntime-gpu 在 WSL2 的 CUDA provider 可用性验证。

判定标准（计划）：10 条编码，GPU provider 生效且 <50ms/条 则通过。
失败回退链：transformers.js CPU bge-m3 → bge-small 本地缓存。
"""
import time
import sys

import onnxruntime as ort
from fastembed import TextEmbedding

providers = ort.get_available_providers()
print('onnxruntime:', ort.__version__)
print('available providers:', providers)
if 'CUDAExecutionProvider' not in providers:
    print('SPIKE FAIL: CUDA provider 不可用')
    sys.exit(1)

model = TextEmbedding(
    'BAAI/bge-m3',
    providers=['CUDAExecutionProvider', 'CPUExecutionProvider'],
)

texts = [
    '我最近在想课题分离这件事',
    '2021年读《被讨厌的勇气》的笔记：通往地狱的路是由期望铺成的',
    '健身计划：胸+肩+背轮流训练',
    '今天是周六，天气不错',
    '实习结束了，和学生时代告别',
    '投资逻辑：新能源取代燃油车是长期趋势',
    '东方 Project 的音乐影响很深，初中就玩红魔乡',
    '我喜欢 Trance 和 Eurodance 风格',
    '死亡意识：转瞬即逝，早晚会到土里',
    '记忆库像图书馆一样，分类越细越好',
]

# 预热一次（模型加载/编译）
list(model.embed(['预热']))

# 计时：10 条
t0 = time.perf_counter()
vecs = list(model.embed(texts))
t1 = time.perf_counter()

elapsed = t1 - t0
per_item = elapsed / len(texts)
dims = set(len(v) for v in vecs)
print(f'encoded {len(texts)} items in {elapsed:.2f}s → {per_item*1000:.1f}ms/item')
print('dimensions:', dims)

# sanity：相似句余弦 vs 无关句
import numpy as np


def cos(a, b):
    a, b = np.array(a), np.array(b)
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))


sim_same = cos(vecs[0], vecs[1])  # 课题分离 vs 读书笔记（相关）
sim_diff = cos(vecs[0], vecs[3])  # 课题分离 vs 天气（无关）
print(f'cos(课题分离, 读书笔记) = {sim_same:.3f}')
print(f'cos(课题分离, 天气)    = {sim_diff:.3f}')

ok = per_item < 0.05 and dims == {1024} and sim_same > sim_diff
print('SPIKE PASS' if ok else 'SPIKE FAIL')
sys.exit(0 if ok else 1)
