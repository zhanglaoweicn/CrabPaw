/**
 * 云端 ASR WebSocket 代理 — 完整自主实现
 *
 * 支持语音识别服务商：
 * aliyun — 阿里云百炼 Paraformer（默认首选）
 * tencent — 腾讯云 ASR
 * xunfei — 科大讯飞 RTASR
 * volcengine — 火山引擎豆包大模型流式 ASR
 * local — 仅 macOS 可用
 *
 * V2 改进：引入 speechFinal 语义层
 * - isFinal: 段级最终（segment complete，后续可能还有更多段）
 * - speechFinal: 句级最终（整个 utterance 完成，可提交）
 * - 新增 flushSpeechFinal(): flush 并将最后一段标记为 speechFinal
 */

'use strict';
const { getLogger } = require('../observability');
const log = getLogger({ module: 'voice' }).child('asr');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocket } = require('ws');

const MAX_PENDING_CHUNKS = 16;
// ─── 火山引擎豆包大模型流式 ASR ───
// 协议：自定义二进制帧，首包 gzip JSON full request，后续 gzip PCM audio only request。
// 端点统一用 bigmodel_async（官方文档：双向流式优化版，数据变化即返回、低延迟，推荐的实时端点）。
// 不要用 bigmodel_nostream（流式输入模式：音频>15s 或收到最后一包才返回）。bigmodel 为 legacy 双向流式。
const VOLC_BIGMODEL_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
// 新配置优先使用 ASR 2.0；未开通时，在握手 403 后无感回退到对应的 1.0 资源。
const VOLC_DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const VOLC_RESOURCE_FALLBACKS = new Map([
  ['volc.seedasr.sauc.duration', 'volc.bigasr.sauc.duration'],
  ['volc.seedasr.sauc.concurrent', 'volc.bigasr.sauc.concurrent'],
]);
const VOLC_PROTOCOL_VERSION = 0x1;
const VOLC_HEADER_SIZE = 0x1;
const VOLC_SERIALIZATION_NONE = 0x0;
const VOLC_SERIALIZATION_JSON = 0x1;
const VOLC_COMPRESSION_GZIP = 0x1;
const VOLC_MESSAGE_FULL_CLIENT_REQUEST = 0x1;
const VOLC_MESSAGE_AUDIO_ONLY_REQUEST = 0x2;
const VOLC_MESSAGE_FULL_SERVER_RESPONSE = 0x9;
const VOLC_MESSAGE_ERROR = 0xf;
const VOLC_FLAG_NO_SEQUENCE = 0x0;
const VOLC_FLAG_LAST_NO_SEQUENCE = 0x2;

function isValidAliyunAsrKey(value) {
 return /^sk-[A-Za-z0-9_\-.]{20,}$/.test(String(value || '').trim());
}

// ─── 错误结构化分类（2026-08-14 fix）───
// 任何 provider 的 onError 都附类别，前端据此区分可重试性：
//   auth    — 401/403/鉴权/token 类，重试无意义
//   network — 断线/超时/连接重置类，可重试
//   rate    — 429/限流类，可重试
//   other   — 其余
function classifyASRError(err) {
 const message = (err && typeof err.message === 'string') ? err.message : String(err || '未知错误');
 const code = Number(err && (err.code ?? err.status ?? err.statusCode)) || 0;
 let category = 'other';
 if (code === 401 || code === 403 || /401|403|unauthorized|forbidden|token|expired|无效.*appid|鉴权|认证失败|api.?key/i.test(message)) {
   category = 'auth';
 } else if (code === 429 || /429|rate.?limit|too many|限流|配额/i.test(message)) {
   category = 'rate';
 } else if (/econnreset|econnrefused|enotfound|etimedout|esockettimedout|timed out|timeout|超时|断线|网络|connection reset|abort/i.test(message)) {
   category = 'network';
 }
 return category;
}

/**
 * 给错误附 category：原对象可写则直接附加并返回；不可写（frozen 等）则包一层
 * { message, category } 传给 onError。onError 消费方需同时兼容 Error/字符串/包装对象。
 */
