/**
 * 发布 S-2b — wecom send 服务 chatId 授权集 + 回环监听（spawn 端到端）。
 * 无凭证启动真实 event-bridge（WS 不连），仅验证 HTTP 层：
 * - 无 token → 401（既有鉴权不退化）；
 * - 白名单内 chat_id（user.wecomUserId / defaultChatId）→ 通过授权（503=WS 未连接）；
 * - 白名单外 / 缺失 chat_id → 403 目标用户未授权。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const BRIDGE = path.join(__dirname, '..', 'channels', 'wecom', 'event-bridge.js');

function waitFor(fn, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function postJson(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/wecom/send',
      method: 'POST',
      agent: false, // 免 keep-alive 句柄滞留 worker
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(d); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('wecom send 服务 — chatId 授权集 + 回环监听（spawn 端到端）', () => {
  let tmp;
  let port;
  let child;
  const token = 'tok-e2e-123';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-wecom-bridge-'));
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.api_token'), token);
    fs.writeFileSync(path.join(tmp, 'config', 'user.json'), JSON.stringify({ wecomUserId: 'boss' }));
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ wecom: { defaultChatId: 'bossgroup' } }));
    port = 42000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [BRIDGE], {
      stdio: 'ignore',
      env: { ...process.env, CRABPAW_DATA_DIR: tmp, WECOM_SEND_PORT: String(port) },
    });
    await waitFor(() => fs.existsSync(path.join(tmp, '.wecom_send_port')), 10000);
  }, 20000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不阻塞 */ }
  });

  test('无 token → 401（既有鉴权不退化）', async () => {
    const r = await postJson(port, { chat_id: 'boss', msg_type: 'markdown', content: 'hi' });
    expect(r.status).toBe(401);
  });

  test('白名单内 chat_id（wecomUserId/defaultChatId）→ 通过授权，503=WS 未连接', async () => {
    const r = await postJson(port, { chat_id: 'boss', msg_type: 'markdown', content: 'hi' }, { 'X-Api-Key': token });
    expect(r.status).toBe(503);
    const r2 = await postJson(port, { chat_id: 'bossgroup', msg_type: 'markdown', content: 'hi' }, { 'X-Api-Key': token });
    expect(r2.status).toBe(503);
  });

  test('白名单外 chat_id → 403 目标用户未授权', async () => {
    const r = await postJson(port, { chat_id: 'evil-user', msg_type: 'markdown', content: 'hi' }, { 'X-Api-Key': token });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ success: false, error: '目标用户未授权' });
  });

  test('缺失 chat_id → 403', async () => {
    const r = await postJson(port, { msg_type: 'markdown', content: 'hi' }, { 'X-Api-Key': token });
    expect(r.status).toBe(403);
  });
});
