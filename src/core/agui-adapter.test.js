/**
 * agui-adapter 全映射表测试(GUI 全量修复 P1)
 *
 * 覆盖: 事件映射(广播侧 + 流内)、thinking 累计缓冲、step 边界映射、
 * resume 翻译全分支、幂等 LRU、kill switch(AGUI_DUAL_BROADCAST=0)。
 */
const adapter = require('./agui-adapter');

beforeEach(() => {
  adapter._resetBuffers();
  delete process.env.AGUI_DUAL_BROADCAST;
});

describe('isAguiEnabled / kill switch', () => {
  test('默认开启', () => {
    expect(adapter.isAguiEnabled()).toBe(true);
  });
  test('AGUI_DUAL_BROADCAST=0 关闭', () => {
    process.env.AGUI_DUAL_BROADCAST = '0';
    expect(adapter.isAguiEnabled()).toBe(false);
    // 关闭时 mapToAgui 恒空
    expect(adapter.mapToAgui('run:finished', { roundId: 'r1' })).toEqual([]);
  });
});

describe('广播侧映射 mapToAgui', () => {
  test('run:finished → RUN_FINISHED success(threadId/runId 从 payload 提取)', () => {
    const frames = adapter.mapToAgui('run:finished', { roundId: 'r1', userId: 'u1', status: 'finished', ts: 1 });
    expect(frames).toEqual([
      { type: 'RUN_FINISHED', threadId: 'u1', runId: 'r1', outcome: { type: 'success' } },
    ]);
  });

  test('run:error → RUN_ERROR(message 取自 payload.error)', () => {
    const frames = adapter.mapToAgui('run:error', { roundId: 'r1', status: 'error', error: 'boom' });
    expect(frames[0]).toMatchObject({ type: 'RUN_ERROR', runId: 'r1', message: 'boom' });
  });

  test('run:interrupt → RUN_FINISHED interrupt(user_stop, 带 interrupt id)', () => {
    const frames = adapter.mapToAgui('run:interrupt', { roundId: 'r1', status: 'interrupted', ts: 1 });
    expect(frames[0].type).toBe('RUN_FINISHED');
    expect(frames[0].outcome.type).toBe('interrupt');
    expect(frames[0].outcome.interrupts[0]).toMatchObject({ id: 'stop-r1', reason: 'crabpaw:user_stop' });
  });

  test('tool_call → TOOL_CALL_START/ARGS/END 三元组(toolId 透传)', () => {
    const frames = adapter.mapToAgui('tool_call', { toolName: 'Bash', toolId: 'call_1', toolArgs: { cmd: 'ls' } });
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ type: 'TOOL_CALL_START', toolCallId: 'call_1', toolCallName: 'Bash' });
    expect(frames[1]).toMatchObject({ type: 'TOOL_CALL_ARGS', toolCallId: 'call_1' });
    expect(frames[2]).toMatchObject({ type: 'TOOL_CALL_END', toolCallId: 'call_1' });
  });

  test('tool_result → TOOL_CALL_RESULT(role tool)', () => {
    const frames = adapter.mapToAgui('tool_result', { toolName: 'Bash', toolId: 'call_1', result: 'ok', success: true });
    expect(frames[0]).toMatchObject({
      type: 'TOOL_CALL_RESULT', toolCallId: 'call_1', content: 'ok', role: 'tool',
    });
  });

  test('thinking → TEXT_MESSAGE_CHUNK(2026-08-15 增量语义修正)', () => {
    const f1 = adapter.mapToAgui('thinking', { content: '正在理解' });
    const f2 = adapter.mapToAgui('thinking', { content: '你的问题' });
    expect(f1[0]).toMatchObject({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'anon-think', delta: '正在理解' });
    // 2026-08-15 合规: delta 为增量切片(客户端 append 语义)——此前发累计全文,
    // 标准客户端重复拼接("正在理解正在理解…")。第二次只发新增部分。
    expect(f2[0].delta).toBe('你的问题');
  });

  test('2026-08-15: 终态后同 run 不再发帧(verify 终态禁发), run:start 例外', () => {
    adapter._resetBuffers();
    expect(adapter.mapToAgui('run:finished', { roundId: 'r9' })).toHaveLength(1);
    // 已终态: 后续 activity/turn_complete/重复终帧均被拦截
    expect(adapter.mapToAgui('activity', { roundId: 'r9', summary: 'x' })).toEqual([]);
    expect(adapter.mapToAgui('run:interrupt', { roundId: 'r9' })).toEqual([]);
    // 新一轮(run:start 例外放行)
    adapter._resetBuffers();
    expect(adapter.mapToAgui('run:start', { roundId: 'r9' })[0].type).toBe('RUN_STARTED');
  });

  test('2026-08-18: phase → CUSTOM {name:"phase"}(不再冒充 STEP); step:start/end → STEP_STARTED/STEP_FINISHED', () => {
    const p = adapter.mapToAgui('phase', { phase: 'planning' });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ type: 'CUSTOM', name: 'phase', value: { phase: 'planning' } });
    const s1 = adapter.mapToAgui('step:start', { runId: 'r1', step: 1 });
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatchObject({ type: 'STEP_STARTED', runId: 'r1', stepIndex: 1, stepName: 'step-1' });
    const s2 = adapter.mapToAgui('step:end', { runId: 'r1', step: 1 });
    expect(s2).toHaveLength(1);
    expect(s2[0]).toMatchObject({ type: 'STEP_FINISHED', runId: 'r1', stepIndex: 1 });
  });

  test('approval_requested → RUN_FINISHED interrupt(tool_call reason + responseSchema + ISO expiresAt)', () => {
    const frames = adapter.mapToAgui('approval_requested', {
      requestId: 'req1', command: 'rm -rf /', message: '危险操作需要确认',
      expiresAt: Date.UTC(2026, 7, 14, 14, 0, 0), conversationId: 'sess_1',
    });
    expect(frames).toHaveLength(1);
    const it = frames[0].outcome.interrupts[0];
    expect(frames[0]).toMatchObject({ type: 'RUN_FINISHED', threadId: 'sess_1' });
    expect(it).toMatchObject({ id: 'req1', reason: 'tool_call', toolCallId: 'req1' });
    expect(it.expiresAt).toBe('2026-08-14T14:00:00.000Z');
    expect(it.responseSchema.required).toEqual(['approved']);
    expect(it.responseSchema.properties.editedArgs).toBeTruthy(); // approve-with-edits 能力信号
  });

  test('taskflow_approval → interrupt(workflow reason + resumeToken 入 metadata)', () => {
    const frames = adapter.mapToAgui('taskflow_approval', {
      flowId: 'flow1', approvalId: 'app1', message: '工作流需确认', resumeToken: 'tok', expiresAt: Date.UTC(2026, 7, 14),
    });
    expect(frames[0].outcome.interrupts[0]).toMatchObject({
      id: 'app1', reason: 'crabpaw:workflow_approval',
      metadata: { resumeToken: 'tok', flowId: 'flow1' },
    });
  });

  test('activity → ACTIVITY_DELTA; 未知事件 → CUSTOM(原样透传)', () => {
    expect(adapter.mapToAgui('activity', { type: 'tool_call', summary: 'x' })[0].type).toBe('ACTIVITY_DELTA');
    const c = adapter.mapToAgui('proactive_speak', { text: 'hi' })[0];
    expect(c).toMatchObject({ type: 'CUSTOM', name: 'proactive_speak', value: { text: 'hi' } });
  });
});

