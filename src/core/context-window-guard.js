const { DATA_DIR } = require('./config');

const CONTEXT_WINDOW_HARD_MIN_TOKENS = 4000;
const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 8000;
const CONTEXT_WINDOW_HARD_MIN_RATIO = 0.1;
const CONTEXT_WINDOW_WARN_BELOW_RATIO = 0.2;

const DOMESTIC_MODEL_CONTEXT = {
  deepseek: { 'deepseek-v4-pro': 128000, 'deepseek-v4-flash': 65536, 'deepseek-v4-flash-vision-exp': 65536, 'deepseek-chat': 128000, 'deepseek-reasoner': 128000 },
  qwen: { 'qwen-max': 32768, 'qwen-plus': 131072, 'qwen-turbo': 131072, 'qwen-long': 1000000 },
  glm: { 'glm-4': 128000, 'glm-4-flash': 128000, 'glm-4-plus': 128000, 'glm-4-long': 1000000 },
  moonshot: { 'moonshot-v1-8k': 8192, 'moonshot-v1-32k': 32768, 'moonshot-v1-128k': 128000 },
  yi: { 'yi-lightning': 16384, 'yi-large': 32768, 'yi-vision': 16384 },
  baichuan: { 'Baichuan4': 128000, 'Baichuan3-Turbo': 32768 },
  minimax: { 'abab6.5s-chat': 24576, 'abab6.5-chat': 128000 },
  spark: { 'generalv3.5': 8192, '4.0Ultra': 32768 },
  doubao: { 'doubao-pro-128k': 128000, 'doubao-pro-32k': 32768 },
  openai: { 'gpt-4o': 128000, 'gpt-4o-mini': 128000, 'gpt-4-turbo': 128000, 'o1': 200000, 'o1-mini': 128000, 'o3-mini': 200000 },
  anthropic: { 'claude-sonnet-4-20250514': 200000, 'claude-opus-4-20250514': 200000, 'claude-3-5-sonnet-20241022': 200000, 'claude-3-haiku-20240307': 200000 },
  mistral: { 'mistral-large-latest': 128000, 'mistral-small-latest': 32000 },
  kimi: { 'moonshot-v1-8k': 8192, 'moonshot-v1-32k': 32768, 'moonshot-v1-128k': 128000 },
};

const MODEL_PREFIX_RULES = [
  { prefix: 'claude-opus-4', tokens: 200000 },
  { prefix: 'claude-sonnet-4', tokens: 200000 },
  { prefix: 'claude-3-5', tokens: 200000 },
  { prefix: 'claude-3', tokens: 200000 },
  { prefix: 'gpt-4o', tokens: 128000 },
  { prefix: 'gpt-4-turbo', tokens: 128000 },
  { prefix: 'o1-', tokens: 200000 },
  { prefix: 'o3-', tokens: 200000 },
  { prefix: 'deepseek-r', tokens: 128000 },
  { prefix: 'deepseek-chat', tokens: 128000 },
  { prefix: 'qwen-long', tokens: 1000000 },
  { prefix: 'qwen-', tokens: 131072 },
  { prefix: 'glm-4-long', tokens: 1000000 },
  { prefix: 'glm-', tokens: 128000 },
  { prefix: 'moonshot-v1-128k', tokens: 128000 },
  { prefix: 'moonshot-v1-32k', tokens: 32768 },
  { prefix: 'moonshot-v1-8k', tokens: 8192 },
  { prefix: 'doubao-pro-128k', tokens: 128000 },
  { prefix: 'doubao-', tokens: 32768 },
  { prefix: 'mistral-large', tokens: 128000 },
  { prefix: 'mistral-small', tokens: 32000 },
];

function normalizePositiveInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

function resolveContextWindowInfo(params) {
  const { provider, modelId, modelContextTokens, modelContextWindow, defaultTokens } = params;

  const fromModelMap = (() => {
    const providerModels = DOMESTIC_MODEL_CONTEXT[provider];
    if (!providerModels) return null;
    const modelKey = Object.keys(providerModels).find(
      k => k.toLowerCase() === (modelId || '').toLowerCase()
    );
    return modelKey ? providerModels[modelKey] : null;
  })();

  const fromPrefix = (() => {
    if (!modelId) return null;
    const lower = modelId.toLowerCase();
    for (const rule of MODEL_PREFIX_RULES) {
      if (lower.startsWith(rule.prefix)) return rule.tokens;
    }
    return null;
  })();

  const fromModel = normalizePositiveInt(modelContextTokens) ?? normalizePositiveInt(modelContextWindow);
  const fallback = normalizePositiveInt(defaultTokens) ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS;

  if (fromModelMap) {
    return { tokens: fromModelMap, source: 'modelMap' };
  }
  if (fromPrefix) {
    return { tokens: fromPrefix, source: 'prefix' };
  }
  if (fromModel) {
    return { tokens: fromModel, source: 'model' };
  }
  return { tokens: fallback, source: 'default' };
}

