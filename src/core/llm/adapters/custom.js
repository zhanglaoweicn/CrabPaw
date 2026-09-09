const { ProviderAdapter } = require('./base');

/**
 * 自定义 OpenAI 兼容端点适配器
 *
 * 适用于任何实现了 /v1/chat/completions 的服务：
 * - vLLM / LocalAI / LM Studio 等自托管推理服务
 * - OpenRouter / AI Gateway 等路由服务
 * - 企业内部模型网关
 * - 其他 OpenAI 兼容 API
 */

const CUSTOM_DEFAULT_MODELS = [
  { id: 'custom-model', name: '自定义模型', maxTokens: 8192, contextWindow: 32768 },
];

class CustomAdapter extends ProviderAdapter {
  constructor(config = {}) {
    const modelName = config.model || 'custom-model';

    super({
      providerId: config.providerId || 'custom',
      baseUrl: config.baseUrl || 'http://localhost:8000/v1',
      apiKey: config.apiKey || '',
      defaultModel: modelName,
      supportedModels: [
        { id: modelName, name: config.modelName || modelName, maxTokens: config.maxTokens || 8192, contextWindow: config.contextWindow || 32768 },
      ],
      capabilities: {
        streaming: true,
        toolUse: config.toolUse !== false,
        vision: config.vision === true,
        reasoning: config.reasoning === true,
        maxTokens: config.maxTokens || 8192,
      },
    });

    this._config = config;
  }

  validate() {
    if (!this._baseUrl) {
      return { valid: false, error: `${this._providerId}: base URL not configured` };
    }
    // 自定义端点可以不需要 API Key（如本地服务）
    return { valid: true };
  }

  getRequestHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };

    if (this._apiKey) {
      headers['Authorization'] = `Bearer ${this._apiKey}`;
    }

    return headers;
  }

  /**
   * 动态检测端点可用模型
   */
  async detectModels() {
    try {
      const resp = await fetch(`${this._baseUrl}/models`, {
        headers: this.getRequestHeaders(),
      });
      if (!resp.ok) return this._supportedModels;

      const data = await resp.json();
      if (data.data && Array.isArray(data.data)) {
        return data.data.map(m => ({
          id: m.id,
          name: m.id,
          maxTokens: 8192,
          contextWindow: 32768,
        }));
      }
    } catch (e) {

      // 端点不可用，返回默认列表

      console.warn('[custom.js] 空 catch 补日志:', e && e.message);
    }

    return this._supportedModels;
  }
}

CustomAdapter.DEFAULT_MODELS = CUSTOM_DEFAULT_MODELS;

module.exports = { CustomAdapter, CUSTOM_DEFAULT_MODELS };
