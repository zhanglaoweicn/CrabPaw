#!/bin/bash
# 全面监控后端日志 — 收集互动问题
LOG="/d/bossagent/data/.crabpaw/crabpaw.log"
LAST_POS=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
echo "[monitor] 开始 at $(date '+%H:%M:%S')"
while true; do
  CUR_SIZE=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$CUR_SIZE" -lt "$LAST_POS" ]; then echo "[monitor] 日志轮转 $(date '+%H:%M:%S')"; LAST_POS=0; fi
  if [ "$CUR_SIZE" -gt "$LAST_POS" ]; then
    NEW=$(dd if="$LOG" bs=1 skip=$LAST_POS 2>/dev/null)
    echo "$NEW" | grep -iE "\[ERROR\]|❌|error:|exception|失败|拦截|denied|invalid|超时|timeout|Cannot find|Cannot read|TypeError|ReferenceError|被阻止|被拒|拒绝|契约|HTTP 400|aborted|溢出" \
      | grep -viE "MEMORY-GRAPH|scene-server|桥接器|wecom bridge|Network.enable|Emulation|setAttach|clearAccepted|Tier 1 全部失败|进化建议" \
      | sed 's/^/[ERR] /'
    echo "$NEW" | grep -iE "命中唤醒词|AI 响应 content 前|检测到无效回复|流式检测到空|AI 回复完整内容|AI 最终回复|回复完成" \
      | grep -viE "MEMORY-GRAPH" \
      | sed 's/^/[AI]  /'
    echo "$NEW" | grep -iE "执行工具:|工具结果: (未知|失败)|工具.*失败|Tool Contract|慢请求|Bash|Music.*play|Music.*search" \
      | grep -viE "MEMORY-GRAPH" \
      | sed 's/^/[TOOL] /'
    LAST_POS=$CUR_SIZE
  fi
  sleep 6
done