function resolveContextWindowGuardThresholds(contextWindowTokens) {
  const tokens = normalizePositiveInt(contextWindowTokens) ?? 0;
  return {
    hardMinTokens: Math.max(
      CONTEXT_WINDOW_HARD_MIN_TOKENS,
      Math.floor(tokens * CONTEXT_WINDOW_HARD_MIN_RATIO)
    ),
    warnBelowTokens: Math.max(
      CONTEXT_WINDOW_WARN_BELOW_TOKENS,
      Math.floor(tokens * CONTEXT_WINDOW_WARN_BELOW_RATIO)
    ),
  };
}

function evaluateContextWindowGuard(params) {
  const { info, warnBelowTokens, hardMinTokens } = params;
  const tokens = normalizePositiveInt(info.tokens) ?? 0;
  const referenceTokens = normalizePositiveInt(info.referenceTokens) ?? tokens;
  const thresholds = resolveContextWindowGuardThresholds(referenceTokens);

  const warnBelow = Math.max(1, Math.floor(warnBelowTokens ?? thresholds.warnBelowTokens));
  const hardMin = Math.max(1, Math.floor(hardMinTokens ?? thresholds.hardMinTokens));

  return {
    ...info,
    tokens,
    hardMinTokens: hardMin,
    warnBelowTokens: warnBelow,
    shouldWarn: !normalizePositiveInt(info.tokens) || tokens < warnBelow,
    shouldBlock: !normalizePositiveInt(info.tokens) || tokens < hardMin,
  };
}

class ContextWindowGuard {
  constructor() {
    this._overrides = new Map();
    this._warnings = [];
    // 自适应截断阈值（可动态调整）
    this._adaptiveThresholds = {
      compressRatio: 0.75,    // 触发压缩的使用率
      compressTargetRatio: 0.5, // 压缩目标比例
      truncateRatio: 0.95,    // 触发截断的使用率
    };
    this._truncationHistory = []; // 截断历史，用于自适应
    this._loadOverrides();
  }

  /**
   * 自适应截断规则
   * 根据截断频率和压缩效果自动调整阈值：
   *   - 频繁截断 → 提前压缩（降低 compressRatio）
   *   - 压缩后仍频繁溢出 → 更激进截断（降低 truncateRatio）
   *   - 长时间无截断 → 放宽阈值（提高 compressRatio）
   */
  adaptTruncationRules() {
    const now = Date.now();
    const recentTruncations = this._truncationHistory.filter(
      t => now - t.timestamp < 3600000 // 最近1小时
    );

    if (recentTruncations.length >= 5) {
      // 频繁截断：提前压缩
      this._adaptiveThresholds.compressRatio = Math.max(0.6, this._adaptiveThresholds.compressRatio - 0.05);
      this._adaptiveThresholds.compressTargetRatio = Math.max(0.35, this._adaptiveThresholds.compressTargetRatio - 0.05);
    } else if (recentTruncations.length === 0 && this._adaptiveThresholds.compressRatio < 0.75) {
      // 长时间无截断：逐步恢复
      this._adaptiveThresholds.compressRatio = Math.min(0.75, this._adaptiveThresholds.compressRatio + 0.02);
      this._adaptiveThresholds.compressTargetRatio = Math.min(0.5, this._adaptiveThresholds.compressTargetRatio + 0.02);
    }

    return this._adaptiveThresholds;
  }

