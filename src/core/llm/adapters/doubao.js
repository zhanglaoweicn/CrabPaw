const { ProviderAdapter } = require('./base');

const DOUBAO_MODELS = [
  { id: 'doubao-1.5-pro-32k', name: 'Doubao 1.5 Pro 32K', maxTokens: 4096, contextWindow: 32768 },
  { id: 'doubao-1.5-pro-128k', name: 'Doubao 1.5 Pro 128K', maxTokens: 4096, contextWindow: 131072 },
  { id: 'doubao-1.5-lite-32k', name: 'Doubao 1.5 Lite 32K', maxTokens: 4096, contextWindow: 32768 },
  { id: 'doubao-pro-32k', name: 'Doubao Pro 32K', maxTokens: 4096, contextWindow: 32768 },
  { id: 'doubao-pro-128k', name: 'Doubao Pro 128K', maxTokens: 4096, contextWindow: 131072 },
  { id: 'doubao-lite-32k', name: 'Doubao Lite 32K', maxTokens: 4096, contextWindow: 32768 },
  { id: 'doubao-lite-128k', name: 'Doubao Lite 128K', maxTokens: 4096, contextWindow: 131072 },
  { id: 'doubao-1.5-vision-pro-32k', name: 'Doubao 1.5 Vision Pro', maxTokens: 4096, contextWindow: 32768, vision: true },
];

class DoubaoAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super({
      providerId: 'doubao',
      baseUrl: config.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: config.apiKey || '',
      defaultModel: 'doubao-1.5-pro-32k',
      supportedModels: DOUBAO_MODELS,
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: true,
        reasoning: false,
        maxTokens: 4096,
      },
      ...config,
    });
    this._endpointId = config.endpointId || '';
  }

  isModelSupported(modelId) {
    return this._supportedModels.some(m =>
      m.id === modelId || modelId.startsWith('doubao')
    );
  }

  getRequestUrl(_model) {
    if (this._endpointId) {
      return `${this._baseUrl}/chat/completions`;
    }
    return `${this._baseUrl}/chat/completions`;
  }

  buildRequestPayload(params) {
    const payload = super.buildRequestPayload(params);

    if (this._endpointId) {
      payload.model = this._endpointId;
    }

    const modelConfig = this.getModelConfig(params.model);
    if (modelConfig?.vision) {
      this._capabilities.vision = true;
    }

    return payload;
  }

  clampTemperature(temp) {
    return Math.max(0, Math.min(1, temp));
  }
}

DoubaoAdapter.MODELS = DOUBAO_MODELS;

module.exports = { DoubaoAdapter, DOUBAO_MODELS };
