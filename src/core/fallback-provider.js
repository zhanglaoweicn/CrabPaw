/**
 * Fallback Provider — 备用提供者管理
 *
 * 当主模型失败时，自动切换到用户预设的备用模型。
 * 支持多层备援：
 *   1. 同提供者重试（由 recovery-chain 处理）
 *   2. 跨提供者切换到 fallback_model（本模块处理）
 *   3. 辅助任务独立提供者（视觉/压缩等用轻量模型）
 *
 *   - 每会话最多触发一次 fallback，防止级联故障
 *   - 备援触发条件：429/500/502/503/401/403/404/超时/无效响应
 *   - 切换过程无缝：对话历史、工具调用和上下文均保留
 */

const { classifyApiError, FailoverReason } = require('./error-classifier');

// 触发备援的错误类型
const FAILOVER_TRIGGERS = new Set([
  FailoverReason.RATE_LIMIT,
  FailoverReason.OVERLOADED,
  FailoverReason.SERVER_ERROR,
  FailoverReason.TIMEOUT,
  FailoverReason.AUTH,
  FailoverReason.AUTH_PERMANENT,
  FailoverReason.MODEL_NOT_FOUND,
  FailoverReason.BILLING,
]);

// 会话级 fallback 状态（每会话最多触发一次）
const sessionFallbackState = new Map(); // sessionId -> { triggered, fromProvider, toProvider, timestamp }

/**
 * 清理过期的会话状态（每10分钟）
 */
const fallbackCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, state] of sessionFallbackState) {
    if (now - state.timestamp > 30 * 60 * 1000) { // 30分钟过期
      sessionFallbackState.delete(sessionId);
    }
  }
}, 10 * 60 * 1000);
if (fallbackCleanupTimer.unref) {
  fallbackCleanupTimer.unref();
}

class FallbackProviderManager {
  constructor(config = {}) {
    this.config = config;
    this._fallbackConfig = null;
    this._auxiliaryConfig = null;
    this._loadConfig();
  }

  /**
   * 加载 fallback 和 auxiliary 配置
   */
  _loadConfig() {
    const models = this.config.models || {};

    // 主模型备援配置
    this._fallbackConfig = models.fallbackModel || null;

    // 辅助任务提供者配置
    this._auxiliaryConfig = models.auxiliary || {
      vision: { provider: 'auto', model: '' },
      compression: { provider: 'auto', model: '' },
      webExtract: { provider: 'auto', model: '' },
    };
  }

  /**
   * 更新配置
   */
  updateConfig(config) {
    this.config = config;
    this._loadConfig();
  }

  // ========================================================================
  // 主模型备援
  // ========================================================================

  /**
   * 获取 fallback 模型配置
   */
  getFallbackConfig() {
    return this._fallbackConfig;
  }

  /**
   * 设置 fallback 模型配置
   */
  setFallbackConfig(fallbackConfig) {
    this._fallbackConfig = fallbackConfig;
    if (!this.config.models) this.config.models = {};
    this.config.models.fallbackModel = fallbackConfig;
  }

  /**
   * 判断错误是否应触发备援
   */
  shouldFailover(error) {
    const classification = classifyApiError(error);
    return FAILOVER_TRIGGERS.has(classification.reason);
  }

  /**
   * 检查会话是否已触发过备援
   */
  hasSessionFallbacked(sessionId) {
    return sessionId && sessionFallbackState.has(sessionId);
  }

  /**
   * 获取会话的备援状态
   */
  getSessionFallbackState(sessionId) {
    return sessionId ? sessionFallbackState.get(sessionId) : null;
  }

