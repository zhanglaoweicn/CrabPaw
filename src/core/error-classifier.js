const FailoverReason = {
  AUTH: 'auth',
  AUTH_PERMANENT: 'auth_permanent',
  BILLING: 'billing',
  RATE_LIMIT: 'rate_limit',
  OVERLOADED: 'overloaded',
  SERVER_ERROR: 'server_error',
  TIMEOUT: 'timeout',
  CONTEXT_OVERFLOW: 'context_overflow',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  MODEL_NOT_FOUND: 'model_not_found',
  FORMAT_ERROR: 'format_error',
  IMAGE_TOO_LARGE: 'image_too_large',
  CONTENT_POLICY_BLOCKED: 'content_policy_blocked',
  PROVIDER_POLICY_BLOCKED: 'provider_policy_blocked',
  THINKING_SIGNATURE: 'thinking_signature',
  MULTIMODAL_TOOL_CONTENT: 'multimodal_tool_content',
  UNKNOWN: 'unknown',
};

const BILLING_PATTERNS = [
  'insufficient credits', 'insufficient_quota', 'insufficient balance',
  'credit balance', 'credits have been exhausted', 'top up your credits',
  'payment required', 'billing hard limit', 'exceeded your current quota',
  'account is deactivated', 'plan does not include',
];

const RATE_LIMIT_PATTERNS = [
  'rate limit', 'rate_limit', 'too many requests', 'throttled',
  'requests per minute', 'tokens per minute', 'requests per day',
  'try again in', 'please retry after', 'resource_exhausted',
  'rate increased too quickly', 'throttlingexception',
  'too many concurrent requests', 'servicequotaexceededexception',
];

const CONTEXT_OVERFLOW_PATTERNS = [
  'context length', 'context size', 'maximum context', 'token limit',
  'too many tokens', 'reduce the length', 'exceeds the limit',
  'context window', 'prompt is too long', 'prompt exceeds max length',
  'max_tokens', 'maximum number of tokens', 'exceeds the max_model_len',
  'max_model_len', 'prompt length', 'input is too long',
  'maximum model length', 'context length exceeded', 'truncating input',
  'slot context', 'n_ctx_slot', '超过最大长度', '上下文长度',
  'input token', 'exceeds the maximum number of input tokens',
];

const MODEL_NOT_FOUND_PATTERNS = [
  'is not a valid model', 'invalid model', 'model not found',
  'model_not_found', 'does not exist', 'no such model',
  'unknown model', 'unsupported model',
];

const AUTH_PATTERNS = [
  'invalid api key', 'invalid_api_key', 'authentication',
  'unauthorized', 'forbidden', 'invalid token', 'token expired',
  'token revoked', 'access denied',
];

const PROVIDER_ERROR_CODES = {
  openai: {
    billing: [
      'billing_hard_limit_reached', 'insufficient_quota', 'account_deactivated',
      'plan_does_not_include', 'credits_exhausted', 'exceeded_current_quota',
    ],
    rate_limit: [
      'rate_limit_exceeded', 'requests_per_minute_limit', 'tokens_per_minute_limit',
    ],
    auth: [
      'invalid_api_key', 'invalid_api_key_provider', 'account_suspended',
    ],
    overloaded: [
      'server_error', 'engine_overloaded',
    ],
    context: [
      'context_length_exceeded', 'max_tokens_exceeded',
    ],
  },
  anthropic: {
    billing: [
      'payment_required', 'credit_balance_too_low',
    ],
    rate_limit: [
      'rate_limit_error', 'rate_limit_exceeded',
    ],
    auth: [
      'authentication_error', 'permission_error',
    ],
    overloaded: [
      'overloaded_error', 'api_error',
    ],
    context: [
      'max_context_window_reached',
    ],
  },
  google: {
    billing: [
      'RESOURCE_EXHAUSTED', 'billing_not_enabled',
    ],
    rate_limit: [
      'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED',
    ],
    auth: [
      'UNAUTHENTICATED', 'PERMISSION_DENIED',
    ],
    overloaded: [
      'SERVICE_UNAVAILABLE', 'INTERNAL',
    ],
    context: [
      'REQUEST_TOO_LARGE',
    ],
  },
  deepseek: {
    billing: [
      'insufficient_balance', 'account_arrears',
    ],
    rate_limit: [
      'rate_limit_reached',
    ],
    auth: [
      'authentication_failed',
    ],
    overloaded: [
      'server_overloaded',
    ],
    context: [
      'context_length_exceeded',
    ],
  },
};

