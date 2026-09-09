const http = require('http');
const WebSocket = require('ws');
const { SceneServer } = require('../core/scene/scene-server');
const { TaskStatusWebSocket } = require('../tasks/core/task-status-websocket');
const { attachVoiceCloudWS, destroyVoiceCloudWS } = require('../handlers/voice-cloud-ws');

const API_KEY = 'test-secret';

// 2026-08-13 (Task 3 审查补充): stub 云端 ASR 会话工厂——config 帧测试若走真实
// createVolcengineSession 会按 data/.crabpaw/config.json 里的真实凭证发起外网 WS 连接
// (单测不允许外网/凭证使用)。返回 null → 服务端走"会话创建失败"路径,
// 不影响本测试目标(seenSessionIds 复用检测在会话创建之前完成)。
jest.mock('../core/asr/cloud-asr', () => ({
  createCloudASRSession: jest.fn(() => null),
}));

function openWs(server, path, token) {
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `ws://127.0.0.1:${server.address().port}${path}${query}`;

  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, { origin: 'http://localhost:5173' });
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error(`WebSocket open timed out: ${url}`));
    }, 3000);

    client.once('open', () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      resolve({ statusCode: res.statusCode });
    });
    client.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForWsMessage(client, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const handler = (raw) => {
      let msg = null;
      try { msg = JSON.parse(raw.toString()); } catch (e) { console.error('[test] 非 JSON 帧:', e); return; }
      if (!msg || !predicate(msg)) return;
      clearTimeout(timer);
      client.off('message', handler);
      resolve(msg);
    };
    timer = setTimeout(() => {
      client.off('message', handler);
      reject(new Error('waiting for WS message timed out'));
    }, timeoutMs);
    client.on('message', handler);
  });
}

describe('shared WebSocket upgrade auth', () => {
  let server;
  let scene;
  let tasks;
  let clients;

  beforeEach(async () => {
    clients = [];
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    scene = new SceneServer(server, {
      path: '/scene',
      apiKey: API_KEY,
      sseBroadcast: false,
    });
    tasks = new TaskStatusWebSocket(server, {
      apiKey: API_KEY,
      heartbeatInterval: 60000,
      heartbeatTimeout: 30000,
    });
    attachVoiceCloudWS(server, { apiKey: API_KEY });
  });

  afterEach(async () => {
    for (const client of clients) {
      try { client.terminate(); } catch (e) {
        /* ignore */
        console.warn('[websocket-auth.test.js] 空 catch 补日志:', e && e.message);
      }

    }
    destroyVoiceCloudWS();
    scene.destroy();
    tasks.close();
    await new Promise((resolve) => server.close(resolve));
  });

  test('keeps all three endpoints reachable after voice-cloud attaches', async () => {
    for (const path of ['/scene', '/ws/tasks', '/voice/cloud']) {
      const client = await openWs(server, path, API_KEY);
      expect(client).toBeInstanceOf(WebSocket);
      clients.push(client);
    }
  });

  test('rejects each endpoint without a token', async () => {
    for (const path of ['/scene', '/ws/tasks', '/voice/cloud']) {
      const result = await openWs(server, path);
      expect(result.statusCode).toBe(401);
    }
  });
});

const { getMetricsCollector } = require('../core/observability');
const { BoundedBacklog } = require('../core/voice-pipeline');

describe('voice-cloud metrics wiring', () => {
  let server;
  let clients;
  let metrics;

  beforeEach(async () => {
    clients = [];
    metrics = getMetricsCollector();
    metrics.reset();
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    attachVoiceCloudWS(server, { apiKey: API_KEY });
  });

  afterEach(async () => {
    for (const client of clients) {
      try { client.terminate(); } catch (e) {
        /* ignore */
        console.warn('[websocket-auth.test.js] 空 catch 补日志:', e && e.message);
      }

    }
    destroyVoiceCloudWS();
    await new Promise((resolve) => server.close(resolve));
  });

  test('WS 连接建立 → voice_ws_sessions_total=1 且 active gauge=1', async () => {
    const client = await openWs(server, '/voice/cloud', API_KEY);
    expect(client).toBeInstanceOf(WebSocket);
    clients.push(client);

    const all = metrics.getAllMetrics();
    expect(all.counters['voice_ws_sessions_total']).toBe(1);
    expect(all.gauges['voice_ws_sessions_active']).toBe(1);
  });

  test('WS 关闭后 active gauge 回 0（total 保持不变）', async () => {
    const client = await openWs(server, '/voice/cloud', API_KEY);
    expect(client).toBeInstanceOf(WebSocket);
    clients.push(client);
    expect(metrics.getAllMetrics().gauges['voice_ws_sessions_active']).toBe(1);

    client.terminate();
    const deadline = Date.now() + 1000;
    let gauge = null;
    while (Date.now() < deadline) {
      gauge = metrics.getAllMetrics().gauges['voice_ws_sessions_active'];
      if (gauge === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(gauge).toBe(0);
    expect(metrics.getAllMetrics().counters['voice_ws_sessions_total']).toBe(1);
  });

  test('backlog 溢出回调链 → voice_backlog_overflow_total 递增一次', () => {
    const backlog = new BoundedBacklog(256); // 与 voice-cloud-ws MAX_BACKLOG_CHUNKS 一致
    backlog.onOverflow((_size) => metrics.increment('voice_backlog_overflow_total'));
    for (let i = 0; i < 300; i++) backlog.push(Buffer.from([i]));
    expect(metrics.getCounter('voice_backlog_overflow_total')).toBe(1);
  });

  test('config 帧重复携带已见 sessionId → voice_ws_reconnects_total 计一次(全新 ID 不计)', async () => {
    // 连接 A 携带 's1'(首次,不计重连)——等 config-status diag(会话创建前发送)确认 config 已处理
    const c1 = await openWs(server, '/voice/cloud', API_KEY);
    expect(c1).toBeInstanceOf(WebSocket);
    clients.push(c1);
    const p1 = waitForWsMessage(c1, (m) => m.type === 'diag' && m.event === 'config-status' && m.sessionId === 's1');
    c1.send(JSON.stringify({ type: 'config', provider: 'volcengine', lang: 'zh', sessionId: 's1' }));
    await p1;
    expect(metrics.getCounter('voice_ws_reconnects_total')).toBe(0);
    c1.terminate();

    // 连接 B 携带同一 's1' → 计 1 次重连
    const c2 = await openWs(server, '/voice/cloud', API_KEY);
    expect(c2).toBeInstanceOf(WebSocket);
    clients.push(c2);
    const p2 = waitForWsMessage(c2, (m) => m.type === 'diag' && m.event === 'config-status' && m.sessionId === 's1');
    c2.send(JSON.stringify({ type: 'config', provider: 'volcengine', lang: 'zh', sessionId: 's1' }));
    await p2;
    expect(metrics.getCounter('voice_ws_reconnects_total')).toBe(1);
    c2.terminate();

    // 连接 C 携带全新 's2' → 首次连接不计重连,计数保持 1
    const c3 = await openWs(server, '/voice/cloud', API_KEY);
    expect(c3).toBeInstanceOf(WebSocket);
    clients.push(c3);
    const p3 = waitForWsMessage(c3, (m) => m.type === 'diag' && m.event === 'config-status' && m.sessionId === 's2');
    c3.send(JSON.stringify({ type: 'config', provider: 'volcengine', lang: 'zh', sessionId: 's2' }));
    await p3;
    expect(metrics.getCounter('voice_ws_reconnects_total')).toBe(1);
  });
});
