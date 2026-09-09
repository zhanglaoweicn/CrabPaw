/**
 * Voice Cloud WebSocket — 实时流式 ASR 代理
 *
 * V2 改进（对标 Grok Build pipeline.rs）：
 * - 并行采集+连接：WS 连接后立即预加载配置，config 帧到达时立即创建 ASR 会话
 * - 有界 backlog：独立 PCM 缓冲，连接就绪后自动 flush
 * - No-Speech 看门狗：10s 无转录自动断连，防止空麦克风浪费资源
 * - 事件语义分层：区分 is_final（段级）与 speech_final（句级），支持 locked_prefix
 * - flushSpeechFinal：flush 并将最后一段标记为 speechFinal，确保不丢尾字
 *
 * 协议：
 * 1. 前端连接后先发 JSON config 帧: { type: 'config', provider, lang }
 * 2. 后端读取 config.json 凭证，创建 createCloudASRSession
 * 3. 后续二进制帧 = PCM Int16 → session.sendAudio()
 * 4. JSON { type: 'flush' } → session.flush()
 *    JSON { type: 'flush_speech_final' } → session.flushSpeechFinal()（V2）
 * 5. 后端推送 JSON: { type: 'transcript', text, is_final, speech_final, seg }
 *    { type: 'error', message }
 *    { type: 'diag', event, info }
 *    { type: 'no_speech_timeout' }（V2：无语音看门狗触发）
 */

const WebSocket = require('ws');
const { getLogger, getMetricsCollector } = require('../core/observability');
const log = getLogger({ module: 'voice:cloud' });
const metrics = getMetricsCollector();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createCloudASRSession } = require('../core/asr/cloud-asr');
const { BoundedBacklog, NoSpeechWatchdog, computeRms } = require('../core/voice-pipeline');
const { verifyApiToken } = require('../core/http-middleware');

/** @type {WebSocket.Server|null} */
let wss = null;
let draining = false; // 2026-08-12: 优雅排空中——职责:拒绝新连接(upgrade 503)与 TTS 合成(503);destroy 仍无条件 1001 关闭活动连接
let upgradeHandler = null;
let attachedServer = null;

// ─── 常量 ───────────────────────────────────────────────
const MAX_BACKLOG_CHUNKS = 256;       // ~4s at 16kHz 2048 samples/chunk
const SILENCE_RMS = 100;              // Int16 域近静音阈值(~0.003),背压期间跳过
                                      // 2026-08-14: 原 500(~0.015)会误丢弱麦说话开头块,调低到 ~100
const NO_SPEECH_TIMEOUT_MS = 10000;   // 10s 无转录 → 自动断连
// 2026-08-12: 已见过的会话 ID——config 帧重复携带视为重连(voice_ws_reconnects_total)
const seenSessionIds = new Set();


// ─── 安全: WebSocket Origin 白名单 ──────────────────────
// 默认仅允许本地和开发环境。生产环境应通过环境变量 CRABPAW_WS_ALLOWED_ORIGINS 配置
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  'http://0.0.0.0',
  'https://localhost',
  'http://localhost:',  // Allow any port on localhost
  'http://127.0.0.1:',  // Allow any port on 127.0.0.1
];

