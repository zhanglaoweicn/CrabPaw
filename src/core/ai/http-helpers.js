'use strict';

/**
 * HTTP 请求重试工具（从 ai.js 拆分）
 *
 * 提供带指数退避重试的 fetch 封装，处理网络错误、超时、限流等可重试场景。
 */

const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  retryableErrors: [
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENETDOWN',
    'ENETUNREACH',
    'EHOSTDOWN',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'EAI_AGAIN',
    'EAI_NONAME',
    'EAI_TIMEOUT',
    'UND_ERR_CONNECT'
  ],
  retryableStatusCodes: [408, 429, 500, 502, 503, 504]
};

/**
 * 判断错误是否可重试
 */
function isRetryableError(error) {
  if (error.code && RETRY_CONFIG.retryableErrors.includes(error.code)) {
    return true;
  }

  if (error.status && RETRY_CONFIG.retryableStatusCodes.includes(error.status)) {
    return true;
  }

  if (error.cause) {
    const causeCode = error.cause.code;
    const causeMessage = error.cause.message || '';
    if (causeCode && RETRY_CONFIG.retryableErrors.includes(causeCode)) {
      return true;
    }
    if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_/i.test(causeCode || '')) {
      return true;
    }
    if (/connection/i.test(causeMessage) || /timeout/i.test(causeMessage)) {
      return true;
    }
  }

  if (error.message) {
    const retryablePatterns = [
      /network/i,
      /timeout/i,
      /connection/i,
      /ECONNRESET/i,
      /ETIMEDOUT/i,
      /rate limit/i,
      /too many requests/i,
      /service unavailable/i,
      /bad gateway/i,
      /gateway timeout/i,
      /fetch failed/i,
      /EAI_/i,
      /ENOTFOUND/i,
      /socket hang up/i,
      /connect ETIMEDOUT/i,
      /connect ECONNREFUSED/i
    ];

    for (const pattern of retryablePatterns) {
      if (pattern.test(error.message)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 计算指数退避延迟（含抖动）
 */
function calculateDelay(attempt, baseDelay = RETRY_CONFIG.baseDelay, maxDelay = RETRY_CONFIG.maxDelay) {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.1 * exponentialDelay;
  const delay = exponentialDelay + jitter;
  return Math.min(delay, maxDelay);
}

/**
 * Promise 延迟
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的 fetch
 * @param {string} url - 请求 URL
 * @param {object} [options] - fetch 选项（含 timeout，默认 60s）
 * @param {object} [retryConfig] - 重试配置覆盖
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, retryConfig = {}) {
  const config = { ...RETRY_CONFIG, ...retryConfig };
  const maxRetries = config.maxRetries || 3;

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = options.timeout || 60000;
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // I-3 T1: 组合外部 signal 与超时 signal（Node 24 AbortSignal.any）
      const effectiveSignal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;

      const response = await fetch(url, {
        ...options,
        signal: effectiveSignal
      });

      clearTimeout(timeoutId);

      if (!response.ok && config.retryableStatusCodes.includes(response.status)) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      return response;

    } catch (error) {
      lastError = error;

      // I-3 T1: 外部中断不重试
      if (options.signal?.aborted) {
        console.log('🛑 [fetchWithRetry] 外部中断，跳过重试');
        throw error;
      }

      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = calculateDelay(attempt, config.baseDelay, config.maxDelay);
        const causeInfo = error.cause ? ` (cause: ${error.cause.code || ''} ${error.cause.message || ''})` : '';
        console.log(`🔄 API 调用失败，${delay}ms 后重试 (尝试 ${attempt + 1}/${maxRetries}): ${error.message}${causeInfo}`);
        await sleep(delay);
        continue;
      }

      const causeDetail = error.cause ? ` | cause: ${error.cause.code || ''} ${error.cause.message || ''}` : '';
      console.error(`❌ API 调用最终失败 (${attempt + 1}次尝试): ${error.message}${causeDetail}`);
      throw error;
    }
  }

  throw lastError;
}

/**
 * 带重试的 fetch + JSON 解析
 */
async function fetchJsonWithRetry(url, options = {}, retryConfig = {}) {
  const response = await fetchWithRetry(url, options, retryConfig);
  return response.json();
}

module.exports = {
  RETRY_CONFIG,
  isRetryableError,
  calculateDelay,
  sleep,
  fetchWithRetry,
  fetchJsonWithRetry,
};
