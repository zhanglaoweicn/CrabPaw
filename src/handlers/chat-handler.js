const crypto = require('crypto');
const path = require('path');

const { readRequestBody, readJsonBody, sendError, sendJson } = require('./http-utils');

const { broadcastEvent } = require('../core/sse-broadcast');
// AG-UI 双名映射适配层(2026-08-14 GUI 全量修复 P1, 参考 D:/Down/ag-ui-main)——resume 翻译/流内双写
const aguiAdapter = require('../core/agui-adapter');
const { buildWecomMessagePayload } = require('./wecom-payload');
const { globalActivityStream } = require('../core/activity-stream');
const { getConversationIntegration } = require('../core/taskflow-conversation-integration');

const { executeCommand } = require('../core/commands');
const commandsIndex = require('../core/commands-index');
const { execSync: _execSync } = require('child_process');
const { getIntentAnalyzer } = require('../taskflow/intent-analyzer');
const { IMAGE_GEN_TASKS } = require('../tools/image-tools');
const { VIDEO_GEN_TASKS } = require('../tools/video-tools');

const { extractDocxText, extractXlsxData, extractPdfText } = require('../tools/document-tools');

const _recentSentMessages = new Map();
const _LOOP_DETECTION_WINDOW = 30000;
const _LOOP_MAX_SAME_CONTENT = 2;
const _userMessageQueues = new Map();

// ── 渠道回调验签辅助（S1）────────────────────────────────────────────
// 公开路由 /webhook、/webhook/wecom 在 authMiddleware 层放行（外部平台回调无法带
// 本机 API token），因此必须在 handler 层完成来源验签后才允许进入消息流水线。

function _getWebhookDataDir() {
  return process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', 'data', '.crabpaw');
}

/** 主 API token（与 request-handler getApiKey 同源：env ADMIN_API_KEY > .api_token） */
function _getApiKey() {
  if (process.env.ADMIN_API_KEY) return process.env.ADMIN_API_KEY;
  const tokenPath = path.join(_getWebhookDataDir(), '.api_token');
  try {
    const raw = require('fs').readFileSync(tokenPath, 'utf-8').trim();
    if (raw) return raw;
  } catch (e) { console.debug('[chat-handler] .api_token 读取失败(未配置):', e?.message || e); }
  return '';
}

/** 读取磁盘最新渠道配置（与 handleStatus 同款模式，避免内存配置过期） */
function _getDiskConfig(ctx) {
  try {
    if (ctx && ctx.config && typeof ctx.config.loadConfig === 'function') {
      return ctx.config.loadConfig();
    }
  } catch (e) { console.warn('[webhook] 读取磁盘配置失败，回退 appConfig:', e.message); }
  return (ctx && ctx.appConfig) || {};
}

/** 常量时间字符串比较（防时序攻击） */
function _safeEqual(a, b) {
  const A = String(a || '');
  const B = String(b || '');
  if (A.length !== B.length || A.length === 0) return false;
  return crypto.timingSafeEqual(Buffer.from(A), Buffer.from(B));
}

/**
 * 飞书回调 token 校验：事件体带 "token" 字段（url_verification 与 v1 事件在顶层，
 * v2 事件在 header.token）。
 * 未配置 verificationToken 时安全降级：直接拒绝（401），不跳过校验。
 * TODO(security): 配置 encrypt_key 时飞书回传密文（body.encrypt），需先按飞书规范
 * AES-256-CBC 解密（key=encryptKey, iv=前16字节）再校验内部 token——解密为后续项，
 * 当前对加密回调一律拒绝并在日志中提示。
 */
function _verifyLarkCallback(ctx, data) {
  const diskConfig = _getDiskConfig(ctx);
  const verificationToken = (diskConfig.lark && diskConfig.lark.verificationToken)
    || process.env.LARK_VERIFICATION_TOKEN || '';
  const encryptKey = (diskConfig.lark && diskConfig.lark.encryptKey)
    || process.env.LARK_ENCRYPT_KEY || '';

  if (data && data.encrypt) {
    console.warn('[webhook] 飞书加密回调（encrypt_key）暂不支持，已拒绝——需先配置并实现 AES 解密');
    return false;
  }
  if (encryptKey) {
    // 配置了 encryptKey 但回调未加密——按飞书规范属异常形态，拒绝
    console.warn('[webhook] 已配置 encrypt_key 但回调未携带加密负载，已拒绝');
    return false;
  }
  if (!verificationToken) {
    console.warn('[webhook] 未配置 lark.verificationToken，拒绝飞书回调（安全降级）——请在配置中填写飞书事件订阅的 Verification Token');
    return false;
  }
  const bodyToken = (data && (data.token || (data.header && data.header.token))) || '';
  if (!_safeEqual(bodyToken, verificationToken)) {
    console.warn('[webhook] 飞书回调 token 校验失败（可能为伪造请求）');
    return false;
  }
  return true;
}

/**
 * 企业微信回调签名校验（官方算法，与 @wecom/aibot-node-sdk WecomCrypto.computeSignature 一致）：
 * msg_signature = sha1( sort([token, timestamp, nonce, encrypt]).join('') )
 * - query 参数: msg_signature / timestamp / nonce；encrypt 为回调体中的密文字段
 * - 未配置企微签名 token 时安全降级：直接拒绝（401），不跳过校验
 */
function _verifyWecomCallbackSignature(query, encryptText, token) {
  const get = (k) => (typeof query.get === 'function' ? query.get(k) : query[k]);
  const msgSignature = String(get('msg_signature') || '');
  const timestamp = String(get('timestamp') || '');
  const nonce = String(get('nonce') || '');
  if (!msgSignature || !timestamp || !nonce || !encryptText) return false;
  const raw = [token, timestamp, nonce, String(encryptText)].sort().join('');
  const signature = crypto.createHash('sha1').update(raw).digest('hex');
  return _safeEqual(signature, msgSignature.toLowerCase());
}

/**
 * 企微回调鉴权（S1）：
 * 1) 本地桥接器（event-bridge）携带 X-Api-Key（.api_token）转发解析后的事件 → 校验 API token
 * 2) 企微平台直连回调 → 校验 query 的 msg_signature（token 取自配置 wecom.token）
 * 3) 两者皆无/皆不通过 → 401 拒绝
 */
function _authorizeWecomCallback(ctx, req, body) {
  const headerKey = String(req.headers['x-api-key'] || req.headers['X-Api-Key'] || '');
  if (headerKey && _safeEqual(headerKey, _getApiKey())) {
    return { ok: true };
  }
  const diskConfig = _getDiskConfig(ctx);
  const wecomToken = (diskConfig.wecom && diskConfig.wecom.token) || process.env.WECOM_TOKEN || '';
  const searchParams = (ctx && ctx.url && ctx.url.searchParams) ? ctx.url.searchParams : new URL(req.url, 'http://localhost').searchParams;
  if (!wecomToken) {
    console.warn('[webhook] 企微回调缺少签名 token 配置（wecom.token），已拒绝（安全降级）');
    return { ok: false, reason: '未配置 wecom.token，无法验签' };
  }
  // 企微回调密文: body.encrypt（POST 回调）；URL 验证时用 query.echostr
  const encryptText = (body && body.encrypt) || String(searchParams.get('echostr') || '');
  if (_verifyWecomCallbackSignature(searchParams, encryptText, wecomToken)) {
    return { ok: true };
  }
  console.warn('[webhook] 企微回调 msg_signature 校验失败（可能为伪造请求）');
  return { ok: false, reason: 'msg_signature 校验失败' };
}

// 流空闲超时：如果 Provider 超过该时长未发送任何数据，强制重试
// 2026-08-06: 45s→120s——多工具长任务(写文章/调研)的工具调用间隔可能>45s，
// 原值导致请求被中断(实测"写OPC文章"60s超时aborted)。

const STREAM_IDLE_TIMEOUT_MS = 120000;

// 2026-09-06: 通道消息去重——飞书事件为 at-least-once 投递（断线重放/超时重试），
// 企微桥重试同理；复用 wecom MessageDeduplicator（msgId 优先，缺则分钟桶+内容）。
let _channelDedup = null;
function getChannelDedup() {
  if (!_channelDedup) {
    const { MessageDeduplicator } = require('../channels/wecom/message-dedup');
    _channelDedup = new MessageDeduplicator({ ttl: 10 * 60 * 1000, maxEntries: 5000 });
    _channelDedup.start();
  }
  return _channelDedup;
}

// 2026-09-06: 通道来源登记——异步任务（workflow）完成回推的匹配依据。
// 通道消息处理时登记 userId→会话（2h TTL）；任务完成事件带 userId 命中
// 即向来源会话推一条完成摘要。纯旁路，不改任务记录结构。
const _recentChannelChats = new Map(); // userId -> { channelType, chatId, ts }
const CHANNEL_CHAT_TTL_MS = 2 * 60 * 60 * 1000;
function recordChannelChat(userId, channelType, chatId) {
  if (!userId) return;
  _recentChannelChats.set(String(userId), { channelType, chatId: String(chatId || ''), ts: Date.now() });
  // 顺手清理过期项
  for (const [k, v] of _recentChannelChats) {
    if (Date.now() - v.ts > CHANNEL_CHAT_TTL_MS) _recentChannelChats.delete(k);
  }
}

async function handleWorkflowComplete(data, channelCtx) {
  try {
    if (!channelCtx) return;
    const userId = String(data?.userId || data?.ownerId || data?.initiator || '');
    if (!userId) return;
    const entry = _recentChannelChats.get(userId);
    if (!entry || Date.now() - entry.ts > CHANNEL_CHAT_TTL_MS) return;
    const name = data?.flowName || data?.name || data?.workflowName || data?.title || '异步任务';
    const text = `✅ ${name} 已完成。`;
    if (entry.channelType === 'wecom' && channelCtx.wecom && typeof channelCtx.wecom.isConfigured === 'function' && channelCtx.wecom.isConfigured()) {
      const target = entry.chatId || channelCtx.appConfig?.wecom?.defaultChatId || userId;
      const sendFn = typeof channelCtx.wecom.sendSmart === 'function' ? channelCtx.wecom.sendSmart.bind(channelCtx.wecom) : channelCtx.wecom.send.bind(channelCtx.wecom);
      await sendFn(target, text, 'single', {});
    } else if (entry.channelType === 'lark' && channelCtx.lark && typeof channelCtx.lark.isConfigured === 'function' && channelCtx.lark.isConfigured()) {
      const target = entry.chatId || userId;
      await channelCtx.lark.send(target, text);
    }
  } catch (e) {
    console.warn('[channel-pushback] 任务完成回推失败:', e.message);
  }
}

function _enqueueUserMessage(userId, fn) {
 const prev = _userMessageQueues.get(userId) || Promise.resolve();
 const next = prev.then(fn, fn);
 _userMessageQueues.set(userId, next);
 return next;
}

function _convertMarkdownTablesToList(text) {
 if (!text) return text;
 
 const tableRegex = /\|[^\n]+\|\n\|[-\s|:]+\|\n((\|[^\n]+\|\n?)+)/g;
 
 return text.replace(tableRegex, (match) => {
 const lines = match.trim().split('\n');
 if (lines.length < 2) return match;
 
 const headerLine = lines[0];
 const headers = headerLine.split('|').filter(h => h.trim()).map(h => h.trim());
 
 const dataLines = lines.slice(2).filter(line => line.trim() && line.includes('|'));
 
 let result = '';
 dataLines.forEach((line, idx) => {
 const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
 if (cells.length > 0) {
 result += `**${idx + 1}.** `;
 cells.forEach((cell, cellIdx) => {
 const headerName = headers[cellIdx] || `列${cellIdx + 1}`;
 result += `${headerName}: ${cell}`;
 if (cellIdx < cells.length - 1) result += ' | ';
 });
 result += '\n';
 }
 });
 
 return result;
 });
}

