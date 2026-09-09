/**
 * ProviderRegistry — 统一模型提供商注册中心
 * 
 * 职责：
 * 1. 注册 Provider（含家族子端点）
 * 2. 管理模型按业务分类的分配
 * 3. 按 capability 查询 Provider
 * 4. 统一适配器实例管理
 */

// eslint-disable-next-line no-unused-vars
const { ProviderAdapter } = require('./adapters/base');
const { DeepSeekAdapter, DEEPSEEK_MODELS } = require('./adapters/deepseek');
const { QwenAdapter, QWEN_MODELS } = require('./adapters/qwen');
const { GLMAdapter, GLM_MODELS } = require('./adapters/glm');
const { DoubaoAdapter, DOUBAO_MODELS } = require('./adapters/doubao');
const { MinimaxAdapter, MINIMAX_MODELS } = require('./adapters/minimax');
const { CodingPlanAdapter } = require('./adapters/coding-plan');
const { OllamaAdapter, OLLAMA_MODELS } = require('./adapters/ollama');
const { CustomAdapter, CUSTOM_DEFAULT_MODELS } = require('./adapters/custom');

// ===== Provider Capability 矩阵 =====
const PROVIDER_CAPABILITIES = {
  deepseek:            { chat: true,  image: false, video: false, vision: true,  audio: false },
  minimax:             { chat: true,  image: false, video: false, vision: true,  audio: true  },
  zhipu:               { chat: true,  image: true,  video: false, vision: true,  audio: false },
  aliyun_standard:     { chat: true,  image: true,  video: false, vision: true,  audio: false },
  aliyun_coding:       { chat: true,  image: false, video: false, vision: false, audio: false },
  volcengine_standard: { chat: true,  image: true,  video: true,  vision: true,  audio: false },
  volcengine_coding:   { chat: true,  image: false, video: false, vision: false, audio: false },
  ollama:              { chat: true,  image: false, video: false, vision: false, audio: false },
  custom:              { chat: true,  image: true,  video: true,  vision: true,  audio: true  },
};

// ===== 内建 Provider → Adapter 映射 =====
const PROVIDER_ADAPTER_MAP = {
  deepseek:            { Adapter: DeepSeekAdapter,   Models: DEEPSEEK_MODELS },
  minimax:             { Adapter: MinimaxAdapter,    Models: MINIMAX_MODELS },
  zhipu:               { Adapter: GLMAdapter,        Models: GLM_MODELS },
  aliyun_standard:     { Adapter: QwenAdapter,       Models: QWEN_MODELS },
  aliyun_coding:       { Adapter: CodingPlanAdapter, Models: [] },
  volcengine_standard: { Adapter: DoubaoAdapter,     Models: DOUBAO_MODELS },
  volcengine_coding:   { Adapter: CodingPlanAdapter, Models: [] },
  ollama:              { Adapter: OllamaAdapter,     Models: OLLAMA_MODELS },
  custom:              { Adapter: CustomAdapter,     Models: CUSTOM_DEFAULT_MODELS },
};

// ===== 家族定义（用于 UI 分组）=====
const PROVIDER_FAMILIES = {
  volcengine: {
    name: '火山方舟',
    currency: '¥',
    endpoints: ['volcengine_standard', 'volcengine_coding'],
  },
  aliyun: {
    name: '阿里云百炼',
    currency: '¥',
    endpoints: ['aliyun_standard', 'aliyun_coding'],
  },
};

// ===== Coding Plan 端点列表 =====
const CODING_PLAN_ENDPOINTS = new Set(['aliyun_coding', 'volcengine_coding']);

// ===== 默认模型 =====
const DEFAULT_CHAT_MODEL = 'deepseek-chat';