  /**
   * 执行备援切换
   * @param {string} sessionId - 会话 ID
   * @param {Error} error - 触发备援的错误
   * @param {object} modelRouter - ModelRouter 实例
   * @returns {object|null} 备援路由结果，或 null（无可用备援）
   */
  performFailover(sessionId, error, modelRouter) {
    // 每会话最多触发一次
    if (this.hasSessionFallbacked(sessionId)) {
      console.log('⚠️ 会话已触发过备援，不再重复切换');
      return null;
    }

    if (!this.shouldFailover(error)) {
      return null;
    }

    // 尝试用户配置的 fallback_model
    if (this._fallbackConfig) {
      const result = this._tryConfiguredFallback(modelRouter);
      if (result) {
        sessionFallbackState.set(sessionId, {
          triggered: true,
          fromProvider: modelRouter.getCurrentProvider(),
          toProvider: result.provider,
          timestamp: Date.now(),
        });
        console.log(`🔄 备援切换: ${modelRouter.getCurrentProvider()} → ${result.provider} (${result.model})`);
        return result;
      }
    }

    // 尝试 fallback chain 中的下一个可用提供者
    const chainResult = this._tryChainFallback(modelRouter);
    if (chainResult) {
      sessionFallbackState.set(sessionId, {
        triggered: true,
        fromProvider: modelRouter.getCurrentProvider(),
        toProvider: chainResult.provider,
        timestamp: Date.now(),
      });
      console.log(`🔄 链式备援: ${modelRouter.getCurrentProvider()} → ${chainResult.provider} (${chainResult.model})`);
      return chainResult;
    }

    console.log('❌ 无可用备援提供者');
    return null;
  }

  /**
   * 尝试用户配置的 fallback_model
   */
  _tryConfiguredFallback(modelRouter) {
    const fb = this._fallbackConfig;
    if (!fb || !fb.provider) return null;

    const providerConfig = modelRouter.getProviderConfig(fb.provider);
    if (!providerConfig) return null;

    // 检查提供者是否可用
    const noKeyRequired = ['ollama', 'custom'].includes(fb.provider);
    const apiKey = providerConfig.apiKey || providerConfig.key;
    if (!noKeyRequired && !apiKey) return null;

    return {
      provider: fb.provider,
      model: fb.model || providerConfig.model || fb.provider,
      baseUrl: fb.baseUrl || modelRouter.getApiUrl(fb.provider),
      apiKey: apiKey || '',
      reason: 'configured_fallback',
    };
  }

  /**
   * 尝试 fallback chain 中的下一个可用提供者
   */
  _tryChainFallback(modelRouter) {
    const chain = modelRouter.getFallbackChain();
    const current = modelRouter.getCurrentProvider();

    for (const provider of chain) {
      if (provider === current) continue;

      const providerConfig = modelRouter.getProviderConfig(provider);
      if (!providerConfig) continue;

      const noKeyRequired = ['ollama', 'custom'].includes(provider);
      const apiKey = modelRouter.getApiKey(provider);
      if (!noKeyRequired && !apiKey) continue;

      // 检查健康状态
      const health = modelRouter.getHealthStatus();
      if (health[provider]?.health === 'down') continue;

      return {
        provider,
        model: providerConfig.model || provider,
        baseUrl: modelRouter.getApiUrl(provider),
        apiKey: apiKey || '',
        reason: 'chain_fallback',
      };
    }

    return null;
  }

  /**
   * 重置会话备援状态（新对话时调用）
   */
  resetSession(sessionId) {
    if (sessionId) {
      sessionFallbackState.delete(sessionId);
    }
  }

  // ========================================================================
  // 辅助任务提供者
  // ========================================================================