function convertDataListsToTable(text) {
 if (!text) return text;

 const lines = text.split('\n');
 const result = [];

 let i = 0;
 
 while (i < lines.length) {
 const line = lines[i];
 
 const bulletPattern = /^[•\-*]\s+(.+)$/;
 const match = line.match(bulletPattern);
 
 if (match) {
 const dataLines = [];
 let j = i;
 
 while (j < lines.length) {
 const currentMatch = lines[j].match(bulletPattern);
 if (currentMatch) {
 dataLines.push(currentMatch[1]);
 j++;
 } else if (lines[j].trim() === '') {
 j++;
 break;
 } else {
 break;
 }
 }
 
 if (dataLines.length >= 2) {
 const parsed = dataLines.map(dl => parseDataLine(dl)).filter(p => p.length >= 2);
 
 if (parsed.length >= 2) {
 const maxCols = Math.max(...parsed.map(p => p.length));
 
 if (maxCols >= 2) {
 const headers = inferHeaders(parsed, maxCols);
 
 let table = '';
 table += '| ' + headers.join(' | ') + ' |\n';
 table += '| ' + headers.map(() => '------').join(' | ') + ' |\n';
 
 for (const row of parsed) {
 while (row.length < maxCols) row.push('-');
 table += '| ' + row.join(' | ') + ' |\n';
 }
 
 result.push(table.trimEnd());
 i = j;
 continue;
 }
 }
 }
 
 result.push(line);
 i++;
 } else {
 result.push(line);
 i++;
 }
 }
 
 return result.join('\n');
}

function parseDataLine(dl) {
 const parts = [];
 
 let namePart = '';
 let restPart = dl;
 
 const dashSeps = [' = ', ' \u2014 ', ' \u2013 ', ' - ', ': ', ' | ', '\uff0c', ','];
 let splitIdx = -1;
 let splitSep = '';
 
 for (const sep of dashSeps) {
 const idx = restPart.indexOf(sep);
 if (idx !== -1) {
 splitIdx = idx;
 splitSep = sep;
 break;
 }
 }
 
 if (splitIdx !== -1) {
 namePart = restPart.substring(0, splitIdx).trim();
 restPart = restPart.substring(splitIdx + splitSep.length).trim();
 } else {
 namePart = restPart;
 restPart = '';
 }
 
 const quantityMatch = namePart.match(/^(.+?)\s*\u00d7(\d+[^\s]*?)$/);
 if (quantityMatch) {
 parts.push(quantityMatch[1].trim());
 parts.push('\u00d7' + quantityMatch[2].trim());
 } else {
 parts.push(namePart);
 }
 
 if (restPart) {
 parts.push(restPart);
 }
 
 return parts;
}

function inferHeaders(parsed, maxCols) {
 const hasPrice = parsed.some(row => row.some(cell => /[¥￥$]/.test(cell)));
 const hasQuantity = parsed.some(row => row.some(cell => /^\u00d7\d+/.test(cell)));
 // (removed dead hasUnit check — result never consumed)
 
 if (maxCols === 4 && hasPrice && hasQuantity) {
 return ['项目', '数量', '单价', '金额'];
 }
 if (maxCols === 3 && hasPrice && hasQuantity) {
 return ['项目', '数量', '金额'];
 }
 if (maxCols === 3 && hasPrice) {
 return ['项目', '详情', '金额'];
 }
 if (maxCols === 3) {
 return ['项目', '属性1', '属性2'];
 }
 if (maxCols === 2 && hasPrice) {
 return ['项目', '金额'];
 }
 if (maxCols === 2) {
 return ['项目', '详情'];
 }
 return Array.from({ length: maxCols }, (_, i) => `列${i + 1}`);
}

/**
 * 2026-08-13 P2-2: 运行摘要(run digest)——从 ActivityStream 过滤同 roundId 的
 * 活动摘要拼接,供 RunStore 快照记录"这轮做了什么"。
 */
function runDigestFor(userId, roundId) {
 try {
  if (!roundId) return '';
  const { globalActivityStream } = require('./activity-stream');
  const activities = (globalActivityStream.activities || globalActivityStream.getRecent?.(100) || [])
   .filter((a) => a && a.roundId === roundId && a.summary)
   .map((a) => a.summary)
   .slice(0, 12)
   .join(' | ');
  return activities || '';
 } catch (e) {
  return '';
 }
}

// 轻量标签剥离：仅移除内部 XML/DSML 标签，保留所有用户可见内容
function stripToolTagsOnly(text) {
 if (!text) return text;
 let cleaned = text;
 cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '');
 cleaned = cleaned.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/g, '');
 cleaned = cleaned.replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/g, '');
 cleaned = cleaned.replace(/<\/?(?:function_calls|invoke|parameter)[^>]*>/g, '');
 cleaned = cleaned.replace(/<\/?[\s｜]*DSML[\s｜]*[^>]*>/gi, '');
 cleaned = cleaned.replace(/<\/?[\s｜]*tool_calls[\s｜]*[^>]*>/gi, '');
 cleaned = cleaned.replace(/<\/?[\s｜]*invoke[\s｜]*[^>]*>/gi, '');
 cleaned = cleaned.replace(/<\/?[\s｜]*parameter[\s｜]*[^>]*>/gi, '');
 cleaned = cleaned.replace(/<\/?[^>]*[｜]{2}[^>]*[｜]{2}[^>]*>/g, '');
 cleaned = cleaned.replace(/<\/?[^>]*[｜][^>]*>/g, '');
 cleaned = cleaned.replace(/<[a-zA-Z_][\w:]*(?:\s+[^>]*)?\/>/g, '');
 cleaned = cleaned.replace(/\[\s*\{[\s\S]*?"content"[\s\S]*?"status"[\s\S]*?\}\s*\]/g, '');
 cleaned = cleaned.replace(/\[\s*\{[\s\S]*?"id"[\s\S]*?"priority"[\s\S]*?\}\s*\]/g, '');
 cleaned = cleaned.replace(/\[\s*\{[\s\S]*?\}\s*\]/g, (match) => {
 if (match.includes('"tool"') || match.includes('"name"') || match.includes('"function"')) return '';
 return match;
 });
 return cleaned;
}
function cleanReplyForUser(text, forWecom = false) {
 if (!text) return text;
 let cleaned = text;
 // Strip LLM XML tool-call tags from visible output
 cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '');
 cleaned = cleaned.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/g, '');
 cleaned = cleaned.replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/g, '');
 cleaned = cleaned.replace(/<\/?(?:function_calls|invoke|parameter)[^>]*>/g, '');
 // Strip DSML-style tags (e.g. </｜｜DSML｜｜invoke>, </｜｜DSML｜｜tool_calls>)
 cleaned = cleaned.replace(/<\/?[\s｜]*DSML[\s｜]*[^>]*>/gi, '');
 cleaned = cleaned.replace(/<\/?[\s｜]*tool_calls[\s｜]*[^>]*>/gi, '');
 cleaned = cleaned.replace(/<\/?[\s｜]*invoke[\s｜]*[^>]*>/gi, '');
 cleaned = cleaned.replace(/<\/?[\s｜]*parameter[\s｜]*[^>]*>/gi, '');
 // Strip any remaining DSML-like tags with ｜ separators
 cleaned = cleaned.replace(/<\/?[^>]*［［[^>]*］］[^>]*>/g, '');
 cleaned = cleaned.replace(/<\/?[^>]*｜｜[^>]*>/g, '');
 cleaned = cleaned.replace(/<[a-zA-Z_][\w:]*(?:\s+[^>]*)?\/>/g, '');
 cleaned = cleaned.replace(/\[\s*\{[\s\S]*?"content"[\s\S]*?"status"[\s\S]*?\}\s*\]/g, '');
 cleaned = cleaned.replace(/\[\s*\{[\s\S]*?"id"[\s\S]*?"priority"[\s\S]*?\}\s*\]/g, '');
 cleaned = cleaned.replace(/\[\s*\{[\s\S]*?\}\s*\]/g, (match) => {
 if (match.includes('"tool"') || match.includes('"name"') || match.includes('"function"')) {
 return '';
 }
 return match;
 });
 if (!forWecom) {
 cleaned = cleaned.replace(/```[\s\S]*?```/g, (match) => {
 const lines = match.split('\n');
 if (lines.length <= 3 && !match.includes('|') && !match.includes('─')) return '';
 return match;
 });
 
 cleaned = convertDataListsToTable(cleaned);
 
 cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
 }
 return cleaned.trim();
}

async function extractFileContent(filePath) {
 if (!filePath || !require('fs').existsSync(filePath)) return null;
 const fs = require('fs');
 const ext = filePath.split('.').pop().toLowerCase();

 // 纯文本文件直接读取
 if (['txt', 'md', 'csv', 'json', 'xml', 'html', 'css', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'sh', 'yaml', 'yml', 'ini', 'conf', 'log', 'sql'].includes(ext)) {
 return fs.readFileSync(filePath, 'utf-8');
 }

 // DOCX: Node.js 原生 ZIP+XML 解析
 if (['docx', 'doc'].includes(ext)) {
 try {
 return await extractDocxText(filePath);
 } catch (e) {
 console.warn(`⚠️ DOCX 解析失败:`, e.message?.substring(0, 200));
 return null;
 }
 }

 // XLSX/XLS: exceljs 解析
 if (ext === 'xlsx' || ext === 'xls') {
 try {
 const data = await extractXlsxData(filePath);
 if (data.error) { console.warn(`⚠️ XLSX 解析失败:`, data.error); return null; }
 // 格式化为表格文本
 let output = '';
 for (const sheet of data.sheets) {
 output += `## 工作表: ${sheet.name} (${sheet.rowCount}行)\n\n`;
 if (sheet.rows && sheet.rows.length > 0) {
 // 表头
 const headers = sheet.rows[0];
 output += '| ' + headers.join(' | ') + ' |\n';
 output += '|' + headers.map(() => '------').join('|') + '|\n';
 // 数据行（最多200行）
 for (let i = 1; i < Math.min(sheet.rows.length, 201); i++) {
 const row = sheet.rows[i];
 if (row.some(v => v !== null && v !== undefined && String(v).trim())) {
 output += '| ' + row.map(v => String(v ?? '').replace(/\n/g, ' ')).join(' | ') + ' |\n';
 }
 }
 }
 output += '\n';
 }
 return output;
 } catch (e) {
 console.warn(`⚠️ XLSX 解析失败:`, e.message?.substring(0, 200));
 return null;
 }
 }

 // PDF: pdf-parse 解析（带降级提示）
 if (ext === 'pdf') {
 try {
 return await extractPdfText(filePath);
 } catch (e) {
 console.warn(`⚠️ PDF 解析失败:`, e.message?.substring(0, 200));
 }
 // 降级：返回提示信息
 return '[PDF needs pdf-parse npm package or uses scanned/image PDF]';
 }

 // PPTX 暂不支持（保留占位）
 if (ext === 'pptx') {
 return null;
 }

 return null;
}

function recordSentMessage(senderId, content) {
 const key = senderId;
 const now = Date.now();
 const entry = _recentSentMessages.get(key) || { messages: [] };
 entry.messages.push({ content: content.substring(0, 200), ts: now });
 entry.messages = entry.messages.filter(m => now - m.ts < _LOOP_DETECTION_WINDOW);
 _recentSentMessages.set(key, entry);

 // 清理过期 key，防止 Map 无限增长
 if (_recentSentMessages.size > 100) {
 for (const [k, v] of _recentSentMessages) {
 if (v.messages.length === 0 || v.messages.every(m => now - m.ts >= _LOOP_DETECTION_WINDOW)) {
 _recentSentMessages.delete(k);
 }
 }
 }
}

function isLoopDetected(senderId, content) {
 const entry = _recentSentMessages.get(senderId);
 if (!entry) return false;
 const recent = entry.messages.filter(m => Date.now() - m.ts < _LOOP_DETECTION_WINDOW);
 const snippet = content.substring(0, 200);
 const matchCount = recent.filter(m => m.content === snippet || snippet.includes(m.content) || m.content.includes(snippet)).length;
 return matchCount >= _LOOP_MAX_SAME_CONTENT;
}

module.exports.readJsonBody = readJsonBody;
module.exports.sendError = sendError;
module.exports.sendJson = sendJson;
module.exports.readRequestBody = readRequestBody;

