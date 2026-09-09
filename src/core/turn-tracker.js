/**
 * turn-tracker — 从 /events 广播事件流派生 step 边界(轻量 turn/step 生命周期)
 *
 * 协议形状参考 deepseek-harness: step = 一次模型请求 + 其工具批; turn = 0..n 个 step。
 * 本项目 /events 总线无持久日志, 由本模块对现有事件词汇做纯函数折叠:
 *   run:start            → 打开 step 1
 *   eval_start           → 关闭当前 step(工具批已结算, LLM 进入反思)
 *   eval_done            → 打开下一个 step(反思结束, 下一轮模型请求开始)
 *   tool_call            → 无打开的 step 时兜底打开(未走 eval 路径的工具批)
 *   run:finished/error/interrupt → 关闭当前 step 并遗忘该 run
 * 输出事件 step:start / step:end(带 runId + step 序号), 经 agui-adapter 映射为
 * STEP_STARTED / STEP_FINISHED; 旧事件名原样保留供旧前端消费。
 * 纯模块: 无 IO、无全局状态泄漏, feed 可安全被测试注入。
 */
const openRuns = new Map(); // runId -> { step, active }
const closedRuns = new Set(); // runId -> 已到达终态被遗忘(tool_call 兜底不复活已遗忘的 run)

function feed(eventType, data) {
  // 防自循环: 自身产出的事件不参与派生
  if (eventType === 'step:start' || eventType === 'step:end') return [];
  const runId = data && (data.runId || data.roundId || data.flowId);
  if (!runId) return [];
  const frames = [];
  const cur = openRuns.get(runId);
  switch (eventType) {
    case 'run:start':
      closedRuns.delete(runId); // runId 复用则重新开放生命周期
      openRuns.set(runId, { step: 1, active: true });
      frames.push({ type: 'step:start', runId, step: 1 });
      break;
    case 'eval_start':
      if (cur && cur.active) {
        cur.active = false;
        frames.push({ type: 'step:end', runId, step: cur.step });
      }
      break;
    case 'eval_done':
      if (cur && !cur.active) {
        cur.step += 1;
        cur.active = true;
        frames.push({ type: 'step:start', runId, step: cur.step });
      }
      break;
    case 'tool_call':
      if (closedRuns.has(runId)) break; // 已遗忘的 run 不复活
      if (!cur) {
        openRuns.set(runId, { step: 1, active: true });
        frames.push({ type: 'step:start', runId, step: 1 });
      } else if (!cur.active) {
        cur.step += 1;
        cur.active = true;
        frames.push({ type: 'step:start', runId, step: cur.step });
      }
      break;
    case 'run:finished':
    case 'run:error':
    case 'run:interrupt':
      if (cur && cur.active) frames.push({ type: 'step:end', runId, step: cur.step });
      openRuns.delete(runId);
      closedRuns.add(runId); // 遗忘: 终态后 tool_call 不再兜底复活
      // 2026-08-18 终审: closedRuns 无界增长(~50B/run, roundId 永不复用)——超 1000
      // 删最旧 500(Set 按插入序迭代); 被修剪的老 run 重新允许 tool_call 兜底开 step,
      // 近期关闭的 run 仍保持遗忘语义。
      if (closedRuns.size > 1000) {
        const it = closedRuns.values();
        for (let i = 0; i < 500; i++) {
          const v = it.next().value;
          if (v === undefined) break;
          closedRuns.delete(v);
        }
      }
      break;
  }
  return frames;
}

function reset() {
  openRuns.clear();
  closedRuns.clear();
}

module.exports = { feed, reset };
