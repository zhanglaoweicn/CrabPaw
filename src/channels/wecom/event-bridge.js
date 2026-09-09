require('../../core/safe-stdio').installSafeStdio();
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AiBot = require('@wecom/aibot-node-sdk');
const { getCredentialManager } = require('../../core/credential-manager');
const { DEFAULT_PORT } = require('../../core/config');
const { loadAllowedChatIds, isAllowedChatId, loadApprovedGroupChats } = require('./send-guard');

console.log('🚀 企业微信事件桥接器启动（官方 SDK 模式）');

const BASE_DIR = path.join(__dirname, '..', '..', '..');
const DATA_DIR = process.env.CRABPAW_DATA_DIR || path.join(BASE_DIR, 'data', '.crabpaw');
const WORKSPACE_DIR = path.join(BASE_DIR, 'data', 'workspace');
const WECOM_STATUS_PATH = path.join(DATA_DIR, 'wecom-status.json');
const WECOM_SEND_PORT_PATH = path.join(DATA_DIR, '.wecom_send_port');
const API_PORT = parseInt(process.env.API_PORT || String(DEFAULT_PORT), 10);
const SEND_PORT = parseInt(process.env.WECOM_SEND_PORT || '38769', 10);
const PID_FILE_PATH = path.join(DATA_DIR, '.wecom_bridge.pid');

const MESSAGE_BUFFER_TTL = 3000;

const messageBuffer = new Map();

try {
  if (fs.existsSync(PID_FILE_PATH)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE_PATH, 'utf-8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      try { process.kill(oldPid, 0); } catch (e) {
        // 旧进程不存在，清理 PID 文件
        fs.unlinkSync(PID_FILE_PATH);
      }
      try {
        process.kill(oldPid, 'SIGTERM');
        console.log(`🔄 终止旧的企业微信桥接进程: PID ${oldPid}`);
        const start = Date.now();
        while (Date.now() - start < 3000) {
          try { process.kill(oldPid, 0); } catch (e) { break; /* 进程已退出 */ }
        }
      } catch (e) { console.warn('终止旧桥接进程失败:', e.message) }
    }
  }
  fs.writeFileSync(PID_FILE_PATH, process.pid.toString());
} catch (e) { console.warn('PID 文件管理失败:', e.message) }

