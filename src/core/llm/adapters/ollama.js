const { ProviderAdapter } = require('./base');

/**
 * Ollama 适配器 — 本地模型，零配置
 *
 * Ollama 通过 OpenAI 兼容 API 提供服务 (http://localhost:11434/v1)
 * 无需 API Key，支持工具调用
 */

const OLLAMA_MODELS = [
  { id: 'qwen2.5-coder:32b', name: 'Qwen2.5 Coder 32B', maxTokens: 32768, contextWindow: 32768 },
  { id: 'qwen2.5-coder:14b', name: 'Qwen2.5 Coder 14B', maxTokens: 32768, contextWindow: 32768 },
  { id: 'qwen2.5-coder:7b', name: 'Qwen2.5 Coder 7B', maxTokens: 32768, contextWindow: 32768 },
  { id: 'qwen3:8b', name: 'Qwen3 8B', maxTokens: 32768, contextWindow: 32768 },
  { id: 'llama3.1:8b', name: 'Llama 3.1 8B', maxTokens: 8192, contextWindow: 32768 },
  { id: 'llama3.1:70b', name: 'Llama 3.1 70B', maxTokens: 8192, contextWindow: 32768 },
  { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B', maxTokens: 16384, contextWindow: 32768 },
  { id: 'deepseek-r1:7b', name: 'DeepSeek R1 7B', maxTokens: 16384, contextWindow: 32768 },
  { id: 'gemma3:12b', name: 'Gemma 3 12B', maxTokens: 8192, contextWindow: 32768 },
  { id: 'mistral:7b', name: 'Mistral 7B', maxTokens: 8192, contextWindow: 32768 },
];

class OllamaAdapter extends ProviderAdapter {
  constructor(config = {}) {
    super({
      providerId: 'ollama',
      baseUrl: config.baseUrl || 'http://localhost:11434/v1',
      apiKey: config.apiKey || 'ollama', // Ollama 不需要 API Key，但填一个占位值以通过验证
      defaultModel: config.model || 'qwen2.5-coder:7b',
      supportedModels: OLLAMA_MODELS,
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: false,
        reasoning: false,
        maxTokens: 32768,
      },
      ...config,
    });
  }

  validate() {
    // Ollama 不需要 API Key
    if (!this._baseUrl) {
      return { valid: false, error: 'ollama: base URL not configured' };
    }
    return { valid: true };
  }

  getRequestHeaders() {
    return {
      'Content-Type': 'application/json',
      // Ollama 不需要 Authorization header
    };
  }

  /**
   * 动态检测 Ollama 可用模型
   */
  async detectModels() {
    try {
      const baseUrl = this._baseUrl.replace(/\/v1$/, '');
      const resp = await fetch(`${baseUrl}/api/tags`);
      if (!resp.ok) return this._supportedModels;

      const data = await resp.json();
      if (data.models && Array.isArray(data.models)) {
        return data.models.map(m => ({
          id: m.name,
          name: m.name,
          maxTokens: m.parameters?.num_ctx || 32768,
          contextWindow: m.parameters?.num_ctx || 32768,
        }));
      }
    } catch (e) {

      // Ollama 未运行，返回默认列表

      console.warn('[ollama.js] 空 catch 补日志:', e && e.message);
    }

    return this._supportedModels;
  }
}

OllamaAdapter.MODELS = OLLAMA_MODELS;

module.exports = { OllamaAdapter, OLLAMA_MODELS };