/**
 * 统一通道消息处理 - 提取飞书和企业微信 webhook 的公共逻辑
 * @param {object} params
 * @param {string} params.channelType - 通道类型 'lark' | 'wecom'
 * @param {string} params.senderId - 发送者ID
 * @param {string} params.content - 消息内容
 * @param {Array} params.files - 文件列表
 * @param {string} [params.chatId] - 群聊ID（企业微信）
 * @param {string} [params.chatType] - 聊天类型（企业微信）
 * @param {string} [params.messageId] - 消息ID（飞书，用于表情反应）
 * @param {object} ctx - 请求上下文
 * @returns {{ reply: string|null, _lark_card: object|null }}
 */
async function _processChannelMessage({ channelType, senderId, content, files, chatId, chatType, messageId, rawEvent }, ctx) {
 const fs = require('fs');
 const path = require('path');
 const channelClient = channelType === 'lark' ? ctx.lark : ctx.wecom;
 const isLark = channelType === 'lark';
 const isWecom = channelType === 'wecom';

 // 1. 循环检测
 if (content && isLoopDetected(senderId, content)) {
 console.warn(`🔄 [循环防护] 检测到${isLark ? '飞书' : '企业微信'}消息循环，跳过处理`);
 return { loopDetected: true };
 }

 // 1.5 消息去重（2026-09-06: msgId 优先，缺 msgId 按分钟桶+内容；检查失败放行）
 if (messageId || content) {
 try {
 const dd = getChannelDedup();
 const dup = dd.check({
 msgId: messageId || '',
 chatId: chatId || '',
 fromUserId: senderId || '',
 content: content || '',
 timestamp: Date.now(),
 });
 if (dup.isDuplicate) {
 console.log(`🔁 [去重] ${channelType} 重复消息已跳过: ${messageId || (content || '').substring(0, 30)}`);
 return { duplicated: true };
 }
 } catch (dedupErr) {
 console.warn('[去重] 检查失败(放行):', dedupErr.message);
 }
 }

 // 1.7 群聊路由（2026-09-06 接线: 此前 group-router 是死代码，群消息不经 @
 // 也被当私聊回答，mention_only 策略从未生效）
 if (chatType === 'group' && channelClient && typeof channelClient.routeGroupMessage === 'function') {
 try {
 const routerResult = channelClient.routeGroupMessage({
 content: content || '',
 chatId: chatId || '',
 chatType: 'group',
 rawBody: rawEvent || {},
 });
 if (!routerResult.shouldProcess) {
 console.log(`👥 [群路由] ${channelType} 群消息已过滤: ${routerResult.reason} (chat=${chatId})`);
 return { groupFiltered: true, reason: routerResult.reason };
 }
 if (routerResult.extractedContent) {
 content = routerResult.extractedContent; // 剥离机器人 @ 后的净文本
 }
 // 企微: router 批准的群交互落盘白名单（桥按 10 分钟窗口放行群回复）
 if (isWecom && chatId) {
 try {
 const { approveGroupChat } = require('../channels/wecom/send-guard');
 approveGroupChat(ctx.config.DATA_DIR, chatId);
 } catch (guardErr) { console.warn('[群路由] 群白名单落盘失败:', guardErr.message); }
 }
 } catch (routeErr) {
 console.warn('[群路由] 路由失败(放行):', routeErr.message);
 }
 }

 // 2. 用户记录
 if (senderId && senderId !== 'unknown') {
 if (isLark && ctx.setLastLarkSenderId) {
 ctx.setLastLarkSenderId(senderId);
 }
 ctx.config.recordUser(senderId);
 }

 // 3. 白名单检查
 const enableWhitelist = ctx.appConfig.enableWhitelist || false;
 const allowedUsers = ctx.appConfig.allowedUsers || [];
 if (enableWhitelist && senderId && senderId !== 'unknown') {
 if (!allowedUsers.includes(senderId)) {
 console.log('🚫 用户不在白名单中:', senderId);
 await channelClient.send(isWecom ? (chatId || senderId) : senderId, '抱歉，您没有权限使用此智能体。', isWecom ? chatType : undefined);
 return { blocked: true };
 }
 console.log('✅ 用户在白名单中:', senderId);
 }

 // 4. 文件处理
 let processedContent = content || '';
 let downloadedFiles = [];
 // P3: 提升附件引用到函数作用域，供 9.5 节即时广播携带文件元数据
 let broadcastFiles = [];

 if (files && files.length > 0) {
 if (isLark) {
 // 飞书文件下载
 const workspaceDir = ctx.WORKSPACE_DIR || path.join(__dirname, '..', 'data', 'workspace');
 const uploadsDir = path.join(workspaceDir, 'uploads');
 if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

 for (const file of files) {
 try {
 const timestamp = Date.now();
 let savedPath;
 if (file.type === 'file' || file.type === 'media') {
 const safeName = (file.fileName || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
 savedPath = path.join(uploadsDir, `${timestamp}_${safeName}`);
 await ctx.lark.downloadFile(file.fileKey, savedPath);
 } else if (file.type === 'image') {
 savedPath = path.join(uploadsDir, `${timestamp}_image.jpg`);
 await ctx.lark.downloadImage(file.fileKey, savedPath);
 } else if (file.type === 'audio') {
 savedPath = path.join(uploadsDir, `${timestamp}_audio.mp3`);
 await ctx.lark.downloadFile(file.fileKey, savedPath);
 }
 if (savedPath && fs.existsSync(savedPath)) {
 downloadedFiles.push({ originalName: file.fileName || file.type, path: savedPath, type: file.type, size: file.fileSize });
 }
 } catch (e) {
 console.error('❌ 下载文件失败:', e.message);
 }
 }
 if (downloadedFiles.length > 0) {
 const filePaths = downloadedFiles.map(f => ` - ${f.path}`).join('\n');
 const fileNames = downloadedFiles.map(f => f.originalName).join(', ');
 broadcastFiles = downloadedFiles.map(f => ({ fileName: f.originalName, fileKey: f.path }))
 processedContent = `${content}\n\n[用户上传了以下文件: ${fileNames}]\n文件路径:\n${filePaths}\n\n你可以使用 DocRead 工具读取这些文件的内容（参数 path 传入文件路径）。`;
 }
 } else {
 // 企业微信文件处理（本地路径已存在）
 const validFiles = files.filter(f => f.fileKey && fs.existsSync(f.fileKey));
 broadcastFiles = validFiles
 if (validFiles.length > 0) {
 const fileParts = [];
 for (const file of validFiles) {
 const fileName = file.fileName || 'unknown';
 const filePath = file.fileKey;
 const ext = filePath.split('.').pop().toLowerCase();
 const extracted = await extractFileContent(filePath);
 if (extracted) {
 const truncated = extracted.length > 30000 ? extracted.substring(0, 30000) + '\n...(内容过长，已截断)' : extracted;
 fileParts.push(`[以下为文件 ${fileName} 的完整内容，已直接提供，无需再用任何工具读取]\n${truncated}\n[文件 ${fileName} 内容结束]`);
 } else if (ext === 'pdf') {
 fileParts.push(`[文件: ${fileName}，路径: ${filePath}]\n⚠️ 这是一个扫描版 PDF 或图片 PDF，无法直接提取文本内容。`);
 } else {
 fileParts.push(`[文件: ${fileName}，路径: ${filePath}]\n请使用 DocRead 工具读取文件内容（参数 path 传入文件路径）。`);
 }
 }
 if (processedContent) {
 processedContent += '\n\n' + fileParts.join('\n\n');
 } else {
 processedContent = fileParts.join('\n\n');
 }
 }
 }
 }

 // 6. 飞书表情反应
 let reactionResult = { success: false, reactionId: null };
 if (isLark && messageId) {
 reactionResult = await ctx.lark.addReaction(messageId, 'THINKING');
 }

 // 7. 工具调用提示（企业微信专用）
 const needsToolHint = /股票|行情|买入|卖出|股价|基金|财经|天气|搜索|查找|文件|读取|写入|分析|查询|检查/i.test(processedContent);
 if (isWecom && needsToolHint && ctx.wecom.isConfigured()) {
 await ctx.wecom.send(chatId || senderId, '⏳ 正在分析中，请稍候...', chatType);
 broadcastEvent('wecom_reply', { senderId, content: '⏳ 正在分析中，请稍候...', timestamp: Date.now() });
 }

 // 8. 问候检测
 const GREETING_PATTERN = /^(你好|您好|嗨|哈喽|早上好|下午好|晚上好|在吗|在么|hi|hello|hey|嗨呀|你好啊|你好呀|哈喽啊|你好！|您好！|在吗？|在么？)\s*[！!？?。.~]*\s*$/i;
 const isGreetingMessage = GREETING_PATTERN.test(processedContent.trim()) ||
 (processedContent.trim().length <= 6 && /^(你好|您好|嗨|哈喽|在吗|在么|hi|hello)/i.test(processedContent.trim()));

 // 9. 用户ID解析
 const syncMode = ctx.appConfig.user?.syncMode || 'gui_user';
 const larkUserId = ctx.appConfig.user?.larkUserId || '';
 let userId = isWecom ? 'wecom_user' : 'lark_user';
 if (syncMode === 'lark_sync' && larkUserId) {
 userId = larkUserId;
 } else if (syncMode === 'wecom_sync' && senderId) {
 userId = senderId;
 if (isWecom && !ctx.appConfig.user.wecomUserId) {
 ctx.appConfig.user.wecomUserId = senderId;
 const userConfigPath = path.join(process.env.DATA_DIR || path.join(__dirname, '../../data/.crabpaw'), 'config', 'user.json');
 try {
 let existing = {};
 if (fs.existsSync(userConfigPath)) existing = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
 existing.wecomUserId = senderId;
 const dir = path.dirname(userConfigPath);
 if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
 fs.writeFileSync(userConfigPath, JSON.stringify(existing, null, 2));
 } catch (e) { console.warn('⚠️ 保存企业微信用户ID失败:', e.message); }
 }
 } else if (senderId) {
 userId = senderId;
 }

 // 登记通道来源（异步任务完成回推匹配用）
 recordChannelChat(userId, channelType, chatId || senderId);

 // 9.5 立即广播用户消息到 Electron（不等 AI 回复）
 if (isWecom && syncMode === 'wecom_sync' && processedContent) {
   const payload = buildWecomMessagePayload(senderId, processedContent, broadcastFiles)
   console.log(`📡 [即时广播] 企业微信用户消息→Electron: senderId=${senderId}, content=${processedContent.substring(0, 50)}`);
   broadcastEvent('wecom_message', payload);
 }
 if (isLark && syncMode === 'lark_sync' && processedContent) {
 broadcastEvent('lark_message', { senderId, content: processedContent, timestamp: Date.now() });
 }

 // 10. 工具调用回调（企业微信专用）
 const ai = ctx.ai;
 const skills = ctx.skillsRegistry || ctx.skills;
 let lastToolCallTime = 0;

 if (isWecom) {
 ai.setToolCallCallback((uid, toolName, status, _data) => {
 if (uid !== userId) return;
 if (isGreetingMessage) return;
 const now = Date.now();
 if (status === 'start') {
 const toolHints = {
 'Read': '正在读取文件...', 'Write': '正在写入文件...', 'Grep': '正在搜索内容...',
 'WebSearch': '正在搜索网络...', 'WebFetch': '正在获取网页...', 'Bash': '正在执行命令...',
 'StockQuery': '正在查询股票数据...', 'Weather': '正在查询天气...',
 'TodoRead': '正在读取任务列表...', 'TodoWrite': '正在更新任务...',
 };
 const hint = toolHints[toolName] || `正在执行 ${toolName}...`;
 if (ctx.wecom.isConfigured() && now - lastToolCallTime > 3000) {
 ctx.wecom.send(chatId || senderId, `🔧 ${hint}`, chatType).catch(e => console.debug('[chat] Send failed:', e?.message));
 lastToolCallTime = now;
 }
 broadcastEvent('wecom_reply', { senderId, content: `🔧 ${hint}`, timestamp: Date.now() });
 }
 });
 }

 // 11. AI 调用
 const beforeChatTime = Date.now();
 const replyResult = await (isLark
 ? ctx.handleMessage(senderId, processedContent, ctx)
 : ai.chat(ctx.appConfig, skills, userId, processedContent));
 const reply = typeof replyResult === 'object' && replyResult.reply ? replyResult.reply : replyResult;
 const larkCard = typeof replyResult === 'object' ? replyResult._lark_card : null;

 if (isWecom) ai.setToolCallCallback(null);

 // 12. 移除飞书表情反应
 if (isLark && reactionResult.success && messageId && reactionResult.reactionId) {
 await ctx.lark.removeReaction(messageId, reactionResult.reactionId);
 }

 // 13. 回复发送
 if (reply) {
 if (isLark && ctx.lark.isConfigured() && senderId && senderId !== 'unknown') {
 // 飞书回复（webhook 收到消息即证明通道活跃，不需要 channels.includes 检查）
 if (larkCard) {
 if (larkCard.type === 'doc' && larkCard.docUrl) {
 await ctx.lark.sendDocCard(senderId, { title: larkCard.title || '飞书文档', docUrl: larkCard.docUrl, docType: larkCard.docType || 'docx', description: '点击下方按钮查看文档' });
 } else if (larkCard.type === 'calendar') {
 await ctx.lark.sendMarkdown(senderId, { title: '📅 日程已创建', content: reply, color: 'green' });
 try {
 const { addEvent } = require('./calendar-handler');
 const calData = larkCard.calendarEvent || {};
 addEvent({ title: calData.summary || '日程', date: calData.startTime ? new Date(calData.startTime * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10), time: calData.startTime ? new Date(calData.startTime * 1000).toISOString().slice(11, 16) : '', duration: calData.startTime && calData.endTime ? Math.round((calData.endTime - calData.startTime) / 60) : 30, description: calData.description || '', color: 'blue' });
 } catch (syncErr) { console.warn('⚠️ 同步本地日历失败:', syncErr.message); }
 } else if (larkCard.type === 'task') {
 await ctx.lark.sendMarkdown(senderId, { title: '✅ 任务已创建', content: reply, color: 'blue' });
 } else {
 await ctx.lark.send(senderId, reply);
 }
 } else if (reply.length > 500) {
 await ctx.lark.sendMarkdown(senderId, { title: '🦀 CrabPaw 回复', content: reply, color: 'blue' });
 } else {
 await ctx.lark.send(senderId, reply);
 }
 recordSentMessage(senderId, reply);

 // 2026-09-06: 文档产物回推——本次对话期间新生成的 doc-artifacts（filegen
 // 生成的本地 Word/PDF 等）上传后直发飞书（与企微侧图片回推同构）
 try {
 const { listArtifacts } = require('../core/doc-artifacts/registry');
 const newDocs = listArtifacts(50).filter(a =>
 (Number(a.updatedAt) || Number(a.createdAt) || 0) >= beforeChatTime && a.path && fs.existsSync(a.path));
 for (const doc of newDocs.slice(0, 5)) {
 try { await ctx.lark.sendFile(senderId, doc.path); } catch (docErr) { console.error('❌ 发送文档到飞书失败:', docErr.message); }
 }
 } catch (pushErr) { console.warn('[lark] 文档产物回推失败:', pushErr.message);
 }
 } else if (isWecom && ctx.wecom.isConfigured()) {
 // 企业微信回复（webhook 收到消息即证明通道活跃，不需要 channels.includes 检查）
 const cleanedReply = cleanReplyForUser(reply, true);
 const targetId = chatId || senderId;
 try {
 await ctx.wecom.send(targetId, cleanedReply, chatType);
 } catch (sendErr) {
 console.error('❌ 发送回复到企业微信失败:', sendErr.message);
 }

 // 发送生成的图片
 const generatedImages = [];
 for (const [, task] of IMAGE_GEN_TASKS.entries()) {
 if (task.status === 'completed' && task.completedAt && task.completedAt >= beforeChatTime) {
 const result = task.result;
 if (result?.image_path) generatedImages.push(result.image_path);
 else if (result?.images) for (const img of result.images) if (img.file_path) generatedImages.push(img.file_path);
 }
 }
 if (generatedImages.length === 0) {
 const pathPatterns = [/data\/\.crabpaw\/generated-images\/[^\s`)"'|\]]+\.png/g, /data\/\.crabpaw\/generated-images\/[^\s`)"'|\]]+\.jpg/g, /data\/\.crabpaw\/generated-images\/[^\s`)"'|\]]+\.jpeg/g, /data\/\.crabpaw\/generated-images\/[^\s`)"'|\]]+\.webp/g];
 for (const pattern of pathPatterns) {
 const matches = reply.match(pattern);
 if (matches) for (const match of matches) { const resolvedPath = path.resolve(match); if (!generatedImages.includes(resolvedPath)) generatedImages.push(resolvedPath); }
 }
 }
 for (const imagePath of generatedImages) {
 try { await ctx.wecom.sendImage(chatId || senderId, imagePath, chatType); } catch (imgErr) { console.error('❌ 发送图片到企业微信失败:', imgErr.message); }
 }

 // 发送生成的视频
 const generatedVideos = [];
 for (const [, task] of VIDEO_GEN_TASKS.entries()) {
 if (task.status === 'completed' && task.completedAt && task.completedAt >= beforeChatTime) {
 const result = task.result;
 if (result?.videos) for (const vid of result.videos) if (vid.file_path) generatedVideos.push(vid.file_path);
 }
 }
 if (generatedVideos.length === 0) {
 const videoPathPatterns = [/data\/\.crabpaw\/generated-videos\/[^\s`)"'|\]]+\.mp4/g, /data\/\.crabpaw\/generated-videos\/[^\s`)"'|\]]+\.mov/g, /data\/\.crabpaw\/generated-videos\/[^\s`)"'|\]]+\.webm/g];
 for (const pattern of videoPathPatterns) {
 const matches = reply.match(pattern);
 if (matches) for (const match of matches) { const resolvedPath = path.resolve(match); if (!generatedVideos.includes(resolvedPath)) generatedVideos.push(resolvedPath); }
 }
 }
 for (const videoPath of generatedVideos) {
 try { await ctx.wecom.sendVideo(chatId || senderId, videoPath, chatType); } catch (vidErr) { console.error('❌ 发送视频到企业微信失败:', vidErr.message); }
 }

 // 2026-09-06: 文档产物回推——本次对话期间新生成的 doc-artifacts（filegen
 // 生成的本地 Word/PDF 等）经企微桥 sendFile 直发（与图片回推同构）
 try {
 const { listArtifacts } = require('../core/doc-artifacts/registry');
 const newDocs = listArtifacts(50).filter(a =>
 (Number(a.updatedAt) || Number(a.createdAt) || 0) >= beforeChatTime && a.path && fs.existsSync(a.path));
 for (const doc of newDocs.slice(0, 5)) {
 try { await ctx.wecom.sendFile(targetId, doc.path, chatType); } catch (docErr) { console.error('❌ 发送文档到企业微信失败:', docErr.message); }
 }
 } catch (pushErr) { console.warn('[wecom] 文档产物回推失败:', pushErr.message);
 }
 }
 }

 // 15. 同步广播（仅广播 AI 回复，用户消息已在步骤 9.5 提前广播）
 if (isLark && syncMode === 'lark_sync') {
 if (reply) broadcastEvent('lark_reply', { senderId, content: reply, timestamp: Date.now() });
 }
 if (isWecom && syncMode === 'wecom_sync') {
 console.log(`📡 [同步广播] 企业微信AI回复→Electron: hasReply=${!!reply}`);
 if (reply) broadcastEvent('wecom_reply', { senderId, content: cleanReplyForUser(reply, false), timestamp: Date.now() });
 }

 return { reply, _lark_card: larkCard, processedContent };
}