const PROVIDER_AUTH_PERMANENT_CODES = new Set([
  'invalid_api_key', 'invalid_api_key_provider', 'account_suspended',
  'authentication_error', 'UNAUTHENTICATED',
  'token_revoked', 'invalid_grant', 'refresh_token_reused',
]);

const PAYLOAD_TOO_LARGE_PATTERNS = [
  'request entity too large', 'payload too large', 'error code: 413',
];

const IMAGE_TOO_LARGE_PATTERNS = [
  'image too large', 'image size exceeds', 'image dimensions exceed',
  'image file too large', 'image exceeds maximum', '图片过大', '图片尺寸超限',
  'image must be less than', 'max image size',
];

const CONTENT_POLICY_PATTERNS = [
  'content policy', 'content_policy_violation', 'safety system',
  'content filter', 'content_filter', 'flagged by our',
  'violates our policy', 'harmful content', 'inappropriate content',
  'refused to respond', 'i cannot fulfill', 'content violation',
  'safety_settings', 'blocked by safety',
];

const PROVIDER_POLICY_PATTERNS = [
  'provider policy', 'provider_policy_blocked', 'not supported by provider',
  'provider does not support', 'disallowed by provider',
  'feature not available', 'not enabled for this provider',
];

const THINKING_SIGNATURE_PATTERNS = [
  'thinking signature', 'thinking_signature', 'invalid thinking block',
  'thinking parameter mismatch', 'thinking mode not supported',
  'extended thinking', 'budget_tokens',
];

const MULTIMODAL_TOOL_CONTENT_PATTERNS = [
  'multimodal tool content', 'tool_result with image',
  'image in tool result not supported', 'non-text content in tool',
  'tool result content type not supported', 'multimodal content in tool_result',
];

const TRANSPORT_ERROR_TYPES = new Set([
  'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED',
  'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'ReadTimeout', 'ConnectTimeout', 'PoolTimeout',
  'ConnectError', 'RemoteProtocolError',
  'ConnectionError', 'ConnectionResetError',
  'ConnectionAbortedError', 'BrokenPipeError',
  'TimeoutError', 'APIConnectionError', 'APITimeoutError',
]);

const SERVER_DISCONNECT_PATTERNS = [
  'server disconnected', 'peer closed connection',
  'connection reset by peer', 'connection was closed',
  'network connection lost', 'unexpected eof',
  'incomplete chunked read',
];

function _extractStatusCode(error) {
  if (error.status) return error.status;
  if (error.statusCode) return error.statusCode;
  if (error.response?.status) return error.response.status;
  if (error.code === 'ECONNREFUSED') return 503;
  if (error.code === 'ETIMEDOUT' || error.code === 'UND_ERR_CONNECT_TIMEOUT') return 408;
  return null;
}

function _extractErrorMessage(error) {
  const sources = [
    error.message,
    error.error?.message,
    error.response?.data?.error?.message,
    error.response?.data?.message,
    error.data?.error?.message,
    error.data?.message,
  ];
  for (const s of sources) {
    if (typeof s === 'string' && s.trim()) return s;
  }
  return String(error);
}

function _matchesPatterns(text, patterns) {
  const lower = (text || '').toLowerCase();
  return patterns.some(p => lower.includes(p));
}

function _extractProviderErrorCode(error) {
  const sources = [
    error.error?.code,
    error.code,
    error.response?.data?.error?.code,
    error.response?.data?.code,
    error.data?.error?.code,
    error.data?.code,
    error.error?.type,
    error.type,
    error.response?.data?.error?.type,
  ];
  for (const s of sources) {
    if (typeof s === 'string' && s.trim()) return s;
  }
  return null;
}

function _classifyProviderSpecific(errorCode, provider) {
  if (!errorCode || !provider) return null;
  const providerCodes = PROVIDER_ERROR_CODES[provider.toLowerCase()];
  if (!providerCodes) return null;

  const lowerCode = errorCode.toLowerCase();
  for (const [category, codes] of Object.entries(providerCodes)) {
    for (const code of codes) {
      if (lowerCode === code.toLowerCase()) {
        return { category, code: errorCode, permanent: PROVIDER_AUTH_PERMANENT_CODES.has(errorCode) };
      }
    }
  }
  return null;
}

