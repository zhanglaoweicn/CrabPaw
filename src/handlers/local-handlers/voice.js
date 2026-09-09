// voice.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

// 人物卡片 — GET /api/person-card?name=
async function handlePersonCard(req, res, ctx) {
  const h = require('../../handlers/person-card-handler');
  await h.handlePersonCard(req, res, ctx.url.pathname);
}

// 文档面板 — GET /api/docs
async function handleDocs(req, res, _ctx) {
  const topics = [
    { id: 'voice', title: '语音配置指南', subtitle: 'ASR + TTS', summary: 'CrabPaw 使用火山 ASR 和豆包 TTS 2.0。在设置中填写豆包 API Key 即可同时启用。' },
    { id: 'aci', title: '预判注入 (ACI)', subtitle: 'Anticipatory Context Injection', summary: '在 LLM 调用前预取记忆、天气、热点、线程上下文、Scene manifest。' },
    { id: 'scene', title: 'Scene UI 协议', subtitle: 'Agent 驱动界面', summary: 'Agent 通过 scene 声明 UI surface, SceneShell 渲染。' },
    { id: 'model', title: '模型配置', subtitle: 'LLM Provider', summary: '支持 DeepSeek、豆包、OpenAI、Kimi、GLM 等 Provider。' },
  ];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, data: { topics } }));
}

// 语音 ASR 端点 — 接收 PCM 返回文字
async function handleVoiceASR(req, res, _ctx) {
  const { handleVoiceASR } = require('../../handlers/voice-asr-handler');
  await handleVoiceASR(req, res);
}

async function handleVoiceAudio(req, res, ctx) {
  const raw = decodeURIComponent(ctx.url.pathname.replace(/^\/api\/voice\/audio\//, ""));
  const { sendJson } = require('../../handlers/http-utils');
  const path = require("path");
  const fss = require("fs");
  const { getDataDir } = require('../../core/config');
  const audioDir = path.join(getDataDir(), "tts-output");
  const safePath = path.resolve(audioDir, path.basename(raw));
  if (!safePath.startsWith(path.resolve(audioDir) + path.sep)) {
    return sendJson(res, 403, { success: false, error: "Access denied" });
  }
  if (!fss.existsSync(safePath)) {
    return sendJson(res, 404, { success: false, error: "File not found" });
  }
  const ext = path.extname(safePath).toLowerCase();
  const ctMap = { ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4" };
  res.writeHead(200, { "Content-Type": ctMap[ext] || "audio/mpeg", "Accept-Ranges": "bytes" });
  fss.createReadStream(safePath).pipe(res);
}

async function handleVoiceDiagnose(req, res, ctx) {
  const { sendJson } = require("../../handlers/http-utils");
  const { validateCredentials } = require('../../core/asr/providers');
  try {
    // C4 fix: 区分 GET/POST — GET 返回快速诊断，POST 执行深度验证
    if (req.method === 'GET') {
      sendJson(res, 200, { success: true, asrReady: true, method: 'quick' });
      return;
    }
    // V3 fix: 传入正确的 providerName 和 config 参数
    const appCfg = ctx.appConfig || {};
    const asrProvider = (appCfg.voice || {}).asrProvider || 'volcengine';
    const asrConfig = ((appCfg.models || {}).providers || {})[asrProvider] || {};
    const result = validateCredentials(asrProvider, asrConfig);
    sendJson(res, 200, { success: true, asrReady: result.valid, missing: result.missing, provider: asrProvider });
  } catch (e) {
    sendJson(res, 200, { success: true, asrReady: false, error: e.message });
  }
}

module.exports = {
  handlePersonCard,
  handleDocs,
  handleVoiceASR,
  handleVoiceAudio,
  handleVoiceDiagnose,
};
