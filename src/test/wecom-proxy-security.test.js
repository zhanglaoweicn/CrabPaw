/**
 * 发布 S-2b — wecom 代理 file_path 白名单接线测试。
 * 真实本地 send 服务桩（记录是否被命中）+ mock req/res 直调 handleWecomSendFileProxy：
 * - uploads 内允许 → 转发且注入配置 chatId；
 * - uploads 外（DATA_DIR 根 config.json / 遍历逃逸）→ 403 且不触达 send 服务；
 * - 缺 file_path → 400。
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { handleWecomSendFileProxy } = require('../handlers/local-handlers/wecom');

function mockRes() {
  let doneResolve;
  const done = new Promise((r) => { doneResolve = r; });
  return {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    end(data) { this.body = data; doneResolve(); },
    waitDone: (timeoutMs = 3000) => Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error('proxy response timeout')), timeoutMs)),
    ]),
  };
}

function fakeReq(bodyObj) {
  const stream = Readable.from([JSON.stringify(bodyObj)]);
  stream.headers = {};
  return stream;
}

describe('handleWecomSendFileProxy — file_path 白名单', () => {
  let tmp;
  let sendService;
  let hits;
  let okPath;
  let secretPath;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-wecom-proxy-'));
    fs.mkdirSync(path.join(tmp, 'uploads'), { recursive: true });
    okPath = path.join(tmp, 'uploads', 'ok.txt');
    secretPath = path.join(tmp, 'config.json');
    fs.writeFileSync(okPath, 'ok');
    fs.writeFileSync(secretPath, '{"wecom":{"secret":"should-not-leak"}}');
    // 代理读取的配置：用户 wecomUserId（chatId 注入源）与 API token
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'user.json'), JSON.stringify({ wecomUserId: 'boss' }));
    fs.writeFileSync(path.join(tmp, '.api_token'), 'tok123');

    hits = [];
    sendService = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        hits.push({ path: req.url, body: JSON.parse(body || '{}'), headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      });
    });
    await new Promise((r) => sendService.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(tmp, '.wecom_send_port'), String(sendService.address().port));
  });

  afterEach(async () => {
    if (sendService) await new Promise((r) => sendService.close(r));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不阻塞 */ }
  });

  test('uploads 内文件允许：转发到 send 服务且注入配置 chatId', async () => {
    const res = mockRes();
    await handleWecomSendFileProxy(fakeReq({ file_path: okPath }), res, { dataDir: tmp });
    // 转发路径的响应在 proxyRes 回调里异步落盘——等 res.end 再断言
    await res.waitDone();
    expect(res.statusCode).toBe(200);
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe('/wecom/send-file');
    expect(hits[0].body.chat_id).toBe('boss');
    expect(hits[0].body.file_path).toBe(okPath);
    expect(hits[0].headers['x-api-key']).toBe('tok123');
  });

  test('DATA_DIR 根 config.json 拒绝：403 且不触达 send 服务', async () => {
    const res = mockRes();
    await handleWecomSendFileProxy(fakeReq({ file_path: secretPath }), res, { dataDir: tmp });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ success: false, error: '安全限制：只允许发送 uploads 与 data/workspace 产物目录内的文件（config/密钥类文件一律拒绝）' });
    expect(hits.length).toBe(0);
  });

  test('路径遍历逃逸拒绝（uploads/../config.json）', async () => {
    const res = mockRes();
    await handleWecomSendFileProxy(fakeReq({ file_path: path.join(tmp, 'uploads', '..', 'config.json') }), res, { dataDir: tmp });
    expect(res.statusCode).toBe(403);
    expect(hits.length).toBe(0);
  });

  test('缺少 file_path → 400 且不触达 send 服务', async () => {
    const res = mockRes();
    await handleWecomSendFileProxy(fakeReq({}), res, { dataDir: tmp });
    expect(res.statusCode).toBe(400);
    expect(hits.length).toBe(0);
  });
});
