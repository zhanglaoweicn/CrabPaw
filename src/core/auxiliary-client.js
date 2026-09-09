const { loadConfig } = require('./config');
const { isRateLimited, recordRateLimit } = require('./rate-limit-guard');
const { recordUsage } = require('./usage-stats');
const { resolveVisionModel, buildSetupGuide } = require('./vision-resolver');

const TASK_TYPES = {
  TITLE_GENERATION: 'title_generation',
  COMPRESSION: 'compression',
  VISION: 'vision',
  SESSION_SEARCH: 'session_search',
  WEB_EXTRACTION: 'web_extraction',
  CURATOR: 'curator',
  REVIEW: 'review',
  SKILL_MERGE: 'skill_merge',
  EXPERIENCE_REPLAY: 'experience_replay',
  ONBOARDING: 'onboarding',
  TRANSLATION: 'translation',
  CODE_REVIEW: 'code_review',
};

const DOMESTIC_PROVIDERS = ['deepseek', 'qwen', 'glm', 'kimi', 'doubao', 'minimax'];

const CHEAP_MODELS = {
  deepseek: 'deepseek-chat',
  qwen: 'qwen-turbo',
  glm: 'glm-4-flash',
  kimi: 'moonshot-v1-8k',
  doubao: 'doubao-pro-32k',
  minimax: 'abab6-chat',
};

// 不再在 auxiliary-client.js 里硬编码 VISION_MODELS。
// 视觉模型选择完全由 vision-resolver.js 根据 config 决定。
// 见 src/core/vision-resolver.js

class AuxiliaryClient {
  constructor(config) {
    this.config = config || loadConfig();
    this._fallbackChain = this._buildFallbackChain();
  }

  _buildFallbackChain() {
    const chain = [];
    const mainProvider = this.config.models?.currentProvider;
    if (mainProvider && DOMESTIC_PROVIDERS.includes(mainProvider)) {
      chain.push(mainProvider);
    }
    for (const p of DOMESTIC_PROVIDERS) {
      if (!chain.includes(p)) {
        chain.push(p);
      }
    }
    return chain;
  }

  _getProviderConfig(provider) {
    return this.config.models?.providers?.[provider];
  }

  _hasValidKey(provider) {
    const cfg = this._getProviderConfig(provider);
    return cfg && cfg.apiKey && cfg.apiKey.trim() !== '' && !cfg.apiKey.includes('***');
  }

  resolveProvider(taskType) {
    const auxConfig = this.config.models?.auxiliary || this.config.auxiliary || {};
    const taskConfig = auxConfig[taskType] || {};

    // 视觉任务：交由 vision-resolver 统一决策（config-driven）
    if (taskType === TASK_TYPES.VISION) {
      const resolved = resolveVisionModel(this.config);
      if (!resolved) {
        const err = new Error('[AuxiliaryClient] 无可用视觉模型');
        err.setupGuide = buildSetupGuide(this.config);
        throw err;
      }
      if (resolved.warning) {
        console.warn('⚠️ ' + resolved.warning);
      }
      return {
        provider: resolved.provider,
        model: resolved.model,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        source: resolved.source,
      };
    }

    // 如果配置了 base_url，直接使用自定义端点
    if (taskConfig.baseUrl) {
      return {
        provider: 'custom',
        model: taskConfig.model || 'default',
        baseUrl: taskConfig.baseUrl,
        apiKey: taskConfig.apiKey || '',
      };
    }

    if (taskConfig.provider && taskConfig.provider !== 'auto') {
      // "main" 表示使用主 Agent 的提供者
      if (taskConfig.provider === 'main') {
        const mainProvider = this.config.models?.currentProvider;
        if (mainProvider && this._hasValidKey(mainProvider)) {
          const mainCfg = this._getProviderConfig(mainProvider);
          return {
            provider: mainProvider,
            model: taskConfig.model || mainCfg?.model || CHEAP_MODELS[mainProvider],
            baseUrl: mainCfg?.baseUrl,
          };
        }
      } else if (this._hasValidKey(taskConfig.provider)) {
        return {
          provider: taskConfig.provider,
          model: taskConfig.model || CHEAP_MODELS[taskConfig.provider],
          baseUrl: this._getProviderConfig(taskConfig.provider)?.baseUrl,
        };
      }
    }
    const chain = this._fallbackChain;
    for (const provider of chain) {
      if (!this._hasValidKey(provider)) continue;
      const check = isRateLimited({ provider });
      if (check.limited) continue;
      return {
        provider,
        model: taskConfig.model || CHEAP_MODELS[provider],
        baseUrl: this._getProviderConfig(provider)?.baseUrl,
      };
    }
    return null;
  }

