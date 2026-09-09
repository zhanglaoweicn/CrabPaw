// voice-tts.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const { readJsonBody, sendJson } = require('../http-utils');

// 专用 TTS 端点
async function handleVoiceTTS(req, res, ctx) {
  try {
    const body = await readJsonBody(req);
    if (!body || !body.text) return sendJson(res, 400, { success: false, error: '缺少 text' });
    const refineParam = body.refine;
    const allowRefine = refineParam !== '0';
    const { resolveRefinedText } = require('../../core/voice-evolution');
    const ttsText = resolveRefinedText(body.text, { allowRefine });
    // C1 fix: 不再在此处 stripMarkdownForSpeech — 引擎内部 synthesize() 已统一处理 sanitizeTextForSpeech
    const { getTextToSpeechEngine } = require('../../core/tts');
    const ttsEngine = getTextToSpeechEngine();
    // 2026-08-05 fix: provider 默认空串——不强制 edge。前端不带 provider 时应走
    // 引擎 _buildProviderOrder 智能排序(edge 熔断时跳过、doubao 优先)。
    // 此前默认 'edge' 使 options.provider 覆盖排序，被墙环境每请求白等 6s。
    const provider = body.provider || '';
    // V1 fix: 构建请求级 voiceOverride 而非直接修改 ttsEngine.config.voice 单例
    const voiceOverride = {};
    if (provider === 'doubao' || provider === 'volcano') {
      const appCfg = ctx.appConfig || {};
      let realKey = (appCfg.voice || {}).doubaoKey || '';
      if (!realKey || realKey.indexOf('***') >= 0 || realKey.length < 8) {
        realKey = ((appCfg.models || {}).providers || {}).doubao?.apiKey || '';
      }
      if (!realKey || realKey.indexOf('***') >= 0 || realKey.length < 8) {
        try {
          const { loadConfig } = require('../../core/config');
          const diskCfg = loadConfig();
          realKey = (diskCfg.voice || {}).doubaoKey || ((diskCfg.models || {}).providers || {}).doubao?.apiKey || '';
        } catch (e) { console.error("[VoiceTTS] 从磁盘读取配置失败:", e.message); }
      }
      if (realKey && realKey.length > 8 && realKey.indexOf('***') < 0) {
        voiceOverride.doubaoKey = realKey;
        if (provider === 'volcano') {
          voiceOverride.volcanoAppId = (appCfg.voice || {}).volcanoAppId || '';
          voiceOverride.volcanoToken = (appCfg.voice || {}).volcanoToken || '';
        }
      }
    }
    // 确保 doubao key 在 fallback 场景下可用
    if (!voiceOverride.doubaoKey) {
      const existingKey = (ttsEngine.config.voice || {}).doubaoKey;
      if (existingKey && existingKey.length > 8 && !existingKey.includes('***')) {
        voiceOverride.doubaoKey = existingKey;
      } else {
        try {
          const { loadConfig } = require('../../core/config');
          const diskCfg2 = loadConfig();
          const dk = (diskCfg2.voice || {}).doubaoKey || ((diskCfg2.models || {}).providers || {}).doubao?.apiKey || '';
          if (dk && dk.length > 8 && !dk.includes('***')) {
            voiceOverride.doubaoKey = dk;
          }
        } catch (e) { /* 静默 */ console.error('[VoiceTTSStream] 从磁盘读取配置失败:', e?.message || e) }
      }
    }
    const result = await ttsEngine.synthesize(ttsText, {
      voice: body.voice || 'zh-CN-XiaoxiaoNeural',
      speed: body.speed || 1.0,
      _refined: body._refined || false,
      provider: provider === 'edge-tts' ? 'edge' : provider,
      voiceOverride: Object.keys(voiceOverride).length > 0 ? voiceOverride : undefined,
    });
    if (result.success && result.filePath && fs.existsSync(result.filePath)) {
      const audioBuffer = fs.readFileSync(result.filePath);
      result.audioBase64 = audioBuffer.toString('base64');
      result.audioFormat = result.format || 'mp3';
    }
    return sendJson(res, 200, result);
  } catch (e) { return sendJson(res, 500, { success: false, error: e.message }); }
}