/**
 * x-should-retry header parser
 * 服务端通过 x-should-retry 或 Retry-After 传递重试建议
 */
function _extractRetryHints(error) {
  const headers = error.response?.headers || error.headers || {};
  const xShouldRetry = headers['x-should-retry'] || headers['x-should-retry'] || null;
  const retryAfter = headers['retry-after'] || headers['Retry-After'] || null;
  
  let shouldRetry = null;
  let retryAfterMs = null;
  
  // x-should-retry: "true", "false", or "backoff"
  if (xShouldRetry !== null) {
    if (xShouldRetry === 'false' || xShouldRetry === 'never') {
      shouldRetry = false;
    } else if (xShouldRetry === 'true' || xShouldRetry === 'always') {
      shouldRetry = true;
    } else if (xShouldRetry === 'backoff') {
      shouldRetry = 'backoff';
    }
  }
  
  // Retry-After: seconds or HTTP-date
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (!isNaN(seconds)) {
      retryAfterMs = Math.round(seconds * 1000);
    } else {
      const dateMs = new Date(retryAfter).getTime();
      if (!isNaN(dateMs)) {
        retryAfterMs = Math.max(0, dateMs - Date.now());
      }
    }
  }
  
  return { shouldRetry, retryAfterMs };
}

function classifyApiError(error, options = {}) {
  const { provider = '', model = '', approxTokens = 0, contextLength = 200000, numMessages = 0 } = options;
  const statusCode = _extractStatusCode(error);
  const errorMsg = _extractErrorMessage(error);
  const errorType = error.code || error.name || '';
  const providerErrorCode = _extractProviderErrorCode(error);
  const retryHints = _extractRetryHints(error);

  const result = {
    reason: FailoverReason.UNKNOWN,
    statusCode,
    provider,
    model,
    providerErrorCode,
    message: errorMsg,
    retryable: true,
    shouldCompress: false,
    shouldRotateCredential: false,
    shouldFallback: false,
    shouldStripImages: false,
    retryAfterMs: retryHints.retryAfterMs,
    serverRetryHint: retryHints.shouldRetry,
  };
  
  // Apply server-side retry hints
  if (retryHints.shouldRetry === false) {
    result.retryable = false;
  } else if (retryHints.shouldRetry === true || retryHints.shouldRetry === 'backoff') {
    result.retryable = true;
  }

  if (providerErrorCode && provider) {
    const providerResult = _classifyProviderSpecific(providerErrorCode, provider);
    if (providerResult) {
      result.providerErrorCode = providerErrorCode;
      const CATEGORY_ACTIONS = {
        billing: {
          reason: FailoverReason.BILLING,
          retryable: false,
          shouldRotateCredential: true,
          shouldFallback: true,
        },
        rate_limit: {
          reason: FailoverReason.RATE_LIMIT,
          retryable: true,
          shouldRotateCredential: true,
        },
        auth: {
          reason: providerResult.permanent ? FailoverReason.AUTH_PERMANENT : FailoverReason.AUTH,
          retryable: false,
          shouldRotateCredential: true,
        },
        overloaded: {
          reason: FailoverReason.OVERLOADED,
          retryable: true,
        },
        context: {
          reason: FailoverReason.CONTEXT_OVERFLOW,
          retryable: true,
          shouldCompress: true,
        },
      };
      
      const actions = CATEGORY_ACTIONS[providerResult.category];
      if (actions) {
        Object.assign(result, actions);
        return result;
      }
    }
  }

  if (statusCode === 401 || statusCode === 403) {
    if (_matchesPatterns(errorMsg, AUTH_PATTERNS)) {
      result.reason = FailoverReason.AUTH;
      result.retryable = false;
      result.shouldRotateCredential = true;
      return result;
    }
    result.reason = FailoverReason.AUTH;
    result.retryable = false;
    result.shouldRotateCredential = true;
    return result;
  }

  if (statusCode === 402) {
    result.reason = FailoverReason.BILLING;
    result.retryable = false;
    result.shouldRotateCredential = true;
    result.shouldFallback = true;
    return result;
  }

  if (statusCode === 429) {
    if (_matchesPatterns(errorMsg, BILLING_PATTERNS)) {
      result.reason = FailoverReason.BILLING;
      result.retryable = false;
      result.shouldRotateCredential = true;
      result.shouldFallback = true;
      return result;
    }
    result.reason = FailoverReason.RATE_LIMIT;
    result.retryable = true;
    result.shouldRotateCredential = true;
    return result;
  }

  if (statusCode === 400) {
    if (_matchesPatterns(errorMsg, CONTEXT_OVERFLOW_PATTERNS)) {
      result.reason = FailoverReason.CONTEXT_OVERFLOW;
      result.retryable = true;
      result.shouldCompress = true;
      return result;
    }
    if (_matchesPatterns(errorMsg, MODEL_NOT_FOUND_PATTERNS)) {
      result.reason = FailoverReason.MODEL_NOT_FOUND;
      result.retryable = false;
      result.shouldFallback = true;
      return result;
    }
    result.reason = FailoverReason.FORMAT_ERROR;
    result.retryable = false;
    return result;
  }

  if (statusCode === 404) {
    if (_matchesPatterns(errorMsg, MODEL_NOT_FOUND_PATTERNS)) {
      result.reason = FailoverReason.MODEL_NOT_FOUND;
      result.retryable = false;
      result.shouldFallback = true;
      return result;
    }
    result.reason = FailoverReason.MODEL_NOT_FOUND;
    result.retryable = false;
    result.shouldFallback = true;
    return result;
  }

  if (statusCode === 413) {
    result.reason = FailoverReason.PAYLOAD_TOO_LARGE;
    result.retryable = true;
    result.shouldCompress = true;
    result.shouldStripImages = true;
    return result;
  }

  if (statusCode === 500 || statusCode === 502) {
    result.reason = FailoverReason.SERVER_ERROR;
    result.retryable = true;
    return result;
  }

  if (statusCode === 503 || statusCode === 529) {
    result.reason = FailoverReason.OVERLOADED;
    result.retryable = true;
    return result;
  }

  if (statusCode === 408) {
    result.reason = FailoverReason.TIMEOUT;
    result.retryable = true;
    return result;
  }

  if (TRANSPORT_ERROR_TYPES.has(errorType)) {
    result.reason = FailoverReason.TIMEOUT;
    result.retryable = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, CONTEXT_OVERFLOW_PATTERNS)) {
    const isLargeSession = approxTokens > contextLength * 0.5 || numMessages > 40;
    if (isLargeSession || _matchesPatterns(errorMsg, SERVER_DISCONNECT_PATTERNS)) {
      result.reason = FailoverReason.CONTEXT_OVERFLOW;
      result.retryable = true;
      result.shouldCompress = true;
      return result;
    }
  }

  if (_matchesPatterns(errorMsg, RATE_LIMIT_PATTERNS)) {
    result.reason = FailoverReason.RATE_LIMIT;
    result.retryable = true;
    result.shouldRotateCredential = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, BILLING_PATTERNS)) {
    result.reason = FailoverReason.BILLING;
    result.retryable = false;
    result.shouldRotateCredential = true;
    result.shouldFallback = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, AUTH_PATTERNS)) {
    result.reason = FailoverReason.AUTH;
    result.retryable = false;
    result.shouldRotateCredential = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, PAYLOAD_TOO_LARGE_PATTERNS)) {
    result.reason = FailoverReason.PAYLOAD_TOO_LARGE;
    result.retryable = true;
    result.shouldCompress = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, IMAGE_TOO_LARGE_PATTERNS)) {
    result.reason = FailoverReason.IMAGE_TOO_LARGE;
    result.retryable = true;
    result.shouldCompress = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, CONTENT_POLICY_PATTERNS)) {
    result.reason = FailoverReason.CONTENT_POLICY_BLOCKED;
    result.retryable = false;
    return result;
  }

  if (_matchesPatterns(errorMsg, PROVIDER_POLICY_PATTERNS)) {
    result.reason = FailoverReason.PROVIDER_POLICY_BLOCKED;
    result.retryable = false;
    result.shouldFallback = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, THINKING_SIGNATURE_PATTERNS)) {
    result.reason = FailoverReason.THINKING_SIGNATURE;
    result.retryable = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, MULTIMODAL_TOOL_CONTENT_PATTERNS)) {
    result.reason = FailoverReason.MULTIMODAL_TOOL_CONTENT;
    result.retryable = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, MODEL_NOT_FOUND_PATTERNS)) {
    result.reason = FailoverReason.MODEL_NOT_FOUND;
    result.retryable = false;
    result.shouldFallback = true;
    return result;
  }

  if (_matchesPatterns(errorMsg, SERVER_DISCONNECT_PATTERNS)) {
    result.reason = FailoverReason.TIMEOUT;
    result.retryable = true;
    return result;
  }

  return result;
}

