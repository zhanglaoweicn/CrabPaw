/**
 * activity-stream 单测(2026-08-15 LOOP 修复轮)
 *
 * 覆盖:
 * - P2-9: recordLLMEvent('interrupt') 相位——用户中断不再是 error(红标),
 *   独立 interrupt 类型 + 状态机回 idle + turn_complete 携带 interrupted
 * - P1-4: 显式 roundId 优先于全局 _currentRoundId 回退(并发双流错乱防护)
 * - 回归: error 路径语义不变
 */
jest.mock('./sse-broadcast', () => ({
  broadcastEvent: jest.fn(),
  handleSSE: jest.fn(),
  getSSEClientCount: jest.fn(() => 0),
  stopHeartbeat: jest.fn(),
}));

const { ActivityStream } = require('./activity-stream');
const { globalActivityState } = require('./activity-state');
const { broadcastEvent } = require('./sse-broadcast');

function makeStream() {
  const stream = new ActivityStream();
  stream.terminalEnabled = false;
  stream.sseEnabled = false;
  return stream;
}

beforeEach(() => {
  jest.clearAllMocks();
  globalActivityState.reset();
});

describe('2026-08-15 P2-9: 用户中断在活动流记为 interrupt(非 error)', () => {
  test('interrupt 相位: 独立类型 + interrupted 状态 + 状态机回 idle', () => {
    const stream = makeStream();
    const roundId = stream.recordLLMEvent('start');

    stream.recordLLMEvent('interrupt', { roundId, summary: '用户中断' });

    const acts = stream.activities;
    const last = acts[acts.length - 1];
    // 独立 interrupt 类型(此前为 error → 前端呈现模型出错红标)
    expect(last.type).toBe('interrupt');
    expect(last.status).toBe('interrupted');
    expect(last.summary).toBe('用户中断');
    expect(last.roundId).toBe(roundId);
    // 状态机不落 error 态(中断 → idle)
    expect(globalActivityState.state).toBe('idle');
    // start 的 thinking 条目被 resolve 为 done(不卡"思考中")
    expect(acts[0].status).toBe('done');
    // turn_complete 广播携带 interrupted 语义(前端据此区分终态)
    expect(broadcastEvent).toHaveBeenCalledWith(
      'turn_complete',
      expect.objectContaining({ roundId, status: 'interrupted' })
    );
  });

  test('interrupt 活动级别为 INFO(非 ERROR)', () => {
    const stream = makeStream();
    const roundId = stream.recordLLMEvent('start');
    stream.recordLLMEvent('interrupt', { roundId, summary: '连接已断开' });
    const last = stream.activities[stream.activities.length - 1];
    expect(last.level).toBe('info');
    expect(last.icon).not.toBe('❌');
  });
});

describe('回归: error 路径语义不变', () => {
  test('error 相位仍落 error 类型 + 状态机 error 态', () => {
    const stream = makeStream();
    const roundId = stream.recordLLMEvent('start');
    stream.recordLLMEvent('error', { roundId, summary: '推理失败: x' });
    const last = stream.activities[stream.activities.length - 1];
    expect(last.type).toBe('error');
    expect(last.status).toBe('done');
    expect(globalActivityState.state).toBe('error');
  });
});

describe('2026-08-15 P1-4: 显式 roundId 优先于全局回退', () => {
  test('recordToolEvent 显式 roundId 不被 _currentRoundId 覆盖', () => {
    const stream = makeStream();
    stream.recordLLMEvent('start'); // _currentRoundId = R1
    const r1 = stream._currentRoundId;
    expect(r1).toBeTruthy();

    stream.recordToolEvent('executing', 'Bash', { roundId: 'EXPLICIT-R2', summary: '执行: Bash' });
    const explicit = stream.activities[stream.activities.length - 1];
    expect(explicit.roundId).toBe('EXPLICIT-R2');

    // 漏传时仍回退到当前 round(旧行为保留, 另有 debug 日志标记)
    stream.recordToolEvent('executing', 'Bash', { summary: '执行: Bash' });
    const fallback = stream.activities[stream.activities.length - 1];
    expect(fallback.roundId).toBe(r1);
  });
});


// ── 2026-08-15 审查返工 Minor-6: recordToolEvent 回退 debug 标记前移 ──────
describe('Minor-6: recordToolEvent 显式 roundId 缺失时在回退发生处打 debug', () => {
  test('未显式传 roundId → debug 标记触发(此前在 record() 内被自身回退短路)', () => {
    const stream = makeStream();
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    stream.recordLLMEvent('start');
    stream.recordToolEvent('executing', 'Bash');
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('recordToolEvent 未显式传入 roundId'));
    debugSpy.mockRestore();
  });

  test('显式传 roundId → 不打 debug', () => {
    const stream = makeStream();
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const roundId = stream.recordLLMEvent('start');
    stream.recordToolEvent('executing', 'Bash', { roundId });
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining('recordToolEvent 未显式传入 roundId'));
    debugSpy.mockRestore();
  });
});