function _convertMarkdownTableToAlignedText(text) {
  const lines = text.split('\n');
  const result = [];
  let inTable = false;
  let tableRows = [];
  let inCodeBlock = false;

  function getDisplayWidth(str) {
    let w = 0;
    for (const ch of str) {
      const code = ch.charCodeAt(0);
      if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F) ||
          (code >= 0xFF01 && code <= 0xFF60) || (code >= 0xF900 && code <= 0xFAFF) ||
          (code >= 0x2E80 && code <= 0x2EFF) || (code >= 0x3400 && code <= 0x4DBF)) {
        w += 2;
      } else {
        w += 1;
      }
    }
    return w;
  }

  function stripMarkdownFormatting(cell) {
    return cell.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1').replace(/`(.*?)`/g, '$1');
  }

  function truncateToWidth(str, maxW) {
    let w = 0;
    let out = '';
    for (const ch of str) {
      const code = ch.charCodeAt(0);
      const cw = ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F) ||
                  (code >= 0xFF01 && code <= 0xFF60) || (code >= 0xF900 && code <= 0xFAFF) ||
                  (code >= 0x2E80 && code <= 0x2EFF) || (code >= 0x3400 && code <= 0x4DBF)) ? 2 : 1;
      if (w + cw > maxW) {
        if (maxW - w >= 2) out += '..';
        break;
      }
      out += ch;
      w += cw;
    }
    return out;
  }

  function padCell(cell, width) {
    return cell + ' '.repeat(Math.max(0, width - getDisplayWidth(cell)));
  }

  function flushTable() {
    if (tableRows.length === 0) return;
    const parsedRows = tableRows.map(row => {
      return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => stripMarkdownFormatting(c.trim()));
    });

    const dataRows = parsedRows.filter((row, idx) => {
      if (idx === 1 && row.every(c => /^[-:]+$/.test(c.trim()))) return false;
      return true;
    });

    if (dataRows.length === 0) {
      tableRows = [];
      inTable = false;
      return;
    }

    if (dataRows.length < 2) {
      dataRows.forEach(r => result.push(r.join(' | ')));
      tableRows = [];
      inTable = false;
      return;
    }

    const colCount = dataRows[0].length;
    const maxTotalWidth = 46;
    const maxCellW = Math.max(4, Math.floor((maxTotalWidth - (colCount - 1)) / colCount));

    const colWidths = [];
    dataRows.forEach(row => {
      row.forEach((cell, i) => {
        const len = Math.min(getDisplayWidth(cell), maxCellW);
        colWidths[i] = Math.max(colWidths[i] || 4, len);
      });
    });

    let totalW = colWidths.reduce((a, b) => a + b, 0) + (colCount - 1);
    if (totalW > maxTotalWidth) {
      const scale = maxTotalWidth / totalW;
      colWidths.forEach((w, i) => { colWidths[i] = Math.max(4, Math.floor(w * scale)); });
    }

    const truncatedRows = dataRows.map(row =>
      row.map((cell, i) => truncateToWidth(cell, colWidths[i] || 4))
    );

    const tableLines = [];

    tableLines.push('┌' + colWidths.map(w => '─'.repeat(w)).join('┬') + '┐');

    truncatedRows.forEach((row, rowIdx) => {
      const padded = row.map((cell, i) => padCell(cell, colWidths[i] || 4));
      tableLines.push('│' + padded.join('│') + '│');

      if (rowIdx === 0) {
        tableLines.push('├' + colWidths.map(w => '─'.repeat(w)).join('┼') + '┤');
      } else if (rowIdx < truncatedRows.length - 1) {
        tableLines.push('├' + colWidths.map(w => '─'.repeat(w)).join('┼') + '┤');
      }
    });

    tableLines.push('└' + colWidths.map(w => '─'.repeat(w)).join('┴') + '┘');

    result.push('```');
    tableLines.forEach(l => result.push(l));
    result.push('```');

    tableRows = [];
    inTable = false;
  }

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inTable) flushTable();
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    
    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    if (/^\|.*\|$/.test(line.trim()) && line.includes('|')) {
      if (!inTable) inTable = true;
      tableRows.push(line.trim());
    } else {
      if (inTable) flushTable();
      result.push(line);
    }
  }
  if (inTable) flushTable();
  return result.join('\n');
}

function getWecomCredentials() {
  const credMgr = getCredentialManager(DATA_DIR);
  return credMgr.getWecomCredentials();
}

function getApiToken() {
  const credMgr = getCredentialManager(DATA_DIR);
  return credMgr.getApiToken();
}

/**
 * 发送服务鉴权（S2）：/wecom/send* 端点必须携带与主 API 一致的 token
 * （X-Api-Key == .api_token）。调用方（wecom channel sendViaWebhook 等）已同步
 * 携带该头；无 token 时安全降级：一律拒绝。
 */
function _isAuthorized(req) {
  const headerKey = String(req.headers['x-api-key'] || req.headers['X-Api-Key'] || '');
  const expected = getApiToken();
  if (!expected || !headerKey || headerKey.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(headerKey), Buffer.from(expected));
  } catch (e) {
    console.warn('[wecom/send] 鉴权比较异常:', e.message);
    return false;
  }
}