function attachErrorCategory(err) {
 const message = (err && typeof err.message === 'string') ? err.message : String(err || '未知错误');
 const category = classifyASRError(err);
 const target = (err && typeof err === 'object') ? err : {};
 try {
   target.category = category;
   if (!target.message) target.message = message;
   return target;
 } catch (e) {
   // 错误对象不可写（罕见）——包一层纯数据对象
   log.warn('ASR 错误对象不可写，改用包装对象:', e.message);
   return { message, category };
 }
}

// ─── 阿里云 Paraformer ───
function createAliyunSession(apiKey, lang, onTranscript, onError, onClose, onEvent, model) {
 const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference/';
 const taskId = crypto.randomUUID();
 let ready = false, finishing = false;
 const pending = [];
 let pendingFlush = false;
 // V2: 跟踪最近的 segment 用于 speechFinal
 let lastSeg = null;
 let lastSegText = '';
 // 2026-08-14: 记录已预发的 speechFinal 文本——task-finished 与 flushSpeechFinal
 // 预发重复同一段时跳过(此前靠前端 includes 去重兜底)
 let lastSpeechFinalText = '';

 const ws = new WebSocket(WS_URL, {
 headers: { Authorization: `bearer ${apiKey}` },
 });

 ws.on('open', () => {
 const langCode = (lang === 'zh' || !lang) ? 'zh' : lang;
 ws.send(JSON.stringify({
 header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
 payload: {
 task_group: 'audio', task: 'asr', function: 'recognition',
 model: model || 'paraformer-realtime-v2',
 parameters: { sample_rate: 16000, format: 'pcm', language_hints: [langCode], punctuation_prediction: true, inverse_text_normalization: true },
 input: {},
 },
 }));
 ready = true;
 for (const buf of pending) { try { ws.send(buf); } catch (e) { log.error('阿里云会话建立后发送缓存音频块失败:', { error: e }); } }
 pending.length = 0;
 if (pendingFlush) {
 pendingFlush = false;
 finishing = true;
 try { ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } })); } catch (e) { log.error('阿里云 flush 发送失败:', { error: e }); }
 }
 });

 ws.on('message', (data) => {
 try {
 const msg = JSON.parse(data.toString());
 const event = msg?.header?.event;
 if (event === 'result-generated') {
 const sentence = msg?.payload?.output?.sentence;
 if (sentence?.text) {
 const seg = sentence.begin_time != null ? `a${sentence.begin_time}` : null;
 const isFinal = sentence.status === 'sentence_end';
 // V2: 阿里云 sentence_end 后如果是 task-finished，最后一句即为 speechFinal
 // 这里先按 isFinal 上报，flushSpeechFinal 时会再发一次 speechFinal 标记
 onTranscript(sentence.text, isFinal, seg, false);
 lastSeg = seg;
 lastSegText = sentence.text;
 }
 } else if (event === 'task-failed') {
 onEvent?.('task-failed', msg?.header?.error_message);
 onError(attachErrorCategory(msg?.header?.error_message || '阿里云 ASR 错误'));
 } else if (event === 'task-finished') {
 // V2: task-finished 时标记最后一段为 speechFinal
 // 2026-08-14: flushSpeechFinal 已预发过相同文本则跳过(去重,不改变最终行为)
 if (lastSeg && lastSegText && lastSegText !== lastSpeechFinalText) {
 onTranscript(lastSegText, true, lastSeg, true);
 }
 onEvent?.(event);
 if (!finishing) { try { ws.close(); } catch (e) { log.error('阿里云 task-finished 后关闭 WebSocket 失败:', { error: e }); } }
 } else {
 onEvent?.(event);
 }
 } catch (e) { log.error('阿里云 WebSocket 消息解析失败:', { error: e }); }
 });

 ws.on('error', (err) => { pending.length = 0; onError(attachErrorCategory(err)); });
 ws.on('close', () => { pending.length = 0; onClose(); });

 return {
 sendAudio(buf) {
 if (!ready) { pending.push(buf); return; }
 if (ws.readyState === WebSocket.OPEN) ws.send(buf);
 },
 flush() {
 if (!ready) { pendingFlush = true; return; }
 if (ws.readyState !== WebSocket.OPEN) return;
 finishing = true;
 ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
 },
 // V2: flush 并将最后一段标记为 speechFinal
 flushSpeechFinal() {
 if (lastSeg && lastSegText) {
 onTranscript(lastSegText, true, lastSeg, true);
 lastSpeechFinalText = lastSegText;
 }
 this.flush();
 },
 close() { try { ws.close(); } catch (e) { log.error('阿里云会话关闭失败:', { error: e }); } },
 };
}

