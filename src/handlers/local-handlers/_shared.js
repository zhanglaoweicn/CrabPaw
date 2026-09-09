// _shared.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { readJsonBody } = require('../http-utils');

function getDataDir() {
  return process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
}

function getApiKey() {
  if (process.env.ADMIN_API_KEY) {
    return process.env.ADMIN_API_KEY;
  }
  const tokenPath = path.join(getDataDir(), '.api_token');
  try {
    return fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('读取 API token 失败:', e.message);
    }
  }
  return '';
}

/** 本机来源判定（remoteAddress 为 127.0.0.1 / ::1 / IPv4-mapped 回环） */
function isLocalSocket(req) {
  const remote = (req.socket && req.socket.remoteAddress) || '';
  return remote === '127.0.0.1' || remote === '::1' ||
    remote.startsWith('::ffff:127.') || remote.startsWith('127.');
}

/**
 * 本地浏览器上下文判定（S3/M5 兜底层）：
 * - Electron 客户端请求带 X-Electron: true
 * - 浏览器页面（Vite dev 5173 / 后端同源 38767）带 localhost 的 Origin/Referer
 * 用于区分"真实本地客户端"与"无脑盲打脚本"，避免仅靠 remoteAddress 判本机
 * （经本地端口转发/代理的连接同样显示为 127.0.0.1）。
 */
function isLocalBrowserContext(req) {
  const h = req.headers || {};
  const get = (k) => h[k] || h[k.toLowerCase()] || h[k.toUpperCase()];
  if (get('X-Electron') === 'true') return true;
  if (get('X-Requested-With') === 'XMLHttpRequest') return true;
  const referer = String(get('Referer') || get('Origin') || '');
  if (!referer) return false;
  try {
    const hostname = new URL(referer).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch (e) {
    return false;
  }
}

function _safeCallMethod(obj, method, ...args) {
  try {
    return obj && typeof obj[method] === 'function' ? obj[method](...args) : null;
  } catch (e) {
    return null;
  }
}

async function _readJsonBodyOptional(req) {
  try {
    return (await readJsonBody(req)) || {};
  } catch (e) {
    return {};
  }
}

module.exports = {
  getDataDir,
  getApiKey,
  isLocalSocket,
  isLocalBrowserContext,
  _readJsonBodyOptional,
  _safeCallMethod,
};
