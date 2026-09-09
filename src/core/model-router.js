// eslint-disable-next-line no-unused-vars -- require 解构中 getRecoveryAction 未用（不可删 require）
const { classifyApiError, getRecoveryAction, FailoverReason } = require('./error-classifier');

const FALLBACK_CHAINS = {
  deepseek: ['deepseek', 'qwen', 'glm', 'moonshot'],
  qwen: ['qwen', 'deepseek', 'glm', 'moonshot'],
  glm: ['glm', 'qwen', 'deepseek', 'moonshot'],
  moonshot: ['moonshot', 'qwen', 'deepseek', 'glm'],
  yi: ['yi', 'qwen', 'deepseek', 'glm'],
  baichuan: ['baichuan', 'qwen', 'deepseek', 'glm'],
  minimax: ['minimax', 'qwen', 'deepseek', 'glm'],
  spark: ['spark', 'qwen', 'deepseek', 'glm'],
  doubao: ['doubao', 'qwen', 'deepseek', 'glm'],
  // 国内 Coding Plan 套餐：套餐间互为回退，再回退到普通 API
  tencent_coding: ['tencent_coding', 'aliyun_coding', 'volc_coding', 'deepseek'],
  aliyun_coding: ['aliyun_coding', 'tencent_coding', 'volc_coding', 'qwen'],
  volc_coding: ['volc_coding', 'tencent_coding', 'aliyun_coding', 'doubao'],
};

const DEFAULT_FALLBACK = ['deepseek', 'qwen', 'glm', 'moonshot'];

const MAX_FALLBACK_ATTEMPTS = 3;
const RATE_LIMIT_COOLDOWN_MS = 60000;
const MODEL_HEALTH_CHECK_INTERVAL = 30000;

let globalRouter = null;

class ModelRouter {
  constructor(config) {
    this.config = config;
    this.models = config.models || {};
    this.providers = this.models.providers || {};
    this.currentProvider = this.models.currentProvider || 'deepseek';
    this._healthStatus = {};
    this._rateLimitUntil = {};
    this._fallbackHistory = [];
    this._consecutiveFailures = {};
    this._lastHealthCheck = 0;
    this._adapterRegistry = null; // 统一适配器注册中心

    for (const provider of Object.keys(this.providers)) {
      this._healthStatus[provider] = 'unknown';
      this._consecutiveFailures[provider] = 0;
    }
  }

  /**
   * 绑定 AdapterRegistry，统一适配器管理
   * 绑定后 route() 和 selectProvider() 优先从 Registry 获取适配器
   */
  setAdapterRegistry(registry) {
    this._adapterRegistry = registry;
  }

  /**
   * 获取指定 provider 的适配器实例
   * 优先从 AdapterRegistry 获取，回退到自身配置
   */
  getAdapter(providerName) {
    const name = providerName || this.currentProvider;
    if (this._adapterRegistry) {
      const adapter = this._adapterRegistry.getAdapter(name);
      if (adapter) return adapter;
    }
    return null;
  }

  getCurrentProvider() {
    return this.currentProvider;
  }

  getCurrentModel() {
    const provider = this.providers[this.currentProvider];
    return provider?.model || 'unknown';
  }

  getProviderConfig(providerName) {
    const name = providerName || this.currentProvider;
    return this.providers[name] || null;
  }

  getApiUrl(providerName) {
    const config = this.getProviderConfig(providerName);
    if (!config) return null;

    // ollama 和 custom 优先使用配置的 baseUrl
    if (['ollama', 'custom'].includes(providerName) && config.baseUrl) {
      return config.baseUrl.replace(/\/$/, '') + '/chat/completions';
    }

    const urls = {
      deepseek: 'https://api.deepseek.com/v1/chat/completions',
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      moonshot: 'https://api.moonshot.cn/v1/chat/completions',
      yi: 'https://api.01.ai/v1/chat/completions',
      baichuan: 'https://api.baichuan-ai.com/v1/chat/completions',
      minimax: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
      spark: 'https://spark-api.xf-yun.com/v1/chat/completions',
      doubao: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      // 国内 Coding Plan 套餐（OpenAI 兼容协议）
      tencent_coding: 'https://api.lkeap.cloud.tencent.com/coding/v3/chat/completions',
      aliyun_coding: 'https://coding.dashscope.aliyuncs.com/v1/chat/completions',
      volc_coding: 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions',
    };

    return config.apiBase || config.baseUrl || urls[providerName] || null;
  }

  getApiKey(providerName) {
    const config = this.getProviderConfig(providerName);
    return config?.apiKey || config?.key || null;
  }

