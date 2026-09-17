/**
 * Voice Realtime WS — 豆包实时语音模型 3.0 (Seeduplex) 全双工对话代理
 *
 * 端点: /voice/realtime
 * 协议来源: 官方文档 6561/2549778（全双工版，纯 JSON 事件协议）+ 2026-09-17 PoC 实测
 * (cdp-diag/rtv-poc/realtime-poc.js)
 *
 * GUI ↔ 本模块 ↔ 火山 duplex:
 * - GUI 上行: 二进制 PCM(16k int16, 与 /voice/cloud 完全同款采集链) + JSON 控制帧
 * - 本模块: 20ms/640B 节奏化 → base64 → input_audio_buffer.append；
 *   队列饥饿(采集暂停)自动 input_audio_mute.commit 保活, 恢复时 unmute
 * - 火山下行事件映射为 JSON 推给 GUI(asr/reply/audio/delegate/error)
 *
 * 任务委托（混合架构核心，2026-09-17 PoC 定稿）:
 * - 任务路由不依赖模型的函数调用——转写 completed 上跑 detectTaskMode,
 *   isTask → 通知 GUI 走既有 sendText 主链路(DeepSeek) + response.cancel 打断模型
 * - 模型自发的 FC 以 <|FunctionCallBegin|>[...] 特殊 token 混在 output_text 流
 *   (独立事件 response.function_call_arguments.done 此版服务端不下发)——解析后同样委托
 * - GUI 任务完成后经 {type:'speak'} 回喂 → speech_text_buffer.commit 让模型口播摘要
 *
 * 已知模型行为(PoC 实测): 内容生成类请求("写文章/讲笑话")模型硬静默——
 * 恰与"生成类任务交 DeepSeek"分工吻合, 由任务检测路径接管。
 */

const WebSocket = require('ws');
const { getLogger, getMetricsCollector } = require('../core/observability');
const log = getLogger({ module: 'voice:rt' });
const metrics = getMetricsCollector();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyApiToken } = require('../core/http-middleware');
const { detectTaskMode } = require('../core/task-mode-detector');

const DIALOGUE_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';

// ─── 节奏化常量（官方要求 20ms/640B 严格实时节奏, 过快过慢都报错） ───
const PACING_INTERVAL_MS = 20;
const PACING_CHUNK_BYTES = 640;          // 20ms @16k int16 mono
const QUEUE_MAX_BYTES = 160000;          // ~5s 上限, 防挂起保活帧积压无界
const STARVE_MUTE_TICKS = 15;            // 连续 15 tick(300ms) 无数据 → mute.commit 保活
// 委托去重窗口: 同一转写(检测器+模型FC双路径)60s 内只委托一次
const DELEGATE_DEDUP_MS = 60000;
// 沉默兜底: 转写完成后模型这么久无输出 → 委托主链路(内容生成类硬静默的兜底)。
// 2026-09-17 实测: 4s 死等是"没反应"体感的主因, 收紧到 2.5s(模型正常回复 <1s)。
const SILENCE_FALLBACK_MS = 2500;
// 静音尾窗缓冲: 模型播报结束→解除静音之间的用户语音不再丢弃, 缓冲后补播
// (实测"接着说几点了没反应"= 尾窗丢音频), 上限 ~2s
const TAIL_BUFFER_MAX = 64000;
// 查询类话题即时委托: 台风/天气/新闻/股票等实时信息, 实时模型的训练知识是旧的,
// 答了也是错的; 识别到直接秒级转交主链路(不再等模型犹豫/兜底)
const LOOKUP_TOPIC_RE = /(台风|天气|气温|下雨|新闻|资讯|热点|股票|股市|基金|汇率|金价|油价)/;
// 2026-09-17: 媒体播放类即时委托——实时模型自带"能唱会演"(实测: 让播放歌曲它自己
// 开唱), 但产品语义是调起音乐播放器; 播放/听/唱+歌/音乐/视频 组合一律转主链路
// PlayMusic 工具(FloatingMusicPlayer 出卡片出声)
const MEDIA_PLAY_RE = /(播放|放|来|点|听|唱)[^。！？]{0,6}(一?首)?[^。！？]{0,6}(歌|音乐|歌曲|视频|电影|动漫|电视)/;
// 委托语音回执按来源分级(分工精准化): 查询→带话题的查话术, 任务→开工话术, 兜底→转后台话术。
// 查询回执从原话提取话题词("最近有台风吗"→"我看看台风的情况"), 比"我查一下"更自然(用户反馈生硬)
const DELEGATE_ACK = {
  lookup: null, // null = 用话题提取动态生成
  detector: '好的，开工了，结果出来我会告诉你。',
  fallback: '这个问题我转到后台详细处理，稍等。',
  'model-fc': null,
  media: '好的，马上安排。',
};
function lookupAck(utterance) {
  const m = String(utterance || '').match(LOOKUP_TOPIC_RE);
  return m && m[1] ? `好的，我看看${m[1]}的情况。` : '好的，稍等，我查一下。';
}
// 下行音频"结束"去抖: 最后一个音频 delta 后这么久无新块才算播完
// (output_audio.done 事件远早于真实流结束——提前解静音会让喇叭尾音回灌自打断)
const AUDIO_END_DEBOUNCE_MS = 350;
// 解除静音后的回声防护窗: 尾音残响的转写不可信, 忽略(尾窗音频已缓冲补播,
// 此窗口内的 completed 只可能是残响)
const ECHO_GUARD_MS = 500;