// ─── 腾讯云 ASR ───
function createTencentSession(secretId, secretKey, appId, lang, onTranscript, onError, onClose) {
 const host = 'asr.cloud.tencent.com';
 const path = `/asr/v2/${appId}`;
 const ts = Math.floor(Date.now() / 1000);
 const nonce = Math.floor(Math.random() * 1000000);
 const params = { secretid: secretId, timestamp: ts, expired: ts + 86400, nonce, engine_model_type: lang === 'zh' ? '16k_zh' : '16k_en', voice_format: 1, needvad: 1 };
 const sortedQuery = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
 const signature = crypto.createHmac('sha256', secretKey).update(`${host}${path}?${sortedQuery}`).digest('base64');
 const ws = new WebSocket(`wss://${host}${path}?${sortedQuery}&signature=${encodeURIComponent(signature)}`);
 let ready = false;
 const pending = [];
 // V2: 跟踪最近的 segment 用于 speechFinal
 let lastSeg = null;
 let lastSegText = '';
 let hasAnyTranscript = false;

 ws.on('open', () => { ready = true; for (const buf of pending) { try { ws.send(buf); } catch (e) { log.error('腾讯云会话建立后发送缓存音频块失败:', { error: e }); } } pending.length = 0; });
 ws.on('message', (data) => {
 try {
 const msg = JSON.parse(data.toString());
 if (msg.code !== 0) { onError(attachErrorCategory({ message: `腾讯云 ASR 错误: ${msg.message}`, code: msg.code })); return; }
 const result = msg.result;
 if (result?.voice_text_str) {
 const seg = result.index != null ? `t${result.index}` : null;
 const isFinal = result.slice_type === 2;
 // V2: 腾讯云没有原生 utterance final，最后一段在 flushSpeechFinal 时标记
 onTranscript(result.voice_text_str, isFinal, seg, false);
 lastSeg = seg;
 lastSegText = result.voice_text_str;
 hasAnyTranscript = true;
 }
 } catch (e) { log.error('腾讯云 WebSocket 消息解析失败:', { error: e }); }
 });
 ws.on('error', (err) => { pending.length = 0; onError(attachErrorCategory(err)); });
 ws.on('close', () => { pending.length = 0; onClose(); });

 return {
 sendAudio(buf) {
 if (!ready) { pending.push(buf); return; }
 if (ws.readyState === WebSocket.OPEN) ws.send(buf);
 },
 flush() { try { ws.close(); } catch (e) { log.error('腾讯云会话 flush 关闭失败:', { error: e }); } },
 // V2: flush 并将最后一段标记为 speechFinal
 flushSpeechFinal() {
 if (hasAnyTranscript && lastSeg && lastSegText) {
 onTranscript(lastSegText, true, lastSeg, true);
 }
 this.flush();
 },
 close() { try { ws.close(); } catch (e) { log.error('腾讯云会话关闭失败:', { error: e }); } },
 };
}

