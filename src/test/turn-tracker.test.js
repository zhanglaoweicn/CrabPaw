const { feed, reset } = require('../core/turn-tracker');

describe('turn-tracker step 边界派生', () => {
  beforeEach(() => reset());

  test('run:start 开 step 1; eval_start 关; eval_done 开 step 2; run:finished 关', () => {
    expect(feed('run:start', { runId: 'r1' })).toEqual([{ type: 'step:start', runId: 'r1', step: 1 }]);
    expect(feed('chunk', { runId: 'r1' })).toEqual([]);
    expect(feed('tool_call', { runId: 'r1', toolId: 't1' })).toEqual([]); // step 已开, 不重复
    expect(feed('eval_start', { runId: 'r1' })).toEqual([{ type: 'step:end', runId: 'r1', step: 1 }]);
    expect(feed('eval_done', { runId: 'r1' })).toEqual([{ type: 'step:start', runId: 'r1', step: 2 }]);
    expect(feed('run:finished', { runId: 'r1' })).toEqual([{ type: 'step:end', runId: 'r1', step: 2 }]);
    expect(feed('tool_call', { runId: 'r1', toolId: 't2' })).toEqual([]); // run 已遗忘
  });

  test('无 run:start 直接 tool_call 兜底开 step 1', () => {
    expect(feed('tool_call', { runId: 'r2', toolId: 't1' })).toEqual([{ type: 'step:start', runId: 'r2', step: 1 }]);
  });

  test('step:* 输入忽略(防自循环)', () => {
    expect(feed('step:start', { runId: 'r3', step: 1 })).toEqual([]);
    expect(feed('step:end', { runId: 'r3', step: 1 })).toEqual([]);
  });

  test('无 runId 不派生', () => {
    expect(feed('tool_call', { toolId: 't1' })).toEqual([]);
  });

  test('run:error 关闭 step 并遗忘', () => {
    feed('run:start', { runId: 'r4' });
    expect(feed('run:error', { runId: 'r4' })).toEqual([{ type: 'step:end', runId: 'r4', step: 1 }]);
    expect(feed('tool_call', { runId: 'r4', toolId: 't1' })).toEqual([]);
  });

  test('2026-08-18 终审: closedRuns 修剪——超 1000 删最旧 500(老 run 可复活, 新 run 仍遗忘)', () => {
    for (let i = 1; i <= 1001; i++) {
      feed('run:start', { runId: `r${i}` });
      feed('run:finished', { runId: `r${i}` });
    }
    // 第 1001 个终态触发修剪: 最旧 500 个(r1..r500)被删 → r1 遗忘解除, 兜底重新开 step
    expect(feed('tool_call', { runId: 'r1', toolId: 't1' })).toEqual([{ type: 'step:start', runId: 'r1', step: 1 }]);
    // 近期关闭的 r900 仍在 closedRuns → 不复活
    expect(feed('tool_call', { runId: 'r900', toolId: 't2' })).toEqual([]);
  });
});

// Task 3: sse-broadcast 接线后, step 派生事件会进入广播
const { addSSEClient, removeSSEClient, broadcastEvent, handleSSE, _resetStreamState } = require('../core/sse-broadcast');
describe('turn-tracker 接线', () => {
  beforeEach(() => { _resetStreamState(); });
  test('run:start 广播自动补发 step:start', () => {
    const res = { writes: [], write(s) { this.writes.push(s); return true; }, writeHead() {}, on() {} };
    addSSEClient(res);
    broadcastEvent('run:start', { runId: 'r1' });
    const events = res.writes.map((w) => w.match(/^event: (.+)$/m)?.[1]).filter(Boolean);
    expect(events).toEqual(expect.arrayContaining(['run:start', 'step:start']));
    removeSSEClient(res);
  });
});
