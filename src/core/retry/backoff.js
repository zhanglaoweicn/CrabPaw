const crypto = require('crypto');
/**
 * Retry with Jittered Backoff - 抖动退避重试
 * 
 * 特性:
 * - 指数退避 + 随机抖动
 * - 防止惊群效应
 * - 并发重试去相关
 * - 可配置最大重试次数
 * - 支持自定义重试条件
 */

const DEFAULT_CONFIG = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  multiplier: 2,
  jitterFactor: 0.5,
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'rate_limit',
    'overloaded',
    'timeout',
    '429',
    '503',
    '502',
    '500'
  ]
};

function calculateBackoff(attempt, config = DEFAULT_CONFIG) {
  const { initialDelayMs, maxDelayMs, multiplier, jitterFactor } = config;
  
  const baseDelay = initialDelayMs * Math.pow(multiplier, attempt);
  const cappedDelay = Math.min(baseDelay, maxDelayMs);
  
  const jitter = cappedDelay * jitterFactor * Math.random();
  const jitteredDelay = cappedDelay + jitter;
  
  return Math.floor(jitteredDelay);
}

function isRetryableError(error, config = DEFAULT_CONFIG) {
  if (!error) return false;
  
  const errorStr = (
    error.code || 
    error.message || 
    error.status?.toString() ||
    error.toString()
  ).toLowerCase();
  
  for (const retryable of config.retryableErrors) {
    if (errorStr.includes(retryable.toLowerCase())) {
      return true;
    }
  }
  
  if (error.status) {
    const status = parseInt(error.status, 10);
    if (status >= 500 && status < 600) return true;
    if (status === 429) return true;
  }
  
  if (error.statusCode) {
    const status = parseInt(error.statusCode, 10);
    if (status >= 500 && status < 600) return true;
    if (status === 429) return true;
  }
  
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, config = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const { maxRetries } = finalConfig;
  
  let lastError = null;
  let attempt = 0;
  
  while (attempt <= maxRetries) {
    try {
      const result = await fn(attempt);
      return {
        success: true,
        result,
        attempts: attempt + 1
      };
    } catch (error) {
      lastError = error;
      
      if (!isRetryableError(error, finalConfig)) {
        return {
          success: false,
          error,
          attempts: attempt + 1,
          retryable: false
        };
      }
      
      if (attempt >= maxRetries) {
        return {
          success: false,
          error,
          attempts: attempt + 1,
          retryable: true,
          exhausted: true
        };
      }
      
      const delay = calculateBackoff(attempt, finalConfig);
      
      if (finalConfig.onRetry) {
        finalConfig.onRetry(attempt, delay, error);
      }
      
      await sleep(delay);
      attempt++;
    }
  }
  
  return {
    success: false,
    error: lastError,
    attempts: attempt,
    exhausted: true
  };
}

class RetryManager {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._activeRetries = new Map();
    this._stats = {
      totalAttempts: 0,
      successfulRetries: 0,
      failedRetries: 0,
      totalDelayMs: 0
    };
  }
  
  async execute(id, fn, overrideConfig = {}) {
    const config = { ...this.config, ...overrideConfig };
    const retryId = id || `retry-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    
    const retryState = {
      id: retryId,
      startTime: Date.now(),
      attempt: 0,
      status: 'running'
    };
    
    this._activeRetries.set(retryId, retryState);
    
    const result = await retryWithBackoff(async (attempt) => {
      retryState.attempt = attempt;
      this._stats.totalAttempts++;
      
      return fn(attempt);
    }, {
      ...config,
      onRetry: (attempt, delay, error) => {
        retryState.lastDelay = delay;
        retryState.lastError = error;
        this._stats.totalDelayMs += delay;
        
        if (config.onRetry) {
          config.onRetry(attempt, delay, error, retryId);
        }
      }
    });
    
    retryState.status = result.success ? 'completed' : 'failed';
    retryState.endTime = Date.now();
    retryState.duration = retryState.endTime - retryState.startTime;
    
    if (result.success) {
      this._stats.successfulRetries++;
    } else {
      this._stats.failedRetries++;
    }
    
    setTimeout(() => {
      this._activeRetries.delete(retryId);
    }, 60000);
    
    return {
      ...result,
      retryId,
      duration: retryState.duration
    };
  }
  
  getStats() {
    return { ...this._stats };
  }
  
  getActiveRetries() {
    return Array.from(this._activeRetries.values());
  }
  
  resetStats() {
    this._stats = {
      totalAttempts: 0,
      successfulRetries: 0,
      failedRetries: 0,
      totalDelayMs: 0
    };
  }
  
  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

function createRetryWrapper(fn, config = {}) {
  return async (...args) => {
    const result = await retryWithBackoff(() => fn(...args), config);
    
    if (result.success) {
      return result.result;
    }
    
    throw result.error;
  };
}

module.exports = {
  retryWithBackoff,
  calculateBackoff,
  isRetryableError,
  RetryManager,
  createRetryWrapper,
  DEFAULT_CONFIG
};