// ─── 科大讯飞 RTASR ───
function createXunfeiSession(appId, apiKey, lang, onTranscript, onError, onClose) {
 const ts = Math.floor(Date.now() / 1000).toString();
 const signa = crypto.createHmac('sha1', apiKey).update(crypto.createHash('md5').update(appId + ts).digest('hex')).digest('base64');
 const ws = new WebSocket(`wss://rtasr.xfyun.cn/v1/ws?appid=${appId}&ts=${ts}&signa=${encodeURIComponent(signa)}&lang=${lang === 'en' ? 'en_us' : 'cn'}`);
 let ready = false;
 const pending = [];
 let pendingFlush = false;
 // V2: 跟踪最近的 segment 用于 speechFinal
 let lastSeg = null;
 let lastSegText = '';
 let hasAnyTranscript = false;

 ws.on('open', () => {
 ready = true;
 for (const buf of pending) { try { ws.send(buf); } catch (e) { log.error('讯飞会话建立后发送缓存音频块失败:', { error: e }); } }
 pending.length = 0;
 if (pendingFlush) {
 pendingFlush = false;
 try { ws.send(JSON.stringify({ end: true })); } catch (e) { log.error('讯飞 flush 发送失败:', { error: e }); }
 }
 });
 ws.on('message', (data) => {
 try {
 const msg = JSON.parse(data.toString());
 if (msg.action === 'error') { onError(attachErrorCategory({ message: `讯飞 RTASR 错误: ${msg.desc}`, code: msg.code })); return; }
 if (msg.action === 'result') {
 const parsed = JSON.parse(msg.data);
 const text = (parsed.ws || []).flatMap(w => w.cw || []).map(c => c.w || '').join('');
 if (text) {
 const isFinal = parsed.type === '1';
 const seg = isFinal ? `xf_${parsed.sn || Date.now()}` : null;
 // V2: 讯飞没有原生 utterance final，最后一段在 flushSpeechFinal 时标记
 onTranscript(text, isFinal, seg, false);
 if (isFinal) { lastSeg = seg; lastSegText = text; hasAnyTranscript = true; }
 }
 }
 } catch (e) { log.error('讯飞 WebSocket 消息解析失败:', { error: e }); }
 });
 ws.on('error', (err) => { pending.length = 0; onError(attachErrorCategory(err)); });
 ws.on('close', () => { pending.length = 0; onClose(); });

 return {
 sendAudio(buf) {
 if (!ready) { pending.push(buf); return; }
 if (ws.readyState === WebSocket.OPEN) ws.send(buf);
 },
 flush() {
 if (!ready) { pendingFlush = true; return; }
 if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ end: true }));
 },
 // V2: flush 并将最后一段标记为 speechFinal
 flushSpeechFinal() {
 if (hasAnyTranscript && lastSeg && lastSegText) {
 onTranscript(lastSegText, true, lastSeg, true);
 }
 this.flush();
 },
 close() { try { ws.close(); } catch (e) { log.error('讯飞会话关闭失败:', { error: e }); } },
 };
}