describe('流内映射 mapStreamChunk', () => {
  const ctx = { runId: 'r1', threadId: 'sess_1' };

  test('chunk → TEXT_MESSAGE_CHUNK(role assistant, messageId=runId-msg)', () => {
    const frames = adapter.mapStreamChunk('chunk', { content: '你好' }, ctx);
    expect(frames[0]).toMatchObject({
      type: 'TEXT_MESSAGE_CHUNK', messageId: 'r1-msg', role: 'assistant', delta: '你好', runId: 'r1', threadId: 'sess_1',
    });
  });

  test('tool_call 三元组 + tool_result', () => {
    const start = adapter.mapStreamChunk('tool_call', { toolName: 'Bash', toolId: 'c1', toolArgs: '{"a":1}' }, ctx);
    expect(start.map((f) => f.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']);
    const res = adapter.mapStreamChunk('tool_result', { toolId: 'c1', result: 'done' }, ctx);
    expect(res[0]).toMatchObject({ type: 'TOOL_CALL_RESULT', toolCallId: 'c1', content: 'done' });
  });

  test('不映射类型返回空数组', () => {
    expect(adapter.mapStreamChunk('done', { content: 'x' }, ctx)).toEqual([]);
    expect(adapter.mapStreamChunk('start', {}, ctx)).toEqual([]);
    // 2026-08-18: phase 仅 /events 侧映射 CUSTOM, 流内落 default 丢弃(不冒充 STEP)
    expect(adapter.mapStreamChunk('phase', { phase: 'planning' }, ctx)).toEqual([]);
  });

  test('2026-08-18 终审: step:start 流内恒空(step 帧仅由 /events turn-tracker 派生, /chat 流不得处理)', () => {
    expect(adapter.mapStreamChunk('step:start', { runId: 'r1', step: 1 }, ctx)).toEqual([]);
  });

  test('2026-08-15 P2-2: 流内 thinking 增量切片(与 /events mapToAgui 同构)', () => {
    adapter._resetBuffers();
    const f1 = adapter.mapStreamChunk('thinking', { content: '正在理解' }, ctx);
    const f2 = adapter.mapStreamChunk('thinking', { content: '你的问题' }, ctx);
    expect(f1[0]).toMatchObject({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'r1-think', delta: '正在理解' });
    // 增量切片: 第二次只发新增部分(此前发累计全文 → 客户端重复拼接)
    expect(f2[0].delta).toBe('你的问题');
  });

  test('2026-08-15 P2-2: 双通道切片游标独立(互不吞增量/不翻倍)', () => {
    adapter._resetBuffers();
    // /chat 流内先消费
    expect(adapter.mapStreamChunk('thinking', { content: '第一步' }, ctx)[0].delta).toBe('第一步');
    // /events 通道独立游标: 同一更新仍收到完整增量(此前共享游标 → 空增量)
    expect(adapter.mapToAgui('thinking', { roundId: 'r1', content: '第一步' })[0].delta).toBe('第一步');
    // 各自第二次增量
    expect(adapter.mapStreamChunk('thinking', { content: '第二步' }, ctx)[0].delta).toBe('第二步');
    expect(adapter.mapToAgui('thinking', { roundId: 'r1', content: '第二步' })[0].delta).toBe('第二步');
  });

  test('2026-08-15 P2-2: 流内 tool_result 补 messageId(与 /events 同构)', () => {
    const res = adapter.mapStreamChunk('tool_result', { toolId: 'c1', result: 'done' }, ctx);
    expect(res[0]).toMatchObject({
      type: 'TOOL_CALL_RESULT', toolCallId: 'c1', content: 'done', messageId: 'tool-c1', role: 'tool',
    });
  });
});

describe('2026-08-15 P1-1: 双通道终态帧放行(流内 build 先发不吞 /events 终态帧)', () => {
  test('finished 路径: buildRunFinishedSuccess → mapToAgui(run:finished) 放行一次, 之后拦截', () => {
    adapter._resetBuffers();
    // 模拟 chat-handler finishRun: aguiWrite(buildRunFinishedSuccess) 先登记终态
    adapter.buildRunFinishedSuccess({ runId: 'rD', threadId: 'sess_1' }, { content: 'ok' });
    // 随后 broadcastEvent('run:finished') → mapToAgui: /events 通道终态帧应放行(allowance 1→0)
    expect(adapter.mapToAgui('run:finished', { roundId: 'rD', userId: 'u1' })).toHaveLength(1);
    // 终态帧已各发一次: 中间帧与重复终帧均拦截
    expect(adapter.mapToAgui('activity', { roundId: 'rD', summary: 'x' })).toEqual([]);
    expect(adapter.mapToAgui('run:finished', { roundId: 'rD' })).toEqual([]);
  });

  test('interrupted 路径: buildRunInterrupted → mapToAgui(run:interrupt) 放行一次', () => {
    adapter._resetBuffers();
    // 模拟 onChunk interrupted: aguiWrite(buildRunInterrupted) 先发
    adapter.buildRunInterrupted({ runId: 'rI', threadId: 'sess_1' });
    // finishRun('interrupted') → broadcastEvent('run:interrupt') 不被误杀
    expect(adapter.mapToAgui('run:interrupt', { roundId: 'rI' })).toHaveLength(1);
    expect(adapter.mapToAgui('run:error', { roundId: 'rI' })).toEqual([]);
  });

  test('仅 /events 通道: mapToAgui 终态帧即唯一终态帧(无多余 allowance)', () => {
    adapter._resetBuffers();
    expect(adapter.mapToAgui('run:error', { roundId: 'rE', error: 'boom' })).toHaveLength(1);
    expect(adapter.mapToAgui('run:finished', { roundId: 'rE' })).toEqual([]);
  });

  test('2026-08-18: 终态守卫放行 step 帧——派生 STEP_FINISHED 不被吞(/events 生命周期闭合)', () => {
    adapter._resetBuffers();
    // 标准双通道成功流: chat-handler 先 aguiWrite(buildRunFinishedSuccess) 登记终态
    adapter.buildRunFinishedSuccess({ runId: 'rS', threadId: 'sess_1' }, { content: 'ok' });
    // 随后 broadcastEvent('run:finished') 内 turn-tracker 派生 step:end——必须放行,
    // 否则 /events 客户端每个 STEP_STARTED 都等不到 STEP_FINISHED(生命周期失衡)。
    expect(adapter.mapToAgui('step:end', { runId: 'rS', step: 1 })).toEqual([
      { type: 'STEP_FINISHED', runId: 'rS', stepIndex: 1 },
    ]);
    // step:start 同理(复用 runId 重开 step 的边界)
    expect(adapter.mapToAgui('step:start', { runId: 'rS', step: 2 })).toEqual([
      { type: 'STEP_STARTED', runId: 'rS', stepIndex: 2, stepName: 'step-2' },
    ]);
    // step 帧豁免不消耗终态 allowance: run:finished 仍按双通道规则放行一次
    expect(adapter.mapToAgui('run:finished', { roundId: 'rS' })).toHaveLength(1);
    // 其他中间帧仍被终态守卫拦截
    expect(adapter.mapToAgui('activity', { roundId: 'rS', summary: 'x' })).toEqual([]);
  });
});

describe('2026-08-15 P2-6: 审批中断(假终结)→resume→最终终态 帧序列对严格状态机客户端合法', () => {
  test('审批 RUN_FINISHED{interrupt} 不登记终态; resume 后同 run 继续发帧; 最终终态才拦截', () => {
    adapter._resetBuffers();
    const runId = 'rA';
    // 审批中断帧(假终结): 携带 roundId 也不登记终态
    const approval = adapter.mapToAgui('approval_requested', {
      requestId: 'req1', command: 'rm -rf', message: '确认?', conversationId: 'sess_1', roundId: runId,
    });
    expect(approval).toHaveLength(1);
    expect(approval[0]).toMatchObject({ type: 'RUN_FINISHED', outcome: { type: 'interrupt' } });
    // resume 后同 run 中间帧仍放行(严格状态机客户端合法)
    expect(adapter.mapToAgui('thinking', { roundId: runId, content: '继续执行' })).toHaveLength(1);
    expect(adapter.mapToAgui('tool_call', { roundId: runId, toolId: 'c1', toolName: 'Bash', toolArgs: {} })).toHaveLength(3);
    // 最终用户可见终态: 流内 build 先行, /events 广播仍放行一次
    adapter.buildRunFinishedSuccess({ runId, threadId: 'sess_1' }, { content: 'ok' });
    expect(adapter.mapToAgui('run:finished', { roundId: runId })).toHaveLength(1);
    // 终态后中间帧/重复终帧拦截
    expect(adapter.mapToAgui('activity', { roundId: runId, summary: 'x' })).toEqual([]);
    expect(adapter.mapToAgui('run:finished', { roundId: runId })).toEqual([]);
  });

  test('taskflow_approval 同语义: 不登记终态(flowId 非 run 终态)', () => {
    adapter._resetBuffers();
    adapter.mapToAgui('taskflow_approval', { flowId: 'flow1', approvalId: 'app1', message: '工作流需确认' });
    // flow1 后续帧不受终态拦截
    expect(adapter.mapToAgui('phase', { roundId: 'flow1', phase: 'executing' })).toHaveLength(1);
  });
});

describe('buildRun* 帧构造', () => {
  test('buildRunStarted(开关关闭时返回 null)', () => {
    expect(adapter.buildRunStarted({ runId: 'r1', threadId: 't1', input: { message: 'hi' } })).toMatchObject({
      type: 'RUN_STARTED', runId: 'r1', threadId: 't1', input: { message: 'hi' },
    });
    process.env.AGUI_DUAL_BROADCAST = '0';
    expect(adapter.buildRunStarted({ runId: 'r1' })).toBeNull();
  });
  test('buildRunFinishedSuccess / buildRunError / buildRunInterrupted', () => {
    expect(adapter.buildRunFinishedSuccess({ runId: 'r1', threadId: 't1' }, { content: 'ok' })).toMatchObject({
      type: 'RUN_FINISHED', outcome: { type: 'success' }, result: { content: 'ok' },
    });
    expect(adapter.buildRunError({ runId: 'r1' }, 'bad')).toMatchObject({ type: 'RUN_ERROR', message: 'bad' });
    expect(adapter.buildRunInterrupted({ runId: 'r1' }).outcome.interrupts[0].reason).toBe('crabpaw:user_stop');
  });
});

describe('resume 翻译 translateResume', () => {
  test('resolved + approved → respond(true, once)', () => {
    const t = adapter.translateResume({ interruptId: 'req1', status: 'resolved', payload: { approved: true } });
    expect(t).toEqual({ kind: 'respond', requestId: 'req1', approved: true, scope: 'once', options: {} });
  });
  test('resolved + approved:false → respond(false)(拒绝表达在 payload 内)', () => {
    const t = adapter.translateResume({ interruptId: 'req1', status: 'resolved', payload: { approved: false } });
    expect(t.approved).toBe(false);
  });
  test('cancelled → cancel(respond false)', () => {
    const t = adapter.translateResume({ interruptId: 'req1', status: 'cancelled' });
    expect(t).toMatchObject({ kind: 'cancel', requestId: 'req1', approved: false });
  });
  test('approve-with-edits: editedArgs 全量替换 → options.editedCommand', () => {
    const t = adapter.translateResume({
      interruptId: 'req1', status: 'resolved',
      payload: { approved: true, editedArgs: 'echo hi', scope: 'session', conversationId: 'sess_1' },
    });
    expect(t).toMatchObject({ kind: 'respond', approved: true, scope: 'session' });
    expect(t.options).toEqual({ editedCommand: 'echo hi', conversationId: 'sess_1' });
  });
  test('非法 status / 缺 interruptId → error', () => {
    expect(adapter.translateResume({ interruptId: 'x', status: 'bogus' }).kind).toBe('error');
    expect(adapter.translateResume({ status: 'resolved' }).kind).toBe('error');
    expect(adapter.translateResume(null).kind).toBe('error');
  });
});

describe('幂等 LRU', () => {
  test('mark/is 配对, 超容量裁剪最旧', () => {
    expect(adapter.isResumeHandled('a')).toBe(false);
    adapter.markResumeHandled('a');
    expect(adapter.isResumeHandled('a')).toBe(true);
    for (let i = 0; i < 300; i++) adapter.markResumeHandled(`k${i}`);
    // 容量 200: 最早的 'a' 已被裁掉, 最近的不在(只放 k199), k198 是倒数第二个…
    expect(adapter.isResumeHandled('a')).toBe(false);
    expect(adapter.isResumeHandled('k199')).toBe(true);
  });
});
