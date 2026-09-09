const { addSSEClient, removeSSEClient, broadcastEvent, handleSSE, _resetStreamState, stopHeartbeat } = require('../core/sse-broadcast');

function mockRes() {
  const writes = [];
  return {
    writes,
    write(s) { writes.push(s); return true; },
    writeHead() {},
    on() {},
  };
}

function parseId(line) {
  // m 标志: write() 以整帧多行 chunk 入 writes, 需按行匹配首个 id: 行
  const m = line.match(/^id: (\d+)$/m);
  return m ? Number(m[1]) : null;
}

describe('sse-broadcast seq / 重放', () => {
  beforeEach(() => {
    _resetStreamState();
    // 隔离: 测试内禁用 AG-UI 双名帧派生, seq 编号确定可断言
    global.__aguiMap = null;
  });
  afterEach(() => { stopHeartbeat(); });

  test('每帧带递增 id', () => {
    const res = mockRes();
    addSSEClient(res);
    broadcastEvent('x', { a: 1 });
    broadcastEvent('y', { b: 2 });
    const ids = res.writes.map(parseId).filter((v) => v !== null);
    expect(ids).toEqual([1, 2]);
    removeSSEClient(res);
  });

  test('环形缓冲上限 500', () => {
    const res = mockRes();
    addSSEClient(res);
    for (let i = 0; i < 510; i++) broadcastEvent('x', { i });
    removeSSEClient(res);
    // 重放 since=0: 缓冲只剩 seq 11..510 共 500 条
    const replayRes = mockRes();
    handleSSE({ url: '/events?since=0', headers: {}, on() {} }, replayRes);
    removeSSEClient(replayRes);
    const ids = replayRes.writes.map(parseId).filter((v) => v !== null);
    expect(ids.length).toBe(500);
    expect(ids[0]).toBe(11);
    expect(ids[499]).toBe(510);
  });

  test('Last-Event-ID 头只重放后续帧', () => {
    const res = mockRes();
    addSSEClient(res);
    broadcastEvent('x', { n: 1 }); // seq 1
    broadcastEvent('x', { n: 2 }); // seq 2
    broadcastEvent('x', { n: 3 }); // seq 3
    removeSSEClient(res);
    const replayRes = mockRes();
    handleSSE({ url: '/events', headers: { 'last-event-id': '1' }, on() {} }, replayRes);
    removeSSEClient(replayRes);
    const ids = replayRes.writes.map(parseId).filter((v) => v !== null);
    expect(ids).toEqual([2, 3]);
  });

  test('2026-08-18 终审 I2: connected 帧 data 携带当前 seq(重启对账信号)', () => {
    broadcastEvent('x', { a: 1 }); // nextSeq = 1(无 AG-UI 双名帧: 全局 __aguiMap 已置空)
    const replayRes = mockRes();
    handleSSE({ url: '/events', headers: {}, on() {} }, replayRes);
    removeSSEClient(replayRes);
    // 无 since → 无重放帧, writes 只有 connected 帧(无 id: 行)
    const frame = replayRes.writes[replayRes.writes.length - 1];
    const dataLine = frame.match(/^data: (.+)$/m);
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine[1]);
    expect(payload.type).toBe('connected');
    expect(payload.seq).toBe(1); // 等于当前 nextSeq
  });
});

// 2026-08-18 终审 I1: 重放环序必须等于直播序——主帧先于 AG-UI 双名帧入环,
// 否则客户端按 seq 去重(seq<=lastSeq)时 AG-UI 帧先抬升 lastSeq, 旧名主帧被吞。
describe('sse-broadcast AG-UI 双名帧重放顺序', () => {
  let prevAguiMap;
  let prevTurnTracker;

  beforeEach(() => {
    _resetStreamState();
    prevAguiMap = global.__aguiMap;
    prevTurnTracker = global.__turnTracker;
    global.__aguiMap = (type) => (type === 'run:start' ? [{ type: 'RUN_STARTED', runId: 'r1' }] : []);
    global.__turnTracker = (type) => (type === 'run:start' ? [{ type: 'step:start', runId: 'r1', step: 1 }] : []);
  });
  afterEach(() => {
    global.__aguiMap = prevAguiMap;
    global.__turnTracker = prevTurnTracker;
    stopHeartbeat();
  });

  test('重放事件名按直播序(step:start, run:start, RUN_STARTED), seq 严格递增', () => {
    broadcastEvent('run:start', { runId: 'r1' });
    const replayRes = mockRes();
    handleSSE({ url: '/events?since=0', headers: {}, on() {} }, replayRes);
    removeSSEClient(replayRes);
    // connected 帧非重放帧, 排除后即重放序
    const names = replayRes.writes
      .map((w) => w.match(/^event: (.+)$/m)?.[1])
      .filter((n) => n && n !== 'connected');
    expect(names).toEqual(['step:start', 'run:start', 'RUN_STARTED']);
    const ids = replayRes.writes.map(parseId).filter((v) => v !== null);
    expect(ids).toHaveLength(3);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
  });
});
