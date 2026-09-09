const { ProviderAdapter } = require('./base');

/**
 * Coding Plan 通用适配器
 *
 * 适用于所有 OpenAI 兼容的 Coding Plan 端点：
 * - 阿里云百炼 Coding Plan (coding.dashscope.aliyuncs.com)
 * - 火山方舟 Coding Plan (ark.cn-beijing.volces.com)
 * - 腾讯云 Coding Plan (api.lkeap.cloud.tencent.com)
 *
 * 特点：固定月费、模型池自由切换、专为代码场景优化
 */

class CodingPlanAdapter extends ProviderAdapter {
  constructor(config = {}) {
    const modelName = config.model || 'qwen3-coder-plus';

    super({
      providerId: config.providerId || 'aliyun_coding',
      baseUrl: config.baseUrl || 'https://coding.dashscope.aliyuncs.com/v1',
      apiKey: config.apiKey || '',
      defaultModel: modelName,
      supportedModels: [
        {
          id: modelName,
          name: config.modelName || modelName,
          maxTokens: config.maxTokens || 16384,
          contextWindow: config.contextWindow || 131072,
        },
      ],
      capabilities: {
        streaming: true,
        toolUse: true,
        vision: false,
        reasoning: false,
        maxTokens: 16384,
      },
    });

    this._config = config;
  }

  validate() {
    if (!this._apiKey) {
      return { valid: false, error: `${this._providerId}: API Key 未配置` };
    }
    if (!this._baseUrl) {
      return { valid: false, error: `${this._providerId}: Base URL 未配置` };
    }
    return { valid: true };
  }

  buildRequestPayload(params) {
    const payload = super.buildRequestPayload(params);

    // Coding Plan 通常不使用 temperature
    if (payload.temperature !== undefined) {
      payload.temperature = this.clampTemperature(payload.temperature);
    }

    return payload;
  }

  clampTemperature(temp) {
    return Math.max(0, Math.min(1, temp));
  }
}

module.exports = { CodingPlanAdapter };