// ─── 火山引擎 ASR ───
function makeVolcHeader(messageType, flags, serialization, compression) {
 return Buffer.from([(VOLC_PROTOCOL_VERSION << 4) | VOLC_HEADER_SIZE, (messageType << 4) | flags, (serialization << 4) | compression, 0x00]);
}
function makeVolcFrame(messageType, flags, serialization, payload) {
 const body = zlib.gzipSync(payload && payload.length ? payload : Buffer.alloc(0));
 const size = Buffer.alloc(4); size.writeUInt32BE(body.length, 0);
 return Buffer.concat([makeVolcHeader(messageType, flags, serialization, VOLC_COMPRESSION_GZIP), size, body]);
}
function makeVolcFullClientRequest(lang) {
 const langCode = lang === 'zh' ? 'zh-CN' : lang;
 return makeVolcFrame(VOLC_MESSAGE_FULL_CLIENT_REQUEST, VOLC_FLAG_NO_SEQUENCE, VOLC_SERIALIZATION_JSON,
 Buffer.from(JSON.stringify({ user: { uid: 'crabpaw' }, audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1, language: langCode || 'zh-CN' }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, enable_ddc: false, result_type: 'full', show_utterances: true } }), 'utf-8'));
}
function makeVolcAudioFrame(pcmBuffer, isLast = false) {
 return makeVolcFrame(VOLC_MESSAGE_AUDIO_ONLY_REQUEST, isLast ? VOLC_FLAG_LAST_NO_SEQUENCE : VOLC_FLAG_NO_SEQUENCE, VOLC_SERIALIZATION_NONE, Buffer.from(pcmBuffer || Buffer.alloc(0)));
}
function parseVolcResponse(data) {
 const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
 if (buf.length < 8) return null;
 const headerSize = (buf[0] & 0x0f) * 4, messageType = (buf[1] >> 4) & 0x0f, flags = buf[1] & 0x0f, compression = buf[2] & 0x0f;
 let offset = headerSize;
 if (messageType === VOLC_MESSAGE_ERROR) {
 const code = buf.readUInt32BE(offset); offset += 4;
 const size = buf.readUInt32BE(offset); offset += 4;
 return { error: `火山 ASR 错误 ${code}: ${buf.slice(offset, offset + size).toString('utf-8')}` };
 }
 if (messageType !== VOLC_MESSAGE_FULL_SERVER_RESPONSE) return null;
 if (flags === 0x1 || flags === 0x3) offset += 4;
 if (buf.length < offset + 4) return null;
 const size = buf.readUInt32BE(offset); offset += 4;
 let payload = buf.slice(offset, offset + size);
 if (compression === VOLC_COMPRESSION_GZIP && payload.length) payload = zlib.gunzipSync(payload);
 const text = payload.toString('utf-8');
 if (!text) return null;
 return { body: JSON.parse(text), isLast: flags === 0x3 };
}
// 火山 result 是「累积」的：每帧带从头到现在的全部 utterances（最后一条通常是非 definite 的
// 当前句，前面的是 definite 已定句）。逐条下发、用「会话 ID + 累积列表稳定下标」作 seg，正好套进前端
// 那套（与阿里云一致）按 seg 去重/替换的累积模型：definite→final 入库、非 definite→interim 显示。
// 不要把它们拼成一坨整段重发——那样跨多句会被前端当新内容反复追加，导致重复/错乱。
// V2: 新增 speechFinal 参数 — 当 isLast=true 时最后一条 definite utterance 标记为 speechFinal
function emitVolcTranscripts(body, isLast, onTranscript, sessionId) {
 const results = Array.isArray(body?.result) ? body.result : (body?.result ? [body.result] : []);
 const utterances = results.flatMap(r => Array.isArray(r?.utterances) ? r.utterances : []);
 if (utterances.length > 0) {
   utterances.forEach((u, i) => {
     if (!u?.text) return;
     const isDefinite = !!u.definite;
     // V2: isLast 时最后一条 definite utterance 即为 speechFinal
     const isSpeechFinal = isLast && isDefinite && (i === utterances.length - 1 || !utterances.slice(i + 1).some(x => x?.definite));
     onTranscript(u.text, isDefinite, `v${sessionId}:${i}`, isSpeechFinal);
   });
   return;
 }
 // 兜底：没有 utterances 字段时用整段 text，常量 seg 让前端替换而非追加
 const text = results.map(r => r?.text || '').filter(Boolean).join('');
 if (text) onTranscript(text, !!isLast, `v${sessionId}:full`, !!isLast);
}