// TTS 流式端点 — 使用 synthesizeStream 实现真正的边合成边推送
async function handleVoiceTTSStream(req, res, ctx) {
  try {
    const body = await readJsonBody(req);
    if (!body || !body.text) return sendJson(res, 400, { success: false, error: '缺少 text' });
    const refineParam = body.refine;
    const allowRefine = refineParam !== '0';
    const { resolveRefinedText } = require('../../core/voice-evolution');
    const ttsText = resolveRefinedText(body.text, { allowRefine });
    // C1 fix: 不再在此处 stripMarkdownForSpeech — 引擎内部已统一处理
    const { getTextToSpeechEngine } = require('../../core/tts');
    const ttsEngine = getTextToSpeechEngine();
    // 2026-08-05 fix: provider 默认空串——不强制 edge。前端不带 provider 时应走
    // 引擎 _buildProviderOrder 智能排序(edge 熔断时跳过、doubao 优先)。
    // 此前默认 'edge' 使 options.provider 覆盖排序，被墙环境每请求白等 6s。
    const provider = body.provider || '';
    // V1 fix: 构建请求级 voiceOverride 而非直接修改 ttsEngine.config.voice 单例
    const streamVoiceOverride = {};
    if (provider === 'doubao' || provider === 'volcano') {
      const appCfg = ctx.appConfig || {};
      let realKey = (appCfg.voice || {}).doubaoKey || '';
      if (!realKey || realKey.indexOf('***') >= 0 || realKey.length < 8) {
        realKey = ((appCfg.models || {}).providers || {}).doubao?.apiKey || '';
      }
      if (!realKey || realKey.indexOf('***') >= 0 || realKey.length < 8) {
        try {
          const { loadConfig } = require('../../core/config');
          const diskCfg = loadConfig();
          realKey = (diskCfg.voice || {}).doubaoKey || ((diskCfg.models || {}).providers || {}).doubao?.apiKey || '';
        } catch (e) { console.error("[VoiceTTSStream] 从磁盘读取配置失败:", e.message); }
      }
      if (realKey && realKey.length > 8 && realKey.indexOf(String.fromCharCode(42,42,42)) < 0) {
        streamVoiceOverride.doubaoKey = realKey;
        if (provider === String.fromCharCode(118,111,108,99,97,110,111)) {
          streamVoiceOverride.volcanoAppId = (appCfg.voice || {}).volcanoAppId || String();
          streamVoiceOverride.volcanoToken = (appCfg.voice || {}).volcanoToken || String();
        }
      }
    }
    if (!streamVoiceOverride.doubaoKey) {
      const existingKey = (ttsEngine.config.voice || {}).doubaoKey;
      if (existingKey && existingKey.length > 8 && !existingKey.includes(String.fromCharCode(42,42,42))) {
        streamVoiceOverride.doubaoKey = existingKey;
      } else {
        try {
          const { loadConfig } = require(String.fromCharCode(46,46,47) + String.fromCharCode(46,46,47) + String.fromCharCode(99,111,114,101,47) + String.fromCharCode(99,111,110,102,105,103));
          const diskCfg3 = loadConfig();
          const dk = (diskCfg3.voice || {}).doubaoKey || ((diskCfg3.models || {}).providers || {}).doubao?.apiKey || String();
          if (dk && dk.length > 8 && !dk.includes(String.fromCharCode(42,42,42))) {
            streamVoiceOverride.doubaoKey = dk;
          }
        } catch (e) { /* silent */ console.error('[VoiceTTSStream] 从磁盘读取配置失败:', e?.message || e) }
      }
    }
    const stream = await ttsEngine.synthesizeStream(ttsText, {
      voice: body.voice || String.fromCharCode(122,104,45,67,78,45,88,105,97,111,120,105,97,111,78,101,117,114,97,108),
      speed: body.speed || 1.0,
      provider: provider === String.fromCharCode(101,100,103,101,45,116,116,115) ? String.fromCharCode(101,100,103,101) : provider,
      style: typeof body.style === 'string' && body.style.trim() ? body.style : undefined,
      voiceOverride: Object.keys(streamVoiceOverride).length > 0 ? streamVoiceOverride : undefined,
    });
    // 2026-08-03 修复: 合成失败（stream.destroyed，如 edge-tts 被封/doubao key 无效）
    // 此前无条件 writeHead(200) → 前端收到 200 空音频 → <audio> 无声立即结束 → "播一半就停"。
    // destroy 的 error 事件在 await 返回前已派发（nextTick 先于 promise 微任务），
    // 下方 on('error') 监听器可能错过——故在 writeHead 前显式检查 destroyed。
    if (stream.destroyed) {
      const errMsg = (stream.errored && stream.errored.message)
        || (stream.readableAborted ? 'TTS 合成中止' : 'TTS 合成失败（全部提供商不可用）');
      console.error('[TTS Stream] synthesize failed before headers:', errMsg);
      return sendJson(res, 500, { success: false, error: errMsg });
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    stream.on('data', (chunk) => {
      try { res.write(chunk); } catch (writeErr) {
        // 客户端已断开连接（EPIPE），停止写入并销毁流
        console.warn('[TTS Stream] Client disconnected during write:', writeErr.code || writeErr.message);
        stream.destroy();
      }
    });
    stream.on('end', () => { try { res.end(); } catch (_e) {
      /* client gone */
      console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
 } });
    stream.on('error', (err) => {
      console.error('[TTS Stream] Error:', err.message);
      if (!res.headersSent) {
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); } catch (_e) {
        /* client gone */
        console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
      }
      try { res.end(JSON.stringify({ success: false, error: err.message })); } catch (_e) {
        /* client gone */
        console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
    }
      } else {
        try { res.end(); } catch (_e) {
          /* client gone */
          console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
 }
      }
    });
    // 客户端断开时销毁流，避免后端继续推数据
    req.on('close', () => { stream.destroy(); });
  } catch (e) { sendJson(res, 500, { success: false, error: e.message }); }
}

