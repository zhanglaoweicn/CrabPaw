const { ProviderAdapter } = require('./adapters/base');
const { DeepSeekAdapter, DEEPSEEK_MODELS } = require('./adapters/deepseek');
const { QwenAdapter, QWEN_MODELS } = require('./adapters/qwen');
const { GLMAdapter, GLM_MODELS } = require('./adapters/glm');
const { DoubaoAdapter, DOUBAO_MODELS } = require('./adapters/doubao');
const { OllamaAdapter, OLLAMA_MODELS } = require('./adapters/ollama');
const { CustomAdapter, CUSTOM_DEFAULT_MODELS } = require('./adapters/custom');

// 内置提供商注册表
const PROVIDER_REGISTRY = {
  deepseek: { Adapter: DeepSeekAdapter, Models: DEEPSEEK_MODELS },
  qwen: { Adapter: QwenAdapter, Models: QWEN_MODELS },
  glm: { Adapter: GLMAdapter, Models: GLM_MODELS },
  doubao: { Adapter: DoubaoAdapter, Models: DOUBAO_MODELS },
  ollama: { Adapter: OllamaAdapter, Models: OLLAMA_MODELS },
  custom: { Adapter: CustomAdapter, Models: CUSTOM_DEFAULT_MODELS },
};

class AdapterRegistry {
  constructor() {
    this._adapters = new Map();
    this._modelToProvider = new Map();
    this._defaultProvider = null;
  }

  /**
   * 注册内置提供商
   */
  register(providerId, config) {
    const entry = PROVIDER_REGISTRY[providerId];
    if (!entry) {
      throw new Error(`未知的LLM Provider: ${providerId}, 可用: ${Object.keys(PROVIDER_REGISTRY).join(', ')}`);
    }

    const adapter = new entry.Adapter(config);
    const validation = adapter.validate();
    if (!validation.valid) {
      console.warn(`⚠️ ${providerId} 适配器验证失败: ${validation.error}`);
    }

    this._adapters.set(providerId, adapter);

    for (const model of entry.Models) {
      this._modelToProvider.set(model.id, providerId);
    }

    if (!this._defaultProvider) {
      this._defaultProvider = providerId;
    }

    console.log(`✅ LLM Provider 已注册: ${providerId} (${entry.Models.length} 个模型)`);
    return adapter;
  }

  /**
   * 注册外部适配器（来自插件系统）
   */
  registerAdapter(providerId, adapter) {
    if (!(adapter instanceof ProviderAdapter)) {
      throw new Error(`适配器必须继承 ProviderAdapter`);
    }

    const validation = adapter.validate();
    if (!validation.valid) {
      console.warn(`⚠️ ${providerId} 插件适配器验证失败: ${validation.error}`);
    }

    this._adapters.set(providerId, adapter);

    for (const model of adapter.supportedModels) {
      this._modelToProvider.set(model.id, providerId);
    }

    if (!this._defaultProvider) {
      this._defaultProvider = providerId;
    }

    console.log(`✅ LLM Provider 已注册（插件）: ${providerId} (${adapter.supportedModels.length} 个模型)`);
    return adapter;
  }

  /**
   * 从配置注册内置提供商
   */
  registerFromConfig(providersConfig) {
    if (!providersConfig || typeof providersConfig !== 'object') return;

    for (const [providerId, config] of Object.entries(providersConfig)) {
      if (!PROVIDER_REGISTRY[providerId]) continue;

      // ollama 和 custom 不强制要求 apiKey
      const needsApiKey = !['ollama', 'custom'].includes(providerId);
      if (needsApiKey && !config.apiKey) continue;
      if (!config.baseUrl && needsApiKey) continue;

      try {
        this.register(providerId, config);
      } catch (e) {
        console.error(`❌ 注册 ${providerId} 失败:`, e.message);
      }
    }
  }

  /**
   * 从插件系统注册模型提供商
   */
  async registerFromPlugins(pluginManager) {
    if (!pluginManager) return;

    const providers = pluginManager.getModelProviders();
    for (const { id, plugin } of providers) {
      try {
        const adapter = plugin.getAdapter();
        if (adapter) {
          this.registerAdapter(id, adapter);
        }
      } catch (e) {
        console.error(`❌ 注册插件提供商 ${id} 失败:`, e.message);
      }
    }
  }

  getAdapter(providerId) {
    return this._adapters.get(providerId) || null;
  }

  getAdapterForModel(modelId) {
    const providerId = this._modelToProvider.get(modelId);
    if (providerId) {
      return this._adapters.get(providerId) || null;
    }

    for (const [pid, adapter] of this._adapters) {
      if (adapter.isModelSupported(modelId)) {
        this._modelToProvider.set(modelId, pid);
        return adapter;
      }
    }

    return null;
  }

  async chat(params) {
    const adapter = this._resolveAdapter(params);
    return adapter.chat(params);
  }

  async *streamChat(params) {
    const adapter = this._resolveAdapter(params);
    yield* adapter.streamChat(
      adapter.getRequestUrl(params.model || adapter._defaultModel),
      adapter.buildRequestPayload({ ...params, stream: true })
    );
  }

  _resolveAdapter(params) {
    const { model, provider: providerId } = params;

    let adapter = null;
    if (providerId) {
      adapter = this._adapters.get(providerId);
    }
    if (!adapter && model) {
      adapter = this.getAdapterForModel(model);
    }
    if (!adapter && this._defaultProvider) {
      adapter = this._adapters.get(this._defaultProvider);
    }
    if (!adapter) {
      throw new Error(`无可用的LLM适配器 (model=${model}, provider=${providerId})`);
    }
    return adapter;
  }

  setDefaultProvider(providerId) {
    if (!this._adapters.has(providerId)) {
      throw new Error(`未注册的Provider: ${providerId}`);
    }
    this._defaultProvider = providerId;
  }

  getDefaultProvider() {
    return this._defaultProvider;
  }

  listProviders() {
    return Array.from(this._adapters.keys());
  }

  listModels(providerId) {
    if (providerId) {
      const adapter = this._adapters.get(providerId);
      return adapter ? adapter.supportedModels : [];
    }

    const allModels = [];
    for (const [pid, adapter] of this._adapters) {
      for (const model of adapter.supportedModels) {
        allModels.push({ ...model, provider: pid });
      }
    }
    return allModels;
  }

  getProviderForModel(modelId) {
    return this._modelToProvider.get(modelId) || null;
  }

  getStats() {
    const providers = {};
    for (const [pid, adapter] of this._adapters) {
      providers[pid] = {
        models: adapter.supportedModels.length,
        capabilities: adapter.capabilities,
        valid: adapter.validate().valid,
      };
    }

    return {
      totalProviders: this._adapters.size,
      totalModels: this._modelToProvider.size,
      defaultProvider: this._defaultProvider,
      providers,
    };
  }
}

AdapterRegistry.PROVIDER_REGISTRY = PROVIDER_REGISTRY;

module.exports = { AdapterRegistry, PROVIDER_REGISTRY };