// ===== 各 Provider 默认模型 =====
const PROVIDER_DEFAULT_MODELS = {
  deepseek:            'deepseek-chat',
  minimax:             'abab6.5s-chat',
  zhipu:               'glm-4-flash',
  aliyun_standard:     'qwen-plus',
  aliyun_coding:       'qwen3-coder-plus',
  volcengine_standard: 'doubao-1.5-pro-32k',
  volcengine_coding:   'ark-code-latest',
  ollama:              'qwen2.5-coder:7b',
  custom:              'custom-model',
};

// ===== 模型定义 =====
const PROVIDER_MODEL_DEFS = {
  deepseek: [
    { id: 'deepseek-v4-pro',   name: 'DeepSeek V4 Pro',   maxTokens: 16384, contextWindow: 128000 },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 8192,  contextWindow: 65536  },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision', maxTokens: 8192, contextWindow: 65536, vision: true },
    { id: 'deepseek-chat',     name: 'DeepSeek V3',       maxTokens: 8192,  contextWindow: 65536  },
    { id: 'deepseek-reasoner', name: 'DeepSeek R1',       maxTokens: 8192,  contextWindow: 65536  },
    { id: 'deepseek-coder',    name: 'DeepSeek Coder',    maxTokens: 16384, contextWindow: 65536  },
  ],
  minimax: [
    { id: 'abab6.5s-chat',      name: 'abab6.5s-chat',  maxTokens: 8192,  contextWindow: 245760 },
    { id: 'abab7-chat-preview', name: 'abab7-chat',      maxTokens: 8192,  contextWindow: 245760 },
    { id: 'speech-01',          name: 'speech-01 (TTS)', maxTokens: 4096,  contextWindow: 4096   },
    { id: 'speech-02',          name: 'speech-02 (TTS)', maxTokens: 4096,  contextWindow: 4096   },
  ],
  zhipu: [
    { id: 'glm-4-plus',   name: 'GLM-4 Plus',   maxTokens: 4096, contextWindow: 128000 },
    { id: 'glm-4-0520',   name: 'GLM-4 0520',   maxTokens: 4096, contextWindow: 128000 },
    { id: 'glm-4-air',    name: 'GLM-4 Air',    maxTokens: 4096, contextWindow: 128000 },
    { id: 'glm-4-airx',   name: 'GLM-4 AirX',   maxTokens: 4096, contextWindow: 8192   },
    { id: 'glm-4-flash',  name: 'GLM-4 Flash',  maxTokens: 4096, contextWindow: 128000 },
    { id: 'glm-4-long',   name: 'GLM-4 Long',   maxTokens: 4096, contextWindow: 1048576},
    { id: 'glm-4v',       name: 'GLM-4V',       maxTokens: 1024, contextWindow: 2048,   vision: true },
    { id: 'glm-4v-plus',  name: 'GLM-4V Plus',  maxTokens: 4096, contextWindow: 8192,   vision: true },
    { id: 'cogview-4',    name: 'CogView-4',    maxTokens: 4096, contextWindow: 4096,   image: true  },
  ],
  aliyun_standard: [
    { id: 'qwen-plus',                 name: 'Qwen Plus',              maxTokens: 8192, contextWindow: 131072  },
    { id: 'qwen-turbo',                name: 'Qwen Turbo',             maxTokens: 8192, contextWindow: 131072  },
    { id: 'qwen-max',                  name: 'Qwen Max',               maxTokens: 8192, contextWindow: 32768   },
    { id: 'qwen-long',                 name: 'Qwen Long',              maxTokens: 6000, contextWindow: 10000000 },
    { id: 'qwen-vl-plus',              name: 'Qwen VL Plus',           maxTokens: 8192, contextWindow: 32768,   vision: true },
    { id: 'qwen-vl-max',               name: 'Qwen VL Max',            maxTokens: 8192, contextWindow: 32768,   vision: true },
    { id: 'qwen2.5-72b-instruct',      name: 'Qwen 2.5 72B',           maxTokens: 8192, contextWindow: 131072  },
    { id: 'qwen2.5-coder-32b-instruct',name: 'Qwen 2.5 Coder 32B',     maxTokens: 8192, contextWindow: 131072  },
    { id: 'wanx-v1',                   name: '通义万相 v1',            maxTokens: 4096, contextWindow: 4096,    image: true  },
  ],
  aliyun_coding: [
    { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', maxTokens: 8192, contextWindow: 131072 },
  ],
  volcengine_standard: [
    { id: 'doubao-1.5-pro-32k',        name: 'Doubao 1.5 Pro 32K',    maxTokens: 4096, contextWindow: 32768  },
    { id: 'doubao-1.5-pro-128k',       name: 'Doubao 1.5 Pro 128K',   maxTokens: 4096, contextWindow: 131072 },
    { id: 'doubao-1.5-lite-32k',       name: 'Doubao 1.5 Lite 32K',   maxTokens: 4096, contextWindow: 32768  },
    { id: 'doubao-pro-32k',            name: 'Doubao Pro 32K',        maxTokens: 4096, contextWindow: 32768  },
    { id: 'doubao-pro-128k',           name: 'Doubao Pro 128K',       maxTokens: 4096, contextWindow: 131072 },
    { id: 'doubao-1.5-vision-pro-32k', name: 'Doubao 1.5 Vision Pro', maxTokens: 4096, contextWindow: 32768,  vision: true },
    { id: 'doubao-seed-vision',        name: 'Seed Vision',           maxTokens: 4096, contextWindow: 32768,  vision: true },
    { id: 'doubao-seedream-5-0-260128',name: 'Seedream 5.0',          maxTokens: 4096, contextWindow: 4096,   image: true  },
    { id: 'doubao-seedance-1.5-pro',   name: 'Seedance 1.5 Pro',      maxTokens: 4096, contextWindow: 4096,   video: true  },
  ],
  volcengine_coding: [
    { id: 'ark-code-latest', name: 'Ark Code Latest', maxTokens: 16384, contextWindow: 128000 },
  ],
  ollama: [
    { id: 'qwen2.5-coder:32b', name: 'Qwen2.5 Coder 32B', maxTokens: 32768, contextWindow: 32768 },
    { id: 'qwen2.5-coder:14b', name: 'Qwen2.5 Coder 14B', maxTokens: 32768, contextWindow: 32768 },
    { id: 'qwen2.5-coder:7b',  name: 'Qwen2.5 Coder 7B',  maxTokens: 32768, contextWindow: 32768 },
    { id: 'qwen3:8b',          name: 'Qwen3 8B',          maxTokens: 32768, contextWindow: 32768 },
    { id: 'llama3.1:8b',       name: 'Llama 3.1 8B',     maxTokens: 8192,  contextWindow: 32768 },
    { id: 'llama3.1:70b',      name: 'Llama 3.1 70B',    maxTokens: 8192,  contextWindow: 32768 },
    { id: 'deepseek-r1:14b',   name: 'DeepSeek R1 14B',  maxTokens: 16384, contextWindow: 32768 },
    { id: 'deepseek-r1:7b',    name: 'DeepSeek R1 7B',   maxTokens: 16384, contextWindow: 32768 },
    { id: 'gemma3:12b',        name: 'Gemma 3 12B',      maxTokens: 8192,  contextWindow: 32768 },
    { id: 'mistral:7b',        name: 'Mistral 7B',       maxTokens: 8192,  contextWindow: 32768 },
  ],
  custom: [
    { id: 'custom-model', name: '自定义模型', maxTokens: 8192, contextWindow: 32768 },
  ],
};

