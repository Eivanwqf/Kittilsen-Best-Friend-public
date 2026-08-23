#!/usr/bin/env bash
# 后台启动/停止/查看 dev 服务（tmux 会话 kbf，独立于终端存活）
# 用法：bash scripts/dev-bg.sh start | stop | logs | status
set -euo pipefail
SESSION=kbf
case "${1:-status}" in
  start)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "已在运行（tmux 会话 $SESSION）"
    else
      tmux new-session -d -s "$SESSION" "npm run dev:all"
      echo "已后台启动 → http://localhost:3000（日志：bash scripts/dev-bg.sh logs）"
    fi
    ;;
  stop)
    tmux kill-session -t "$SESSION" 2>/dev/null && echo "已停止 tmux 会话" || echo "tmux 会话未在运行"
    # 清理残留子进程（npm/tsx/node 可能还占着端口，2026-08-08 修复）
    for port in 8899 3000; do
      pids=$(lsof -ti :"$port" 2>/dev/null || true)
      if [ -n "$pids" ]; then kill $pids 2>/dev/null; echo "  已清理端口 $port 残留进程"; fi
    done
    ;;
  logs)
    tmux attach -t "$SESSION"   # 进入后 Ctrl+B 再按 D 退出（不停止服务）
    ;;
  status)
    tmux has-session -t "$SESSION" 2>/dev/null && echo "运行中（http://localhost:3000）" || echo "未运行"
    ;;
  *) echo "用法：bash scripts/dev-bg.sh start | stop | logs | status" ;;
esac