  getContextLength(providerName) {
    const config = this.getProviderConfig(providerName);
    const contextLengths = {
      deepseek: 128000,
      qwen: 131072,
      glm: 128000,
      moonshot: 128000,
      yi: 4096,
      baichuan: 4096,
      minimax: 24576,
      spark: 4096,
      doubao: 128000,
      // 国内 Coding Plan 套餐
      tencent_coding: 128000,
      aliyun_coding: 131072,
      volc_coding: 128000,
    };
    return config?.contextLength || contextLengths[providerName] || 4096;
  }

  getFallbackChain() {
    return FALLBACK_CHAINS[this.currentProvider] || DEFAULT_FALLBACK;
  }

  route(_message) {
    const provider = this.currentProvider;

    // ollama 和 custom 不强制要求 API Key
    const noKeyRequired = ['ollama', 'custom'].includes(provider);

    // 优先从 AdapterRegistry 获取适配器信息
    const adapter = this.getAdapter(provider);
    if (adapter) {
      const apiKey = adapter.getApiKey?.() || this.getApiKey(provider);
      if (!noKeyRequired && !apiKey) {
        return {
          error: `模型提供商 "${provider}" 缺少 API 密钥。请在设置中填写 API 密钥。`,
          provider: null, model: null, baseUrl: null, apiKey: null, reason: 'no_api_key'
        };
      }
      return {
        error: null,
        provider,
        model: adapter.getDefaultModel?.() || this.providers[provider]?.model || provider,
        baseUrl: adapter.getBaseUrl?.() || this.getApiUrl(provider),
        apiKey: apiKey || '',
        adapter,
        reason: 'adapter_registry'
      };
    }

    // 回退到自身配置
    const config = this.getProviderConfig(provider);

    if (!config) {
      return {
        error: `模型提供商 "${provider}" 未配置。请在设置中配置 API 密钥。`,
        provider: null, model: null, baseUrl: null, apiKey: null, reason: 'not_configured'
      };
    }

    const apiKey = this.getApiKey(provider);
    if (!noKeyRequired && !apiKey) {
      return {
        error: `模型提供商 "${provider}" 缺少 API 密钥。请在设置中填写 API 密钥。`,
        provider: null, model: null, baseUrl: null, apiKey: null, reason: 'no_api_key'
      };
    }

    return {
      error: null,
      provider,
      model: config.model || provider,
      baseUrl: this.getApiUrl(provider),
      apiKey: apiKey || '',
      reason: 'default'
    };
  }

  async selectProvider(preferredProvider = null) {
    this._updateHealthStatus();

    const target = preferredProvider || this.currentProvider;

    if (this._isProviderAvailable(target)) {
      return target;
    }

    const chain = this.getFallbackChain();
    for (const provider of chain) {
      if (provider === target) continue;
      if (this._isProviderAvailable(provider)) {
        if (!preferredProvider) {
          this._recordFallback(target, provider, 'primary_unavailable');
        }
        return provider;
      }
    }

    return target;
  }

  _isProviderAvailable(providerName) {
    if (!this.providers[providerName]) return false;
    // ollama 和 custom 不强制要求 API Key
    const noKeyRequired = ['ollama', 'custom'].includes(providerName);
    if (!noKeyRequired && !this.getApiKey(providerName)) return false;
    if (this._healthStatus[providerName] === 'down') return false;
    if (this._rateLimitUntil[providerName] && Date.now() < this._rateLimitUntil[providerName]) return false;
    return true;
  }

  _updateHealthStatus() {
    const now = Date.now();
    if (now - this._lastHealthCheck < MODEL_HEALTH_CHECK_INTERVAL) return;
    this._lastHealthCheck = now;

    for (const [provider, failures] of Object.entries(this._consecutiveFailures)) {
      if (failures >= 3) {
        this._healthStatus[provider] = 'down';
      } else if (failures === 0) {
        this._healthStatus[provider] = 'healthy';
      } else {
        this._healthStatus[provider] = 'degraded';
      }
    }
  }

  recordSuccess(providerName) {
    this._consecutiveFailures[providerName] = 0;
    this._healthStatus[providerName] = 'healthy';
    // 成功后延迟演化（避免频繁调整）
    this._scheduleEvolve();
  }

  recordFailure(providerName, error) {
    this._consecutiveFailures[providerName] = (this._consecutiveFailures[providerName] || 0) + 1;

    const classification = classifyApiError(error);
    if (classification.reason === FailoverReason.RATE_LIMITED) {
      this._rateLimitUntil[providerName] = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    }

    if (this._consecutiveFailures[providerName] >= 3) {
      this._healthStatus[providerName] = 'down';
    }

    // 失败后立即演化
    this._scheduleEvolve();
  }