class ProviderRegistry {
  constructor() {
    this._adapters = new Map();
    this._providerConfigs = new Map();
    this._modelAssignments = {
      chat:       { provider: 'deepseek', model: DEFAULT_CHAT_MODEL },
      reasoning:  { provider: '',         model: '' },
      vision:     { provider: '',         model: '' },
      imageGen:   { provider: '',         model: '' },
      videoGen:   { provider: '',         model: '' },
      tts:        { provider: '',         model: '' },
      asr:        { provider: '',         model: '' },
      embedding:  { provider: '',         model: '' },
      codingPlan: { provider: '',         model: '' },
    };
    this._defaultChatProvider = 'deepseek';
  }

  // ===== Provider 注册 =====

  registerProvider(providerId, config = {}) {
    const entry = PROVIDER_ADAPTER_MAP[providerId];
    if (!entry) {
      throw new Error(`未知 Provider: ${providerId}`);
    }

    const mergedConfig = {
      providerId,
      baseUrl: config.baseUrl || '',
      apiKey: config.apiKey || '',
      model: config.model || PROVIDER_DEFAULT_MODELS[providerId] || '',
      ...config,
    };

    const adapter = new entry.Adapter(mergedConfig);
    const validation = adapter.validate();
    if (!validation.valid) {
      console.warn(`ProviderRegistry: ${providerId} 验证失败: ${validation.error}`);
    }

    this._adapters.set(providerId, adapter);
    this._providerConfigs.set(providerId, mergedConfig);

    console.log(`ProviderRegistry: 已注册 ${providerId}`);
    return adapter;
  }

