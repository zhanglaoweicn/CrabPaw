/**
 * 视觉模型解析器（config-driven，无硬编码模型 ID）
 *
 * 设计原则：
 *  1. 视觉模型的 provider / model / baseUrl / apiKey 完全由 config 决定
 *  2. 优先级（从高到低）：
 *     a) models.auxiliary.vision  显式配置（用户首选）
 *     b) visionGeneration.*       专门用于视觉生成的 section
 *     c) 当前主 provider 的模型本身就是视觉模型（如 gpt-4o / claude-3-5-sonnet / qwen-vl-plus）
 *     d) 其它已配 API Key 的视觉供应商（按 VISION_CAPABLE_PROVIDERS 顺序）
 *  3. SUGGESTED_VISION_MODELS 只是"提示默认值"，永远可以被 config 覆盖
 *  4. 如果以上都拿不到，返回 null，让调用方给出可操作的设置指引
 *
 * 不再维护 PROVIDER_VISION_MODEL 之类的硬编码 ID 列表。
 * 如果你想新增一个"我推荐的模型"，加到 SUGGESTED_VISION_MODELS 即可。
 */



// 这些供应商已知支持视觉模型。命中顺序：列表中先出现者优先。
const VISION_CAPABLE_PROVIDERS = [
  'qwen',       // qwen-vl-plus, qwen-vl-max
  'glm',        // glm-4v, glm-4v-flash
  'zhipu',      // glm-4v-plus
  'doubao',     // doubao-1.5-vision-pro-32k
  'ollama',     // llava, llama3.2-vision, moondream, minicpm-v
];

// 视觉模型关键词（小写匹配）。命中即视为"该模型支持视觉"。
const VISION_KEYWORDS = [
  'vision',
  '-vl',
  'llava',
  'moondream',
  'minicpm-v',
  'llama3.2-vision',
  'qwen-vl',
  'glm-4v',
  'doubao-vision',
  'doubao-1.5-vision',
];

// 供应商未显式配置 model 时，给出的"建议默认模型"。
// 这不是硬编码 — 用户只要在 auxiliary.vision.model 里写自己的模型名就一定优先。
const SUGGESTED_VISION_MODELS = {
  qwen: 'qwen-vl-plus',
  glm: 'glm-4v-flash',
  zhipu: 'glm-4v',
  doubao: 'doubao-1-5-vision-pro-32k-250115',
  // ollama: 用户必须自己 ollama pull 一个视觉模型，不给默认避免误用文本模型
};

/**
 * 判断一个模型是否支持视觉
 * @param {string} provider - provider id（用于白名单前置过滤）
 * @param {string} model - 模型名
 * @returns {boolean}
 */
function isVisionCapable(provider, model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase();

  // provider 在视觉供应商白名单内，且模型名命中关键词
  if (provider && VISION_CAPABLE_PROVIDERS.includes(provider)) {
    if (VISION_KEYWORDS.some(k => m.includes(k))) return true;
  }

  // provider 不在白名单内（用户自定义），但模型名明显是视觉模型
  if (m.includes('vision') || m.includes('llava') || m.includes('moondream')) {
    return true;
  }

  return false;
}

/**
 * 解析视觉后端。
 *
 * @param {Object} config - 完整 config（loadConfig() 的结果）
 * @returns {null | {
 *   provider: string,
 *   model: string,
 *   baseUrl: string,
 *   apiKey: string,
 *   source: string,         // 命中来源，便于日志与提示
 *   warning?: string,       // 命中"非首选来源"时给用户的提示
 * }}
 */
