const { ProviderAdapter } = require('./base');

const QWEN_MODELS = [
  { id: 'qwen-plus', name: 'Qwen Plus', maxTokens: 8192, contextWindow: 131072 },
  { id: 'qwen-turbo', name: 'Qwen Turbo', maxTokens: 8192, contextWindow: 131072 },
  { id: 'qwen-max', name: 'Qwen Max', maxTokens: 8192, contextWindow: 32768 },
  { id: 'qwen-long', name: 'Qwen Long', maxTokens: 6000, contextWindow: 10000000 },
  { id: 'qwen-vl-plus', name: 'Qwen VL Plus', maxTokens: 8192, contextWindow: 32768, vision: true },
  { id: 'qwen-vl-max', name: 'Qwen VL Max', maxTokens: 8192, contextWindow: 32768, vision: true },
  { id: 'qwen2.5-72b-instruct', name: 'Qwen 2.5 72B', maxTokens: 8192, contextWindow: 131072 },
  { id: 'qwen2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', maxTokens: 8192, contextWindow: 131072 },
];

class QwenAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super({
      providerId: 'qwen',
      baseUrl: config.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: config.apiKey || '',
      defaultModel: 'qwen-plus',
      supportedModels: QWEN_MODELS,
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        reasoning: false,
        maxTokens: 8192,
      },
      ...config,
    });
  }

  isModelSupported(modelId) {
    return this._supportedModels.some(m =>
      m.id === modelId || modelId.startsWith('qwen')
    );
  }

  clampTemperature(temp) {
    return Math.max(0, Math.min(2, temp));
  }

  formatImageContent(item) {
    const url = item.image_url?.url || item.url || '';
    if (url.startsWith('data:')) {
      return {
        type: 'image_url',
        image_url: { url },
      };
    }

    return {
      type: 'image_url',
      image_url: { url },
    };
  }

  buildRequestPayload(params) {
    const payload = super.buildRequestPayload(params);

    const modelConfig = this.getModelConfig(params.model);
    if (modelConfig?.vision) {
      this._capabilities.vision = true;
    }

    if (params.model === 'qwen-long' && payload.max_tokens > 6000) {
      payload.max_tokens = 6000;
    }

    return payload;
  }
}

QwenAdapter.MODELS = QWEN_MODELS;

module.exports = { QwenAdapter, QWEN_MODELS };