let wss = null;
let draining = false;
let upgradeHandler = null;
let attachedServer = null;

// ─── Origin 白名单（与 voice-cloud-ws.js 同策略, 自包含拷贝） ───
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost', 'http://127.0.0.1', 'http://0.0.0.0', 'https://localhost',
  'http://localhost:', 'http://127.0.0.1:',
];

function _isOriginAllowed(origin) {
  if (!origin) return true;
  const allowedOrigins = (process.env.CRABPAW_WS_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  for (const allowed of allowedOrigins) {
    if (allowed.endsWith('*')) { if (origin.startsWith(allowed.slice(0, -1))) return true; }
    else if (origin === allowed) return true;
  }
  const lowerOrigin = origin.toLowerCase();
  for (const allowed of DEFAULT_ALLOWED_ORIGINS) {
    if (allowed.endsWith(':')) { if (lowerOrigin.startsWith(allowed)) return true; }
    else if (lowerOrigin === allowed) return true;
  }
  return false;
}

// ─── 配置缓存（mtime 策略, 与 voice-cloud-ws.js 一致） ───
let cachedCfg = null;
let cachedCfgMtime = 0;

function loadRealtimeConfig() {
  try {
    const { DATA_DIR } = require('../core/config');
    const configPath = path.join(DATA_DIR, 'config.json');
    const stat = fs.statSync(configPath);
    if (cachedCfg && stat.mtimeMs === cachedCfgMtime) return cachedCfg;
    cachedCfgMtime = stat.mtimeMs;
    const full = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const voice = full?.voice || {};
    const doubaoKey = full?.models?.providers?.doubao?.apiKey || '';
    cachedCfg = {
      apiKey: voice.volcAsrApiKey || voice.doubaoKey || doubaoKey || '',
      appId: voice.volcAsrAppKey || voice.doubaoAppId || '',
      accessKey: voice.volcAsrAccessKey || '',
      // 音色/人设可覆盖; 默认 vv(精品音色, O 系版本可用)
      voice: voice.realtimeVoice || 'zh_female_vv_jupiter_bigtts',
      // 2026-09-18: 人设从配置组装——智能体名(agent.name)+用户称呼(user.callMe/name),
      // 让实时模型知道"它是谁/用户是谁"(实测缺失时模型不知道自己身份)
      instructions: voice.realtimeInstructions || buildDefaultPersona(full, (full.agent && full.agent.name) || 'CrabPaw'),
    };
    return cachedCfg;
  } catch (e) {
    log.error('读取实时对话配置失败', { error: e });
    return null;
  }
}

/** 默认人设组装: 智能体名(agent.name)+用户称呼(管理舱"用户与智能体"配置的 callMe/name) */
function buildDefaultPersona(full, agentName) {
  const user = (full && full.user) || {};
  const callMe = user.callMe || user.name || '';
  const called = callMe ? `用户称呼为「${callMe}」，对话中自然使用这个称呼。` : '';
  return `你是${agentName}，用户桌面上的智能助手（CrabPaw）。请始终用简短口语回答（1-2句话），不要列清单，不要读长文。你只负责对话，实际任务由后台系统处理。${called}`;
}

/** 默认上游工厂: 连火山 duplex（测试可注入 mock） */
function defaultUpstreamFactory(cfg) {
  const headers = { 'X-Api-Resource-Id': 'volc.openspeech.dialog' };
  // 单 key 与 appid+accessKey 对两种鉴权 PoC 均已验证可用
  if (cfg.appId && cfg.accessKey) {
    headers['X-Api-App-Key'] = cfg.appId;
    headers['X-Api-Access-Key'] = cfg.accessKey;
  } else {
    headers.Authorization = 'Bearer ' + cfg.apiKey;
  }
  return new WebSocket(DIALOGUE_URL, { headers, handshakeTimeout: 12000 });
}

/**
 * 在已有 HTTP 服务器上挂载 /voice/realtime WebSocket 端点
 * @param {import('http').Server} server
 * @param {{apiKey?: string, upstreamFactory?: (cfg: object) => WebSocket}} options
 */
function attachVoiceRealtimeWS(server, options = {}) {
  if (wss) return wss;
  const apiKey = options.apiKey || '';
  const upstreamFactory = options.upstreamFactory || defaultUpstreamFactory;
  // 测试注入口: 覆盖 loadRealtimeConfig（密封测试不依赖真实 config.json）
  const configOverride = options.configOverride || null;

  wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });
  attachedServer = server;

  upgradeHandler = (req, socket, head) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/voice/realtime') return;

    if (draining) {
      log.warn('draining: 拒绝新 WebSocket 连接');
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!verifyApiToken(req, apiKey)) {
      log.warn('Blocked realtime WebSocket connection without valid API token');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const origin = req.headers['origin'];
    if (origin && !_isOriginAllowed(origin)) {
      log.warn(`Blocked realtime WebSocket from disallowed origin: ${origin}`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', upgradeHandler);

  log.info(' ✅ Voice Realtime WebSocket 服务器已启动 (/voice/realtime)');

  wss.on('connection', (ws) => {
    metrics.increment('voice_rt_sessions_total');
    metrics.gauge('voice_rt_sessions_active', wss ? wss.clients.size : 0);
    createRtConnection(ws, { upstreamFactory, configOverride });
  });

  return wss;
}

function stripFcMarkers(text) {
  return String(text || '')
    .replace(/<\|FunctionCallBegin\|>[\s\S]*?(?:<\|FunctionCallEnd\|>|$)/g, '')
    .replace(/<\|[^|]*\|>/g, '');
}

/** 从 <|FunctionCallBegin|>[{"name":"delegate_task","arguments":{...}}] 提取委托语句 */
function parseFcDelegation(text) {
  const m = String(text || '').match(/<\|FunctionCallBegin\|>([\s\S]*?)(?:<\|FunctionCallEnd\|>|$)/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1].trim());
    for (const fc of (Array.isArray(arr) ? arr : [arr])) {
      if (!fc || typeof fc !== 'object') continue;
      const args = typeof fc.arguments === 'string' ? safeJsonParse(fc.arguments) : (fc.arguments || {});
      const utter = args && (args.utterance || args.query || args.text);
      if (utter) return String(utter);
      if (fc.name) return JSON.stringify(fc); // 无标准参数: 整调用 JSON 当语句交给主链路
    }
  } catch (e) {
    log.warn('FC token 解析失败', { fragment: m[1].slice(0, 120) });
  }
  return null;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function createRtConnection(ws, deps = {}) {
  const upstreamFactory = deps.upstreamFactory || defaultUpstreamFactory;
  const configOverride = deps.configOverride || null;
  let upstream = null;
  let sessionReady = false;
  let sessionId = '';
  let configured = false;

  // 上行节奏化
  let pcmQueue = [];
  let queueBytes = 0;
  let pacingTimer = null;
  let starveTicks = 0;
  // 静音状态: clientMuted=GUI 显式(播放中), starved=采集断流自动保活
  let clientMuted = false;
  let mutedSent = false;

  // 下行/委托状态
  let replyAccum = '';
  let modelSpeaking = false;
  let lastDelegatedUtterance = '';
  let lastDelegatedAt = 0;
  let closed = false;
  let silenceFallbackTimer = null;
  let audioEndTimer = null;
  let lastAudioDeltaTs = 0;
  let lastUnmuteAt = 0;
  // 滚动转写上下文(最近 6 轮用户话轮, 委托事件携带最近 3 轮)
  const userTurns = [];
  // 静音尾窗缓冲(播报结束→解除静音期间的用户语音, 解除后补播)
  let tailBuffer = [];
  let tailBytes = 0;

  const mask = (s) => (s ? String(s).slice(0, 4) + '***len' + String(s).length : '(empty)');

  function toClient(obj) {
    if (closed) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { log.debug('发往 GUI 失败(ws 可能已关)', { error: e }); }
  }

  function upstreamSend(obj) {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return false;
    try { upstream.send(JSON.stringify(obj)); return true; } catch (e) { log.warn('发往火山失败', { error: e }); return false; }
  }

  function setMute(mute) {
    if (mute === mutedSent) return;
    const ok = upstreamSend({ type: mute ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' });
    if (!ok) return; // 2026-09-17 修复: 发送失败不翻转状态, 下个 pacing tick 重试(防 desync 永久静音)
    mutedSent = mute;
    if (!mute) lastUnmuteAt = Date.now(); // 回声防护窗起点
    log.info(mute ? '→ mute.commit (保活静音)' : '→ unmute.commit (恢复上行)');
  }

  // ── 20ms 节奏化: 队列 → input_audio_buffer.append ──
  function startPacing() {
    if (pacingTimer) return;
    pacingTimer = setInterval(() => {
      if (closed || !upstream) return;
      const starved = queueBytes < PACING_CHUNK_BYTES;
      if (clientMuted || (starved && ++starveTicks >= STARVE_MUTE_TICKS)) {
        if (!clientMuted && starved && !mutedSent) log.debug('上行断流 → 静音保活');
        setMute(true);
        if (queueBytes > 0 && clientMuted) { pcmQueue = []; queueBytes = 0; } // 显式静音丢弃陈旧音频
        return;
      }
      if (starved) return; // 未达 mute 门槛, 等数据
      starveTicks = 0;
      if (mutedSent) setMute(false);
      // 拼够 640B 发一包
      let buf = queueBytes === PACING_CHUNK_BYTES && pcmQueue.length === 1
        ? pcmQueue.shift()
        : Buffer.concat(pcmQueue);
      while (buf.length >= PACING_CHUNK_BYTES) {
        const chunk = buf.slice(0, PACING_CHUNK_BYTES);
        buf = buf.slice(PACING_CHUNK_BYTES);
        upstreamSend({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
        queueBytes -= PACING_CHUNK_BYTES;
      }
      pcmQueue = buf.length > 0 ? [buf] : [];
      if (buf.length === 0) queueBytes = 0; else queueBytes = buf.length;
    }, PACING_INTERVAL_MS);
  }

  function enqueuePcm(buf) {
    // 2026-09-17 关键修正: 静音尾窗(播报结束→解除静音)期间的用户语音不再丢弃——
    // 缓冲后解除静音时补播, 快接话不丢字(实测"接着说几点了没反应"= 尾窗丢音频)
    if (clientMuted) {
      tailBuffer.push(buf);
      tailBytes += buf.length;
      while (tailBytes > TAIL_BUFFER_MAX && tailBuffer.length > 1) {
        const dropped = tailBuffer.shift();
        tailBytes -= dropped.length;
      }
      return;
    }
    pcmQueue.push(buf);
    queueBytes += buf.length;
    while (queueBytes > QUEUE_MAX_BYTES && pcmQueue.length > 1) {
      const dropped = pcmQueue.shift();
      queueBytes -= dropped.length;
    }
  }

  function teardown() {
    closed = true;
    if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
    if (silenceFallbackTimer) { clearTimeout(silenceFallbackTimer); silenceFallbackTimer = null; }
    if (audioEndTimer) { clearInterval(audioEndTimer); audioEndTimer = null; }
    tailBuffer = []; tailBytes = 0;
    if (upstream) {
      try { upstreamSend({ type: 'session.close' }); } catch (e) { log.debug('session.close 发送失败', { error: e }); }
      try { upstream.close(); } catch (e) { log.debug('upstream 关闭失败', { error: e }); }
      upstream = null;
    }
  }

  function maybeDelegate(utterance, source) {
    const text = String(utterance || '').trim();
    if (!text) return false;
    const now = Date.now();
    const norm = text.replace(/\s+/g, '');
    if (norm === lastDelegatedUtterance.replace(/\s+/g, '') && now - lastDelegatedAt < DELEGATE_DEDUP_MS) {
      log.info('委托去重命中, 跳过', { source });
      return false;
    }
    lastDelegatedUtterance = text;
    lastDelegatedAt = now;
    log.info('🛠️ 任务委托 → GUI 主链路', { source, utterance: text.slice(0, 60), recentTurns: userTurns.slice(-3).map(t => t.text.slice(0, 20)) });
    metrics.increment('voice_rt_delegates_total', 1, { source: source || 'unknown' });
    toClient({ type: 'delegate', utterance: text, source, context: userTurns.slice(-3) });
    // 打断模型当前轮（闲聊回复/FC token 流）, 让出话头给主链路
    upstreamSend({ type: 'response.cancel' });
    // 2026-09-17: 即时语音回执——委托后先说一句, 消除无声真空期(结果好了再口播摘要)。
    // 回执按来源分级; 查询类带话题词更自然; 面板指令卡片即时弹出有视觉反馈, 不加;
    // 模型说话中不插话。
    let ack = DELEGATE_ACK[source];
    if ((source === 'lookup' || source === 'model-fc') && !ack) ack = lookupAck(text);
    if (ack && !modelSpeaking) {
      upstreamSend({ type: 'speech_text_buffer.commit', text: ack });
    }
    return true;
  }

  // ── 火山下行事件映射 ──
  function handleUpstreamMessage(data) {
    let ev;
    try { ev = JSON.parse(data.toString()); } catch (e) { log.warn('非 JSON 下行帧', { head: String(data).slice(0, 80) }); return; }
    const type = ev.type || '';

    switch (type) {
      case 'session.created':
        sessionReady = true;
        sessionId = (ev.session && ev.session.id) || '';
        log.info('🟢 火山会话就绪', { sessionId });
        toClient({ type: 'ready', sessionId });
        break;

      case 'input_audio_buffer.committed':
      case 'response.canceled':
      case 'session.updated':
        break; // ack 类, GUI 无需感知

      case 'conversation.item.input_audio_transcription.delta':
        if (typeof ev.delta === 'string' && ev.delta) toClient({ type: 'asr', text: ev.delta, final: false });
        break;

      case 'conversation.item.input_audio_transcription.completed': {
        // 注意: delta 为累计式, completed.text 才是最终干净文本
        const text = String(ev.text || ev.transcript || '').trim();
        if (!text) break;
        // 2026-09-17: 回声防护窗——解除静音后 900ms 内的转写是喇叭尾音残响
        // (日志实锤: 模型口播内容被回灌转写成乱码并误委托), 不可信, 直接忽略
        if (Date.now() - lastUnmuteAt < ECHO_GUARD_MS) {
          log.info('忽略解除静音后的回声转写', { text: text.slice(0, 30) });
          break;
        }
        toClient({ type: 'asr', text, final: true });
        // 2026-09-17: 滚动转写上下文——实时会话最近几轮用户话轮(委托时随事件携带,
        // 供 GUI/主链路做上下文接力的数据通路)
        userTurns.push({ text, ts: Date.now() });
        if (userTurns.length > 6) userTurns.shift();
        const task = detectTaskMode(text);
        // 2026-09-17: 面板/卡片指令(打开天气卡片/关闭音乐面板等)——实时模型没有
        // 面板工具, 不委托它只能说"无法打开"; 委托主链路走既有面板意图识别
        // 2026-09-18: 正则补 文档/文件/word——"打开 Word 版文档"类请求也委托,
        // 由 DeepSeek 实际调 ShowDocPanel/文件工具打开(此前模型只口头说"点开就能看")
        const isPanelCmd = /(打开|关闭|弹出|调出|显示|隐藏)[^。！？]{0,12}(卡片|面板|天气|新闻|资讯|热点|股票|台风|音乐|会议|任务|文档|文件|word|Word)/i.test(text);
        // 2026-09-17 分工细化: 查询类话题即时委托, 但知识型问句("台风是怎么形成的"
        // "介绍一下XX")是实时模型擅长的闲聊问答——不委托(秒答), 仅当要现势数据时才转
        const isKnowledge = /(是什么|是怎么|怎么形成|怎么形成的|的原理|介绍一下|介绍下|的区别|什么意思|形成原因|历史沿革)/.test(text);
        const isLookup = LOOKUP_TOPIC_RE.test(text) && !isKnowledge;
        // 2026-09-17: 媒体播放类即时委托(实测: 不委托则实时模型自己开唱)
        const isMedia = MEDIA_PLAY_RE.test(text);
        if (task.isTask || isPanelCmd || isLookup || isMedia) {
          const source = isPanelCmd ? 'panel-cmd' : isMedia ? 'media' : isLookup ? 'lookup' : 'detector';
          log.info('任务检测命中', { score: task.confidence, panel: isPanelCmd, lookup: isLookup, media: isMedia, text: text.slice(0, 40) });
          maybeDelegate(text, source);
          return;
        }
        // 2026-09-17: 沉默兜底——模型对部分请求(内容生成/拒答)硬静默(PoC 已知)。
        // completed 后 SILENCE_FALLBACK_MS 内无任何模型输出活动 → 兜底委托主链路,
        // 彻底消灭"没反应"。任何输出活动(delta/音频)都会取消本定时器。
        if (silenceFallbackTimer) clearTimeout(silenceFallbackTimer);
        const utter = text;
        silenceFallbackTimer = setTimeout(() => {
          silenceFallbackTimer = null;
          if (closed || modelSpeaking || replyAccum) return;
          log.info('模型沉默兜底 → 委托主链路', { text: utter.slice(0, 40) });
          metrics.increment('voice_rt_silence_fallback_total');
          maybeDelegate(utter, 'fallback');
        }, SILENCE_FALLBACK_MS);
        break;
      }

      case 'response.output_text.delta':
        // 任何模型输出活动取消沉默兜底定时器
        if (silenceFallbackTimer) { clearTimeout(silenceFallbackTimer); silenceFallbackTimer = null; }
        if (typeof ev.delta === 'string' && ev.delta) {
          replyAccum += ev.delta;
          const cleaned = stripFcMarkers(replyAccum);
          if (cleaned.trim()) toClient({ type: 'reply_delta', text: cleaned.slice(-200) });
        }
        break;

      case 'response.output_text.done': {
        const finalText = String(ev.text || replyAccum || '');
        replyAccum = '';
        const fcUtterance = parseFcDelegation(finalText);
        if (fcUtterance) {
          // 模型自发委托(查询类任务): 与检测器共用去重
          maybeDelegate(fcUtterance, 'model-fc');
        } else {
          toClient({ type: 'reply_done', text: stripFcMarkers(finalText) });
        }
        break;
      }

      case 'response.output_audio.started':
        // 音频输出同样取消沉默兜底
        if (silenceFallbackTimer) { clearTimeout(silenceFallbackTimer); silenceFallbackTimer = null; }
        modelSpeaking = true;
        toClient({ type: 'audio_start' });
        break;

      case 'response.output_audio.delta':
        // 2026-09-17 关键修正: output_audio.done 事件远早于真实音频流结束(PoC+日志
        // 实锤: done 后 delta 还在流)。GUI 若在 done 就解除静音, 喇叭尾音回灌被
        // 服务端当成"用户说话"→ 模型自我打断 → 播报中断。改为按 delta 活动去抖:
        // 流真正停了 350ms 才下发 audio_end。
        if (ev.delta) {
          if (silenceFallbackTimer) { clearTimeout(silenceFallbackTimer); silenceFallbackTimer = null; }
          lastAudioDeltaTs = Date.now();
          if (!audioEndTimer) {
            audioEndTimer = setInterval(() => {
              if (Date.now() - lastAudioDeltaTs >= AUDIO_END_DEBOUNCE_MS) {
                clearInterval(audioEndTimer); audioEndTimer = null;
                modelSpeaking = false;
                toClient({ type: 'audio_end' });
              }
            }, 120);
          }
          toClient({ type: 'audio', data: ev.delta });
        }
        break;

      case 'response.output_audio.done':
        // done ≠ 音频流结束(见上), 仅作日志; audio_end 由去抖定时器下发
        break;

      case 'response.done':
        log.info('一轮完成', { usage: JSON.stringify(ev.usage || {}).slice(0, 200) });
        break;

      case 'session.closed':
        log.info('火山会话关闭');
        toClient({ type: 'closed' });
        break;

      case 'error':
        log.error('火山错误事件', { message: JSON.stringify(ev).slice(0, 300) });
        toClient({ type: 'error', message: (ev.error && ev.error.message) || '实时对话服务错误' });
        break;

      default:
        if (!/delta$/.test(type)) log.debug('下行事件(未映射)', { type });
    }
  }

  // ── 会话建立 ──
  function openUpstream(cfg, guiConfig) {
    upstream = upstreamFactory(cfg);
    upstream.on('open', () => {
      log.info('火山 duplex 握手成功', { voice: cfg.voice, key: mask(cfg.apiKey) });
      upstreamSend({
        type: 'session.create',
        session: {
          model: '1.2.6.1',
          instructions: guiConfig.instructions || cfg.instructions,
          audio: {
            input: { format: { type: 'pcm', rate: 16000 } },
            output: { format: { type: 'pcm', rate: 24000 }, speed: 0, loudness: 0, voice: cfg.voice },
          },
          // 注意: tools 放 session.create 被忽略(PoC 实测), session.created 后走 session.update
        },
      });
    });
    upstream.on('message', (data) => {
      let ev;
      try { ev = JSON.parse(data.toString()); } catch (e) { return; }
      if (ev.type === 'session.created') {
        // tools 经 session.update 注入(官方 FC 正确姿势)——模型自发委托用
        upstreamSend({
          type: 'session.update',
          session: {
            tools: [{
              type: 'function',
              name: 'delegate_task',
              description: '当用户提出具体任务（查数据、设提醒、做文件等）时调用；闲聊寒暄不要调用。把用户原话完整传入 utterance。',
              parameters: {
                type: 'object',
                properties: { utterance: { type: 'string', description: '用户原话' } },
                required: ['utterance'],
              },
            }],
          },
        });
      }
      handleUpstreamMessage(data);
    });
    upstream.on('close', (code, reason) => {
      log.warn('火山连接关闭', { code, reason: reason && reason.toString().slice(0, 80) });
      if (!closed) toClient({ type: 'error', message: '实时对话连接已断开', category: 'network', retryable: true });
      sessionReady = false;
    });
    upstream.on('error', (e) => {
      log.error('火山连接错误', { error: e.message });
      if (!closed) toClient({ type: 'error', message: '实时对话连接错误: ' + e.message });
    });
  }

  // ── GUI 消息 ──
  // ws v8: isBinary 区分二进制 PCM 与 JSON 控制帧——文本帧的 data 也是 Buffer,
  // 用 instanceof 判别会把 JSON 当音频吞掉(voice-cloud-ws 奇数帧日志即此坑痕迹)
  ws.on('message', (raw, isBinary) => {
    // 第一帧必须是 JSON config
    if (!configured) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { try { ws.close(); } catch (e2) { /* ignore */ } return; }
      if (msg.type !== 'config') return;
      const cfg = configOverride || loadRealtimeConfig();
      if (!cfg || !cfg.apiKey) {
        toClient({ type: 'error', message: '实时对话未配置：缺少火山语音 API Key', category: 'auth', retryable: false });
        setTimeout(() => { try { ws.close(); } catch (e) { /* ignore */ } }, 200);
        return;
      }
      configured = true;
      sessionId = (typeof msg.sessionId === 'string' && msg.sessionId) || crypto.randomUUID();
      log.info('实时对话连接建立', { sessionId, voice: cfg.voice });
      toClient({ type: 'session', sessionId });
      openUpstream(cfg, msg);
      startPacing();
      return;
    }

    // 二进制 PCM → 节奏化队列
    if (isBinary) {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length >= 2 && buf.length % 2 === 0) enqueuePcm(buf);
      return;
    }

    // JSON 控制帧
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    switch (msg.type) {
      case 'mute':
        clientMuted = true;
        setMute(true);
        break;
      case 'unmute': {
        clientMuted = false;
        // 2026-09-17: 尾窗缓冲补播——静音期间的用户语音按序回灌上行队列
        if (tailBytes > 0) {
          pcmQueue = [...tailBuffer, ...pcmQueue];
          queueBytes += tailBytes;
          tailBuffer = [];
          tailBytes = 0;
          log.info('尾窗缓冲补播', { bytes: queueBytes });
        }
        if (!modelSpeaking) setMute(false);
        break;
      }
      case 'commit':
        // PTT 松手: 强制判停(全双工模型实时听中, 松手即轮次结束)
        upstreamSend({ type: 'input_audio_buffer.commit' });
        break;
      case 'interrupt':
        upstreamSend({ type: 'response.cancel' });
        toClient({ type: 'cancelled' });
        break;
      case 'speak': {
        const text = String(msg.text || '').trim();
        if (!text || !sessionReady) break;
        log.info('→ speech_text_buffer.commit (口播摘要)', { len: text.length });
        upstreamSend({ type: 'speech_text_buffer.commit', text });
        break;
      }
      case 'close':
        teardown();
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    metrics.gauge('voice_rt_sessions_active', wss ? wss.clients.size : 0);
    log.info('GUI 连接关闭, 清理会话', { sessionId });
    teardown();
  });
  ws.on('error', () => teardown());
}

/** 关闭 WebSocket 服务器 */
function destroyVoiceRealtimeWS() {
  if (wss) {
    for (const client of wss.clients) {
      try { client.close(1001, 'server-shutdown'); } catch (e) { log.warn('drain: 关闭 realtime WS 失败:', e.message); }
    }
  }
  if (attachedServer && upgradeHandler) {
    attachedServer.removeListener('upgrade', upgradeHandler);
  }
  attachedServer = null;
  upgradeHandler = null;
  if (wss) {
    try { wss.close(); } catch (e) { log.debug('wss 关闭失败', { error: e }); }
    wss = null;
  }
}

function setDrainingRt(v) { draining = v; }

module.exports = { attachVoiceRealtimeWS, destroyVoiceRealtimeWS, setDrainingRt };
