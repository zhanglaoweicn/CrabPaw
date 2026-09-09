const { EventEmitter } = require('events');
const {
  TASKFLOW_LLM_PROVIDER_STATUS,
  TASKFLOW_ERROR_CATEGORY
} = require('./taskflow-types');
const { classifyError } = require('./error-classifier');

const HEALTH_CHECK_INTERVAL_MS = 30000;
const COOLDOWN_BASE_MS = 10000;
const MAX_COOLDOWN_MS = 300000;
const MAX_CONSECUTIVE_FAILURES = 3;

class LlmProviderManager extends EventEmitter {
  constructor() {
    super();
    this._providers = new Map();
    this._priorityOrder = [];
    this._healthStatus = new Map();
    this._healthCheckTimer = null;
    this._activeProviderId = null;
  }

  registerProvider(id, providerFn, config = {}) {
    const provider = {
      id,
      provider: providerFn,
      priority: config.priority || 0,
      maxTokens: config.maxTokens || 4096,
      model: config.model || 'default',
      cooldownMs: config.cooldownMs || COOLDOWN_BASE_MS,
      metadata: config.metadata || {}
    };

    this._providers.set(id, provider);

    this._healthStatus.set(id, {
      status: TASKFLOW_LLM_PROVIDER_STATUS.HEALTHY,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      cooldownUntil: null,
      totalCalls: 0,
      totalFailures: 0
    });

    this._rebuildPriorityOrder();

    if (!this._activeProviderId) {
      this._activeProviderId = id;
    }

    console.log(`🤖 注册 LLM Provider: ${id} (优先级: ${provider.priority})`);
  }

  unregisterProvider(id) {
    this._providers.delete(id);
    this._healthStatus.delete(id);
    this._rebuildPriorityOrder();

    if (this._activeProviderId === id) {
      this._activeProviderId = this._getBestProviderId();
    }
  }

  async call(prompt, options = {}) {
    const providerId = options.providerId || this._activeProviderId;
    const fallbackChain = this._buildFallbackChain(providerId);

    let lastError = null;

    for (const pid of fallbackChain) {
      const provider = this._providers.get(pid);
      const health = this._healthStatus.get(pid);

      if (!provider || !health) continue;

      if (health.status === TASKFLOW_LLM_PROVIDER_STATUS.FAILED ||
          health.status === TASKFLOW_LLM_PROVIDER_STATUS.RATE_LIMITED) {
        if (health.cooldownUntil && Date.now() < health.cooldownUntil) {
          continue;
        }

        health.status = TASKFLOW_LLM_PROVIDER_STATUS.DEGRADED;
        this.emit('provider_recovered', { providerId: pid, previousStatus: health.status });
      }

      try {
        health.totalCalls++;
        const result = await provider.provider(prompt, {
          ...options,
          maxTokens: Math.min(options.maxTokens || provider.maxTokens, provider.maxTokens),
          model: options.model || provider.model
        });

        health.consecutiveFailures = 0;
        health.lastSuccessAt = Date.now();
        health.status = TASKFLOW_LLM_PROVIDER_STATUS.HEALTHY;
        health.cooldownUntil = null;

        if (this._activeProviderId !== pid) {
          const previousProviderId = this._activeProviderId;
          this._activeProviderId = pid;
          this.emit('provider_switched', {
            from: previousProviderId,
            to: pid,
            reason: 'degradation_recovery'
          });
        }

        return result;
      } catch (error) {
        lastError = error;
        health.consecutiveFailures++;
        health.totalFailures++;
        health.lastFailureAt = Date.now();

        const classification = classifyError(error);

        if (classification.category === TASKFLOW_ERROR_CATEGORY.RATE_LIMIT) {
          health.status = TASKFLOW_LLM_PROVIDER_STATUS.RATE_LIMITED;
          health.cooldownUntil = Date.now() + (classification.suggestedDelay || 60000);
        } else if (classification.category === TASKFLOW_ERROR_CATEGORY.CONTEXT_LIMIT) {
          health.status = TASKFLOW_LLM_PROVIDER_STATUS.DEGRADED;
          if (options.maxTokens) {
            options.maxTokens = Math.floor(options.maxTokens * 0.7);
          }
        } else if (health.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          health.status = TASKFLOW_LLM_PROVIDER_STATUS.FAILED;
          const cooldown = Math.min(
            provider.cooldownMs * Math.pow(2, health.consecutiveFailures - 1),
            MAX_COOLDOWN_MS
          );
          health.cooldownUntil = Date.now() + cooldown;
        } else {
          health.status = TASKFLOW_LLM_PROVIDER_STATUS.DEGRADED;
        }

        this.emit('provider_error', {
          providerId: pid,
          error: error.message,
          errorCategory: classification.category,
          status: health.status,
          consecutiveFailures: health.consecutiveFailures
        });

        console.warn(`⚠️ LLM Provider ${pid} 调用失败 (${health.consecutiveFailures}次): ${error.message}`);
      }
    }

    throw lastError || new Error('No LLM providers available');
  }

