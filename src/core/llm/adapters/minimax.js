const { ProviderAdapter } = require('./base');

/**
 * MiniMax 适配器
 * 支持：对话（abab系列）、视觉识别、音频生成（TTS）
 * API: https://api.minimax.chat/v1 (OpenAI 兼容)
 */

const MINIMAX_MODELS = [
  { id: 'abab6.5s-chat',      name: 'abab6.5s-chat',      maxTokens: 8192,  contextWindow: 245760 },
  { id: 'abab7-chat-preview', name: 'abab7-chat',          maxTokens: 8192,  contextWindow: 245760 },
  { id: 'speech-01',          name: 'speech-01 (TTS)',     maxTokens: 4096,  contextWindow: 4096   },
  { id: 'speech-02',          name: 'speech-02 (TTS-HD)',  maxTokens: 4096,  contextWindow: 4096   },
];

class MinimaxAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super({
      providerId: 'minimax',
      baseUrl: config.baseUrl || 'https://api.minimax.chat/v1',
      apiKey: config.apiKey || '',
      defaultModel: 'abab6.5s-chat',
      supportedModels: MINIMAX_MODELS,
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        reasoning: false,
        maxTokens: 8192,
        audio: true,
      },
      ...config,
    });
  }

  isModelSupported(modelId) {
    return this._supportedModels.some(m =>
      m.id === modelId || modelId.startsWith('abab') || modelId.startsWith('speech')
    );
  }

  clampTemperature(temp) {
    return Math.max(0, Math.min(1, temp));
  }

  formatImageContent(item) {
    const url = item.image_url?.url || item.url || '';
    return { type: 'image_url', image_url: { url } };
  }
}

MinimaxAdapter.MODELS = MINIMAX_MODELS;

module.exports = { MinimaxAdapter, MINIMAX_MODELS };