function createVolcengineSession(config, lang, onTranscript, onError, onClose, onEvent) {
 const requestId = crypto.randomUUID();
 let resourceId = config.volcAsrResourceId || VOLC_DEFAULT_RESOURCE_ID;
 let ws = null;
 let ready = false;
 let closed = false;
 let closeNotified = false;
 let flushRequested = false;
 // 2026-08-14: 网络类断开自动重连一次（同一 requestId,保留未发送 PCM 上下文）
 let reconnectAttempted = false;
 let networkErrorSeen = false;
 const pending = [];

 function notifyClose() {
   if (closeNotified) return;
   closeNotified = true;
   onClose();
 }

 function connect(nextResourceId) {
   resourceId = nextResourceId;
   ready = false;
   const headers = {
     'X-Api-Resource-Id': resourceId,
     'X-Api-Request-Id': requestId,
     'X-Api-Connect-Id': requestId,
     'X-Api-Sequence': '-1',
   };
   if (config.volcAsrApiKey) {
     headers['X-Api-Key'] = config.volcAsrApiKey;
   } else {
     headers['X-Api-App-Key'] = config.volcAsrAppKey;
     headers['X-Api-Access-Key'] = config.volcAsrAccessKey;
   }
   log.info('火山引擎连接', { url: VOLC_BIGMODEL_ASR_URL, resourceId, apiKey: config.volcAsrApiKey ? config.volcAsrApiKey.substring(0, 8) + '...' : 'N/A' });
   onEvent?.('volc-connect-attempt', `url=${VOLC_BIGMODEL_ASR_URL} resourceId=${resourceId}`);
   const socket = new WebSocket(VOLC_BIGMODEL_ASR_URL, { headers });
   ws = socket;

   socket.on('open', () => {
     if (ws !== socket || closed) return;
     log.info(`火山引擎 WS 已连接, resourceId=${resourceId}`);
     onEvent?.('volc-ws-open', `resourceId=${resourceId}`);
     try { socket.send(makeVolcFullClientRequest(lang)); } catch (e) { log.error('火山引擎会话建立后发送初始请求失败:', { error: e }); }
     ready = true;
     for (const buf of pending) { try { socket.send(makeVolcAudioFrame(buf)); } catch (e) { log.error('火山引擎会话建立后发送缓存音频块失败:', { error: e }); } }
     pending.length = 0;
     if (flushRequested && socket.readyState === WebSocket.OPEN) {
       try { socket.send(makeVolcAudioFrame(Buffer.alloc(0), true)); } catch (e) { log.error('火山引擎会话建立后发送 flush 失败:', { error: e }); }
     }
   });

   socket.on('message', (data) => {
     if (ws !== socket) return;
     try {
       const parsed = parseVolcResponse(data);
       if (!parsed) { log.info(`火山引擎响应: 无法解析 (len=${data?.length || 0})`); onEvent?.('volc-msg-unparseable', `len=${data?.length || 0}`); return; }
       if (parsed.error) {
         // 2026-08-15: 45000081 = 服务端 8s 无音频包后回收会话(静默期超时, 正常生命周期)。
         // 此前走 onError 上抛 → UI 报错且此后音频因 !ready 只进 pending 永不发出
         // ("说话没反应"根因之一)。现在静默重连: 直接换新会话, 旧 socket 由
         // "ws !== socket" 守卫自然失效后再关闭。
         if (/45000081|Timeout waiting next packet/i.test(parsed.error)) {
           log.info(`火山引擎会话空闲回收, 静默重连: ${parsed.error.substring(0, 80)}`);
           onEvent?.('volc-idle-reconnect', 'idle timeout, reconnecting silently');
           const old = ws;
           reconnectAttempted = false;
           connect(resourceId);
           try { old.close(); } catch (e) { log.warn('火山空闲回收后关闭旧连接失败:', { error: e }); }
           return;
         }
         log.error(`火山引擎错误: ${parsed.error}`); onError(attachErrorCategory(parsed.error)); return;
       }
       log.info('火山引擎响应', { isLast: parsed.isLast, body: JSON.stringify(parsed.body)?.substring(0, 200) });
       onEvent?.('volc-msg', `isLast=${parsed.isLast} hasUtterances=${!!parsed.body?.result?.[0]?.utterances}`);
       emitVolcTranscripts(parsed.body, parsed.isLast, onTranscript, requestId);
     } catch (err) { log.error(`火山 ASR 响应解析失败: ${err.message}`); onError(attachErrorCategory(`火山 ASR 响应解析失败: ${err.message}`)); }
   });

   socket.on('error', (err) => {
     if (ws !== socket || closed) return;
     log.error(`火山引擎 WS error: ${err.message}`);
     onEvent?.('volc-ws-error', err.message);
     // 403 时自动回退到 1.0 资源（参考历史实现）
     const fallbackResourceId = VOLC_RESOURCE_FALLBACKS.get(resourceId);
     if (/Unexpected server response:\s*403/i.test(err.message || '') && fallbackResourceId) {
       log.info(`Resource ${resourceId} 403, 回退到 ${fallbackResourceId}`);
       onEvent?.('volcengine-fallback', `ASR 2.0 resource ${resourceId} unavailable; retrying with ${fallbackResourceId}`);
       connect(fallbackResourceId);
       return;
     }
     // 2026-08-14: 网络类错误(非 403/auth)记标记,待 close 后自动重连一次;
     // auth/rate/other 走原 error 下发——403 回退路径不受影响
     if (classifyASRError(err) === 'network' && !reconnectAttempted && !flushRequested) {
       networkErrorSeen = true;
       return;
     }
     pending.length = 0;
     onError(attachErrorCategory(err));
   });

   socket.on('close', () => {
     if (ws !== socket) return;
     log.info('火山引擎 WS close');
     onEvent?.('volc-ws-close', `ready=${ready} pending=${pending.length}`);
     ready = false;
     // 2026-08-14: 非主动 flush/close 且为网络类断开时,用同一 requestId 自动重连一次;
     // pending 不清空——重连 open 后重发,utterance 上下文不丢。重连失败走原 error 下发。
     if (networkErrorSeen && !reconnectAttempted && !flushRequested && !closed) {
       networkErrorSeen = false;
       reconnectAttempted = true;
       log.warn(`火山引擎网络断开,自动重连一次 (requestId=${requestId}, pending=${pending.length})`);
       onEvent?.('volc-ws-reconnect', `requestId=${requestId} pending=${pending.length}`);
       connect(resourceId);
       return;
     }
     pending.length = 0;
     closed = true;
     notifyClose();
   });
 }

 connect(resourceId);

 return {
 sendAudio(pcmBuffer) {
   if (closed) return;
   if (!ready) {
     if (pending.length < MAX_PENDING_CHUNKS) pending.push(Buffer.from(pcmBuffer));
     return;
   }
   if (ws.readyState === WebSocket.OPEN) ws.send(makeVolcAudioFrame(pcmBuffer));
 },
 flush() {
   flushRequested = true;
   if (ws?.readyState !== WebSocket.OPEN) return;
   ws.send(makeVolcAudioFrame(Buffer.alloc(0), true));
 },
 // V2: flush 并将最后一段标记为 speechFinal
 flushSpeechFinal() {
   // 火山引擎 isLast 已在 emitVolcTranscripts 中自动处理 speechFinal
   // 直接 flush 即可，服务端会在下一帧返回 isLast
   this.flush();
 },
 close() { try { closed = true; ws?.close(); } catch (e) { log.error('火山引擎会话关闭失败:', { error: e }); } },
 };
}