/**
 * 发布 S-2b 安全: chatId 授权集——仅 user.wecomUserId + wecom.defaultChatId +
 * wecom.defaultUserId（DATA_DIR 配置）。LLM/本地调用者不可发任意人；
 * 不在集合一律 403（fail-closed：配置缺失即全拒）。
 * 2026-09-06: 并入群聊白名单（wecom-allowed-groups.json，服务端 group-router
 * 批准的群交互落盘，10 分钟窗口）——此前群 chatId 恒不在集合，群回复一律 403。
 */
function _rejectIfChatIdNotAllowed(res, chatId) {
  const allowed = loadAllowedChatIds(DATA_DIR);
  if (isAllowedChatId(chatId, allowed)) return false;
  const approvedGroups = loadApprovedGroupChats(DATA_DIR);
  if (isAllowedChatId(chatId, approvedGroups)) return false;
  console.warn('⛔ [wecom/send] 目标用户未授权，已拒绝:', chatId);
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: '目标用户未授权' }));
  return true;
}

let wsClient = null;
let isShuttingDown = false;
let sendServer = null;
let statusHeartbeat = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let rateLimitedUntil = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;
const RATE_LIMIT_COOLDOWN = 120000;

function updateWecomStatus(connected) {
  try {
    fs.writeFileSync(WECOM_STATUS_PATH, JSON.stringify({
      connected,
      timestamp: Date.now()
    }));
  } catch (e) {
    console.error('❌ Failed to write wecom status:', e.message);
  }
  if (connected && !statusHeartbeat) {
    statusHeartbeat = setInterval(() => {
      if (wsClient && wsClient.isConnected) {
        updateWecomStatus(true);
      }
    }, 60000);
  }
  if (!connected && statusHeartbeat) {
    clearInterval(statusHeartbeat);
    statusHeartbeat = null;
  }
}

async function sendToWebhook(event) {
  const postData = JSON.stringify(event);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  };
  const token = getApiToken();
  if (token) {
    headers['X-Api-Key'] = token;
  }

  const options = {
    hostname: 'localhost',
    port: API_PORT,
    path: '/webhook/wecom',
    method: 'POST',
    headers
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          console.error(`❌ webhook 返回错误: ${res.statusCode} ${data}`);
          reject(new Error(`webhook ${res.statusCode}: ${data}`));
        } else {
          console.log('✅ 事件已发送到 webhook');
          resolve(data);
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ 发送到 webhook 失败:', e.message);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

function getBufferKey(userId, event) {
  // 2026-09-06: 键含会话——此前只按用户，同一用户在多个群的消息会被跨群
  // 合并且 chatId 取首条，回复可能发错会话
  return event && event.chatId ? `${userId}:${event.chatId}` : userId;
}

function bufferMessage(userId, event) {
  const key = getBufferKey(userId, event);
  const now = Date.now();

  if (!messageBuffer.has(key)) {
    messageBuffer.set(key, { events: [], timer: null, sending: false });
  }

  const buf = messageBuffer.get(key);
  buf.events.push({ ...event, receivedAt: now });

  if (buf.timer) {
    clearTimeout(buf.timer);
  }

  const hasFile = buf.events.some(e => e.msgType === 'file' || e.msgType === 'image');
  const hasText = buf.events.some(e => e.msgType === 'text' || e.msgType === 'voice');
  const eventCount = buf.events.length;

  if (hasFile && hasText) {
    console.log(`🔗 检测到文件+文本消息组合，立即合并发送 (userId=${userId}, events=${eventCount})`);
    flushBuffer(key);
    return;
  }

  if (eventCount === 1) {
    const ttl = hasFile ? MESSAGE_BUFFER_TTL : 2000;
    console.log(`⏳ 消息已缓冲，等待可能的配对消息 (userId=${userId}, type=${event.msgType}, ttl=${ttl}ms)`);
    buf.timer = setTimeout(() => {
      console.log(`⏰ 缓冲超时，发送消息 (userId=${userId}, events=${buf.events.length})`);
      flushBuffer(key);
    }, ttl);
    return;
  }

  console.log(`⏳ 继续缓冲消息 (userId=${userId}, events=${eventCount})`);
  buf.timer = setTimeout(() => {
    flushBuffer(key);
  }, 1000);
}

const FLUSH_MAX_RETRIES = 3;

async function flushBuffer(key, retryCount = 0) {
  const buf = messageBuffer.get(key);
  if (!buf || buf.sending) return;

  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }

  if (buf.events.length === 0) {
    messageBuffer.delete(key);
    return;
  }

  // 2026-09-06: 先发送成功再出队——此前先 splice 后发送，webhook 失败仅打
  // 日志，主服务重启瞬间缓冲消息全丢。失败留队按退避重试，耗尽丢弃。
  const events = buf.events;
  const payload = events.length === 1 ? events[0] : mergeEvents(events);
  buf.sending = true;
  try {
    await sendToWebhook(payload);
    messageBuffer.delete(key);
  } catch (e) {
    if (retryCount + 1 < FLUSH_MAX_RETRIES) {
      console.error(`❌ 缓冲发送失败(${retryCount + 1}/${FLUSH_MAX_RETRIES}），${2 * (retryCount + 1)}s 后重试:`, e.message);
      buf.timer = setTimeout(() => flushBuffer(key, retryCount + 1), 2000 * (retryCount + 1));
    } else {
      console.error(`❌ 缓冲重试耗尽，丢弃 ${events.length} 条消息:`, e.message);
      messageBuffer.delete(key);
    }
  } finally {
    buf.sending = false;
  }
}