  registerFromConfig(providersConfig) {
    if (!providersConfig || typeof providersConfig !== 'object') return;

    for (const [providerId, config] of Object.entries(providersConfig)) {
      // 跳过家族容器节点（只有 name/currency，没有 apiKey/baseUrl）
      if (!config.apiKey && !config.baseUrl) continue;
      
      const needsApiKey = !['ollama', 'custom'].includes(providerId);
      if (needsApiKey && !config.apiKey) continue;
      if (needsApiKey && !config.baseUrl) continue;

      try {
        this.registerProvider(providerId, config);
      } catch (e) {
        console.error(`ProviderRegistry: 注册 ${providerId} 失败:`, e.message);
      }
    }
  }

  // ===== 模型分配 =====

  setModelAssignment(category, { provider, model }) {
    if (!this._modelAssignments[category]) {
      throw new Error(`未知业务分类: ${category}`);
    }
    this._modelAssignments[category] = { provider: provider || '', model: model || '' };
  }

  getModelAssignment(category) {
    return this._modelAssignments[category] || { provider: '', model: '' };
  }

  setModelAssignments(assignments) {
    if (!assignments) return;
    for (const [category, cfg] of Object.entries(assignments)) {
      if (this._modelAssignments[category] && cfg) {
        this._modelAssignments[category] = {
          provider: cfg.provider || '',
          model: cfg.model || '',
        };
        if (cfg.routing) {
          this._modelAssignments[category].routing = cfg.routing;
        }
      }
    }
  }

  /**
   * 从 CategoryRouter 加载所有分类的路由分配
   */
  setModelAssignmentsFromRouting(categoryRouter) {
    if (!categoryRouter || typeof categoryRouter.getRoutingTable !== 'function') return;
    const routing = categoryRouter.getRoutingTable();
    for (const [cat, entry] of Object.entries(routing)) {
      if (this._modelAssignments[cat] && entry.provider) {
        this._modelAssignments[cat] = { provider: entry.provider, model: entry.model || '' };
      }
    }
  }

  /**
   * 按分类解析最终 provider + model，支持 modelHint 覆盖
   */
  resolveForCategory(category, modelHint) {
    const base = this._modelAssignments[category] || this._modelAssignments.chat;
    return {
      provider: base.provider || 'deepseek',
      model: modelHint || base.model || DEFAULT_CHAT_MODEL,
    };
  }

  getAllModelAssignments() {
    return { ...this._modelAssignments };
  }

  // ===== Capability 查询 =====

  getCapabilities(providerId) {
    return PROVIDER_CAPABILITIES[providerId] || { chat: false, image: false, video: false, vision: false, audio: false };
  }