  _evolveTimer = null;
  _scheduleEvolve() {
    if (this._evolveTimer) return;
    this._evolveTimer = setTimeout(() => {
      this._evolveTimer = null;
      this.evolveFallbackChains();
    }, 5000); // 5秒防抖
  }

  _recordFallback(from, to, reason) {
    this._fallbackHistory.push({
      from,
      to,
      reason,
      timestamp: Date.now(),
    });

    if (this._fallbackHistory.length > 100) {
      this._fallbackHistory = this._fallbackHistory.slice(-50);
    }
  }

  async executeWithFallback(fn, preferredProvider = null) {
    const chain = this.getFallbackChain();
    const target = preferredProvider || this.currentProvider;

    const orderedProviders = [target];
    for (const p of chain) {
      if (p !== target && this._isProviderAvailable(p)) {
        orderedProviders.push(p);
      }
    }

    let lastError = null;
    let attempts = 0;

    for (const provider of orderedProviders) {
      if (attempts >= MAX_FALLBACK_ATTEMPTS) break;
      if (!this._isProviderAvailable(provider)) continue;

      attempts++;
      try {
        const result = await fn(provider, this.getProviderConfig(provider));
        this.recordSuccess(provider);
        return result;
      } catch (error) {
        lastError = error;
        this.recordFailure(provider, error);

        const classification = classifyApiError(error);
        if (!classification.shouldFailover) break;

        if (provider !== target) {
          this._recordFallback(target, provider, classification.reason);
        }
      }
    }

    throw lastError || new Error('所有模型回退尝试均失败');
  }

  getHealthStatus() {
    this._updateHealthStatus();
    const status = {};
    for (const provider of Object.keys(this.providers)) {
      status[provider] = {
        health: this._healthStatus[provider] || 'unknown',
        consecutiveFailures: this._consecutiveFailures[provider] || 0,
        rateLimitedUntil: this._rateLimitUntil[provider] || null,
        model: this.providers[provider]?.model || 'unknown',
        contextLength: this.getContextLength(provider),
      };
    }
    return status;
  }

  getFallbackHistory() {
    return this._fallbackHistory.slice(-20);
  }

  switchProvider(newProvider) {
    if (!this.providers[newProvider]) {
      throw new Error(`未知的模型提供商: ${newProvider}`);
    }
    const old = this.currentProvider;
    this.currentProvider = newProvider;
    this._recordFallback(old, newProvider, 'manual_switch');
    return { from: old, to: newProvider };
  }

  listProviders() {
    return Object.entries(this.providers).map(([name, config]) => ({
      name,
      model: config.model || 'unknown',
      contextLength: this.getContextLength(name),
      isCurrent: name === this.currentProvider,
      health: this._healthStatus[name] || 'unknown',
    }));
  }

  // ========== 路由策略自演化 ==========

  /**
   * 根据历史表现自动调整 fallback 链顺序
   * 综合考虑：成功率、平均延迟、连续失败次数
   * 排序后更新 FALLBACK_CHAINS
   */
  evolveFallbackChains() {
    const scores = {};

    for (const provider of Object.keys(this.providers)) {
      const failures = this._consecutiveFailures[provider] || 0;
      const health = this._healthStatus[provider] || 'unknown';
      const hasApiKey = !!this.getApiKey(provider);

      // 基础分
      let score = hasApiKey ? 50 : 0;

      // 健康状态加权
      if (health === 'healthy') score += 30;
      else if (health === 'degraded') score += 10;
      else if (health === 'down') score -= 20;

      // 连续失败惩罚
      score -= failures * 10;

      // 限流惩罚
      if (this._rateLimitUntil[provider] && Date.now() < this._rateLimitUntil[provider]) {
        score -= 30;
      }

      scores[provider] = score;
    }

    // 按分数排序生成新的 fallback 链
    const sorted = Object.entries(scores)
      .filter(([_name, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);

    if (sorted.length > 0) {
      const oldChain = FALLBACK_CHAINS[this.currentProvider] || DEFAULT_FALLBACK;
      const newChain = [this.currentProvider, ...sorted.filter(p => p !== this.currentProvider)];

      // 检查是否有变化
      const changed = JSON.stringify(oldChain) !== JSON.stringify(newChain);
      if (changed) {
        FALLBACK_CHAINS[this.currentProvider] = newChain;
        console.log(
          `[ModelRouter] 路由策略自演化: fallback链调整 ` +
          `${oldChain.join('→')} → ${newChain.join('→')}`
        );
      }

      return { changed, newChain, scores };
    }

    return { changed: false, scores };
  }
}

function createModelRouter(config) {
  globalRouter = new ModelRouter(config);
  return globalRouter;
}

function getModelRouter() {
  return globalRouter;
}

module.exports = { ModelRouter, createModelRouter, getModelRouter, FALLBACK_CHAINS };