  async callLlm({ taskType, messages, maxTokens, temperature, timeout }) {
    const resolved = this.resolveProvider(taskType);
    if (!resolved) {
      throw new Error(`[AuxiliaryClient] 无可用后端执行任务: ${taskType}`);
    }
    // 自定义端点使用 resolved 中的 apiKey
    const providerCfg = resolved.provider === 'custom' ? null : this._getProviderConfig(resolved.provider);
    if (!providerCfg && !resolved.apiKey) {
      throw new Error(`[AuxiliaryClient] 提供商配置缺失: ${resolved.provider}`);
    }
    try {
      const result = await this._makeApiCall({
        baseUrl: resolved.baseUrl || providerCfg?.baseUrl,
        apiKey: resolved.apiKey || providerCfg?.apiKey,
        model: resolved.model,
        provider: resolved.provider,
        messages,
        maxTokens: maxTokens || 500,
        temperature: temperature ?? 0.3,
        timeout: timeout || 30000,
        type: taskType === TASK_TYPES.VISION ? 'vision' : 'chat',
      });
      return result;
    } catch (err) {
      if (err.status === 429 || err.statusCode === 429) {
        recordRateLimit({
          provider: resolved.provider,
          model: resolved.model,
          headers: err.headers || err.response?.headers,
        });
      }
      if (err.status === 402 || err.code === 'insufficient_quota') {
        return this._retryWithNextProvider({
          taskType,
          messages,
          maxTokens,
          temperature,
          timeout,
          excludeProvider: resolved.provider,
        });
      }
      throw err;
    }
  }

  async _retryWithNextProvider({ taskType, messages, maxTokens, temperature, timeout, excludeProvider }) {
    const auxConfig = this.config.models?.auxiliary || this.config.auxiliary || {};
    const taskConfig = auxConfig[taskType] || {};
    const isVision = taskType === TASK_TYPES.VISION;
    const chain = isVision ? this._buildVisionChain() : this._fallbackChain;
    for (const provider of chain) {
      if (provider === excludeProvider) continue;
      if (!this._hasValidKey(provider)) continue;
      const check = isRateLimited({ provider });
      if (check.limited) continue;
      const providerCfg = this._getProviderConfig(provider);
      const model = isVision
        ? CHEAP_MODELS[provider]
        : (taskConfig.model || CHEAP_MODELS[provider]);
      try {
        return await this._makeApiCall({
          baseUrl: providerCfg.baseUrl,
          apiKey: providerCfg.apiKey,
          model,
          provider,
          messages,
          maxTokens: maxTokens || 500,
          temperature: temperature ?? 0.3,
          timeout: timeout || 30000,
          type: taskType === TASK_TYPES.VISION ? 'vision' : 'chat',
        });
      } catch (err) {
        if (err.status === 429) {
          recordRateLimit({ provider, model, headers: err.headers || err.response?.headers });
        }
        continue;
      }
    }
    throw new Error(`[AuxiliaryClient] 所有后端均不可用，任务: ${taskType}`);
  }