/**
 * 2026-08-15 D1(审计 P0): 客户端断连清理接线。
 * 旧实现 req.on('close') 在请求体读完('end')后即触发(Node v24 实测, 晚于监听
 * 注册)→ cleanup 永不执行 → 服务端 LLM 烧 token 直到自然结束/新请求抢占,
 * run:interrupt 终态迟到可达数分钟。改用 res.on('close'): response 的 close 在
 * 连接销毁时触发, 用 writableFinished 区分正常结束(响应已写完)与提前断连
 * (未写完即断)。req.on('aborted') 保留(HTTP/1 客户端主动中断)。
 * @param {{req: object, res: object, onCleanup: Function}} deps
 */
function _attachDisconnectCleanup({ req, res, onCleanup }) {
  res.on('close', () => {
    if (!res.writableFinished) {
      onCleanup();
    }
  });
  req.on('aborted', onCleanup);
}

async function handleChat(req, res, ctx) {
 try {

 const data = await readJsonBody(req, { maxSize: 10 * 1024 * 1024 });
 const { message, stream, files, conversationId, userId: requestUserId, projectId, resume } = data;

 // 2026-08-13 P2-4: conversationId 启用——sess_* 前缀的会话 id 创建/续用后端会话,
 // 消息按会话落库、历史按会话过滤(上下文延续)。非法/非 sess_ 前缀降级 null。
 let sessionId = null;
 if (conversationId && String(conversationId).startsWith('sess_') && conversationId !== requestUserId) {
  try {
   // 2026-08-14 数据链审计 C1: 修复 require 路径——旧路径 ./memory/memory-manager 从
   // src/handlers/ 解析(该目录不存在)→ MODULE_NOT_FOUND 被 catch 吞 → sessionId 恒 null
   // → 消息从不写入 sess_* 会话文件。memory-system.js 导出唯一 memoryManager 单例,
   // getOrCreateSession 负责 sess_* 会话的创建/续用(与落库共用同一实例)。
   const { memoryManager } = require('../core/memory-system');
   const sess = await memoryManager.getOrCreateSession(String(conversationId), requestUserId);
   if (sess) sessionId = String(conversationId);
  } catch (e) {
   console.warn('[chat-handler] 会话创建/续用失败(降级 null):', e?.message || e);
  }
 }
 
 // AG-UI resume 契约(interrupts.mdx): 带 resume 数组的请求即使无消息也合法(resume-only)
 const hasResume = Array.isArray(resume) && resume.length > 0;
 if (!message && (!files || files.length === 0) && !hasResume) {
 return sendError(res, 400, 'Message or files are required');
 }
 
 const userConfig = ctx.appConfig?.user || {};
 const syncMode = userConfig.syncMode || 'gui_user';
 let userId = 'gui_user';
 
 if (requestUserId) {
 userId = requestUserId;
 } else if (syncMode === 'lark_sync' && userConfig.larkUserId) {
 userId = userConfig.larkUserId;
 } else if (syncMode === 'wecom_sync' && userConfig.wecomUserId) {
 userId = userConfig.wecomUserId;
 }

 // AG-UI resume 契约(interrupts.mdx): 客户端以新 run 携带 resume 数组恢复被 interrupt
 // 的审批——翻译为 approval.respond; 幂等(重复 resume 返回 success+alreadyResolved)。
 // resume-only 请求直接返回 per-item 结果; resume+message 则先解除审批阻塞再走正常流程。
 const resumeResults = [];
 if (hasResume) {
  const approval = ctx.security && ctx.security.approval;
  for (const item of resume) {
   const t = aguiAdapter.translateResume(item);
   if (t.kind === 'error') {
    resumeResults.push({ interruptId: item && item.interruptId, success: false, error: t.error });
    continue;
   }
   if (aguiAdapter.isResumeHandled(t.requestId)) {
    resumeResults.push({ interruptId: t.requestId, success: true, alreadyResolved: true });
    continue;
   }
   if (!approval) {
    resumeResults.push({ interruptId: t.requestId, success: false, error: 'Approval system unavailable' });
    continue;
   }
   const options = { ...t.options };
   if (!options.conversationId && conversationId) options.conversationId = conversationId;
   const result = await approval.respond(t.requestId, t.approved, t.scope, options);
   if (result && result.success) {
    aguiAdapter.markResumeHandled(t.requestId);
    resumeResults.push({ interruptId: t.requestId, success: true });
   } else {
    resumeResults.push({ interruptId: t.requestId, success: false, ...(result || { error: '审批处理失败' }) });
   }
  }
  if (!message && (!files || files.length === 0)) {
   return sendJson(res, 200, { success: true, resume: resumeResults });
  }
 }

 const channels = Array.isArray(ctx.appConfig.chatChannel) ? ctx.appConfig.chatChannel : [ctx.appConfig.chatChannel || 'none'];
 
 // 斜杠命令处理
 if (message && message.startsWith('/')) {
 const trimmed = message.trim();
 const spaceIdx = trimmed.indexOf(' ');
 const cmdName = spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1);
 const cmdArgs = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1) : '';
 
 try {
 const result = await executeCommand(cmdName, cmdArgs, { userId, platform: 'gui', chatType: 'dm' });
 
 if (result.success && result.result) {
 const cmdResult = result.result;
 
 // 处理特殊命令类型
 if (cmdResult.type === 'retry') {
 // /retry: 用之前的消息重新调用 AI，继续正常聊天流程
 commandsIndex.recordInteraction(cmdResult.value, null);
 } else if (cmdResult.type === 'compress') {
 try {
 const { getCompressor } = require('../core/context/compressor');
 const compressor = getCompressor();
 const compressResult = await compressor.forceCompress(userId);
 return sendJson(res, 200, { 
 reply: cmdResult.value || `✅ 上下文已压缩。${compressResult?.summary || ''}`,
 type: 'command_result'
 });
 } catch (compressErr) {
 return sendJson(res, 200, { 
 reply: `⚠️ 压缩失败: ${compressErr.message}`,
 type: 'command_result'
 });
 }
 } else {
 return sendJson(res, 200, { 
 reply: cmdResult.value || `✅ 命令 /${cmdName} 已执行`,
 type: 'command_result'
 });
 }
 } else {
 return sendJson(res, 200, { 
 reply: result.error || `❌ 命令执行失败`,
 type: 'command_error'
 });
 }
 } catch (cmdErr) {
 console.warn('⚠️ 斜杠命令处理异常:', cmdErr.message);
 // 命令解析失败，当作普通消息处理
 }
 }
 
 let processedMessage = message || '';
 // 2026-09-07 实测修复: 保留用户原文——processedMessage 随后会被拼接上传说明/
 // 工作流提示/专家人设等系统脚手架, ai.js prepareChatContext 的注入检测若扫
 // 拼接后全文, 专家人设文本(含"你是…专家/必须…"等指令式措辞)会被自家检测
 // 误杀(实测"让财务分析师分析"整轮被拦截报"出错了")。检测只扫原文。
 const rawUserMessage = message || '';
 
 if (ctx.security) {
 const authResult = await ctx.security.checkUserAuthorization(userId, 'gui');
 if (!authResult.authorized) {
 return sendError(res, 403, `User not authorized: ${authResult.reason}`);
 }
 }
 
 if (ctx.security && message) {
 const injectionResult = await ctx.security.detectPromptInjection(message);
 if (injectionResult.blocked && ctx.security.config.promptInjection.blockOnDetection) {
 return sendError(res, 400, `Potentially malicious input detected (risk: ${injectionResult.riskLevel || 'unknown'})`);
 }
 }
 
 console.log('💬 聊天请求 userId:', userId, '(syncMode:', syncMode, ')');
 
 if (files && files.length > 0) {
 console.log('📁 收到文件:', files.map(f => f.savedName || f.originalName || f.name).join(', '));
 
 const filePaths = files.map(f => f.path).join('\n');
// 2026-08-20: GUI 前端传 name（非 originalName/savedName）→ 此前恒空串；三字段兜底。
 const fileNames = files.map(f => f.originalName || f.savedName || f.name).join(', ');
 
 if (processedMessage) {
 processedMessage += `\n\n[用户上传了以下文件: ${fileNames}]\n文件路径:\n${filePaths}\n\n你可以使用 DocRead 工具读取这些文件的内容（参数 path 传入文件路径）。`;
 } else {
 processedMessage = `[用户上传了以下文件: ${fileNames}]\n文件路径:\n${filePaths}\n\n请使用 DocRead 工具读取这些文件的内容（参数 path 传入文件路径），然后帮助用户处理。`;
 }
 }
 
 console.log('💬 GUI 聊天请求:', processedMessage.substring(0, 100), (stream ? '(流式)' : ''));

 // 2026-08-15 D7(审计 P1): 记录 message_received 活动——此前 handleChat 从不
 // record, 前端左栏消息日志永不显示用户发言条目(TYPE 表与前端 case 均为死代码)
 try {
 // 2026-08-15 修复: TYPE 是 activity-stream 的模块级导出, 非实例属性——
 // 此前 globalActivityStream.TYPE 为 undefined → "Cannot read properties of
 // undefined (reading 'MESSAGE_RECEIVED')" 崩溃(日志实锤 08:50:45)。
 const { TYPE } = require('../core/activity-stream');
 globalActivityStream.record(TYPE.MESSAGE_RECEIVED, {
 summary: (message || '').substring(0, 80) || '(消息)',
 detail: (message || '').substring(0, 200),
 userId,
 silent: true,
 });
 } catch (e) { console.warn('[chat-handler] 记录 message_received 失败:', e?.message || e); }
 
 let intentHint = null;
 try {
 const intentAnalyzer = getIntentAnalyzer();
 const suggestion = intentAnalyzer.suggest(processedMessage, { userId });
 
 if (suggestion.shouldCreateFlow && suggestion.confidence >= 0.4) {
 intentHint = suggestion;
 console.log('💡 工作流建议:', suggestion.intentType, 
 '(置信度:', (suggestion.confidence * 100).toFixed(0) + '%',
 '模板:', suggestion.templateHint?.name || '无',
 '专家:', suggestion.expertHint?.name || '无', ')');
 }
 } catch (intentErr) {
 console.warn('⚠️ 意图分析失败(不影响聊天):', intentErr.message);
 }
 
  if (intentHint) {
  processedMessage += '\n\n[系统提示: 此任务可能需要创建工作流来协调完成。你可以使用 taskflow 工具的 create 操作来创建工作流。';
  if (intentHint.templateHint) {
  processedMessage += ` 推荐模板: "${intentHint.templateHint.name}"`;
  }
  if (intentHint.expertHint) {
    processedMessage += ` 推荐专家: "${intentHint.expertHint.name}"`;
    // 2026-08-21: 专家数据源注入——命中专家带 dataScope 时，动态附加可用数据源
    try {
      const { getExpertDataSources } = require('../core/experts');
      const ds = getExpertDataSources(intentHint.expertHint.id);
      if (ds) processedMessage += `（${ds}）`;
    } catch (dsErr) {
      console.warn('⚠️ 专家数据源注入失败(不影响聊天):', dsErr.message);
    }
  }
  processedMessage += ']';
  }

  // 2026-08-15 T7(分部一): 意图命中「多专家协作」时自动发起专家协作。
  // 与 GUI 手动向导双入口；auto-collab 内部按同会话 running 状态幂等去重。
  try {
  const { maybeAutoStartCollab } = require('../core/experts/auto-collab');
  await maybeAutoStartCollab(userId, processedMessage, intentHint);
  } catch (autoCollabErr) {
  console.warn('⚠️ 专家协作自动触发异常(不影响聊天):', autoCollabErr?.message || autoCollabErr);
  }

  // 2026-08-26 E1: 专家激活——用户消息按 routingKeywords 路由命中专家 → 激活态注入
  // 系统提示(人设/数据源/语音风格)。补 taskflow 链之外的第二条专家路径:
  // 为专家名直接触发(systemPrompt 生效)。激活信息拼进 processedMessage —
  // 与 intentHint 同构(既有模式), 不侵入 ai.js 主循环。
  // 2026-09-05 P4: @提及召唤——"@财务部"/"@岗位名" 是显式指定, 优先于关键词路由:
  // 命中即激活(部门→主管)并从消息中移除 @token, 且跳过 routeAndActivate
  // (关键词路由不得顶掉用户的显式点名); 未命中(@邮箱/普通@词)原样保留走既有链路。
  let mentionHandled = false;
  try {
  const { consumeMentions } = require('../core/experts/mentions');
  const mention = consumeMentions(userId, processedMessage);
  if (mention.handled) {
  mentionHandled = true;
  processedMessage = mention.cleanedMessage;
  }
  } catch (mentionErr) {
  console.warn('⚠️ @提及解析异常(不影响聊天):', mentionErr?.message || mentionErr);
  }
  try {
  const { routeAndActivate, getActiveExpert, buildExpertPromptSuffix } = require('../core/expert-context');
  if (!mentionHandled) {
  routeAndActivate(userId, processedMessage);
  }
  const active = getActiveExpert(userId);
  if (active) {
  // 2026-08-28: 人设完整注入(此前 slice(0,200) 使四段人设只剩前 200 字符)
  processedMessage += buildExpertPromptSuffix(active);
  }
  } catch (expertCtxErr) {
  console.warn('⚠️ 专家激活注入异常(不影响聊天):', expertCtxErr?.message || expertCtxErr);
  }

  try {
  const workflowContext = await getConversationIntegration().buildWorkflowContextForPrompt(userId);
  if (workflowContext) {
  processedMessage += workflowContext;
  }
  } catch (e) {
  console.error('❌ 构建工作流上下文失败(不影响主流程):', e?.message || e);
  }

  // W2 fix: 天气关键词检测 → 预投影 Scene surface（fire-and-forget，不阻塞 LLM 调用）
  // 2026-08-18 实机修复: "台风"从天气关键词移除——"最近有台风吗"会误触发 weather-北京
  // 预投影小卡（城市提取失败默认北京）。台风有专用链（ShowTyphoon → typhoon-panel 大面板）。
  if (processedMessage && /天气|温度|气温|下雨|降雨|下雪|雾霾|阴天|晴天|多云|wttr|weather/i.test(processedMessage)) {
  (async () => {
   try {
   const sceneStore = require('../core/scene/scene-store').getSceneStore();
   const { scheduleSceneSurfaceRemoval } = require('../core/scene/transient-surfaces');
   const panels = require('../core/panels');
   // 提取城市名（启发式：取"天气"前的词组；P5.5 修复：去除时间/语气词前缀，
   // 否则"今天天气"会提取"今天"→ wttr.in 无效城市 500 → 预投影持续失败）
   let detectedCity = null;
   const cityMatch = processedMessage.match(/([^\s,，。！？\n]{1,8})的?天气/);
   if (cityMatch) {
     const cleaned = String(cityMatch[1]).replace(/^(今天|明天|后天|昨天|前天|现在|那个|那边|附近|当地|我们|这边)/, '').trim();
     if (cleaned && cleaned.length <= 6 && !/^(天气|怎么样|如何|什么|情况|如何|台风|飓风)$/.test(cleaned)) {
       detectedCity = cleaned;
     }
   }
   const city = detectedCity || '北京';
   try {
    const data = await panels.weather.getWeather(city, { forceRefresh: true });
    if (data && data.current) {
    const forecast = Array.isArray(data.forecast) ? data.forecast.slice(0, 5).map(f => ({
     day: String(f.day || ''),
     low: Number(f.low) || 0,
     high: Number(f.high) || 0,
     condition: String(f.condition || ''),
    })) : [];
    sceneStore.upsertSurface(`weather-${city}`, {
     kind: 'weather',
     data: {
     city: String(city),
     temp: Number(data.current.temp) || 0,
     condition: String(data.current.condition || ''),
     forecast,
     },
     intent: 'ambient',
    });
    scheduleSceneSurfaceRemoval(`weather-${city}`, { kind: 'weather' });
    console.log('[Weather] 预投影 Scene weather surface:', city);
    }
   } catch (fetchErr) {
    console.warn('[Weather] 预投影 fetch 失败（不影响主流程）:', fetchErr.message);
   }
   } catch (e) {
   console.warn('[Weather] 预投影失败（不影响主流程）:', e.message);
   }
  })();
  }

  // 多智能体生命周期 SSE 事件广播
 const ai = ctx.ai;
 ai.setSubAgentCallback((uid, status, info) => {
 if (uid !== userId) return;
 if (status === "start") {
 broadcastEvent("subagent:start", { userId, ...info, timestamp: Date.now() });
 } else if (status === "end") {
 broadcastEvent("subagent:end", { userId, ...info, timestamp: Date.now() });
 }
 });

 if (stream) {
 // SSE 强化：requestId 透传 + 心跳保活
 const requestId = req.headers['x-request-id'] || `req-${Date.now()}-${crypto.randomBytes(4).toString("hex").slice(0, 8)}`
 res.writeHead(200, {
 'Content-Type': 'text/event-stream; charset=utf-8',
 'Cache-Control': 'no-cache',
 'Connection': 'keep-alive',
 'X-Request-Id': requestId, // 透传给客户端，便于排查
 })

 // 心跳：每 15s 发送，检测连接活性
 const heartbeat = setInterval(() => {
 try { res.write(': heartbeat\n\n') } catch(e) { console.warn("[chat-handler]", e?.message) }
 }, 15000)
 heartbeat.unref() // 不阻止进程退出

 // 客户端断连清理
 let clientClosed = false;
 let cleanedUp = false;
 // B2(Runtime差距分析): roundId 声明前移到 cleanup 之前——cleanup 的断连策略
 // 需要读取 run 记录; 原声明在 try 内(晚于 cleanup 定义),早断连存在 TDZ 风险。
 let roundId = null;
 const cleanup = () => {
  if (cleanedUp) return;
  cleanedUp = true;
  clientClosed = true;
  clearInterval(heartbeat)
  // 2026-08-15 D1(审计 P0)原始语义修订为 B4(Runtime差距分析)断连策略:
  // Run 生命周期与连接生命周期解耦(刷新/断网/关窗 ≠ 停止执行)。
  // 中止服务端 LLM 仅发生在:
  //   (a) 显式取消: 停止按钮 → POST /api/request/cancel 置位 cancelRequested;
  //   (b) 新消息抢占: 下一轮 chat() 内 globalRequestInterrupt.register 内置 abort 旧请求。
  try {
   const { globalRequestInterrupt } = require('../core/request-interrupt');
   const { getRunStore } = require('../core/run-store');
   const runRec = roundId ? getRunStore().getRunRecord(roundId) : null;
   if (runRec && runRec.cancelRequested) {
    // 显式取消路径: 确保 LLM 流终止(取消 API 与断连事件存在竞态)
    globalRequestInterrupt.abort(userId);
   } else if (runRec && runRec.status === 'running') {
    getRunStore().markRunDetached(roundId);
    console.log(`[chat-handler] 断连但 run 继续(roundId=${roundId})——Run 与连接生命周期解耦`);
   } else if (!runRec) {
    // run 尚未注册(roundId 未生成即断连)——保持立即中止兜底
    globalRequestInterrupt.abort(userId);
   }
  } catch (e) { console.warn('[chat-handler] 断连清理失败:', e?.message || e); }
 }
 const safeWrite = (data) => {
  if (clientClosed) return false;
  try {
    res.write(data);
    return true;
  } catch (e) {
    console.warn("[chat-handler] write failed, client disconnected:", e?.message);
    cleanup(); // 2026-08-15 D1: 写入失败即客户端已断——中止服务端 LLM(此前只置位不 abort)
    return false;
  }
 };
 // AG-UI 双名双写: 把映射出的标准事件帧写入同一流(旧事件名原样保留)
 // 2026-08-25 修复: 内联双发默认关闭——/chat 流内 legacy 帧与 AG-UI 帧同时到达,
 // 前端消费两者后文本逐词重复(我来我来/为你为你实测)。AG-UI 标准客户端走
 // /events 通道(mapToAgui 双名广播 + agui-events.ts 订阅层), 无需流内帧。
 // 如确需流内 AG-UI 帧: 设 AGUI_CHAT_INLINE=1 开启(此后前端 normalize 亦兼容)。
 const aguiWrite = (frames) => {
  if (process.env.AGUI_CHAT_INLINE !=='1') return;
  if (clientClosed || !frames || frames.length === 0) return;
  for (const f of frames) safeWrite('data: ' + JSON.stringify(f) + '\n\n');
 };
 const aguiCtx = () => ({ runId: roundId, threadId: sessionId || userId });
 // 2026-08-15 D1(审计 P0): 接线改用 _attachDisconnectCleanup(res.on('close') +
 // writableFinished 判定)——见函数注释; 断连即 cleanup → abort 服务端 LLM。
 _attachDisconnectCleanup({ req, res, onCleanup: cleanup });

 const voiceConfig = ctx.appConfig?.voice || {};
 const speakEnabled = !!voiceConfig.replyEnabled;
 safeWrite('data: ' + JSON.stringify({ type: 'start', content: '', requestId, speak: speakEnabled, mode: 'text', plainReply: true }) + '\n\n')

 let fullReply = '';

 // ── 语音模式优化 ──────────────────────────────────────
 // 如果启用了语音回复，注入"口语简洁性"提示 + 降低 temperature
 let voiceOptimizedConfig = ctx.appConfig;
 let voiceProcessedMessage = processedMessage;
 if (speakEnabled) {
 // 克隆 config 以避免修改全局对象
 voiceOptimizedConfig = Object.assign({}, ctx.appConfig);
 if (voiceOptimizedConfig.models) {
 voiceOptimizedConfig.models = Object.assign({}, voiceOptimizedConfig.models);
 }
 // 模式：语音对话 temperature 上限 0.35
 const originalTemp = voiceOptimizedConfig.models?.temperature;
 if (originalTemp === undefined || originalTemp > 0.35) {
 voiceOptimizedConfig.models = voiceOptimizedConfig.models || {};
 voiceOptimizedConfig.models.temperature = 0.35;
 }

 const brevityHint = '\n\n[系统提示：当前是语音对话模式，你的回复将被 TTS 朗读——用户在听而不是在读。请默认用 1-2 句口语化的短句回复。避免标题、列表、代码块、URL、括号、破折号等不适合朗读的结构。保持自然简洁。]';
 voiceProcessedMessage = processedMessage + brevityHint;
 }

 // 2026-08-13 P2-2: roundId 提升到 try 外(catch 分支 run:error 需要)——
 // B2: 声明已进一步前移到 cleanup 之前(断连策略需要)
 try {
 // 注入项目上下文到 config，供 buildVolatileContext 使用
 if (projectId) {
 ctx.appConfig.activeProjectId = projectId;
 } else {
 delete ctx.appConfig.activeProjectId;
 }
 // 流空闲超时：如果 Provider 120s 未返回任何数据，中止当前流读取
 // 2026-08-15 P1-7: idleAbort 此前恒 null(死代码)——120s 空闲超时只打日志不中止,
 // provider 静默断流时 reader.read() 永久挂起(fetchWithRetry 60s 超时只覆盖响应
 // 首字节)。改为独立 AbortController, signal 经 chatStream options 注入流读取;
 // abort 后 ai.js 抛 AbortError → 既有 interrupted 终态路径。
 // 2026-08-15 审查返工 Important-1: idleAbort 一次性 latch 在工具执行期间
 // (>120s 无 chunk)超时后会把 ai.js 合并信号永久 latch, 工具完成后下一轮
 // fetch 立即 AbortError → 整轮被误判"用户中断"。现在: 超时 abort 后立刻
 // 换新 controller, ai.js 每轮 fetch 经 options.getIdleSignal() 取当前信号
 // (已 abort 的旧信号不再参与后续轮次合并); 收到 chunk 重置计时器保持
 // 「120s 无 chunk → 中止当前读取 → interrupted 终态」既有语义。

 let idleAbort = new AbortController();
 let idleTimer = null;
 const resetIdleTimer = () => {
 if (idleTimer) clearTimeout(idleTimer);
 idleTimer = setTimeout(() => {
 console.warn(`[chat-handler] 流空闲超时 (${STREAM_IDLE_TIMEOUT_MS}ms 无数据)，中止当前流读取`);
 idleAbort.abort();
 // 换新 controller: 超时只中止在飞的流读取, 不污染后续轮次(Important-1)
 idleAbort = new AbortController();
 }, STREAM_IDLE_TIMEOUT_MS);
 idleTimer.unref();
 };

 // 记录 LLM 开始推理事件（供 ActivityStream 消费）
 // 2026-08-13 P2-2: recordLLMEvent 返回 roundId——run 生命周期事件锚点
 roundId = globalActivityStream.recordLLMEvent('start') || null;

 // B2(Runtime差距分析): Run 生命周期注册——runId 级状态落盘(运行中/取消请求/
 // 断连解耦/审批挂起均可见),终态由 finishRun 写入; 崩溃恢复由 RunStore 启动扫描兜底
 try {
  const { getRunStore } = require('../core/run-store');
  const runStore = getRunStore();
  // P0-3(Runtime优化轮): 并发 Run 闸门——断连解耦后同用户可能短暂并存多个 run,
  // 超过上限时抢占最旧的(与新消息抢占语义一致),防异常客户端叠流。
  const maxActive = Number(process.env.CRABPAW_MAX_ACTIVE_RUNS) || 2;
  const actives = runStore.listActiveRunsByUser(userId);
  if (actives.length >= maxActive) {
   const toKill = actives.slice(0, actives.length - maxActive + 1);
   for (const old of toKill) {
    runStore.requestCancel(old.runId);
    console.warn(`[chat-handler] 并发 Run 超限(${actives.length}/${maxActive})，抢占最旧 run ${old.runId}`);
   }
   try {
    const { globalRequestInterrupt } = require('../core/request-interrupt');
    globalRequestInterrupt.abort(userId); // 中止最近注册的在飞 LLM 流
   } catch (e) { console.warn('[chat-handler] 抢占中止失败:', e?.message || e); }
  }
  runStore.startRun({ runId: roundId, userId, conversationId: sessionId });
 } catch (e) { console.warn('[chat-handler] run 注册失败(不阻塞):', e?.message || e); }

 // 2026-08-15 A3(AG-UI 合规): /events 通道补 run:start——此前只连 /events 的
 // 标准客户端永远见不到 run 开始(adapter 映射为 RUN_STARTED)
 try { broadcastEvent('run:start', { roundId, userId, threadId: sessionId || userId, userInput: String(processedMessage || '').slice(0, 500) }); } catch (e) { console.error('[chat-handler] 广播 run:start 失败:', e.message); }

 // AG-UI: RUN_STARTED 补发(roundId 此刻才生成; 1062 行的旧协议 start 帧保持不变)
 aguiWrite([aguiAdapter.buildRunStarted({ runId: roundId, threadId: sessionId || userId, input: { message: processedMessage } })].filter(Boolean));

 // 2026-08-13 P2-2: 流终态标志——修复"错误/中断被记成正常完成"的语义错位
 let streamErrored = false;
 let streamInterrupted = false;

 // 2026-08-15 P1-7: 请求发起即启动空闲计时(此前仅首个 chunk 到达才启动,
 // 首字节前静默断流永远不超时)
 resetIdleTimer();
 // P0-4(Runtime优化轮): TTFT 采集——首个 chunk(含 thinking)相对流发起的毫秒数,
 // 随 run-usage 落进 run 记录,SLO 报告按它建立基线
 const streamStartAt = Date.now();
 let ttftRecorded = false;
 // eslint-disable-next-line no-unused-vars -- chatStream 调用驱动流式输出（副作用），返回值未用
 const reply = await ctx.ai.chatStream(voiceOptimizedConfig, ctx.skills, userId, voiceProcessedMessage, (chunk) => {
 // 收到任何数据 → 重置空闲超时
 resetIdleTimer();
 if (!ttftRecorded) {
  ttftRecorded = true;
  if (roundId) {
   try { require('../core/run-usage').recordTtft(roundId, Date.now() - streamStartAt); } catch (e) { /* best-effort */ }
  }
 }

  if (chunk.done && chunk.content && chunk.type !== 'thinking') {
   // done+content 通常是 prepareChatContext 返回的错误（如缺少 API 密钥）——
   // 线上 SSE 协议不变(error 下发),但 run 终态记为 error 而非 finished
   // 2026-08-15 D12: error 帧补 roundId(与 done/interrupted 帧对齐, 前端可轮次级定位)
   streamErrored = true;
   safeWrite('data: ' + JSON.stringify({ type: 'error', content: chunk.content, roundId }) + '\n\n');
  }
  else if (chunk.content && chunk.type !== 'thinking' && !chunk.done) {
   fullReply += chunk.content;
   fullReply = stripToolTagsOnly(fullReply);
   safeWrite('data: ' + JSON.stringify({ type: 'chunk', content: chunk.content }) + '\n\n');
   aguiWrite(aguiAdapter.mapStreamChunk('chunk', chunk, aguiCtx()));
  }
 if (chunk.type === 'thinking' && chunk.content !== 'thinking_start') {
 safeWrite('data: ' + JSON.stringify({ type: 'thinking', content: chunk.content }) + '\n\n');
 aguiWrite(aguiAdapter.mapStreamChunk('thinking', chunk, aguiCtx()));
 // 2026-08-03: 同步广播到 /events——DocReader 生成舱/TaskPanelHost 消费（此前仅 POST /chat 流，/events 消费者收不到）
 // 2026-08-15 A2: 注入 roundId——/events 通道 AG-UI 帧此前缺 run 关联(_runIdOf 得 undefined)
 try { broadcastEvent('thinking', { ...chunk, roundId }); } catch (e) { console.error('[chat-handler] 广播 thinking 失败:', e.message); }
 }
 if (chunk.type === `tool_call`) {
 safeWrite(`data: ` + JSON.stringify(chunk) + `\n\n`);
 aguiWrite(aguiAdapter.mapStreamChunk('tool_call', chunk, aguiCtx()));
 // 2026-08-03: 广播到 /events——TaskPanelHost 任务卡/DocReader 触发
 // 2026-08-15 D3/D4(审计 P0): 删除重复 recordToolEvent——ai.js onToolStart 已记
 // (带 cardState), 此处再记导致 /events 双份日志; 且原 summary 拼 raw toolArgs
 // 未经脱敏即广播/打印(Bash 参数常含 token/密码), 一并随删除消除。
 // 2026-08-15 A2: 注入 roundId(/events 通道 AG-UI 帧 run 关联)
 try { broadcastEvent('tool_call', { ...chunk, roundId }); } catch (e) { console.error('[chat-handler] 广播 tool_call 失败:', e.message); }
 }
 if (chunk.type === `tool_result`) {
 safeWrite(`data: ` + JSON.stringify(chunk) + `\n\n`);
 aguiWrite(aguiAdapter.mapStreamChunk('tool_result', chunk, aguiCtx()));
 // 2026-08-03: 广播到 /events——TaskPanelHost 任务卡状态更新
 // 2026-08-15 D3: 删除重复 recordToolEvent(ai.js onToolEnd 已记, 含 cardState/resultPayload)
 // 2026-08-15 A2: 注入 roundId(/events 通道 AG-UI 帧 run 关联)
 try { broadcastEvent('tool_result', { ...chunk, roundId }); } catch (e) { console.error('[chat-handler] 广播 tool_result 失败:', e.message); }
 }
 if (chunk.file_generated) {
 safeWrite(`data: ` + JSON.stringify({ type: `file_generated`, file: chunk.file_generated }) + `\n\n`);
 aguiWrite(aguiAdapter.mapStreamChunk('file_generated', { file: chunk.file_generated }, aguiCtx()));
 // 2026-08-03: 广播到 /events——DocReader 生成舱 morph 阅读器 / Dashboard 文件消息
 try { broadcastEvent('file_generated', chunk.file_generated); } catch (e) { console.error('[chat-handler] 广播 file_generated 失败:', e.message); }
 }
 if (chunk.type === `subagent`) {
 safeWrite(`data: ` + JSON.stringify(chunk) + `\n\n`);
 aguiWrite(aguiAdapter.mapStreamChunk('subagent', chunk, aguiCtx()));
 // 2026-08-03: 广播到 /events——CollabOrbit 协作轨道消费 subagent:start/end
 try { broadcastEvent('subagent', chunk); } catch (e) { console.error('[chat-handler] 广播 subagent 失败:', e.message); }
 }
 if (chunk.type === `eval_start` || chunk.type === `eval_done`) {
 safeWrite(`data: ` + JSON.stringify(chunk) + `\n\n`);
 aguiWrite(aguiAdapter.mapStreamChunk(chunk.type, chunk, aguiCtx()));
 // 2026-08-18 AG-UI 协议化: eval 周期同步到 /events 总线(turn-tracker 依赖它派生 step 边界)
 try { broadcastEvent(chunk.type, { ...chunk, roundId }); } catch (e) { console.error('[chat-handler] 广播 eval 事件失败:', e.message); }
 }
 if (chunk.type === `loop_warning`) {
 safeWrite(`data: ` + JSON.stringify(chunk) + `\n\n`);
 aguiWrite(aguiAdapter.mapStreamChunk('loop_warning', chunk, aguiCtx()));
 // 2026-08-13 P2-2: loop_warning 同步广播到 /events(此前仅单客户端 SSE)
 try { broadcastEvent('loop_warning', chunk); } catch (e) { console.error('[chat-handler] 广播 loop_warning 失败:', e.message); }
 }
 // 2026-08-13 P2-2: phase 事件转发(此前被静默丢弃——前端 useChatStream 已实现只差后端一行)
 if (chunk.type === 'phase') {
 safeWrite('data: ' + JSON.stringify({ ...chunk, roundId }) + '\n\n');
 aguiWrite(aguiAdapter.mapStreamChunk('phase', { ...chunk, roundId }, aguiCtx()));
 try { broadcastEvent('phase', { roundId, ...chunk }); } catch (e) { console.error('[chat-handler] 广播 phase 失败:', e.message); }
 }
 // 2026-08-15 D6(审计 P1): route 事件转发——ai.js 发 {type:'route', useMultiAgent}
 // 但此处无分支(死契约), 前端 useChatStream 的 onRoute case 永不触发。转发后
 // 多智能体分流在 /chat 流可见。
 if (chunk.type === 'route') {
 safeWrite('data: ' + JSON.stringify({ ...chunk, roundId }) + '\n\n');
 aguiWrite(aguiAdapter.mapStreamChunk('route', { ...chunk, roundId }, aguiCtx()));
 }
 // 2026-08-13 P2-2: 用户停止/空闲超时中断标记(ai.js abort 路径发出)
 if (chunk.type === 'interrupted') {
 streamInterrupted = true;
 safeWrite('data: ' + JSON.stringify({ type: 'interrupted', roundId }) + '\n\n');
 aguiWrite([aguiAdapter.buildRunInterrupted(aguiCtx())].filter(Boolean));
 }
 // 2026-08-15 P1-4: roundId 显式传给 chatStream——流内工具事件/轨迹锚定本轮
 // (此前 ai.js 内 recordToolEvent 依赖 activity-stream 全局 _currentRoundId 回退,
 // 并发双流错乱); P1-7: 外部 interruptSignal 注入流读取; 审查返工 Important-1:
 // 额外传 getIdleSignal——ai.js 每轮 fetch 前取"当前"空闲信号合并, 超时 abort
 // 后 handler 已换新 controller, 后续轮次不再被一次性 latch 误杀。
 // 2026-08-15 T7(累积H): 静态 interruptSignal 仅为初始快照兜底——ai.js
 // createStreamInterruptRelay 优先消费 getIdleSignal()(动态取当前 controller),
 // interruptSignal 只在未提供 getIdleSignal 时作为惰性回退(见 ai.js:2650 附近)。
 }, { sessionId, roundId, interruptSignal: idleAbort.signal, getIdleSignal: () => idleAbort.signal, rawUserMessage });
 if (idleTimer) clearTimeout(idleTimer);

 ai.setSubAgentCallback(null);

 // 2026-08-13 P2-2: 流终态分流——error/interrupt 不补发 done、不记 end(修复语义错位)
 const now = Date.now();
 const finishRun = (status) => {
  try {
   // 2026-08-14 GUI 全量修复 P1: require 路径修复——run-store 实际在 src/core/
   // (旧路径 './run-store' 从 src/handlers/ 解析 → MODULE_NOT_FOUND 被 catch 吞 →
   // run:finished 广播从不发出 + RunStore 从不落盘, 终态徽章/恢复横幅失效)
   const { getRunStore } = require('../core/run-store');
   const { endRunUsage } = require('../core/run-usage');
   const runStore = getRunStore();
   // B2(Runtime差距分析): 取消请求置位 → 终态记 cancelled(区别于用户断连/超时的 interrupted)
   const runRec = roundId ? runStore.getRunRecord(roundId) : null;
   if (status === 'interrupted' && runRec && runRec.cancelRequested) status = 'cancelled';
   // B5(Runtime差距分析): per-run 用量随终态落盘(LLM 次数/Token/费用/工具次数)
   const runUsage = roundId ? endRunUsage(roundId) : null;
   const runBase = { roundId, userId, status, ts: now };
   if (status === 'error') {
    // 2026-08-15 D2(审计 P0): 显式传 roundId——此前 fallback _currentRoundId,
    // 连发消息时旧流终态在新请求 recordLLMEvent('start') 之后执行 → 新轮被
    // 误标失败(roundId 污染)。三处 recordLLMEvent 全显式锚定本轮。
    globalActivityStream.recordLLMEvent('error', { summary: '回复生成失败', roundId });
    broadcastEvent('run:error', { ...runBase, ts: now, usage: runUsage });
   } else if (status === 'interrupted' || status === 'cancelled') {
    // 2026-08-15 P2-9: 用户中断/断连记 interrupt 相位(此前记 error → 前端呈现
    // 模型出错红标)。前端按事件类型区分中断与出错; 不破坏既有 error 路径。
    // B2: cancelled 额外带标记,前端可区分"显式停止"与"连接中断"。
    globalActivityStream.recordLLMEvent('interrupt', { summary: status === 'cancelled' ? '用户停止' : (clientClosed ? '连接已断开' : '用户中断'), roundId });
    broadcastEvent('run:interrupt', { ...runBase, ts: now, cancelled: status === 'cancelled', usage: runUsage });
   } else {
    safeWrite('data: ' + JSON.stringify({ type: 'done', content: fullReply, speak: speakEnabled, roundId }) + '\n\n');
    aguiWrite([aguiAdapter.buildRunFinishedSuccess({ runId: roundId, threadId: sessionId || userId }, { content: fullReply })].filter(Boolean));
    globalActivityStream.recordLLMEvent('end', { roundId });
    // 2026-08-20 终审 C1: 生产顺序 run:finished 先于下方 gui_reply 广播，而
    // decision-recorder 在 seal 后即删除 run——迟到的 gui_reply 永远命中守卫，
    // 决策 conclusion 恒空。这里把最终回复随 run:finished 一并送出（仅 finished
    // 分支；error/interrupted 无最终回复是合法语义），顺序无关。
    broadcastEvent('run:finished', { ...runBase, ts: now, content: fullReply, usage: runUsage });
   }
   runStore.save(userId, { ...runBase, conversationId: sessionId, digest: runDigestFor(userId, roundId), lastContent: fullReply });
   // B2/B5: runId 级终态记录(活跃索引移除 + 历史记录落盘 + usage 关联)
   try { runStore.finishRunRecord(roundId, status, { usage: runUsage, digest: runDigestFor(userId, roundId), lastContent: fullReply, conversationId: sessionId }); } catch (e) { console.warn('[chat-handler] run 终态记录失败(不阻塞):', e?.message || e); }
  } catch (runErr) {
   // run 终态处理失败不阻塞主流程——回退旧行为(仅发 done)
   console.warn('[chat-handler] run 终态处理失败(回退):', runErr?.message || runErr);
   if (status === 'finished') {
    safeWrite('data: ' + JSON.stringify({ type: 'done', content: fullReply, speak: speakEnabled, roundId }) + '\n\n');
    globalActivityStream.recordLLMEvent('end');
   }
  }
 };
 if (streamErrored) finishRun('error');
 // B4(Runtime差距分析): clientClosed 不再归入 interrupted——断连后 run 继续执行,
 // 自然跑完即为 finished(内容已完整落库,刷新回来的用户能看到完整回复)。
 else if (streamInterrupted) finishRun('interrupted');
 else finishRun('finished');

 // 同步广播
 if (fullReply) {
 broadcastEvent('gui_reply', { roundId, userId, content: fullReply, timestamp: Date.now() });
 }

 // 同步到频道（Electron→频道 方向，与 _processChannelMessage 的频道→Electron 方向互补）
 if (fullReply && syncMode === 'wecom_sync' && channels.includes('wecom') && userConfig.wecomUserId && ctx.wecom && ctx.wecom.isConfigured()) {
 try {
 const wecomReply = cleanReplyForUser(fullReply, true);
 await ctx.wecom.send(userConfig.wecomUserId, wecomReply, 'single');
 console.log('📡 [GUI→企微] 流式回复已同步:', wecomReply.substring(0, 50));
 } catch (syncErr) {
 console.warn('⚠️ [GUI→企微] 流式回复同步失败:', syncErr.message);
 }
 }
 if (fullReply && syncMode === 'lark_sync' && channels.includes('lark') && userConfig.larkUserId && ctx.lark && typeof ctx.lark.isConfigured === 'function' && ctx.lark.isConfigured()) {
 try {
 await ctx.lark.send(userConfig.larkUserId, fullReply);
 console.log('📡 [GUI→飞书] 流式回复已同步:', fullReply.substring(0, 50));
 } catch (syncErr) {
 console.warn('⚠️ [GUI→飞书] 流式回复同步失败:', syncErr.message);
 }
 }
 } catch (streamErr) {
 console.error('❌ 流式聊天失败:', streamErr.message);
 // 2026-08-15 D12: error 帧补 roundId(与 done/interrupted 帧对齐)
 safeWrite('data: ' + JSON.stringify({ type: 'error', content: streamErr.message, roundId }) + '\n\n');
 // 关键：LLM 失败时必须 emit 'error' 事件，防止 round 永久卡在"思考中"
 // 2026-08-15 P1-4: 显式传 roundId——此前 catch 路径回退全局 _currentRoundId,
 // 连发消息时旧流异常会把新轮误标失败(roundId 污染)。
 try { globalActivityStream.recordLLMEvent('error', { summary: `推理失败: ${streamErr.message}`, detail: streamErr.message, roundId }); } catch (e) { console.warn('[chat] Failed to record LLM event:', e); }
 // 2026-08-13 P2-2: 异常路径补 run:error 广播 + RunStore 快照
 try {
  // 2026-08-14 GUI 全量修复 P1: require 路径修复(同 finishRun)
  const { getRunStore } = require('../core/run-store');
  const { endRunUsage } = require('../core/run-usage');
  const errUsage = roundId ? endRunUsage(roundId) : null;
  broadcastEvent('run:error', { roundId, userId, status: 'error', ts: Date.now(), error: streamErr.message, usage: errUsage });
  getRunStore().save(userId, { roundId, status: 'error', ts: Date.now(), digest: runDigestFor(userId, roundId), lastContent: fullReply });
  try { getRunStore().finishRunRecord(roundId, 'error', { error: streamErr.message, usage: errUsage, digest: runDigestFor(userId, roundId), lastContent: fullReply, conversationId: sessionId }); } catch (e3) { console.warn('[chat-handler] run 终态记录失败(不阻塞):', e3?.message || e3); }
 } catch (e2) { console.warn('[chat-handler] run:error 处理失败:', e2?.message || e2); }
 } finally {
 clearInterval(heartbeat);
 ai.setSubAgentCallback(null);
 try { res.end(); } catch(e) { console.warn("[chat-handler]", e?.message) }
 }

 return;
 }

 // 非流式处理
 let reply = '';
 try {
 if (projectId) {
 ctx.appConfig.activeProjectId = projectId;
 } else {
 delete ctx.appConfig.activeProjectId;
 }
 reply = await ctx.ai.chat(ctx.appConfig, ctx.skills, userId, processedMessage);
 ai.setSubAgentCallback(null);
 reply = cleanReplyForUser(reply, false);
 } catch (chatErr) {
 console.error('❌ 聊天失败:', chatErr.message);
 return sendError(res, 500, `Chat failed: ${chatErr.message}`);
 }

 if (reply && syncMode === 'wecom_sync' && channels.includes('wecom') && userConfig.wecomUserId && ctx.wecom && ctx.wecom.isConfigured()) {
 try {
 const wecomReply = cleanReplyForUser(reply, true);
 await ctx.wecom.send(userConfig.wecomUserId, wecomReply, 'single');
 console.log('📡 [GUI→企微] 回复已同步:', wecomReply.substring(0, 50));
 } catch (syncErr) {
 console.warn('⚠️ [GUI→企微] 回复同步失败:', syncErr.message);
 }
 }
 if (reply && syncMode === 'lark_sync' && channels.includes('lark') && userConfig.larkUserId && ctx.lark && typeof ctx.lark.isConfigured === 'function' && ctx.lark.isConfigured()) {
 try {
 await ctx.lark.send(userConfig.larkUserId, reply);
 console.log('📡 [GUI→飞书] 回复已同步:', reply.substring(0, 50));
 } catch (syncErr) {
 console.warn('⚠️ [GUI→飞书] 回复同步失败:', syncErr.message);
 }
 }
 const voiceConfig = ctx.appConfig?.voice || {};
 const speakEnabled = !!voiceConfig.replyEnabled;
 return sendJson(res, 200, { reply, type: 'chat_result', speak: speakEnabled });
 } catch (err) {
 console.error('❌ handleChat 异常:', err);
 return sendError(res, 500, `Internal error: ${err.message}`);
 }
}

