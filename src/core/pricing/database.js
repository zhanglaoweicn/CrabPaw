const OFFICIAL_PRICING = {
  deepseek: {
    'deepseek-chat': {
      input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: null,
      source: 'official_docs', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    },
    'deepseek-reasoner': {
      input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: null,
      source: 'official_docs', sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    },
  },
  alibaba: {
    'qwen-max': { input: 0.20, output: 0.60, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://help.aliyun.com/document_detail/2712595.html' },
    'qwen-plus': { input: 0.08, output: 0.20, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://help.aliyun.com/document_detail/2712595.html' },
    'qwen-turbo': { input: 0.03, output: 0.06, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://help.aliyun.com/document_detail/2712595.html' },
    'qwen-long': { input: 0.0005, output: 0.002, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://help.aliyun.com/document_detail/2712595.html' },
  },
  moonshot: {
    'moonshot-v1-8k': { input: 0.012, output: 0.012, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://platform.moonshot.cn/docs/pricing' },
    'moonshot-v1-32k': { input: 0.024, output: 0.024, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://platform.moonshot.cn/docs/pricing' },
    'moonshot-v1-128k': { input: 0.06, output: 0.06, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://platform.moonshot.cn/docs/pricing' },
  },
  zhipu: {
    'glm-4': { input: 0.10, output: 0.10, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://open.bigmodel.cn/pricing' },
    'glm-4-air': { input: 0.001, output: 0.001, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://open.bigmodel.cn/pricing' },
    'glm-4-flash': { input: 0.0001, output: 0.0001, cacheRead: null, cacheWrite: null, source: 'official_docs', sourceUrl: 'https://open.bigmodel.cn/pricing' },
  },
};

const PROVIDER_ALIASES = {
  qwen: 'alibaba',
  moonshot: 'moonshot',
  glm: 'zhipu',
};

const DEFAULT_PRICING = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  source: 'unknown', sourceUrl: null,
};

function detectProvider(model, baseUrl) {
  const modelLower = (model || '').toLowerCase();
  const baseLower = (baseUrl || '').toLowerCase();

  if (baseLower.includes('deepseek') || modelLower.includes('deepseek')) return 'deepseek';
  if (baseLower.includes('moonshot') || modelLower.includes('moonshot')) return 'moonshot';
  if (baseLower.includes('zhipu') || baseLower.includes('bigmodel') || modelLower.includes('glm')) return 'zhipu';
  if (baseLower.includes('aliyun') || baseLower.includes('dashscope') || modelLower.includes('qwen')) return 'alibaba';

  for (const [alias, provider] of Object.entries(PROVIDER_ALIASES)) {
    if (modelLower.includes(alias)) return provider;
  }

  return 'unknown';
}

function normalizeModelName(model) {
  if (!model) return '';
  let normalized = model.toLowerCase();
  return normalized;
}

function getPricing(model, baseUrl) {
  const provider = detectProvider(model, baseUrl);
  const normalizedModel = normalizeModelName(model);
  const providerPricing = OFFICIAL_PRICING[provider];
  if (providerPricing && providerPricing[normalizedModel]) {
    return providerPricing[normalizedModel];
  }
  for (const [, models] of Object.entries(OFFICIAL_PRICING)) {
    if (models[normalizedModel]) return models[normalizedModel];
  }
  return DEFAULT_PRICING;
}

function calculateCost(model, baseUrl, inputTokens, outputTokens, cacheReadTokens = 0) {
  const pricing = getPricing(model, baseUrl);
  const inputCost = (inputTokens / 1000000) * pricing.input;
  const outputCost = (outputTokens / 1000000) * pricing.output;
  const cacheCost = (cacheReadTokens / 1000000) * (pricing.cacheRead || 0);
  const total = inputCost + outputCost + cacheCost;
  return {
    inputCost, outputCost, cacheCost, total,
    inputTokens, outputTokens, cacheReadTokens,
    model, pricing,
  };
}

module.exports = {
  OFFICIAL_PRICING,
  detectProvider,
  getPricing,
  calculateCost,
  DEFAULT_PRICING,
};
