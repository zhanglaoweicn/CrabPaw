/**
 * scene-server v1 心跳保活回归测试（2026-08-17）
 *
 * 实机 bug（股票卡不上线）：GUI 的 scene WS 每 60 秒心跳判死断开一次、2s 后
 * 重连循环。stocks-card 恰在断连窗口（11:37:41.2 断开 → 11:37:43.2 重连）
 * 内 upsert，patch 丢失 → 有回复无卡片。
 *
 * 根因（双端心跳契约断裂）：
 *   - GUI scene-client 每 25s 发 v1 ping {v:1,type:'ping'}
 *   - 服务端 v1 case 'ping' 只回 pong，不设 isAlive=true
 *   - 服务端心跳每 30s 把 isAlive 置 false 发 scene:ping，客户端不回 pong
 *   - 下一心跳周期 isAlive 仍 false → 判死 terminate → 断连循环
 *
 * 修复：服务端 v1 case 'ping' 同时调 _handlePong 设 isAlive——GUI 的 25s
 * ping 即可保活，不再判死。本测试守该契约：v1 ping 必须保活。
 */

const http = require('http');
const WebSocket = require('ws');
const { SceneServer } = require('../core/scene/scene-server');

const API_KEY = 'test-secret';

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
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
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

describe('scene-server v1 心跳保活', () => {
  let server;
  let scene;
  let client;

  beforeEach(async () => {
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    scene = new SceneServer(server, {
      path: '/scene',
      apiKey: API_KEY,
      sseBroadcast: false,
      protocol: 'v1',
    });
    client = await openWs(server, '/scene', API_KEY);
  });

  afterEach(async () => {
    try {
      await new Promise((resolve) => {
        client.once('close', resolve);
        client.terminate();
        setTimeout(resolve, 500);
      });
      // 等服务端 close handler（console.log）flush，避免 "Cannot log after tests are done"
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (e) { /* ignore */ }
    try { scene.destroy(); } catch (e) { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
  });

  test('v1 ping 必须恢复 isAlive（否则 60s 心跳判死断连循环）', async () => {
    // 完成 v1 握手
    client.send(JSON.stringify({ v: 1, type: 'hello', shell: 'test', caps: ['scene', 'patch'] }));
    await waitForWsMessage(client, (m) => m.v === 1 && m.type === 'welcome');

    // 找到客户端并模拟心跳周期：服务端把 isAlive 置 false
    const [clientInfo] = Array.from(scene._clients.values());
    expect(clientInfo).toBeTruthy();
    clientInfo.isAlive = false;

    // GUI 每 25s 发一次 v1 ping（heartbeat ping）
    client.send(JSON.stringify({ v: 1, type: 'ping' }));

    // 等待 ping 被服务端处理
    await new Promise((r) => setTimeout(r, 100));

    // 修复契约：ping 即探活信号，isAlive 必须恢复 true
    const [after] = Array.from(scene._clients.values());
    expect(after.isAlive).toBe(true);
    expect(after.lastPing).toBeGreaterThan(0);
  });

  test('v1 ping 收到服务端 pong 回复（协议完整性）', async () => {
    client.send(JSON.stringify({ v: 1, type: 'hello', shell: 'test', caps: ['scene', 'patch'] }));
    await waitForWsMessage(client, (m) => m.v === 1 && m.type === 'welcome');

    const pongPromise = waitForWsMessage(client, (m) => m.v === 1 && m.type === 'pong');
    client.send(JSON.stringify({ v: 1, type: 'ping' }));
    const pong = await pongPromise;
    expect(pong.type).toBe('pong');
  });
});