function getRecoveryAction(classified) {
  switch (classified.reason) {
    case FailoverReason.CONTEXT_OVERFLOW:
    case FailoverReason.PAYLOAD_TOO_LARGE:
      return { action: 'compress_and_retry', description: '压缩上下文后重试' };
    case FailoverReason.RATE_LIMIT:
      return { action: 'backoff_and_retry', description: '退避后重试，考虑切换凭据' };
    case FailoverReason.AUTH:
      return { action: 'rotate_credential', description: '轮换API密钥' };
    case FailoverReason.AUTH_PERMANENT:
      return { action: 'abort', description: '认证永久失败，请检查密钥' };
    case FailoverReason.BILLING:
      return { action: 'rotate_or_fallback', description: '余额不足，切换凭据或模型' };
    case FailoverReason.MODEL_NOT_FOUND:
      return { action: 'fallback_model', description: '模型不可用，切换到备用模型' };
    case FailoverReason.OVERLOADED:
      return { action: 'backoff_and_retry', description: '服务过载，退避后重试' };
    case FailoverReason.SERVER_ERROR:
      return { action: 'retry', description: '服务器错误，重试' };
    case FailoverReason.TIMEOUT:
      return { action: 'retry', description: '连接超时，重试' };
    case FailoverReason.FORMAT_ERROR:
      return { action: 'abort', description: '请求格式错误，请检查参数' };
    case FailoverReason.IMAGE_TOO_LARGE:
      return { action: 'shrink_image_and_retry', description: '图片过大，压缩后重试' };
    case FailoverReason.CONTENT_POLICY_BLOCKED:
      return { action: 'notify_user', description: '内容被策略拦截，请修改请求内容' };
    case FailoverReason.PROVIDER_POLICY_BLOCKED:
      return { action: 'fallback_provider', description: '供应商策略拦截，切换供应商' };
    case FailoverReason.THINKING_SIGNATURE:
      return { action: 'strip_thinking_and_retry', description: 'Thinking签名不匹配，移除thinking参数后重试' };
    case FailoverReason.MULTIMODAL_TOOL_CONTENT:
      return { action: 'text_only_fallback', description: '多模态工具内容不支持，使用纯文本回退' };
    default:
      return { action: 'retry_with_backoff', description: '未知错误，退避重试' };
  }
}