  /**
   * 获取辅助任务的提供者路由
   * @param {string} taskType - 任务类型：vision/compression/webExtract
   * @param {object} modelRouter - ModelRouter 实例
   * @returns {object} 路由结果 { provider, model, baseUrl, apiKey }
   */
  getAuxiliaryRoute(taskType, modelRouter) {
    const taskConfig = this._auxiliaryConfig?.[taskType];
    if (!taskConfig) {
      return this._getDefaultAuxiliaryRoute(taskType, modelRouter);
    }

    // 如果配置了 base_url，直接使用
    if (taskConfig.baseUrl) {
      return {
        provider: 'custom',
        model: taskConfig.model || 'default',
        baseUrl: taskConfig.baseUrl,
        apiKey: taskConfig.apiKey || '',
        reason: 'auxiliary_custom',
      };
    }

    // 如果指定了 provider
    if (taskConfig.provider && taskConfig.provider !== 'auto') {
      if (taskConfig.provider === 'main') {
        // 使用主 Agent 的提供者
        const route = modelRouter.route();
        return { ...route, reason: 'auxiliary_main' };
      }

      const providerConfig = modelRouter.getProviderConfig(taskConfig.provider);
      if (providerConfig) {
        return {
          provider: taskConfig.provider,
          model: taskConfig.model || providerConfig.model || taskConfig.provider,
          baseUrl: modelRouter.getApiUrl(taskConfig.provider),
          apiKey: modelRouter.getApiKey(taskConfig.provider) || '',
          reason: 'auxiliary_configured',
        };
      }
    }

    // auto 模式：按优先级尝试
    return this._getDefaultAuxiliaryRoute(taskType, modelRouter);
  }

  /**
   * 获取默认的辅助任务路由（auto 模式）
   */
  _getDefaultAuxiliaryRoute(taskType, modelRouter) {
    // 辅助任务优先使用便宜/快速的模型
    const cheapProviders = ['glm', 'qwen', 'deepseek', 'doubao'];

    // 视觉任务需要支持视觉的模型
    if (taskType === 'vision') {
      const visionProviders = ['qwen', 'glm', 'deepseek'];
      for (const provider of visionProviders) {
        const config = modelRouter.getProviderConfig(provider);
        const apiKey = modelRouter.getApiKey(provider);
        if (config && apiKey) {
          return {
            provider,
            model: config.model || provider,
            baseUrl: modelRouter.getApiUrl(provider),
            apiKey,
            reason: 'auxiliary_auto_vision',
          };
        }
      }
    }

    // 文本类任务：优先使用便宜模型
    for (const provider of cheapProviders) {
      const config = modelRouter.getProviderConfig(provider);
      const apiKey = modelRouter.getApiKey(provider);
      if (config && apiKey) {
        return {
          provider,
          model: config.model || provider,
          baseUrl: modelRouter.getApiUrl(provider),
          apiKey,
          reason: 'auxiliary_auto',
        };
      }
    }

    // 回退到主提供者
    const route = modelRouter.route();
    return { ...route, reason: 'auxiliary_fallback_main' };
  }

  /**
   * 设置辅助任务配置
   */
  setAuxiliaryConfig(taskType, config) {
    if (!this._auxiliaryConfig) this._auxiliaryConfig = {};
    this._auxiliaryConfig[taskType] = config;
    if (!this.config.models) this.config.models = {};
    this.config.models.auxiliary = this._auxiliaryConfig;
  }

  /**
   * 获取所有辅助任务配置
   */
  getAuxiliaryConfig() {
    return this._auxiliaryConfig || {};
  }

  // ========================================================================
  // 状态与统计
  // ========================================================================

  /**
   * 获取备援统计信息
   */
  getStats() {
    return {
      fallbackConfigured: !!this._fallbackConfig,
      // 2026-08-27 审计 A1: 此处曾返回字符串模型名(fallbackProvider/fallbackModel),
      // 与设置页 /api/fallback/status 回显期望的对象形态失配 → 前端解包恒空。
      // 现返回配置对象形态, 与 models.fallbackModel/前端保存形态一致。
      fallbackProvider: this._fallbackConfig?.provider || null,
      fallbackModel: this._fallbackConfig || null,
      auxiliary: this._auxiliaryConfig || {},
      activeSessionFallbacks: sessionFallbackState.size,
      auxiliaryTasks: Object.keys(this._auxiliaryConfig || {}),
    };
  }
}

// ============================================================================
// 单例
// ============================================================================

let _instance = null;

function getFallbackProviderManager(config) {
  if (!_instance && config) {
    _instance = new FallbackProviderManager(config);
  }
  return _instance;
}

function resetFallbackProviderManager() {
  _instance = null;
}

module.exports = {
  FallbackProviderManager,
  getFallbackProviderManager,
  resetFallbackProviderManager,
  FAILOVER_TRIGGERS,
};