function resolveVisionModel(config) {
  if (!config) return null;
  const models = config.models || {};

  // ===== 1. models.auxiliary.vision 显式配置 =====
  const aux = models.auxiliary && models.auxiliary.vision;
  if (aux && aux.provider && aux.provider !== 'auto' && aux.provider !== 'off') {
    const pc = (models.providers || {})[aux.provider] || {};
    if ((pc.apiKey && pc.apiKey.trim() !== '' && !pc.apiKey.includes('***')) || aux.baseUrl) {
      return {
        provider: aux.provider,
        model: aux.model || pc.model || SUGGESTED_VISION_MODELS[aux.provider] || '',
        baseUrl: aux.baseUrl || pc.baseUrl || '',
        apiKey: aux.apiKey || pc.apiKey || '',
        source: 'auxiliary.vision',
      };
    }
  }

  // ===== 2. visionGeneration 专项配置 =====
  const vg = config.visionGeneration;
  if (vg && vg.provider && vg.providers && vg.providers[vg.provider]) {
    const pcfg = vg.providers[vg.provider];
    if (pcfg.apiKey && pcfg.apiKey.trim() !== '' && !pcfg.apiKey.includes('***')) {
      return {
        provider: vg.provider,
        model: vg.model || pcfg.model || SUGGESTED_VISION_MODELS[vg.provider] || '',
        baseUrl: pcfg.baseUrl || '',
        apiKey: pcfg.apiKey,
        source: 'visionGeneration',
      };
    }
  }

  // ===== 3. 当前主 provider 的模型本身就是视觉模型 =====
  const mainProvider = models.currentProvider;
  const mainModel = mainProvider && (models.providers || {})[mainProvider] && (models.providers || {})[mainProvider].model;
  if (isVisionCapable(mainProvider, mainModel)) {
    const pc = (models.providers || {})[mainProvider];
    if (pc && pc.apiKey && pc.apiKey.trim() !== '' && !pc.apiKey.includes('***')) {
      return {
        provider: mainProvider,
        model: mainModel,
        baseUrl: pc.baseUrl || '',
        apiKey: pc.apiKey,
        source: 'current-provider',
      };
    }
  }

  // ===== 4. 其它已配视觉供应商 =====
  for (const provider of VISION_CAPABLE_PROVIDERS) {
    if (provider === mainProvider) continue; // 主 provider 已在步骤 3 检查过
    const pc = (models.providers || {})[provider];
    if (!pc || !pc.apiKey || pc.apiKey.trim() === '' || pc.apiKey.includes('***')) continue;

    const suggested = SUGGESTED_VISION_MODELS[provider] || pc.model;
    return {
      provider,
      model: suggested,
      baseUrl: pc.baseUrl || '',
      apiKey: pc.apiKey,
      source: 'provider-default',
      warning: `未在 models.auxiliary.vision 显式指定视觉模型，自动选用 ${provider} 推荐的 ${suggested}。` +
               `如需切换模型或供应商，请在设置中配置 models.auxiliary.vision。`,
    };
  }

  // ===== 5. 全部 miss =====
  return null;
}

/**
 * 当 resolveVisionModel() 返回 null 时，返回给用户的设置指引
 * （纯字符串，由调用方决定如何呈现）
 */
function buildSetupGuide(_config) {
  const lines = [];
  lines.push('当前没有可用的视觉模型，请通过以下任一方式启用：');
  lines.push('');
  lines.push('方式 A：在主配置中显式指定（推荐）');
  lines.push('  config.json → models.auxiliary.vision');
  lines.push('  示例：');
  lines.push('    "auxiliary": {');
  lines.push('      "vision": { "provider": "qwen", "model": "qwen-vl-plus" }');
  lines.push('    }');
  lines.push('');
  lines.push('方式 B：把主模型切换为支持多模态的模型');
  lines.push('  推荐模型（取决于已配 API Key 的供应商）：');
  for (const p of VISION_CAPABLE_PROVIDERS) {
    if (SUGGESTED_VISION_MODELS[p]) {
      lines.push(`    - ${p}: ${SUGGESTED_VISION_MODELS[p]}`);
    }
  }
  lines.push('');
  lines.push('方式 C：使用本地 Ollama（完全离线）');
  lines.push('  1) ollama pull llama3.2-vision   # 或 llava / moondream / minicpm-v');
  lines.push('  2) 在 providers.ollama.model 中填入模型名');
  lines.push('  3) 在 models.auxiliary.vision 里指定 { provider: "ollama", model: "llama3.2-vision" }');
  lines.push('');
  lines.push('方式 D：纯本地图片元信息（无需视觉模型）');
  lines.push('  使用 ImageInfo 工具可获取 EXIF/尺寸/格式等基础信息；');
  lines.push('  使用 image-preprocess 技能可做压缩/格式转换。');
  return lines.join('\n');
}

module.exports = {
  resolveVisionModel,
  isVisionCapable,
  buildSetupGuide,
  VISION_CAPABLE_PROVIDERS,
  VISION_KEYWORDS,
  SUGGESTED_VISION_MODELS,
};