// ─── 工厂函数 ───
function createCloudASRSession(config, onTranscript, onError, onClose, onEvent) {
 const provider = (config.provider || 'volcengine').toLowerCase();
 const lang = config.lang || 'zh';

 if (provider === 'aliyun') {
 const apiKey = config.aliyunApiKey;
 if (!apiKey) { onError(attachErrorCategory('未配置阿里云 API Key')); return null; }
 if (!isValidAliyunAsrKey(apiKey)) { onError(attachErrorCategory('阿里云 ASR Key 格式不正确：请填写百炼/DashScope 控制台的 sk- 开头 API Key')); return null; }
 const model = config.aliyunModel || 'fun-asr-realtime-2026-02-28'; log.info('Aliyun model=' + model);
 return createAliyunSession(apiKey, lang, onTranscript, onError, onClose, onEvent, model);
 }
 if (provider === 'tencent') {
 if (!config.tencentSecretId || !config.tencentSecretKey) { onError(attachErrorCategory('未配置腾讯云 SecretId/SecretKey')); return null; }
 return createTencentSession(config.tencentSecretId, config.tencentSecretKey, config.tencentAppId || '', lang, onTranscript, onError, onClose);
 }
 if (provider === 'xunfei') {
 if (!config.xunfeiAppId || !config.xunfeiApiKey) { onError(attachErrorCategory('未配置讯飞 AppId/ApiKey')); return null; }
 return createXunfeiSession(config.xunfeiAppId, config.xunfeiApiKey, lang, onTranscript, onError, onClose);
 }
 if (provider === 'volcengine') {
 if (!config.volcAsrApiKey && (!config.volcAsrAppKey || !config.volcAsrAccessKey)) { onError(attachErrorCategory('未配置火山引擎 ASR API Key 或 AppKey/AccessKey')); return null; }
 return createVolcengineSession(config, lang, onTranscript, onError, onClose, onEvent);
 }

 onError(attachErrorCategory(`未知云端 ASR 服务商: ${provider}`));
 return null;
}

module.exports = {
 createCloudASRSession,
 isValidAliyunAsrKey,
 // 纯函数导出（供单元测试）
 _classifyASRError: classifyASRError,
 _attachErrorCategory: attachErrorCategory,
 _makeVolcHeader: makeVolcHeader,
 _makeVolcFrame: makeVolcFrame,
 _makeVolcFullClientRequest: makeVolcFullClientRequest,
 _makeVolcAudioFrame: makeVolcAudioFrame,
 _parseVolcResponse: parseVolcResponse,
 _emitVolcTranscripts: emitVolcTranscripts,
};