function mergeEvents(events) {
  const sorted = [...events].sort((a, b) => a.receivedAt - b.receivedAt);

  const base = { ...sorted[0] };
  delete base.receivedAt;

  const textParts = [];
  const fileInfoParts = [];
  let mergedFilePath = '';
  let mergedFileName = '';

  for (const evt of sorted) {
    if (evt.msgType === 'text' || evt.msgType === 'voice') {
      if (evt.content) textParts.push(evt.content);
    } else if (evt.msgType === 'file' || evt.msgType === 'image') {
      if (evt.filePath) {
        fileInfoParts.push(`文件: ${evt.fileName || 'unknown'}\n路径: ${evt.filePath}`);
        if (!mergedFilePath) mergedFilePath = evt.filePath;
        if (!mergedFileName) mergedFileName = evt.fileName || '';
      }
    }
  }

  let content = '';
  if (textParts.length > 0) {
    content = textParts.join('\n');
  }
  if (fileInfoParts.length > 0) {
    content += (content ? '\n\n' : '') + `[用户上传了以下文件]\n${fileInfoParts.join('\n')}\n\n请使用 DocRead 工具读取文件内容（参数 path 传入文件路径）。`;
  }

  if (!content) content = sorted[sorted.length - 1].content || '';

  base.content = content;
  base.msgType = 'text';
  if (mergedFilePath) {
    base.filePath = mergedFilePath;
    base.fileName = mergedFileName;
  }

  return base;
}

