const { ProviderAdapter } = require('./base');

const GLM_MODELS = [
  { id: 'glm-4-plus', name: 'GLM-4 Plus', maxTokens: 4096, contextWindow: 128000 },
  { id: 'glm-4-0520', name: 'GLM-4 0520', maxTokens: 4096, contextWindow: 128000 },
  { id: 'glm-4-air', name: 'GLM-4 Air', maxTokens: 4096, contextWindow: 128000 },
  { id: 'glm-4-airx', name: 'GLM-4 AirX', maxTokens: 4096, contextWindow: 8192 },
  { id: 'glm-4-flash', name: 'GLM-4 Flash', maxTokens: 4096, contextWindow: 128000 },
  { id: 'glm-4-long', name: 'GLM-4 Long', maxTokens: 4096, contextWindow: 1048576 },
  { id: 'glm-4v', name: 'GLM-4V', maxTokens: 1024, contextWindow: 2048, vision: true },
  { id: 'glm-4v-plus', name: 'GLM-4V Plus', maxTokens: 4096, contextWindow: 8192, vision: true },
];

class GLMAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super({
      providerId: 'glm',
      baseUrl: config.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: config.apiKey || '',
      defaultModel: 'glm-4-flash',
      supportedModels: GLM_MODELS,
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        reasoning: false,
        maxTokens: 4096,
      },
      ...config,
    });
  }

  isModelSupported(modelId) {
    return this._supportedModels.some(m =>
      m.id === modelId || modelId.startsWith('glm')
    );
  }

  clampTemperature(temp) {
    return Math.max(0, Math.min(1, temp));
  }

  formatToolChoice(toolChoice) {
    if (toolChoice === 'auto') return 'auto';
    if (toolChoice === 'none') return 'none';
    if (typeof toolChoice === 'object' && toolChoice.function) {
      return {
        type: 'function',
        function: { name: toolChoice.function.name },
      };
    }
    return 'auto';
  }

  formatImageContent(item) {
    const url = item.image_url?.url || item.url || '';
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

    if (params.model === 'glm-4-long' && payload.max_tokens > 4096) {
      payload.max_tokens = 4096;
    }

    return payload;
  }

  parseStreamChunk(chunk) {
    const choice = chunk.choices?.[0];
    if (!choice) return null;

    const delta = choice.delta || {};
    return {
      id: chunk.id,
      model: chunk.model,
      content: delta.content || '',
      toolCalls: delta.tool_calls || [],
      finishReason: choice.finish_reason,
    };
  }
}

GLMAdapter.MODELS = GLM_MODELS;

module.exports = { GLMAdapter, GLM_MODELS };
