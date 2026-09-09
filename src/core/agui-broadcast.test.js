/**
 * sse-broadcast 双名广播集成测试(GUI 全量修复 P1)
 *
 * 验证: broadcastEvent 旧名原样 + AG-UI 新名帧同时送达; AGUI_DUAL_BROADCAST=0 时仅旧名。
 */
const { handleSSE, broadcastEvent, getSSEClientCount, stopHeartbeat } = require('./sse-broadcast');

function makeClient() {
  const writes = [];
  const res = {
    writeHead: jest.fn(),
    write: jest.fn((chunk) => { writes.push(String(chunk)); return true; }),
  };
  const req = { headers: {}, on: jest.fn() };
  return { req, res, writes };
}

beforeEach(() => {
  delete process.env.AGUI_DUAL_BROADCAST;
  // 2026-08-15: 终态 Set 跨用例隔离——同 runId 在上一用例已终态会拦截本用例帧
  require('./agui-adapter')._resetBuffers();
});

afterEach(() => {
  stopHeartbeat();
  // 清空客户端(通过 stopHeartbeat + 内部 set 无法直接清, 用 handleSSE 断开模拟)
});

test('broadcastEvent 双名广播: 旧名帧 + AG-UI 帧同达', () => {
  const { req, res, writes } = makeClient();
  handleSSE(req, res);

  broadcastEvent('run:finished', { roundId: 'r1', userId: 'u1', status: 'finished', ts: 1 });

  const text = writes.join('');
  // 旧名帧(原样)
  expect(text).toContain('event: run:finished');
  expect(text).toContain('"status":"finished"');
  // AG-UI 帧
  expect(text).toContain('event: RUN_FINISHED');
  expect(text).toContain('"outcome":{"type":"success"}');
  expect(text).toContain('"runId":"r1"');
  // 帧序: 旧名在前, 新名在后
  expect(text.indexOf('event: run:finished')).toBeLessThan(text.indexOf('event: RUN_FINISHED'));
});

test('approval_requested 双名: interrupt 帧带 responseSchema', () => {
  const { req, res, writes } = makeClient();
  handleSSE(req, res);

  broadcastEvent('approval_requested', {
    requestId: 'req1', command: 'rm -rf', message: '确认', expiresAt: Date.UTC(2026, 7, 14), conversationId: 'sess_1',
  });

  const text = writes.join('');
  expect(text).toContain('event: approval_requested');
  expect(text).toContain('event: RUN_FINISHED');
  expect(text).toContain('"reason":"tool_call"');
  expect(text).toContain('"required":["approved"]');
});

test('AGUI_DUAL_BROADCAST=0: 仅旧名帧', () => {
  process.env.AGUI_DUAL_BROADCAST = '0';
  const { req, res, writes } = makeClient();
  handleSSE(req, res);

  broadcastEvent('run:finished', { roundId: 'r1', userId: 'u1', status: 'finished', ts: 1 });

  const text = writes.join('');
  expect(text).toContain('event: run:finished');
  expect(text).not.toContain('event: RUN_FINISHED');
});

test('heartbeat 不产生 AG-UI 帧', () => {
  const { req, res, writes } = makeClient();
  handleSSE(req, res);

  broadcastEvent('heartbeat', {});
  const text = writes.join('');
  expect(text).toContain('event: heartbeat');
  expect(text).not.toContain('CUSTOM');
});

test('tool_call 双名: TOOL_CALL_START/ARGS/END 三元组帧', () => {
  const { req, res, writes } = makeClient();
  handleSSE(req, res);

  broadcastEvent('tool_call', { toolName: 'Bash', toolId: 'c1', toolArgs: { cmd: 'ls' } });

  const text = writes.join('');
  expect(text).toContain('event: TOOL_CALL_START');
  expect(text).toContain('event: TOOL_CALL_ARGS');
  expect(text).toContain('event: TOOL_CALL_END');
  expect(text).toContain('"toolCallName":"Bash"');
});

test('多客户端都收到双名帧', () => {
  const c1 = makeClient();
  const c2 = makeClient();
  handleSSE(c1.req, c1.res);
  handleSSE(c2.req, c2.res);

  broadcastEvent('run:finished', { roundId: 'r1', userId: 'u1', status: 'finished', ts: 1 });

  expect(c1.writes.join('')).toContain('event: RUN_FINISHED');
  expect(c2.writes.join('')).toContain('event: RUN_FINISHED');
});

test('2026-08-15 T7(分部六): 客户端断连(req close)后不再收到广播', () => {
  const c = makeClient();
  handleSSE(c.req, c.res);
  expect(getSSEClientCount()).toBeGreaterThanOrEqual(1);
  // 模拟断连：触发 close 监听器 → 客户端从广播集合移除
  const closeHandler = c.req.on.mock.calls.find(([evt]) => evt === 'close');
  expect(closeHandler).toBeTruthy();
  closeHandler[1]();
  const writesBefore = c.writes.length;
  broadcastEvent('run:finished', { roundId: 'r2', userId: 'u1', status: 'finished', ts: 2 });
  // 断连客户端不应再收到新帧
  expect(c.writes.length).toBe(writesBefore);
});
