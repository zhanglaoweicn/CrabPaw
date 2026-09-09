// auth.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { sendJson, sendError } = require('../http-utils');
const { getApiKey, isLocalSocket, isLocalBrowserContext } = require('./_shared');
const { DEFAULT_PORT } = require('../../core/config');

async function handleDevToken(req, res, _ctx) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return sendError(res, 500, 'API Key not configured');
  }

  if (process.env.NODE_ENV === 'production') {
    return sendError(res, 403, '此端点在生产模式下不可用');
  }

  const referer = req.headers['referer'] || '';
  const origin = req.headers['origin'] || '';
  const isElectron = req.headers['x-electron'] || referer.includes('localhost') || origin.includes('localhost');
  
  if (!isElectron) {
    return sendError(res, 403, 'This endpoint only allows local client access');
  }

  // T1.16(2026-08-08,审计 P1): challenge-response——Electron 主进程带随机
  // challenge,回传 HMAC-SHA256(apiKey, challenge) 证明应答者是持有 API_TOKEN
  // 的真实后端,防本机进程抢绑 38767 伪造应答者做对话/记忆/上传 MITM。
  const challenge = req.url ? new URL(req.url, 'http://localhost').searchParams.get('challenge') : null;
  if (!challenge) {
    return sendError(res, 403, 'challenge required');
  }
  const crypto = require('crypto');
  const challengeHmac = crypto.createHmac('sha256', apiKey).update(challenge).digest('hex');

  sendJson(res, 200, {
    token: apiKey,
    port: parseInt(process.env.PORT || String(DEFAULT_PORT), 10),
    challengeHmac
  });
}

// 2026-08-05: 浏览器模式 token 引导——仅限本机来源返回 API token，
// 供前端 getCredentials 在非 Electron 环境下初始化鉴权凭据（WS/HTTP 同款 token）。
// 安全: authGuard 将其列为 public 路由(否则鸡生蛋)，此处再做双重限制：
// 1) remoteAddress 必须为回环地址（远程部署时该端点对外不可用）；
// 2) 请求必须来自真实本地客户端上下文（X-Electron / localhost Origin|Referer /
//    X-Requested-With）——阻止本机其他进程（经端口转发/代理伪装的远端连接、盲打脚本）
//    无头抓取 token。
async function handleAuthBootstrap(req, res, _ctx) {
  if (!isLocalSocket(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: localhost only' }));
    return true;
  }
  if (!isLocalBrowserContext(req)) {
    console.warn('⛔ /auth/bootstrap 请求缺少本地客户端上下文（无 X-Electron/localhost Origin/Referer），已拒绝');
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: local client context required' }));
    return true;
  }
  const token = getApiKey();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, token }));
  return true;
}

module.exports = {
  handleDevToken,
  handleAuthBootstrap,
};