  getProvidersForCapability(capability) {
    const result = [];
    for (const [providerId, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
      if (caps[capability]) {
        result.push(providerId);
      }
    }
    return result;
  }

  getModelsForProvider(providerId) {
    return PROVIDER_MODEL_DEFS[providerId] || [];
  }

  getModelsForCapability(providerId, capability) {
    const allModels = this.getModelsForProvider(providerId);
    if (capability === 'chat') return allModels.filter(m => !m.image && !m.video && !m.vision);
    return allModels.filter(m => m[capability] === true);
  }

  // ===== 运行时 =====

  getAdapter(providerId) {
    return this._adapters.get(providerId) || null;
  }

  getAdapterForCategory(category) {
    const assignment = this.getModelAssignment(category);
    if (!assignment.provider) return null;
    return this._adapters.get(assignment.provider) || null;
  }

  async chat(params) {
    const { provider, model } = params;
    let adapter;

    if (provider) {
      adapter = this.getAdapter(provider);
    } else {
      adapter = this.getAdapterForCategory('chat');
      if (!adapter) {
        adapter = this.getAdapter(this._defaultChatProvider);
      }
    }

    if (!adapter) {
      throw new Error('无可用聊天适配器');
    }

    return adapter.chat({ ...params, model: model || this.getModelAssignment('chat').model });
  }

  getDefaultChatProvider() {
    return this._defaultChatProvider;
  }

  setDefaultChatProvider(providerId) {
    this._defaultChatProvider = providerId;
  }

  // ===== 工具方法 =====

  async testConnection(providerId) {
    const adapter = this._adapters.get(providerId);
    if (!adapter) return { ok: false, error: `Provider ${providerId} 未注册` };

    const start = Date.now();
    try {
      await adapter.chat({
        messages: [{ role: 'user', content: 'hi' }],
        model: PROVIDER_DEFAULT_MODELS[providerId] || 'default',
        maxTokens: 10,
        stream: false,
      });
      return { ok: true, latency: Date.now() - start };
    } catch (e) {
      return { ok: false, latency: Date.now() - start, error: e.message };
    }
  }

  async detectModels(providerId) {
    const adapter = this._adapters.get(providerId);
    if (!adapter) return [];
    if (typeof adapter.detectModels === 'function') {
      return adapter.detectModels();
    }
    return this.getModelsForProvider(providerId);
  }

  isCodingPlan(providerId) {
    return CODING_PLAN_ENDPOINTS.has(providerId);
  }

  // ===== Provider 信息 =====

  getAllProviders() {
    return Object.keys(PROVIDER_ADAPTER_MAP);
  }

  getProviderInfo(providerId) {
    return {
      id: providerId,
      capabilities: PROVIDER_CAPABILITIES[providerId] || {},
      isCodingPlan: this.isCodingPlan(providerId),
      defaultModel: PROVIDER_DEFAULT_MODELS[providerId] || '',
      models: this.getModelsForProvider(providerId),
    };
  }

  getProviderConfig(providerId) {
    return this._providerConfigs.get(providerId) || null;
  }

  static get PROVIDER_CAPABILITIES() { return PROVIDER_CAPABILITIES; }
  static get PROVIDER_FAMILIES() { return PROVIDER_FAMILIES; }
  static get PROVIDER_DEFAULT_MODELS() { return PROVIDER_DEFAULT_MODELS; }
  static get PROVIDER_MODEL_DEFS() { return PROVIDER_MODEL_DEFS; }
  static get CODING_PLAN_ENDPOINTS() { return CODING_PLAN_ENDPOINTS; }
}

// 单例
let _instance = null;

function getProviderRegistry() {
  if (!_instance) {
    _instance = new ProviderRegistry();
  }
  return _instance;
}

function resetProviderRegistry() {
  _instance = null;
}

module.exports = {
  ProviderRegistry,
  getProviderRegistry,
  resetProviderRegistry,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAMILIES,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_MODEL_DEFS,
  CODING_PLAN_ENDPOINTS,
};
