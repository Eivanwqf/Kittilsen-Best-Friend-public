#!/usr/bin/env bash
# Python embedding sidecar 启动包装：设置 CUDA 运行时库路径后执行。
# 背景（2026-08-01 spike ②）：pip 的 nvidia-*-cu12 wheel 把 .so 放在
# site-packages/nvidia/*/lib，glibc 不会自动搜索，onnxruntime 的 CUDA EP
# 加载失败（libcublasLt/libcurand/libcudart 找不到）。
# 用法：scripts/embed-env.sh <python脚本> [args...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.python/venv"

LIBDIRS="$(find "$VENV/lib" -type d -path '*/nvidia/*/lib' | paste -sd: -)"
export LD_LIBRARY_PATH="${LIBDIRS:+$LIBDIRS:}${LD_LIBRARY_PATH:-}"

exec "$VENV/bin/python" "$@"