/**
 * 飞书 Webhook 处理
 * 安全（S1）：公开路由，必须在 handler 层验签——飞书平台回调校验 body.token
 * == 配置的 verificationToken；本地飞书桥接器（event-bridge）携带 X-Api-Key 放行。
 */
async function handleWebhook(req, res, ctx) {
 try {
 const data = await readJsonBody(req, { maxSize: 5 * 1024 * 1024 });
 console.log('📩 [Webhook] 飞书回调:', JSON.stringify(data).substring(0, 200));

 // S1 验签：本地桥接器 X-Api-Key 或飞书平台 verificationToken 校验（失败即 401，不进流水线）
 const headerKey = String(req.headers['x-api-key'] || req.headers['X-Api-Key'] || '');
 const isTrustedBridge = !!headerKey && _safeEqual(headerKey, _getApiKey());
 if (!isTrustedBridge && !_verifyLarkCallback(ctx, data)) {
 return sendError(res, 401, 'Webhook signature verification failed');
 }

 // 飞书事件验证 challenge
 if (data.challenge) {
 return sendJson(res, 200, { challenge: data.challenge });
 }

 const senderId = data.event?.sender?.sender_id?.open_id
 || data.event?.sender?.sender_id?.user_id
 || data.senderId || data.sender_id || '';
 const content = data.event?.message?.content
 || data.content || '';
 const messageId = data.event?.message?.message_id || data.messageId || '';

 let parsedContent = content;
 try {
 const parsed = JSON.parse(content);
 parsedContent = parsed.text || content;
 } catch (e) { console.debug('[chat-handler] 响应非 JSON(按原样使用):', e?.message || e); }

 if (!senderId || !parsedContent) {
 return sendJson(res, 200, { success: true, message: 'ignored' });
 }

 const result = await _processChannelMessage({
 channelType: 'lark',
 senderId,
 content: parsedContent,
 chatId: data.event?.message?.chat_id || data.chatId || '',
 chatType: data.event?.message?.chat_type || data.chatType || 'p2p',
 messageId,
 rawEvent: data,
 }, ctx);

 return sendJson(res, 200, { success: true, result: result ? 'processed' : 'ignored' });
 } catch (err) {
 console.error('❌ handleWebhook 异常:', err.message);
 return sendError(res, 500, `Webhook error: ${err.message}`);
 }
}