  _loadOverrides() {
    try {
      const fs = require('fs');
      const path = require('path');
      const overridePath = path.join(DATA_DIR, 'context-window-overrides.json');
      if (fs.existsSync(overridePath)) {
        const data = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (entry.provider && entry.modelId && entry.tokens) {
              this._overrides.set(`${entry.provider}:${entry.modelId}`, entry.tokens);
            }
          }
        }
      }
    } catch { console.warn('[context-window-guard] 加载覆盖配置失败'); }
  }

  setOverride(provider, modelId, tokens) {
    this._overrides.set(`${provider}:${modelId}`, tokens);
    this._saveOverrides();
  }

  removeOverride(provider, modelId) {
    this._overrides.delete(`${provider}:${modelId}`);
    this._saveOverrides();
  }

  _saveOverrides() {
    try {
      const fs = require('fs');
      const path = require('path');
      const overridePath = path.join(DATA_DIR, 'context-window-overrides.json');
      const data = [];
      for (const [key, tokens] of this._overrides) {
        const [provider, modelId] = key.split(':');
        data.push({ provider, modelId, tokens });
      }
      fs.writeFileSync(overridePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch { console.warn('[context-window-guard] 保存覆盖配置失败'); }
  }

  check(params) {
    const { provider, modelId, currentTokenCount } = params;

    const overrideTokens = this._overrides.get(`${provider}:${modelId}`);
    const info = resolveContextWindowInfo({
      provider,
      modelId,
      modelContextTokens: overrideTokens,
      modelContextWindow: params.modelContextWindow,
      defaultTokens: params.defaultTokens,
    });

    const guardResult = evaluateContextWindowGuard({ info });

    const result = {
      ...guardResult,
      provider,
      modelId,
      currentTokenCount: currentTokenCount ?? 0,
      utilizationRatio: guardResult.tokens > 0 ? (currentTokenCount ?? 0) / guardResult.tokens : 0,
      shouldCompress: false,
      shouldTruncate: false,
      compressionTarget: null,
      warning: null,
    };

    if (result.currentTokenCount > 0 && guardResult.tokens > 0) {
      const ratio = result.currentTokenCount / guardResult.tokens;
      const thresholds = this._adaptiveThresholds;

      if (ratio > thresholds.compressRatio + 0.15) {
        result.shouldCompress = true;
        result.compressionTarget = Math.floor(guardResult.tokens * thresholds.compressTargetRatio);
        result.warning = `上下文使用率 ${Math.round(ratio * 100)}%，建议压缩至 ${result.compressionTarget} tokens`;
      } else if (ratio > thresholds.compressRatio) {
        result.shouldCompress = true;
        result.compressionTarget = Math.floor(guardResult.tokens * thresholds.compressTargetRatio);
        result.warning = `上下文使用率 ${Math.round(ratio * 100)}%，推荐压缩`;
      }

      if (ratio > thresholds.truncateRatio) {
        result.shouldTruncate = true;
        result.warning = `上下文即将溢出 (${Math.round(ratio * 100)}%)，必须截断或压缩`;
        // 记录截断事件用于自适应
        this._truncationHistory.push({ timestamp: Date.now(), ratio, provider, modelId });
        if (this._truncationHistory.length > 100) {
          this._truncationHistory = this._truncationHistory.slice(-50);
        }
        // 触发自适应调整
        this.adaptTruncationRules();
      }
    }

    if (guardResult.shouldBlock) {
      result.warning = `模型 ${provider}/${modelId} 上下文窗口过小 (${guardResult.tokens} tokens)，可能无法正常工作`;
    } else if (guardResult.shouldWarn) {
      result.warning = `模型 ${provider}/${modelId} 上下文窗口较小 (${guardResult.tokens} tokens)，长对话可能受限`;
    }

    if (result.warning) {
      this._warnings.push({
        ...result,
        timestamp: Date.now(),
      });
      if (this._warnings.length > 100) {
        this._warnings = this._warnings.slice(-50);
      }
    }

    return result;
  }

  getWarnings(limit = 10) {
    return this._warnings.slice(-limit);
  }

  getAvailableContextTokens(params) {
    const { provider, modelId, currentTokenCount } = params;
    const overrideTokens = this._overrides.get(`${provider}:${modelId}`);
    const info = resolveContextWindowInfo({
      provider,
      modelId,
      modelContextTokens: overrideTokens,
      defaultTokens: params.defaultTokens,
    });
    const available = info.tokens - (currentTokenCount ?? 0);
    return Math.max(0, available);
  }

  getUtilization(params) {
    const { provider, modelId, currentTokenCount } = params;
    const overrideTokens = this._overrides.get(`${provider}:${modelId}`);
    const info = resolveContextWindowInfo({
      provider,
      modelId,
      modelContextTokens: overrideTokens,
      defaultTokens: params.defaultTokens,
    });
    if (info.tokens <= 0) return 0;
    return Math.min(1, (currentTokenCount ?? 0) / info.tokens);
  }
}

const globalContextWindowGuard = new ContextWindowGuard();

module.exports = {
  ContextWindowGuard,
  globalContextWindowGuard,
  resolveContextWindowInfo,
  evaluateContextWindowGuard,
  resolveContextWindowGuardThresholds,
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  DOMESTIC_MODEL_CONTEXT,
};
