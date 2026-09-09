/**
 * decision-recorder.test.js — run 级决策折叠纯函数（SSE 事件 → Decision 记录）
 */
const {
  createFoldState, foldRunEvent, sealDecision,
  computeRecordHash, computeChecksum, stableStringify,
  CONCLUSION_MAX,
} = require('../core/memory/decision-recorder');

function feedAll(state, events) {
  let last = null;
  for (const [type, data] of events) {
    const r = foldRunEvent(state, type, data);
    if (r.decision) last = r.decision;
  }
  return last;
}

describe('foldRunEvent 折叠', () => {
  test('完整 run: start→tool_call→tool_result→gui_reply→finished 折叠成功决策', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r1', userId: 'u1', userInput: '查询台风路径' }],
      ['tool_call', { type: 'tool_call', toolName: 'KbSearch', toolId: 't1', toolArgs: '{"query":"铁血丹心"}', cardState: 'running', roundId: 'r1' }],
      ['tool_result', { type: 'tool_result', toolName: 'KbSearch', toolId: 't1', success: true, cardState: 'done', result: '{"total":2}', roundId: 'r1' }],
      ['gui_reply', { roundId: 'r1', userId: 'u1', content: '铁血丹心是金庸作品', timestamp: 1 }],
      ['run:finished', { roundId: 'r1', userId: 'u1', status: 'ok', ts: 2 }],
    ]);
    expect(rec).not.toBeNull();
    expect(rec.run_id).toBe('r1');
    expect(rec.verdict).toBe('success');
    expect(rec.user_intent).toBe('查询台风路径');
    expect(rec.conclusion).toBe('铁血丹心是金庸作品');
    expect(rec.tool_digest).toHaveLength(1);
    expect(rec.tool_digest[0]).toMatchObject({ toolName: 'KbSearch', toolId: 't1', success: true });
  });

  test('run:error 收尾 → verdict failed', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r2' }],
      ['tool_call', { toolName: 'WebSearch', toolId: 't2', toolArgs: '{}', roundId: 'r2' }],
      ['run:error', { roundId: 'r2', status: 'error', ts: 3 }],
    ]);
    expect(rec.verdict).toBe('failed');
  });

  test('run:interrupt 收尾 → verdict interrupted', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r3' }],
      ['run:interrupt', { roundId: 'r3', ts: 4 }],
    ]);
    expect(rec.verdict).toBe('interrupted');
  });

  test('无 run:start 时 tool_call 兜底开 run（turn-tracker 同款）', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['tool_call', { toolName: 'KbSearch', toolId: 't9', toolArgs: '{}', roundId: 'r9' }],
      ['run:finished', { roundId: 'r9', ts: 5 }],
    ]);
    expect(rec).not.toBeNull();
    expect(rec.verdict).toBe('success');
  });

  test('未打开的 run 的 gui_reply/终态事件被忽略', () => {
    const state = createFoldState();
    expect(foldRunEvent(state, 'gui_reply', { roundId: 'ghost', content: 'x' }).decision).toBeNull();
    expect(foldRunEvent(state, 'run:finished', { roundId: 'ghost', ts: 1 }).decision).toBeNull();
  });

  test('证据工具的结果进入 evidence_refs（含截断）', () => {
    const state = createFoldState();
    const longResult = 'x'.repeat(500);
    const longArgs = 'x'.repeat(250);
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r4' }],
      ['tool_call', { toolName: 'KbSearch', toolId: 't4', toolArgs: longArgs, roundId: 'r4' }],
      ['tool_result', { toolName: 'KbSearch', toolId: 't4', success: true, result: longResult, roundId: 'r4' }],
      ['run:finished', { roundId: 'r4', ts: 6 }],
    ]);
    expect(rec.evidence_refs).toHaveLength(1);
    expect(rec.evidence_refs[0].summary.length).toBe(200);
    expect(rec.tool_digest[0].args.length).toBe(200);
  });

  test('user_intent 超过 INTENT_MAX 截断到 500', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r6', userInput: 'y'.repeat(600) }],
      ['run:finished', { roundId: 'r6', ts: 8 }],
    ]);
    expect(rec.user_intent.length).toBe(500);
  });

  test('conclusion 超过 CONCLUSION_MAX 截断到 2000', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r7' }],
      ['gui_reply', { roundId: 'r7', content: 'z'.repeat(2200) }],
      ['run:finished', { roundId: 'r7', ts: 9 }],
    ]);
    expect(rec.conclusion.length).toBe(2000);
  });

  // ---- 2026-08-20 终审 C1 回归：生产顺序 run:finished 先于 gui_reply ----
  test('生产顺序 run:finished(带 content)→迟到 gui_reply：conclusion 捕获自 finished', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r8', userId: 'u1', userInput: '查询台风路径' }],
      ['tool_call', { toolName: 'KbSearch', toolId: 't8', toolArgs: '{}', roundId: 'r8' }],
      ['run:finished', { roundId: 'r8', ts: 10, content: '结论来自 run:finished' }],
      ['gui_reply', { roundId: 'r8', content: '迟到的 gui_reply', timestamp: 11 }],
    ]);
    expect(rec).not.toBeNull();
    expect(rec.conclusion).toBe('结论来自 run:finished');
  });

  test('生产顺序下 run:finished 的 content 截断到 CONCLUSION_MAX', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r9' }],
      ['run:finished', { roundId: 'r9', ts: 12, content: 'q'.repeat(CONCLUSION_MAX + 500) }],
    ]);
    expect(rec.conclusion.length).toBe(CONCLUSION_MAX);
  });

  test('合成顺序 gui_reply → run:finished(同值 content)：conclusion 非空', () => {
    const state = createFoldState();
    const rec = feedAll(state, [
      ['run:start', { roundId: 'r10' }],
      ['gui_reply', { roundId: 'r10', content: '结论来自 gui_reply' }],
      ['run:finished', { roundId: 'r10', ts: 13, content: '结论来自 gui_reply' }],
    ]);
    expect(rec.conclusion).toBe('结论来自 gui_reply');
  });

  test('重复 run:start 不覆写已打开 run（已折叠工具保留）', () => {
    const state = createFoldState();
    feedAll(state, [
      ['run:start', { roundId: 'r11' }],
      ['tool_call', { toolName: 'KbSearch', toolId: 't11', toolArgs: '{}', roundId: 'r11' }],
    ]);
    // 2026-08-20 终审 M2: 第二次 run:start 必须被守卫拦截，否则 t11 被丢弃
    expect(foldRunEvent(state, 'run:start', { roundId: 'r11', userInput: '重复开始' }).decision).toBeNull();
    const rec = foldRunEvent(state, 'run:finished', { roundId: 'r11', ts: 14 }).decision;
    expect(rec.tool_digest).toHaveLength(1);
    expect(rec.tool_digest[0].toolId).toBe('t11');
  });

  test('tool_digest 上限 20 条（截断最旧）', () => {
    const state = createFoldState();
    const events = [['run:start', { roundId: 'r5' }]];
    for (let i = 0; i < 25; i++) events.push(['tool_call', { toolName: 'T', toolId: 't' + i, toolArgs: '{}', roundId: 'r5' }]);
    events.push(['run:finished', { roundId: 'r5', ts: 7 }]);
    const rec = feedAll(state, events);
    expect(rec.tool_digest).toHaveLength(20);
    expect(rec.tool_digest[19].toolId).toBe('t24');
  });
});

