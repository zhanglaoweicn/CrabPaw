const {
  TASKFLOW_ERROR_CATEGORY,
  TASKFLOW_ERROR_SEVERITY,
  TASKFLOW_ERROR_STRATEGY
} = require('./taskflow-types');

const NETWORK_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EPIPE/i,
  /EAI_AGAIN/i,
  /socket hang up/i,
  /network/i,
  /fetch failed/i,
  /connection.*refused/i,
  /connection.*reset/i,
  /DNS/i
];

const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /超时/
];

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'
]);

const TIMEOUT_ERROR_CODES = new Set([
  'ERR_TIMEOUT', 'ETIMEDOUT'
]);

const PERMISSION_PATTERNS = [
  /permission denied/i,
  /EACCES/i,
  /EPERM/i,
  /forbidden/i,
  /unauthorized/i,
  /403/i,
  /401/i,
  /权限/,
  /认证失败/
];

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /429/i,
  /quota exceeded/i,
  /限流/,
  /请求过多/
];

const CONTEXT_LIMIT_PATTERNS = [
  /context.*length/i,
  /token.*limit/i,
  /max.*tokens/i,
  /context window/i,
  /上下文.*长度/,
  /token.*超限/
];

const PROVIDER_PATTERNS = [
  /provider/i,
  /api key/i,
  /invalid.*key/i,
  /model.*not found/i,
  /invalid.*model/i,
  /provider.*error/i,
  /提供者/
];

const DATA_FORMAT_PATTERNS = [
  /JSON/i,
  /parse error/i,
  /syntax error/i,
  /invalid.*format/i,
  /schema.*validation/i,
  /unexpected token/i,
  /格式错误/,
  /解析失败/
];

const VALIDATION_PATTERNS = [
  /validation/i,
  /invalid.*param/i,
  /missing.*required/i,
  /参数.*无效/,
  /缺少.*必填/
];

function classifyError(error) {
  const message = error?.message || String(error);
  const code = error?.code || '';
  const statusCode = error?.statusCode || error?.status || 0;
  const combined = `${message} ${code} ${statusCode}`;

  if (statusCode === 429 || _matchPatterns(combined, RATE_LIMIT_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.RATE_LIMIT,
      severity: TASKFLOW_ERROR_SEVERITY.TRANSIENT,
      strategy: TASKFLOW_ERROR_STRATEGY.RETRY,
      retryable: true,
      suggestedDelay: _extractRateLimitRetryAfter(error) || 60000
    };
  }

  if (statusCode === 401 || statusCode === 403 || _matchPatterns(combined, PERMISSION_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.PERMISSION,
      severity: TASKFLOW_ERROR_SEVERITY.FATAL,
      strategy: TASKFLOW_ERROR_STRATEGY.STOP,
      retryable: false
    };
  }

  if (NETWORK_ERROR_CODES.has(code)) {
    const isTimeout = TIMEOUT_ERROR_CODES.has(code);
    return {
      category: isTimeout ? TASKFLOW_ERROR_CATEGORY.TIMEOUT : TASKFLOW_ERROR_CATEGORY.NETWORK,
      severity: TASKFLOW_ERROR_SEVERITY.TRANSIENT,
      strategy: TASKFLOW_ERROR_STRATEGY.RETRY,
      retryable: true,
      suggestedDelay: isTimeout ? _calculateRetryDelay(error) : 2000
    };
  }

  if (_matchPatterns(combined, TIMEOUT_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.TIMEOUT,
      severity: TASKFLOW_ERROR_SEVERITY.TRANSIENT,
      strategy: TASKFLOW_ERROR_STRATEGY.RETRY,
      retryable: true,
      suggestedDelay: _calculateRetryDelay(error)
    };
  }

  if (_matchPatterns(combined, NETWORK_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.NETWORK,
      severity: TASKFLOW_ERROR_SEVERITY.TRANSIENT,
      strategy: TASKFLOW_ERROR_STRATEGY.RETRY,
      retryable: true,
      suggestedDelay: 2000
    };
  }

  if (_matchPatterns(combined, CONTEXT_LIMIT_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.CONTEXT_LIMIT,
      severity: TASKFLOW_ERROR_SEVERITY.RECOVERABLE,
      strategy: TASKFLOW_ERROR_STRATEGY.DEGRADE,
      retryable: false
    };
  }

  if (_matchPatterns(combined, PROVIDER_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.PROVIDER,
      severity: TASKFLOW_ERROR_SEVERITY.RECOVERABLE,
      strategy: TASKFLOW_ERROR_STRATEGY.DEGRADE,
      retryable: true,
      suggestedDelay: 5000
    };
  }

  if (_matchPatterns(combined, DATA_FORMAT_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.DATA_FORMAT,
      severity: TASKFLOW_ERROR_SEVERITY.RECOVERABLE,
      strategy: TASKFLOW_ERROR_STRATEGY.FALLBACK,
      retryable: false
    };
  }

  if (_matchPatterns(combined, VALIDATION_PATTERNS)) {
    return {
      category: TASKFLOW_ERROR_CATEGORY.VALIDATION,
      severity: TASKFLOW_ERROR_SEVERITY.FATAL,
      strategy: TASKFLOW_ERROR_STRATEGY.STOP,
      retryable: false
    };
  }

  return {
    category: TASKFLOW_ERROR_CATEGORY.UNKNOWN,
    severity: TASKFLOW_ERROR_SEVERITY.RECOVERABLE,
    strategy: TASKFLOW_ERROR_STRATEGY.RETRY,
    retryable: true,
    suggestedDelay: 3000
  };
}

function _matchPatterns(text, patterns) {
  return patterns.some(p => p.test(text));
}

function _calculateRetryDelay(error) {
  const message = error?.message || '';
  const timeoutMatch = message.match(/(\d+)\s*ms/);
  if (timeoutMatch) {
    return parseInt(timeoutMatch[1], 10) + 1000;
  }
  return 5000;
}

function _extractRateLimitRetryAfter(error) {
  const headers = error?.headers || error?.response?.headers || {};
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  return null;
}

function getErrorStrategy(classification, stepConfig) {
  if (stepConfig?.onError) {
    const override = TASKFLOW_ERROR_STRATEGY[stepConfig.onError.toUpperCase()];
    if (override) return override;
  }

  if (stepConfig?.errorStrategy) {
    return stepConfig.errorStrategy;
  }

  return classification.strategy;
}

function isRetryable(classification, attemptCount, maxRetries) {
  if (!classification.retryable) return false;
  if (attemptCount >= maxRetries) return false;
  if (classification.severity === TASKFLOW_ERROR_SEVERITY.FATAL) return false;
  return true;
}

function formatErrorReport(classification, error, stepInfo) {
  return {
    category: classification.category,
    severity: classification.severity,
    strategy: classification.strategy,
    retryable: classification.retryable,
    message: error?.message || String(error),
    stepId: stepInfo?.stepId || null,
    stepType: stepInfo?.stepType || null,
    timestamp: Date.now()
  };
}

class ErrorClassifier {
  classify(error) {
    return classifyError(error);
  }

  getStrategy(classification) {
    return getErrorStrategy(classification);
  }

  isRetryable(classification) {
    return isRetryable(classification);
  }

  formatReport(classification) {
    return formatErrorReport(classification);
  }
}

module.exports = {
  classifyError,
  getErrorStrategy,
  isRetryable,
  formatErrorReport,
  ErrorClassifier
};