function _isOriginAllowed(origin) {
  if (!origin) return true; // Allow non-browser clients (e.g., curl, API)
  const allowedOrigins = (process.env.CRABPAW_WS_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  
  // Check configured origins first
  for (const allowed of allowedOrigins) {
    if (allowed.endsWith('*')) {
      const prefix = allowed.slice(0, -1);
      if (origin.startsWith(prefix)) return true;
    } else if (origin === allowed) {
      return true;
    }
  }
  
  // Check default origins
  const lowerOrigin = origin.toLowerCase();
  for (const allowed of DEFAULT_ALLOWED_ORIGINS) {
    if (allowed.endsWith(':')) {
      if (lowerOrigin.startsWith(allowed)) return true;
    } else if (lowerOrigin === allowed) {
      return true;
    }
  }
  
  return false;
}

// ─── 配置缓存（mtime 策略，与 voice-asr-handler.js 一致） ────────────
let cachedConfig = null;
let cachedConfigMtime = 0;

function loadConfig() {
 try {
 const { DATA_DIR } = require('../core/config');
 const configPath = path.join(DATA_DIR, 'config.json');
 const stat = fs.statSync(configPath);
 if (cachedConfig && stat.mtimeMs === cachedConfigMtime) {
 return cachedConfig;
 }
 cachedConfigMtime = stat.mtimeMs;
 const fullCfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
 const voiceCfg = fullCfg?.voice || {};
 const doubaoKey = fullCfg?.models?.providers?.doubao?.apiKey || '';
 const cfg = {
 provider: voiceCfg.asrProvider || 'volcengine',
 aliyunApiKey: voiceCfg.aliyunApiKey || '',
 aliyunModel: voiceCfg.aliyunModel || 'fun-asr-realtime-2026-02-28',
 tencentSecretId: voiceCfg.tencentSecretId || '',
 tencentSecretKey: voiceCfg.tencentSecretKey || '',
 tencentAppId: voiceCfg.tencentAppId || '',
 xunfeiAppId: voiceCfg.xunfeiAppId || '',
 xunfeiApiKey: voiceCfg.xunfeiApiKey || '',
 volcAsrApiKey: voiceCfg.volcAsrApiKey || voiceCfg.doubaoKey || doubaoKey || '',
 volcAsrAppKey: voiceCfg.volcAsrAppKey || '',
 volcAsrAccessKey: voiceCfg.volcAsrAccessKey || '',
 volcAsrResourceId: voiceCfg.volcAsrResourceId || '',
 volcAsrAppId: voiceCfg.volcAsrAppId || voiceCfg.doubaoAppId || '',
 doubaoAppKey: voiceCfg.doubaoAppKey || '',
 };
 cachedConfig = cfg;
 return cfg;
 } catch (e) {
 log.error('读取配置失败', { error: e });
 return null;
 }
}

/**
 * 在已有 HTTP 服务器上挂载 /voice/cloud WebSocket 端点
 * @param {import('http').Server} server
 */
function attachVoiceCloudWS(server, options = {}) {
 if (wss) return wss;
 const apiKey = options.apiKey || '';

 wss = new WebSocket.Server({
 noServer: true,
 maxPayload: 1024 * 1024,
 });

 // Share upgrade events with other WebSocket endpoints attached to the same server.
 attachedServer = server;

 upgradeHandler = (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname !== '/voice/cloud') return;

  // 2026-08-12: 排空中拒绝新连接
  if (draining) {
    log.warn('draining: 拒绝新 WebSocket 连接');
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  // Security: require the same API token used by HTTP routes.
  if (!verifyApiToken(req, apiKey)) {
    log.warn('Blocked WebSocket connection without valid API token');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Security: validate origin before processing WebSocket upgrade.
  const origin = req.headers['origin'];
  if (origin && !_isOriginAllowed(origin)) {
    log.warn(`Blocked WebSocket connection from disallowed origin: ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
 };
 server.on('upgrade', upgradeHandler);

 log.info(' ✅ Voice Cloud WebSocket 服务器已启动 (/voice/cloud)');

 wss.on('connection', (ws) => {
 metrics.increment('voice_ws_sessions_total');
 metrics.gauge('voice_ws_sessions_active', wss ? wss.clients.size : 0);
 createWsConnection(ws);
 });

 return wss;
}

function createWsConnection(ws) {
 let session = null;
 let sessionId = '';
 let configured = false;
 let diagCounter = 0; // 临时诊断计数器
 let oddFrameLogged = false; // 2026-09-03: 奇数帧取证日志限频标记(每连接一次)
 let isContinuous = false; // 2026-08-03: 连续模式（前端 config 帧 continuous 字段）
 // 2026-08-15 S3/S4: 会话代际——看门狗回收旧会话时递增,使旧会话迟到的
 // onClose 不再误关常开的前端 WS(恢复说话时惰性重建新会话)
 let sessionGen = 0;
 let savedCreds = null; // config 帧解析后的凭证(惰性重建复用)

 const backlog = new BoundedBacklog(MAX_BACKLOG_CHUNKS);
 let providerTag = 'unknown'; // metrics tag：config 帧到达时更新
 let lastChunkTs = 0;         // transcript 延迟测量：最近 chunk 到达时刻
 backlog.onOverflow((size) => {
 metrics.increment('voice_backlog_overflow_total');
 log.warn(`Backlog overflow: dropped PCM chunks (session not ready, ${size} chunks)`);
 });

// 2026-08-12: 背压信号(移植 LiveKit StreamAllocator 迟滞思想)——1s 去抖后通知客户端降速
let bpTimer = null;
let bpLevel = 'ok';
backlog.onLevelChange((level, queued, queuedMs) => {
 bpLevel = level;
 if (bpTimer) return;
 bpTimer = setTimeout(() => {
  bpTimer = null;
  try {
   ws.send(JSON.stringify({ type: 'backpressure', level: bpLevel, queuedMs }));
  } catch (e) {
   log.error('发送 backpressure 失败', { error: e });
  }
 }, 1000);
});

 const watchdog = new NoSpeechWatchdog(NO_SPEECH_TIMEOUT_MS);

 // V2: 并行预加载配置 — WS 连接后立即读取，不等 config 帧
 const preloadedCfg = loadConfig();

 // 2026-08-15 S4(审计 P0): 看门狗回收只关云端会话、保持前端 WS 常开——
 // 此前 session.close() → onClose → ws.close() 链使前端"保持 WS 常开"落空,
 // 每 10s 一轮断连重连循环白烧云端会话。sessionGen 递增让旧会话迟到
 // onClose 失效; 新语音帧到达时 audio 分支惰性重建(recreateSession)。
 function watchdogTimeoutCb() {
 log.warn(`No-speech watchdog: ${NO_SPEECH_TIMEOUT_MS}ms 无转录 → 回收云端会话(前端 WS 常开)`);
 try {
 ws.send(JSON.stringify({ type: 'no_speech_timeout' }));
 } catch (e) { log.debug('no_speech_timeout 通知发送失败(ws 可能已关闭)', { error: e }) }
 sessionGen++; // 使旧会话的 onClose 失效
 try { session?.close(); } catch (e) { log.debug('会话关闭 best-effort 失败', { error: e }) }
 session = null;
 }

 // 2026-08-03: 连续模式不启动 no-speech 断开——常开会话保持 WS 连接，
 // 用户随时说话都识别（此前 10s 静音断开会话 → 用户说话落在重连窗口丢失，
 // 专注模式（PTT 主动开麦）无此问题——用户已实测验证）
 function armWatchdog() {
   if (isContinuous) {
     log.info('连续模式: 保持常开会话（no-speech 断开已禁用）');
     return;
   }
   watchdog.watch(watchdogTimeoutCb);
 }

 function onTranscript(text, isFinal, seg, speechFinal) {
 metrics.increment('voice_asr_transcripts_total', 1, { provider: providerTag });
 if (lastChunkTs > 0) metrics.histogram('voice_asr_transcript_latency_ms', Date.now() - lastChunkTs, { provider: providerTag });
 watchdog.feed();

 log.info('onTranscript', { text: (text || '').substring(0, 60), isFinal, speechFinal, seg, sessionId });
 try {
 ws.send(JSON.stringify({ type: 'transcript', text, is_final: isFinal, speech_final: speechFinal || false, seg, sessionId }));
 } catch (e) {
 log.error('发送 transcript 失败', { error: e });
 }
 }

 function onError(errMsg) {
 // 2026-08-14: 结构化分类下发——兼容字符串/Error/带 category 的包装对象(cloud-asr.js 附加)
 const raw = (errMsg && typeof errMsg === 'object') ? (errMsg.message || String(errMsg)) : String(errMsg || '未知错误');
 const category = (errMsg && typeof errMsg === 'object' && typeof errMsg.category === 'string') ? errMsg.category : 'other';
 // auth 不可重试(重连无意义)；network/rate/other 可重试(前端据此决定是否重连/重试)
 const retryable = category !== 'auth';
 metrics.increment('voice_asr_errors_total', 1, { provider: providerTag });
 log.error('ASR onError', { error: raw, category, retryable });
 stopNoSpeechWatchdog();
 try {
 ws.send(JSON.stringify({ type: 'error', message: raw, category, retryable, sessionId }));
 } catch (e) {
 log.error('发送 error 失败', { error: e });
 }
 }

 // 2026-08-15 S3/S4: 会话代际守卫——只有"当前代"云端会话关闭才关前端 WS;
 // 看门狗回收的旧会话(gen 已过期)关闭时前端 WS 保持常开, 等待惰性重建。
 function onClose() {
 log.info('ASR onClose');
 stopNoSpeechWatchdog();
 try { ws.close(); } catch (e) {
 log.error('关闭 WebSocket 失败', { error: e });
 }
 }

 /** 用 config 帧缓存凭证重建云端 ASR 会话(看门狗回收后惰性重建) */
 function recreateSession() {
   if (!savedCreds) return null;
   const gen = ++sessionGen;
   return createCloudASRSession(
     savedCreds,
     onTranscript,
     onError,
     () => { if (gen === sessionGen) onClose() },
     // onEvent
     (event, info) => {
       try {
         ws.send(JSON.stringify({ type: 'diag', event, info, sessionId }));
       } catch (e) {
         log.error('发送 diag 失败', { error: e });
       }
     }
   );
 }

 function stopNoSpeechWatchdog() {
 watchdog.stop();
 }

 function flushBacklog() {
 const drained = backlog.drain();
 if (drained.length === 0) return;
 log.info(`Flushing ${drained.length} backlog PCM chunks`);
 for (const chunk of drained) {
 try {
 session.sendAudio(chunk);
 } catch (e) {
 log.error('Backlog flush 失败', { error: e });
 }
 }
 }

 ws.on('message', (raw) => {
 // ── 第一帧必须是 JSON config ──
 if (!configured) {
 try {
 const msg = JSON.parse(raw.toString());
 if (msg.type !== 'config') return;

 // V2: 使用预加载配置 + config 帧覆盖
 const provider = preloadedCfg?.provider || msg.provider || 'volcengine';
 const lang = msg.lang || 'zh';
 isContinuous = msg.continuous === true; // 2026-08-03: 连续模式 → 常开会话
 sessionId = (typeof msg.sessionId === 'string' && msg.sessionId) || crypto.randomUUID();
 // 2026-08-12: 重连检测——前端重连 config 帧携带已见过的 sessionId
 if (seenSessionIds.has(sessionId)) {
 metrics.increment('voice_ws_reconnects_total');
 } else {
 seenSessionIds.add(sessionId);
 if (seenSessionIds.size > 1000) seenSessionIds.clear(); // 防无界增长(本机单用户,理论上不触达)
 }
 const creds = {
 ...(preloadedCfg || {}),
 provider,
 lang,
 };
 savedCreds = creds; // 2026-08-15 S3/S4: 缓存凭证供看门狗回收后惰性重建

 log.info('连接建立', { provider, lang, resourceId: creds.volcAsrResourceId || 'default:volc.seedasr.sauc.duration' });

 // 临时诊断：发送配置状态到前端
 try {
 ws.send(JSON.stringify({
 type: 'diag',
 event: 'config-status',
 sessionId,
 info: `provider=${provider} hasApiKey=${!!creds.volcAsrApiKey} hasAppKey=${!!creds.volcAsrAppKey} hasAccessKey=${!!creds.volcAsrAccessKey} resourceId=${creds.volcAsrResourceId || 'default'} preloaded=${!!preloadedCfg}`
 }));
 } catch (e) { log.debug('diag config-status 发送失败', { error: e }) }

 session = recreateSession();

 if (!session) {
 try {
 ws.send(JSON.stringify({ type: 'error', message: 'ASR 会话创建失败：请检查 provider 配置和凭证' }));
 } catch (e) {
 log.error('发送创建失败错误', { error: e });
 }
 setTimeout(() => { try { ws.close(); } catch (e) { log.debug('创建失败后关闭 WS 失败', { error: e }) } }, 200);
 return;
 }

 configured = true;
 providerTag = provider || 'unknown';
 // sessionId 回传：前端保存并在重连 config 帧携带（日志/指标关联键）
 try { ws.send(JSON.stringify({ type: 'session', sessionId })); } catch (e) { log.error(`发送 session 失败: ${e.message}`, { error: e }); }
 // V2: 会话就绪后立即 flush backlog
 flushBacklog();
 // V2: 启动 no-speech 看门狗（连续模式禁用——常开会话）
 armWatchdog();
 } catch (e) {
 log.error('解析 config 帧失败', { error: e });
 try {
 ws.send(JSON.stringify({ type: 'error', message: '配置帧解析失败: ' + e.message }));
 } catch (e2) { log.debug('配置帧解析失败通知发送失败', { error: e2 }) }
 try { ws.close(); } catch (e2) { log.debug('配置帧解析失败后关闭 WS 失败', { error: e2 }) }
 }
 return;
 }

 // ── 后续帧：二进制 PCM 或 JSON 控制消息 ──
 if (raw instanceof Buffer || raw instanceof ArrayBuffer) {
 let pcmData = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
 // 2026-09-03 奇数帧防御: Int16 PCM 恒为偶数字节, 奇数帧是混入的非音频数据——
 // 日志实锤 29 字节碎帧致火山整会话拒绝(55000000 invalid PCM audio length),
 // 循环重连期间表现为"麦克风没有识别"。垫 1 字节 0 转偶数后照发(单样本影响
 // 可忽略, 会话不再被拆), 并限频记录帧内容供定位来源。
 if (pcmData.length % 2 !== 0) {
 if (!oddFrameLogged) {
 oddFrameLogged = true;
 log.warn('收到奇数长度音频帧(非 Int16 对齐)——垫齐转发并记录内容定位来源', {
 len: pcmData.length,
 utf8: pcmData.toString('utf8').slice(0, 60),
 hex: pcmData.toString('hex').slice(0, 64),
 });
 }
 pcmData = Buffer.concat([pcmData, Buffer.alloc(1)]);
 }
 // 临时诊断：计算 RMS 并通过 WS 发回前端
 if (pcmData.length >= 2 && diagCounter++ % 10 === 0) {
 const rms = computeRms(pcmData);
 try {
 ws.send(JSON.stringify({ type: 'diag', event: 'pcm-rms', sessionId, info: `rms=${rms.toFixed(0)} bytes=${pcmData.length}` }));
 } catch (e) { log.debug('pcm-rms diag 发送失败', { error: e }) }
 }
 if (session) {
 lastChunkTs = Date.now();
 metrics.increment('voice_asr_chunks_total', 1, { provider: providerTag });
 session.sendAudio(pcmData);
 } else {
 // 2026-08-15 S3/S4: 会话被看门狗回收(session=null)时惰性重建——新语音帧
 // 到达即重建云端会话 + flush backlog 补发(用户抢话开头不丢);
 // 静音帧(挂起保活帧等)不进 backlog, 防静音占满积压淹没真语音。
 if (computeRms(pcmData) < SILENCE_RMS) return;
 if (configured) {
   session = recreateSession();
   if (session) {
     metrics.increment('voice_asr_sessions_total', 1, { provider: providerTag, reason: 'lazy-recreate' });
     armWatchdog();
     flushBacklog();
   }
 }
 if (session) {
   lastChunkTs = Date.now();
   metrics.increment('voice_asr_chunks_total', 1, { provider: providerTag });
   session.sendAudio(pcmData);
 } else {
   // 未配置或重建失败: 进 backlog 等 config/重试
   backlog.push(pcmData);
 }
 }
 } else {
 try {
 const msg = JSON.parse(raw.toString());
 if (msg.type === 'flush') {
 session?.flush();
 } else if (msg.type === 'flush_speech_final') {
 // V2: flush 并将最后一段标记为 speechFinal
 if (typeof session?.flushSpeechFinal === 'function') {
 session.flushSpeechFinal();
 } else {
 session?.flush();
 }
 }
 } catch (e) {
 log.error('解析控制消息失败', { error: e });
 }
 }
 });

 ws.on('close', () => {
 metrics.gauge('voice_ws_sessions_active', wss ? wss.clients.size : 0);
 // 2026-08-14: 清理背压去抖定时器——ws 关闭后 timer 仍会触发 ws.send 报错(此前泄漏)
 if (bpTimer) { clearTimeout(bpTimer); bpTimer = null; }
 stopNoSpeechWatchdog();
 try { session?.close(); } catch (e) {
 log.error('关闭 ASR 会话失败', { error: e });
 }
 session = null;
 });

 ws.on('error', () => {
 if (bpTimer) { clearTimeout(bpTimer); bpTimer = null; }
 stopNoSpeechWatchdog();
 try { session?.close(); } catch (e) { log.debug('WS error 清理时关闭会话失败', { error: e }) }
 session = null;
 });
}

/** 关闭 WebSocket 服务器 */
function destroyVoiceCloudWS() {
  // 2026-08-12: 无条件优雅关闭活动连接(1001 going-away)——close 处理器会关闭 ASR 会话;
  // client.close 对 CLOSING/CLOSED 幂等安全,server.js 退出链二次调用无副作用
  if (wss) {
    for (const client of wss.clients) {
      try { client.close(1001, 'server-shutdown'); } catch (e) { log.warn('drain: 关闭 WS 客户端失败:', e.message); }
    }
  }
  if (attachedServer && upgradeHandler) {
    attachedServer.removeListener('upgrade', upgradeHandler);
  }
  attachedServer = null;
  upgradeHandler = null;
  if (wss) {
    try { wss.close(); } catch (e) { log.debug('wss 关闭失败', { error: e }) }
    wss = null;
  }
}

function setDraining(v) { draining = v; }
function isDraining() { return draining; }

module.exports = { attachVoiceCloudWS, destroyVoiceCloudWS, setDraining, isDraining };