/**
 * 企业微信 Webhook 处理
 * 安全（S1）：公开路由，必须在 handler 层验签——本地桥接器 X-Api-Key 放行，
 * 企微平台直连回调校验 query 的 msg_signature（token 取配置 wecom.token，
 * 未配置则安全降级拒绝 401）。
 */
async function handleWecomWebhook(req, res, ctx) {
 try {
 const data = await readJsonBody(req, { maxSize: 5 * 1024 * 1024 });
 console.log('📩 [Webhook] 企业微信回调:', JSON.stringify(data).substring(0, 200));

 // S1 验签（失败即 401，不进流水线）
 const auth = _authorizeWecomCallback(ctx, req, data);
 if (!auth.ok) {
 return sendError(res, 401, `Webhook signature verification failed: ${auth.reason || 'unauthorized'}`);
 }

 const payload = require('../channels/wecom').api.parseCallbackPayload(data);
 const { fromUserId, content, chatId, chatType, msgId, msgType: _msgType, files } = payload;

 if (!fromUserId && !content) {
 return sendJson(res, 200, { success: true, message: 'ignored' });
 }

 // 忽略自身消息
 if (fromUserId === ctx.appConfig?.wecom?.botId) {
 return sendJson(res, 200, { success: true, message: 'self-ignored' });
 }

 const senderId = fromUserId;
 // 2026-09-07: 接收人自动学习——主动推送（发文件/告警到企微）需要接收人 ID，
 // 而日常对话的接收人来自消息本身，用户从不需要手配。首次收到某用户的企微
 // 消息且 wecomUserId 未配置时，把该发送者记为默认接收人（user.json），
 // 此后"把文件发到企微"零配置可用。多用户场景首发送者成为默认，后续可手动改。
 try {
  if (senderId) {
   const fsSync = require('fs');
   const pathSync = require('path');
   const dataDirSync = ctx?.dataDir || process.env.CRABPAW_DATA_DIR || pathSync.join(__dirname, '..', '..', 'data', '.crabpaw');
   const userCfgPath = pathSync.join(dataDirSync, 'config', 'user.json');
   let userCfg = {};
   try { userCfg = JSON.parse(fsSync.readFileSync(userCfgPath, 'utf-8')); } catch (e) { /* 首次创建 */ }
   if (!userCfg.wecomUserId) {
    userCfg.wecomUserId = senderId;
    fsSync.mkdirSync(pathSync.dirname(userCfgPath), { recursive: true });
    const tmpPath = userCfgPath + '.tmp';
    fsSync.writeFileSync(tmpPath, JSON.stringify(userCfg, null, 2));
    fsSync.renameSync(tmpPath, userCfgPath);
    console.log(`🎭 [wecom] 接收人自动学习: wecomUserId=${senderId} (首次消息来源，可在设置中修改)`);
   }
  }
 } catch (learnErr) { console.warn('⚠️ [wecom] 接收人自动学习失败(不阻塞):', learnErr.message); }
 // 2026-09-06 修复: 此前成功路径不回响应——桥的 sendToWebhook promise 悬挂
 // 到超时；且即便补响应，await 完整处理也会让桥等几分钟。改为入队后立即
 // 202（处理在每用户串行队列中异步进行，回复经通道异步送达）。
 _enqueueUserMessage(senderId, async () => {
 return await _processChannelMessage({
 channelType: 'wecom',
 senderId,
 content,
 files: files && files.length > 0 ? files : undefined,
 chatId,
 chatType,
 messageId: msgId,
 rawEvent: data,
 }, ctx);
 }).catch((e) => console.error('❌ [wecom-webhook] 消息处理失败:', e.message));
 return sendJson(res, 202, { success: true, message: 'accepted' });
 } catch (err) {
 console.error('❌ handleWecomWebhook 异常:', err.message);
 return sendError(res, 500, `Webhook error: ${err.message}`);
 }
}

// 2026-09-06: 企微 HTTP 直连回调的 GET（回调 URL 验证）——直连模式为半成品
// （无 AES 解密），显式提示走 WS 桥，避免用户在企微后台配 URL 时对着 404 排查
function handleWecomCallbackHint(req, res) {
 return sendJson(res, 200, {
  success: false,
  message: '企微 HTTP 直连回调未启用（无 echostr 验证/AES 解密）。请使用企微 WebSocket 桥（channels/wecom/event-bridge.js）接收消息。',
 });
}

module.exports = { handleChat, handleWebhook, handleWecomWebhook, handleWecomCallbackHint, handleWorkflowComplete, _attachDisconnectCleanup };
