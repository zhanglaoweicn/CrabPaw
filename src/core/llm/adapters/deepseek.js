const { ProviderAdapter } = require('./base');

const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxTokens: 16384, contextWindow: 128000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxTokens: 8192, contextWindow: 65536 },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision', maxTokens: 8192, contextWindow: 65536, vision: true },
  { id: 'deepseek-chat', name: 'DeepSeek V3', maxTokens: 8192, contextWindow: 65536 },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', maxTokens: 8192, contextWindow: 65536 },
  { id: 'deepseek-coder', name: 'DeepSeek Coder', maxTokens: 16384, contextWindow: 65536 },
];

class DeepSeekAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super({
      providerId: 'deepseek',
      // 能力声明: 仅对话
      chatCapable: true,
      baseUrl: config.baseUrl || 'https://api.deepseek.com/v1',
      apiKey: config.apiKey || '',
      defaultModel: 'deepseek-chat',
      supportedModels: DEEPSEEK_MODELS,
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        reasoning: true,
        maxTokens: 16384,
      },
      ...config,
    });
  }

  clampTemperature(temp) {
    return Math.max(0, Math.min(1, temp));
  }

  buildRequestPayload(params) {
    const payload = super.buildRequestPayload(params);

    if (params.model === 'deepseek-reasoner') {
      delete payload.tools;
      delete payload.tool_choice;
    }

    return payload;
  }

  parseResponse(response) {
    const result = super.parseResponse(response);

    if (response.choices?.[0]?.message?.reasoning_content) {
      result.reasoningContent = response.choices[0].message.reasoning_content;
    }

    return result;
  }

  parseStreamChunk(chunk) {
    const choice = chunk.choices?.[0];
    if (!choice) return null;

    const delta = choice.delta || {};
    const result = {
      id: chunk.id,
      model: chunk.model,
      content: delta.content || '',
      toolCalls: delta.tool_calls || [],
      finishReason: choice.finish_reason,
    };

    if (delta.reasoning_content) {
      result.reasoningContent = delta.reasoning_content;
    }

    return result;
  }
}

DeepSeekAdapter.MODELS = DEEPSEEK_MODELS;

module.exports = { DeepSeekAdapter, DEEPSEEK_MODELS };
