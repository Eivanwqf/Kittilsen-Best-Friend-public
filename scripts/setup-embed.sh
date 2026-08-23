#!/usr/bin/env bash
# 一键初始化 embedding 环境：venv + Python 依赖 + bge-m3 ONNX 模型导出
# 用法：bash scripts/setup-embed.sh
# 说明：bge-m3 官方仓库无 ONNX 文件，需用 optimum 从源模型导出（首次下载 ~2.3GB）；
#       无 CUDA GPU 的机器也能跑（onnxruntime 自动回退 CPU，速度较慢）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if command -v python3 >/dev/null; then
  PY=python3
elif command -v python >/dev/null; then
  PY=python
else
  echo "❌ 未找到 Python 3（需 ≥3.10）" >&2
  exit 1
fi

echo "① 创建 Python venv（.python/venv）…"
"$PY" -m venv .python/venv

echo "② 安装 Python 依赖（fastembed-gpu + transformers + optimum）…"
.python/venv/bin/pip install -U pip
.python/venv/bin/pip install fastembed-gpu transformers optimum[exporters] onnx

echo "③ 导出 bge-m3 ONNX 模型（联网下载 ~2.3GB，需几分钟）…"
mkdir -p .python/models/BAAI--bge-m3
.python/venv/bin/optimum-cli export onnx \
  --model BAAI/bge-m3 \
  --task feature-extraction \
  .python/models/BAAI--bge-m3/onnx

echo ""
echo "✅ embedding 环境就绪：.python/models/BAAI--bge-m3/onnx（model.onnx + tokenizer 文件）"
echo "   若导出失败（网络/内存限制），可改用任意已导出的 bge-m3 ONNX 源，"
echo "   将 model.onnx(+model.onnx_data) 与 tokenizer 文件放入上述 onnx 目录即可。"