  getActiveProvider() {
    return this._activeProviderId;
  }

  getProviderStatus(id) {
    const provider = this._providers.get(id);
    const health = this._healthStatus.get(id);
    if (!provider || !health) return null;

    return {
      id: provider.id,
      model: provider.model,
      priority: provider.priority,
      status: health.status,
      consecutiveFailures: health.consecutiveFailures,
      totalCalls: health.totalCalls,
      totalFailures: health.totalFailures,
      lastSuccessAt: health.lastSuccessAt,
      lastFailureAt: health.lastFailureAt,
      cooldownUntil: health.cooldownUntil
    };
  }

  getAllProviderStatuses() {
    const statuses = [];
    for (const id of this._providers.keys()) {
      const status = this.getProviderStatus(id);
      if (status) statuses.push(status);
    }
    return statuses.sort((a, b) => a.priority - b.priority);
  }

  startHealthCheck() {
    if (this._healthCheckTimer) return;

    this._healthCheckTimer = setInterval(() => {
      this._performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);

    if (this._healthCheckTimer.unref) this._healthCheckTimer.unref();
  }

  stopHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  async _performHealthCheck() {
    for (const [id, health] of this._healthStatus) {
      if (health.status === TASKFLOW_LLM_PROVIDER_STATUS.FAILED ||
          health.status === TASKFLOW_LLM_PROVIDER_STATUS.RATE_LIMITED) {
        if (health.cooldownUntil && Date.now() >= health.cooldownUntil) {
          health.status = TASKFLOW_LLM_PROVIDER_STATUS.DEGRADED;
          health.cooldownUntil = null;

          this.emit('provider_cooldown_expired', { providerId: id });
          console.log(`🔄 LLM Provider ${id} 冷却期结束，标记为降级状态`);
        }
      }
    }

    const bestId = this._getBestProviderId();
    if (bestId && bestId !== this._activeProviderId) {
      const currentHealth = this._healthStatus.get(this._activeProviderId);
      if (currentHealth && currentHealth.status !== TASKFLOW_LLM_PROVIDER_STATUS.HEALTHY) {
        this._activeProviderId = bestId;
        this.emit('provider_switched', {
          to: bestId,
          reason: 'health_check'
        });
      }
    }
  }

  _rebuildPriorityOrder() {
    this._priorityOrder = [...this._providers.values()]
      .sort((a, b) => a.priority - b.priority)
      .map(p => p.id);
  }

  _getBestProviderId() {
    for (const id of this._priorityOrder) {
      const health = this._healthStatus.get(id);
      if (health && health.status === TASKFLOW_LLM_PROVIDER_STATUS.HEALTHY) {
        return id;
      }
    }

    for (const id of this._priorityOrder) {
      const health = this._healthStatus.get(id);
      if (health && health.status === TASKFLOW_LLM_PROVIDER_STATUS.DEGRADED) {
        return id;
      }
    }

    return this._priorityOrder[0] || null;
  }

  _buildFallbackChain(startId) {
    const chain = [];

    if (startId && this._providers.has(startId)) {
      chain.push(startId);
    }

    for (const id of this._priorityOrder) {
      if (!chain.includes(id)) {
        chain.push(id);
      }
    }

    return chain;
  }
}

let managerInstance = null;

function getLlmProviderManager() {
  if (!managerInstance) {
    managerInstance = new LlmProviderManager();
  }
  return managerInstance;
}

module.exports = {
  LlmProviderManager,
  getLlmProviderManager
};