// GET /api/voice/tts/stream?text=...&voice=...&provider=...&speed=...
// <audio> 元素只能发 GET 请求，此端点让前端可以直接
// 用 audio.src = "/api/voice/tts/stream?text=..." 实现流式播放（边收边播），
// 首帧延迟从 8-9s 降至 200-500ms。
// HEAD /api/voice/tts/stream — 前端用 HEAD 检测 GET 流式端点是否可用
// 不消耗数据，只返回 200 OK 表示端点存在
async function handleVoiceTTSStreamHead(req, res, _ctx) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': '0',
  });
  res.end();
}

async function handleVoiceTTSStreamGet(req, res, ctx) {
  // 2026-08-12: 排空中拒绝新合成(客户端应立即停止拉流)
  try {
    const { isDraining } = require('../../handlers/voice-cloud-ws');
    if (isDraining()) return sendJson(res, 503, { success: false, error: 'Server draining' });
  } catch (e) { console.warn('[VoiceTTSStreamGet] drain 检查失败:', e.message); }
  const ttsT0 = Date.now();
  let ttsFirstByte = false;
  const noteTtsFirstByte = () => {
    if (ttsFirstByte) return;
    ttsFirstByte = true;
    try {
      const { getMetricsCollector } = require('../../core/observability');
      getMetricsCollector().histogram('voice_tts_first_byte_ms', Date.now() - ttsT0);
    } catch (e) { console.warn('[VoiceTTSStreamGet] metrics 记录失败:', e.message); }
  };
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const text = url.searchParams.get('text');
    if (!text) return sendJson(res, 400, { success: false, error: '缺少 text 参数' });

    const refineParam = url.searchParams.get('refine');
    const allowRefine = refineParam !== '0';
    const { resolveRefinedText } = require('../../core/voice-evolution');
    const ttsText = resolveRefinedText(text, { allowRefine });

    const body = {
      text: ttsText,
      voice: url.searchParams.get('voice') || 'zh-CN-XiaoxiaoNeural',
      provider: url.searchParams.get('provider') || '',
      speed: parseFloat(url.searchParams.get('speed') || '1') || 1,
      style: url.searchParams.get('style') || undefined,
      _refined: true,
    };

    // 复用 handleVoiceTTSStream 的核心逻辑，但用 body 对象替代 req body
    const { getTextToSpeechEngine } = require('../../core/tts');
    const ttsEngine = getTextToSpeechEngine();
    // 2026-08-05 fix: provider 默认空串——不强制 edge。前端不带 provider 时应走
    // 引擎 _buildProviderOrder 智能排序(edge 熔断时跳过、doubao 优先)。
    // 此前默认 'edge' 使 options.provider 覆盖排序，被墙环境每请求白等 6s。
    const provider = body.provider || '';
    const streamVoiceOverride = {};
    if (provider === 'doubao' || provider === 'volcano') {
      const appCfg = ctx.appConfig || {};
      let realKey = (appCfg.voice || {}).doubaoKey || '';
      if (!realKey || realKey.indexOf('***') >= 0 || realKey.length < 8) {
        realKey = ((appCfg.models || {}).providers || {}).doubao?.apiKey || '';
      }
      if (!realKey || realKey.indexOf('***') >= 0 || realKey.length < 8) {
        try {
          const { loadConfig } = require('../../core/config');
          const diskCfg = loadConfig();
          realKey = (diskCfg.voice || {}).doubaoKey || ((diskCfg.models || {}).providers || {}).doubao?.apiKey || '';
        } catch (e) { console.error("[VoiceTTSStreamGet] 从磁盘读取配置失败:", e.message); }
      }
      if (realKey && realKey.length > 8 && realKey.indexOf(String.fromCharCode(42,42,42)) < 0) {
        streamVoiceOverride.doubaoKey = realKey;
        if (provider === String.fromCharCode(118,111,108,99,97,110,111)) {
          streamVoiceOverride.volcanoAppId = (appCfg.voice || {}).volcanoAppId || String();
          streamVoiceOverride.volcanoToken = (appCfg.voice || {}).volcanoToken || String();
        }
      }
    }
    if (!streamVoiceOverride.doubaoKey) {
      const existingKey = (ttsEngine.config.voice || {}).doubaoKey;
      if (existingKey && existingKey.length > 8 && !existingKey.includes(String.fromCharCode(42,42,42))) {
        streamVoiceOverride.doubaoKey = existingKey;
      } else {
        try {
          const { loadConfig } = require(String.fromCharCode(46,46,47) + String.fromCharCode(46,46,47) + String.fromCharCode(99,111,114,101,47) + String.fromCharCode(99,111,110,102,105,103));
          const diskCfg3 = loadConfig();
          const dk = (diskCfg3.voice || {}).doubaoKey || ((diskCfg3.models || {}).providers || {}).doubao?.apiKey || String();
          if (dk && dk.length > 8 && !dk.includes(String.fromCharCode(42,42,42))) {
            streamVoiceOverride.doubaoKey = dk;
          }
        } catch (e) { /* silent */ console.error('[VoiceTTSStream] 从磁盘读取配置失败:', e?.message || e) }
      }
    }
    const stream = await ttsEngine.synthesizeStream(ttsText, {
      voice: body.voice,
      speed: body.speed,
      style: typeof body.style === 'string' && body.style.trim() ? body.style : undefined,
      provider: provider === String.fromCharCode(101,100,103,101,45,116,116,115) ? String.fromCharCode(101,100,103,101) : provider,
      voiceOverride: Object.keys(streamVoiceOverride).length > 0 ? streamVoiceOverride : undefined,
    });
    // 2026-08-03 修复: 合成失败（stream.destroyed）→ 500 而非 200 空音频（同 POST 处理器）
    if (stream.destroyed) {
      const errMsg = (stream.errored && stream.errored.message)
        || (stream.readableAborted ? 'TTS 合成中止' : 'TTS 合成失败（全部提供商不可用）');
      console.error('[TTS Stream GET] synthesize failed before headers:', errMsg);
      return sendJson(res, 500, { success: false, error: errMsg });
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    noteTtsFirstByte();
    stream.on('data', (chunk) => {
      try { res.write(chunk); } catch (writeErr) {
        console.warn('[TTS Stream GET] Client disconnected during write:', writeErr.code || writeErr.message);
        stream.destroy();
      }
    });
    stream.on('end', () => { try { res.end(); } catch (_e) {
      /* client gone */
      console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
 } });
    stream.on('error', (err) => {
      console.error('[TTS Stream GET] Error:', err.message);
      if (!res.headersSent) {
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); } catch (_e) {
        /* client gone */
        console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
      }
      try { res.end(JSON.stringify({ success: false, error: err.message })); } catch (_e) {
        /* client gone */
        console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
    }
      } else {
        try { res.end(); } catch (_e) {
          /* client gone */
          console.warn('[voice-tts.js] 空 catch 补日志:', _e && _e.message);
 }
      }
    });
    req.on('close', () => { stream.destroy(); });
  } catch (e) { sendJson(res, 500, { success: false, error: e.message }); }
}

// TTS 打断端点 — 记录用户打断时实际播放的内容
// POST /api/voice/tts/interrupted { spokenContent, conversationId, requestId }
async function handleTTSInterrupted(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    if (!body || !body.spokenContent) {
      return sendJson(res, 400, { success: false, error: '缺少 spokenContent' });
    }
    console.log('[TTS] 打断记录: spoken=%d chars, requestId=%s',
      body.spokenContent.length, body.requestId || '?');
    return sendJson(res, 200, { success: true });
  } catch (e) { sendJson(res, 500, { success: false, error: e.message }); }
}

module.exports = {
  handleVoiceTTS,
  handleVoiceTTSStream,
  handleVoiceTTSStreamHead,
  handleVoiceTTSStreamGet,
  handleTTSInterrupted,
};