class RetryScheduler {
  constructor(config = {}) {
    this.maxRetries = config.maxRetries || 3;
    this.baseDelay = config.baseDelay || 1000;
    this.maxDelay = config.maxDelay || 60000;
    this.jitterFactor = config.jitterFactor || 0.25;
    this._attempts = new Map();
    this._providerCooldowns = new Map();
    this._serverRetryHints = new Map();
  }

  /**
   * 计算重试延迟 (Exponential Backoff with Jitter)
   * 优先使用服务端 Retry-After 建议
   */
  getDelay(reason, attempt, serverRetryAfterMs = null) {
    // 服务端建议优先
    if (serverRetryAfterMs !== null && serverRetryAfterMs !== undefined) {
      const jitter = serverRetryAfterMs * this.jitterFactor * (Math.random() * 2 - 1);
      return Math.max(100, Math.round(serverRetryAfterMs + jitter));
    }
    
    let delay;
    switch (reason) {
      case FailoverReason.RATE_LIMIT:
        delay = this.baseDelay * Math.pow(3, attempt);
        break;
      case FailoverReason.OVERLOADED:
        delay = this.baseDelay * Math.pow(2, attempt + 1);
        break;
      case FailoverReason.SERVER_ERROR:
        delay = this.baseDelay * Math.pow(2, attempt);
        break;
      case FailoverReason.TIMEOUT:
        delay = this.baseDelay * Math.pow(1.5, attempt);
        break;
      case FailoverReason.CONTEXT_OVERFLOW:
      case FailoverReason.PAYLOAD_TOO_LARGE:
        delay = this.baseDelay;
        break;
      default:
        delay = this.baseDelay * Math.pow(2, attempt);
    }
    delay = Math.min(delay, this.maxDelay);
    const jitter = delay * this.jitterFactor * (Math.random() * 2 - 1);
    return Math.max(100, Math.round(delay + jitter));
  }