function startSendServer() {
  sendServer = http.createServer((req, res) => {
    // 2026-08-07 (S2 安全): /wecom/send* 全部端点统一鉴权——此前零鉴权，
    // 本机任意进程/网页可盲发企微消息。未授权一律 401。
    if (req.method === 'POST' && req.url && req.url.startsWith('/wecom/send')) {
      if (!_isAuthorized(req)) {
        console.warn('⛔ [wecom/send] 未授权发送请求已拒绝:', req.url);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }
    }

    if (req.method === 'POST' && req.url === '/wecom/send') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          // eslint-disable-next-line no-unused-vars
          const { chat_id, msg_type, content, chat_type } = JSON.parse(body);
          // 发布 S-2b: chatId 授权集校验（先于可用性检查——授权优先）
          if (_rejectIfChatIdNotAllowed(res, chat_id)) return;
          if (!wsClient || !wsClient.isConnected) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'WebSocket not connected' }));
            return;
          }

          let targetId = chat_id;

          let msgtype = msg_type || 'markdown';
          if (msgtype === 'text') {
            msgtype = 'markdown';
          }
          let sendContent = content;
          console.log(`📋 发送内容预览 (前500字符): ${content.substring(0, 500)}`);
          const msgBody = {};
          msgBody[msgtype] = { content: sendContent };

          wsClient.sendMessage(targetId, {
            msgtype: msgtype,
            ...msgBody
          }).then(() => {
            console.log(`📤 已发送消息到企业微信: ${targetId} (type=${msgtype})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          }).catch((err) => {
            const errMsg = err?.errmsg || err?.message || String(err);
            const errCode = err?.errcode || 'unknown';
            console.error(`❌ 发送消息失败: errcode=${errCode}, errmsg=${errMsg}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: errMsg, errcode: errCode }));
          });
        } catch (e) {
          console.error('❌ 发送服务处理异常:', e.message, e.stack);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/wecom/send-image') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // eslint-disable-next-line no-unused-vars
          const { chat_id, file_path, chat_type } = JSON.parse(body);
          // 发布 S-2b: chatId 授权集校验（先于可用性检查——授权优先）
          if (_rejectIfChatIdNotAllowed(res, chat_id)) return;
          if (!wsClient || !wsClient.isConnected) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'WebSocket not connected' }));
            return;
          }

          if (!file_path || !fs.existsSync(file_path)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Image file not found: ${file_path}` }));
            return;
          }

          const imageBuffer = fs.readFileSync(file_path);
          const fileName = path.basename(file_path);
          console.log(`📤 上传图片到企业微信: ${fileName} (${imageBuffer.length} bytes)`);

          const uploadResult = await wsClient.uploadMedia(imageBuffer, {
            type: 'image',
            filename: fileName
          });

          const mediaId = uploadResult.media_id;
          console.log(`📤 图片上传成功，media_id: ${mediaId}，正在发送...`);

          await wsClient.sendMediaMessage(chat_id, 'image', mediaId);

          console.log(`✅ 图片已发送到企业微信: ${chat_id}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, media_id: mediaId }));
        } catch (e) {
          console.error('❌ 发送图片到企业微信失败:', e.message, e.stack);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/wecom/send-video') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // eslint-disable-next-line no-unused-vars
          const { chat_id, file_path, chat_type, title, description } = JSON.parse(body);
          // 发布 S-2b: chatId 授权集校验（先于可用性检查——授权优先）
          if (_rejectIfChatIdNotAllowed(res, chat_id)) return;
          if (!wsClient || !wsClient.isConnected) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'WebSocket not connected' }));
            return;
          }

          if (!file_path || !fs.existsSync(file_path)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Video file not found: ${file_path}` }));
            return;
          }

          const videoBuffer = fs.readFileSync(file_path);
          const fileName = path.basename(file_path);
          const fileSizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
          console.log(`📤 上传视频到企业微信: ${fileName} (${fileSizeMB} MB)`);

          if (videoBuffer.length > 50 * 1024 * 1024) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `视频文件过大: ${fileSizeMB}MB，企业微信限制 50MB` }));
            return;
          }

          const uploadResult = await wsClient.uploadMedia(videoBuffer, {
            type: 'video',
            filename: fileName
          });

          const mediaId = uploadResult.media_id;
          console.log(`📤 视频上传成功，media_id: ${mediaId}，正在发送...`);

          const videoOptions = {};
          if (title) videoOptions.title = title;
          if (description) videoOptions.description = description;

          await wsClient.sendMediaMessage(chat_id, 'video', mediaId, videoOptions);

          console.log(`✅ 视频已发送到企业微信: ${chat_id}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, media_id: mediaId }));
        } catch (e) {
          console.error('❌ 发送视频到企业微信失败:', e.message, e.stack);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/wecom/send-file') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          // eslint-disable-next-line no-unused-vars
          const { chat_id, file_path, chat_type } = JSON.parse(body);
          // 发布 S-2b: chatId 授权集校验（先于可用性检查——授权优先）
          if (_rejectIfChatIdNotAllowed(res, chat_id)) return;
          if (!wsClient || !wsClient.isConnected) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'WebSocket not connected' }));
            return;
          }

          if (!file_path || !fs.existsSync(file_path)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `File not found: ${file_path}` }));
            return;
          }

          const fileBuffer = fs.readFileSync(file_path);
          const fileName = path.basename(file_path);
          const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(1);
          console.log(`📤 上传文件到企业微信: ${fileName} (${fileSizeMB} MB)`);

          if (fileBuffer.length > 50 * 1024 * 1024) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `文件过大: ${fileSizeMB}MB，企业微信限制 50MB` }));
            return;
          }

          const uploadResult = await wsClient.uploadMedia(fileBuffer, {
            type: 'file',
            filename: fileName
          });

          const mediaId = uploadResult.media_id;
          console.log(`📤 文件上传成功，media_id: ${mediaId}，正在发送...`);

          await wsClient.sendMediaMessage(chat_id, 'file', mediaId);

          console.log(`✅ 文件已发送到企业微信: ${chat_id}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, media_id: mediaId }));
        } catch (e) {
          console.error('❌ 发送文件到企业微信失败:', e.message, e.stack);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // 发布 S-2b: 仅监听回环——send 服务只服务本机调用方（wecom channel/file-tools/代理），
  // 不再暴露 0.0.0.0（局域网任意主机可触达的盲发面收口）。
  sendServer.listen(SEND_PORT, '127.0.0.1', () => {
    console.log(`✅ 企业微信消息发送服务启动，监听 127.0.0.1:${SEND_PORT}`);
    try {
      fs.writeFileSync(WECOM_SEND_PORT_PATH, SEND_PORT.toString());
    } catch (e) { console.warn('写入发送端口文件失败:', e.message) }
  });

  sendServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`⚠️ 端口 ${SEND_PORT} 已被占用`);
    }
  });
}

async function downloadAndSaveFile(url, aesKey, prefix) {
  if (!url || !wsClient.downloadFile) {
    return { savedFilePath: '', fileName: '' };
  }

  try {
    const { buffer, filename } = await wsClient.downloadFile(url, aesKey);
    const fileName = filename || `${prefix}_${Date.now()}`;
    const uploadDir = path.join(WORKSPACE_DIR, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    const savedFilePath = path.join(uploadDir, fileName);
    fs.writeFileSync(savedFilePath, buffer);
    console.log(`📁 文件已保存: ${savedFilePath} (${buffer.length} bytes)`);
    return { savedFilePath, fileName };
  } catch (dlErr) {
    console.error('❌ 下载文件失败:', dlErr.message);
    return { savedFilePath: '', fileName: '' };
  }
}

function startWecomClient() {
  if (isShuttingDown) return;

  if (Date.now() < rateLimitedUntil) {
    const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
    console.log(`🚫 API 限流期中，跳过连接，还需等待 ${remaining} 秒`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (!isShuttingDown) startWecomClient();
    }, rateLimitedUntil - Date.now() + 5000);
    return;
  }

  const { botId, secret } = getWecomCredentials();

  if (!botId || !secret) {
    console.warn('⚠️ 企业微信未配置 Bot ID 或 Secret，跳过启动');
    updateWecomStatus(false);
    return;
  }

  console.log(`🔌 启动企业微信 WebSocket 连接... Bot ID: ${botId.substring(0, 8)}****`);

  wsClient = new AiBot.WSClient({
    botId: botId,
    secret: secret
  });

  wsClient.on('authenticated', () => {
    console.log('✅ 企业微信认证成功');
    updateWecomStatus(true);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  wsClient.on('disconnected', (reason) => {
    console.log(`⚠️ 企业微信连接断开: ${reason || '未知原因'}`);
    updateWecomStatus(false);
    
    const isRateLimited = String(reason).includes('45009') || String(reason).includes('freq out of limit');
    if (isRateLimited) {
      rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN;
      console.log(`🚫 API 限流中，将在 ${RATE_LIMIT_COOLDOWN/1000} 秒后尝试重连`);
    }

    if (!isShuttingDown && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      let delay;
      if (isRateLimited || Date.now() < rateLimitedUntil) {
        delay = RATE_LIMIT_COOLDOWN;
        reconnectAttempts = Math.max(reconnectAttempts, 1);
      } else {
        delay = RECONNECT_DELAY * Math.min(reconnectAttempts + 1, 5);
      }
      reconnectAttempts++;
      console.log(`🔄 将在 ${delay/1000} 秒后尝试重连 (第 ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} 次)...`);
      
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (!isShuttingDown && (!wsClient || !wsClient.isConnected)) {
          if (Date.now() < rateLimitedUntil) {
            const remaining = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
            console.log(`🚫 仍在限流期，还需等待 ${remaining} 秒`);
            reconnectAttempts--;
            const waitMore = rateLimitedUntil - Date.now() + 5000;
            reconnectTimer = setTimeout(() => {
              if (!isShuttingDown) startWecomClient();
            }, waitMore);
            return;
          }
          console.log('🔌 尝试重新连接企业微信...');
          startWecomClient();
        }
      }, delay);
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`❌ 已达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，停止重连`);
    }
  });

  wsClient.on('message.text', async (frame) => {
    try {
      const content = frame.body?.text?.content || '';
      const fromUserId = frame.body?.from?.userid || '';
      const chatId = frame.body?.chatid || fromUserId;
      const chatType = frame.body?.chattype || 'single';
      const msgId = frame.body?.msgid || '';

      console.log(`📨 收到企业微信文本消息: from=${fromUserId}, chat=${chatId}, content=${content.substring(0, 100)}`);
      updateWecomStatus(true);

      const event = {
        msgType: 'text',
        content: content,
        fromUserId: fromUserId,
        chatId: chatId,
        chatType: chatType,
        msgId: msgId,
        timestamp: Date.now(),
        rawBody: frame.body,
        replyFrame: null
      };

      bufferMessage(fromUserId, event);
    } catch (e) {
      console.error('❌ 处理文本消息失败:', e.message);
    }
  });

  wsClient.on('message.image', async (frame) => {
    try {
      const fromUserId = frame.body?.from?.userid || '';
      const chatId = frame.body?.chatid || fromUserId;
      const msgId = frame.body?.msgid || '';
      const imageUrl = frame.body?.image?.url || '';
      const aesKey = frame.body?.image?.aeskey || '';

      console.log(`📨 收到企业微信图片消息: from=${fromUserId}`);
      updateWecomStatus(true);

      const { savedFilePath, fileName } = await downloadAndSaveFile(imageUrl, aesKey, 'wecom_image');

      const event = {
        msgType: 'image',
        content: savedFilePath ? `[图片已保存: ${savedFilePath}]` : '[图片]',
        fromUserId: fromUserId,
        chatId: chatId,
        chatType: frame.body?.chattype || 'single',
        msgId: msgId,
        timestamp: Date.now(),
        rawBody: frame.body,
        filePath: savedFilePath,
        fileName: fileName || `wecom_image_${Date.now()}.jpg`
      };

      bufferMessage(fromUserId, event);
    } catch (e) {
      console.error('❌ 处理图片消息失败:', e.message);
    }
  });

  wsClient.on('message.file', async (frame) => {
    try {
      const fromUserId = frame.body?.from?.userid || '';
      const chatId = frame.body?.chatid || fromUserId;
      const msgId = frame.body?.msgid || '';
      const fileUrl = frame.body?.file?.url || '';
      const aesKey = frame.body?.file?.aeskey || '';

      console.log(`📨 收到企业微信文件消息: from=${fromUserId}, url=${fileUrl ? '有' : '无'}`);
      updateWecomStatus(true);

      const { savedFilePath, fileName } = await downloadAndSaveFile(fileUrl, aesKey, 'wecom_file');

      const event = {
        msgType: 'file',
        content: savedFilePath ? `用户发送了文件: ${fileName}\n文件路径: ${savedFilePath}` : '[文件下载失败]',
        fromUserId: fromUserId,
        chatId: chatId,
        chatType: frame.body?.chattype || 'single',
        msgId: msgId,
        timestamp: Date.now(),
        rawBody: frame.body,
        filePath: savedFilePath,
        fileName: fileName || 'unknown_file'
      };

      bufferMessage(fromUserId, event);
    } catch (e) {
      console.error('❌ 处理文件消息失败:', e.message);
    }
  });

  wsClient.on('message.voice', async (frame) => {
    try {
      const fromUserId = frame.body?.from?.userid || '';
      const chatId = frame.body?.chatid || fromUserId;
      const msgId = frame.body?.msgid || '';
      const voiceContent = frame.body?.voice?.content || '';

      console.log(`📨 收到企业微信语音消息: from=${fromUserId}`);
      updateWecomStatus(true);

      const event = {
        msgType: 'voice',
        content: voiceContent || '[语音消息]',
        fromUserId: fromUserId,
        chatId: chatId,
        chatType: frame.body?.chattype || 'single',
        msgId: msgId,
        timestamp: Date.now(),
        rawBody: frame.body
      };

      bufferMessage(fromUserId, event);
    } catch (e) {
      console.error('❌ 处理语音消息失败:', e.message);
    }
  });

  wsClient.on('event.enter_chat', async (frame) => {
    const fromUserId = frame.body?.from?.userid || '';

    console.log(`👋 用户进入会话: ${fromUserId}`);
    updateWecomStatus(true);

    try {
      wsClient.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: '你好！我是智能助手，有什么可以帮你的吗？' }
      });
    } catch (e) { console.warn('发送欢迎消息失败:', e.message) }
  });

  wsClient.connect();

  console.log('🔌 企业微信 WebSocket 连接已发起');
}

function shutdown() {
  console.log('\n👋 正在关闭...');
  isShuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (statusHeartbeat) {
    clearInterval(statusHeartbeat);
    statusHeartbeat = null;
  }
  // eslint-disable-next-line no-unused-vars
  for (const [key, buf] of messageBuffer) {
    if (buf.timer) clearTimeout(buf.timer);
  }
  messageBuffer.clear();
  if (wsClient) {
    try { wsClient.disconnect(); } catch (e) {
      /* 关闭时忽略断开错误 */
      console.warn('[event-bridge.js] 空 catch 补日志:', e && e.message);
    }

  }
  if (sendServer) sendServer.close();
  updateWecomStatus(false);
  try { fs.unlinkSync(WECOM_SEND_PORT_PATH); } catch (e) {
    /* 关闭时清理，忽略 */
    console.warn('[event-bridge.js] 空 catch 补日志:', e && e.message);
  }

  try { fs.unlinkSync(PID_FILE_PATH); } catch (e) {
    /* 关闭时清理，忽略 */
    console.warn('[event-bridge.js] 空 catch 补日志:', e && e.message);
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason, _promise) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason);
  // 确保异常退出时更新状态文件
  updateWecomStatus(false);
});

process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED')) {
    return;
  }
  console.error('❌ 未捕获的异常:', err.message, err.stack);
  // 确保异常退出时更新状态文件
  updateWecomStatus(false);
  // 延迟退出，确保状态文件写入完成
  setTimeout(() => process.exit(1), 500);
});

startSendServer();
startWecomClient();