  /**
   * 视觉分析：发送截图 + prompt 到视觉模型
   *
   * 模型选择完全由 vision-resolver.js 根据 config 决定：
   *   1. options.provider/model 显式覆盖
   *   2. auxiliary.vision 显式配置
   *   3. visionGeneration 配置
   *   4. 当前主 provider 是视觉模型
   *   5. 其它已配视觉供应商
   *   6. 抛错 + 设置指引
   *
   * @param {string} base64Image - base64 编码的图片数据（不含 data:image/... 前缀）
   * @param {string} prompt - 分析提示
   * @param {Object} options
   * @param {string} [options.provider] - 指定提供商（最高优先级）
   * @param {string} [options.model] - 指定模型
   * @returns {Object} 分析结果
   */
  async analyzeImage(base64Image, prompt, options = {}) {
    let provider, model, baseUrl, apiKey;

    // 1) 调用方显式覆盖
    if (options.provider && options.apiKey) {
      provider = options.provider;
      model = options.model;
      baseUrl = options.baseUrl || '';
      apiKey = options.apiKey;
    } else {
      // 2) 优先当前主模型(2026-08-25: 主模型已是多模态 deepseek-vision——图片理解
      //    走主通道, 免两份视觉配置与路由心智; 主模型非多模态时回退 vision-resolver)
      const mp = this.config.models?.currentProvider;
      const mm = this.config.models?.providers?.[mp]?.model;
      const mpApiKey = this.config.models?.providers?.[mp]?.apiKey;
      const isMainVision = !!(mp && mm && mpApiKey && /vision|vl|v1\.6|gpt-4o|claude-3-5-sonnet|gemini/i.test(String(mm)));
      if (isMainVision) {
        provider = mp;
        model = mm;
        baseUrl = this.config.models?.providers?.[mp]?.baseUrl || '';
        apiKey = mpApiKey;
      } else {
        // 3) 走 vision-resolver
        const resolved = resolveVisionModel(this.config);
        if (!resolved) {
          const err = new Error('[AuxiliaryClient] 无可用视觉模型');
          err.setupGuide = buildSetupGuide(this.config);
          throw err;
        }
        if (resolved.warning) console.warn('⚠️ ' + resolved.warning);
        provider = options.provider || resolved.provider;
        model = options.model || resolved.model;
        baseUrl = resolved.baseUrl;
        apiKey = resolved.apiKey;
      }
    }

    if (!apiKey || apiKey.trim() === '') {
      const err = new Error(`[AuxiliaryClient] 视觉模型 ${provider} 未配置 API Key`);
      err.setupGuide = buildSetupGuide(this.config);
      throw err;
    }

    // 构建视觉消息
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || '请描述这张图片的内容' },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${base64Image}`,
            detail: 'auto',
          },
        },
      ],
    }];

    return await this._makeApiCall({
      baseUrl,
      apiKey,
      model,
      provider,
      messages,
      maxTokens: options.maxTokens || 1000,
      temperature: options.temperature ?? 0.3,
      timeout: options.timeout || 30000,
    });
  }

  async _makeApiCall({ baseUrl, apiKey, model, messages, maxTokens, temperature, timeout, type = 'vision', provider }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const err = new Error(`API 请求失败: ${response.status} ${response.statusText}`);
        err.status = response.status;
        err.headers = Object.fromEntries(response.headers.entries());
        try {
          err.body = await response.json();
        } catch { console.warn('[auxiliary-client] 解析 API 错误响应失败'); }
        throw err;
      }
      const data = await response.json();
      const usage = data.usage || {};
      // 视觉/辅助调用统一按 type 计入 usage-stats.json
      try {
        recordUsage(model, model, usage, { type });
      } catch (e) {
        // 记录失败不应阻塞返回
        console.warn('⚠️ 辅助调用 usage 记录失败:', e.message);
      }
      return {
        content: data.choices?.[0]?.message?.content || '',
        model: data.model || model,
        usage,
        // 2026-08-21: provider 此前误填为 model 名——修正为实际 provider（未传入时兜底 model）
        provider: provider || model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

let _instance = null;

function getAuxiliaryClient(config) {
  if (!_instance || config) {
    _instance = new AuxiliaryClient(config);
  } else {
    // 2026-08-21: 实例常驻但配置热更——构造时快照的 this.config 是死数据。
    // 实测（crabpaw.log 22:07/23:22 两次 ImageAnalyze）：用户改 config.json
    // 换视觉模型不重启时，direct path 已用上新模型（vision-exp），aux path
    // 仍在用旧快照 → resolveVisionModel 误报「无可用视觉模型」。
    // loadConfig 有 1s TTL 缓存，每次刷新成本可忽略。
    try {
      _instance.config = loadConfig();
    } catch (e) {
      console.warn('[auxiliary-client] 配置刷新失败(继续用旧配置):', e?.message || e);
    }
  }
  return _instance;
}

module.exports = {
  AuxiliaryClient,
  getAuxiliaryClient,
  TASK_TYPES,
  DOMESTIC_PROVIDERS,
  CHEAP_MODELS,
  // VISION_MODELS 已废弃，由 vision-resolver.isVisionCapable 替代。
  VISION_MODELS: undefined,
};