describe('哈希链数学', () => {
  test('computeChecksum 确定性', () => {
    const a = computeChecksum({ sequence_id: 1, previous_checksum: 'GENESIS', recordHash: 'abc', recorded_at: 1000 });
    const b = computeChecksum({ sequence_id: 1, previous_checksum: 'GENESIS', recordHash: 'abc', recorded_at: 1000 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('任一字段变化 → checksum 变化', () => {
    const base = { sequence_id: 1, previous_checksum: 'GENESIS', recordHash: 'abc', recorded_at: 1000 };
    expect(computeChecksum({ ...base, recorded_at: 1001 })).not.toBe(computeChecksum(base));
    expect(computeChecksum({ ...base, recordHash: 'abd' })).not.toBe(computeChecksum(base));
  });

  test('stableStringify 键排序稳定', () => {
    const obj = { b: 1, a: { d: 2, c: 3 } };
    expect(stableStringify(obj)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('computeRecordHash 覆盖全部字段且确定性', () => {
    const state = createFoldState();
    foldRunEvent(state, 'run:start', { roundId: 'x', userInput: 'hi', ts: 1 });
    const rec = foldRunEvent(state, 'run:finished', { roundId: 'x', ts: 2 }).decision;
    expect(computeRecordHash(rec)).toBe(computeRecordHash(rec));
    expect(computeRecordHash({ ...rec, conclusion: 'y' })).not.toBe(computeRecordHash(rec));
  });
});