  /**
   * 生成结构化重试决策对象
   * @returns {{ shouldRetry: boolean, delayMs: number, attempt: number, reason: string, action: string }}
   */
  getRetryDecision(key, classified) {
    if (!this.canRetry(key, classified.reason)) {
      return {
        shouldRetry: false,
        delayMs: 0,
        attempt: 0,
        reason: classified.reason,
        action: 'abort',
      };
    }
    
    const state = this._attempts.get(key);
    const attempt = state ? state.count : 1;
    const delayMs = this.getDelay(classified.reason, attempt - 1, classified.retryAfterMs);
    const recoveryAction = getRecoveryAction(classified);
    
    return {
      shouldRetry: true,
      delayMs,
      attempt,
      reason: classified.reason,
      action: recoveryAction.action,
      description: recoveryAction.description,
    };
  }

  canRetry(key, reason) {
    if (!this._attempts.has(key)) {
      this._attempts.set(key, { count: 0, firstAttempt: Date.now(), reason });
    }
    const state = this._attempts.get(key);
    state.count++;
    if (state.count > this.maxRetries) {
      return false;
    }
    if (!this._isRetryable(reason)) {
      return false;
    }
    return true;
  }

  _isRetryable(reason) {
    const nonRetryable = new Set([
      FailoverReason.AUTH_PERMANENT,
      FailoverReason.BILLING,
      FailoverReason.MODEL_NOT_FOUND,
      FailoverReason.FORMAT_ERROR,
      FailoverReason.CONTENT_POLICY_BLOCKED,
      FailoverReason.PROVIDER_POLICY_BLOCKED,
    ]);
    return !nonRetryable.has(reason);
  }

  setProviderCooldown(provider, durationMs) {
    this._providerCooldowns.set(provider, Date.now() + durationMs);
  }

  isProviderCoolingDown(provider) {
    const cooldown = this._providerCooldowns.get(provider);
    if (!cooldown) return false;
    if (Date.now() >= cooldown) {
      this._providerCooldowns.delete(provider);
      return false;
    }
    return true;
  }

  getProviderCooldownRemaining(provider) {
    const cooldown = this._providerCooldowns.get(provider);
    if (!cooldown) return 0;
    return Math.max(0, cooldown - Date.now());
  }

  reset(key) {
    this._attempts.delete(key);
  }

  resetAll() {
    this._attempts.clear();
    this._providerCooldowns.clear();
  }

  getAttemptCount(key) {
    const state = this._attempts.get(key);
    return state ? state.count : 0;
  }
}

class FailoverChain {
  constructor(config = {}) {
    this.providers = config.providers || [];
    this.models = config.models || [];
    this.scheduler = config.scheduler || new RetryScheduler(config);
    this.currentIndex = 0;
    this._failoverHistory = [];
  }

  getNextProvider(currentProvider, reason) {
    this._failoverHistory.push({
      provider: currentProvider,
      reason,
      timestamp: Date.now(),
    });

    if (this._failoverHistory.length > 100) {
      this._failoverHistory = this._failoverHistory.slice(-50);
    }

    const availableProviders = this.providers.filter(p => {
      if (p === currentProvider) return false;
      return !this.scheduler.isProviderCoolingDown(p);
    });

    if (availableProviders.length === 0) {
      return null;
    }

    if (reason === FailoverReason.RATE_LIMIT || reason === FailoverReason.OVERLOADED) {
      this.scheduler.setProviderCooldown(currentProvider, 30000);
    }

    if (reason === FailoverReason.BILLING || reason === FailoverReason.AUTH) {
      this.scheduler.setProviderCooldown(currentProvider, 300000);
    }

    return availableProviders[this.currentIndex++ % availableProviders.length];
  }

  getNextModel(currentModel, _reason) {
    const currentIdx = this.models.indexOf(currentModel);
    if (currentIdx === -1 || this.models.length <= 1) {
      return this.models[0] || currentModel;
    }
    const nextIdx = (currentIdx + 1) % this.models.length;
    return this.models[nextIdx];
  }

  getHistory() {
    return [...this._failoverHistory];
  }
}

module.exports = {
  FailoverReason,
  classifyApiError,
  getRecoveryAction,
  RetryScheduler,
  FailoverChain,
  BILLING_PATTERNS,
  RATE_LIMIT_PATTERNS,
  CONTEXT_OVERFLOW_PATTERNS,
  MODEL_NOT_FOUND_PATTERNS,
  AUTH_PATTERNS,
};
