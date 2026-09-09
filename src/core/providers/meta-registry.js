/**
 * meta-registry.js — Provider 元数据注册表（Phase 3d, 2026-08-25）
 *
 * 为路由决策/面板展示提供"能力/窗口/限流"清单化数据基础：
 *   kind: llm | tts | doc-engine
 *   llm 元数据**直接引用** llm/provider-registry 的 PROVIDER_MODEL_DEFS
 *   （单一事实源——零复制，无数字漂移；本表只做 provider 级登记+查询面）。
 * 可注册/可查询/可枚举；内置注册失败仅告警（元数据缺失不影响运行——它是"清单"不是"开关"）。
 */
const { PROVIDER_MODEL_DEFS } = require('../llm/provider-registry');

const _metas = new Map(); // id → meta

/** 注册（重名拒绝） */
function registerProviderMeta(meta) {
  if (!meta || typeof meta.id !== 'string' || !meta.id.trim()) return { ok: false, error: 'meta.id 必填' };
  if (!['llm', 'tts', 'doc-engine'].includes(meta.kind)) return { ok: false, error: `meta.kind 非法: ${meta.kind}` };
  if (_metas.has(meta.id)) return { ok: false, error: `重复注册 provider: ${meta.id}` };
  _metas.set(meta.id, meta);
  return { ok: true };
}

function getProviderMeta(id) {
  return _metas.get(id) || null;
}

function listProviderMeta(kind) {
  return Array.from(_metas.values()).filter((m) => !kind || m.kind === kind);
}

function installBuiltinProviderMeta() {
  const results = [];
  const tryReg = (meta) => {
    const r = registerProviderMeta(meta);
    results.push({ id: meta.id, ok: r.ok, error: r.error });
  };

  // LLM：provider 级登记 + models 引用（零复制；窗口/限流以 model defs 为准）
  for (const [providerId, defs] of Object.entries(PROVIDER_MODEL_DEFS || {})) {
    tryReg({
      id: providerId, kind: 'llm',
      name: providerId,
      models: defs, // 引用——单一事实源
      modelCount: Array.isArray(defs) ? defs.length : 0,
    });
  }

  // TTS（src/core/tts/index.js 四家）
  for (const [id, desc] of [
    ['doubao', '豆包 TTS（HTTP 流式, MSE 直播）'],
    ['edge', 'Edge TTS（免费, WS）'],
    ['sapi', 'Windows SAPI 本地语音'],
    ['piper', 'Piper 本地 TTS（需 piperPath/模型）'],
  ]) {
    tryReg({ id, kind: 'tts', name: id, description: desc });
  }

  // 文档引擎（skill-executor 8 清单, HARNESS §13）
  for (const [id, desc] of [
    ['pdf-generator', 'PDF 生成'],
    ['word-docx', 'Word 文档'],
    ['powerpoint-pptx', 'PPT 演示'],
    ['html-generator', '独立 HTML 报告'],
    ['diagram-generator', '图表/架构图'],
    ['chart-generator', '数据图表'],
    ['image-editor', '图片编辑'],
    ['bilibili-playurl', 'B站直链解析'],
  ]) {
    tryReg({ id, kind: 'doc-engine', name: id, description: desc });
  }

  return results;
}

module.exports = { registerProviderMeta, getProviderMeta, listProviderMeta, installBuiltinProviderMeta };
