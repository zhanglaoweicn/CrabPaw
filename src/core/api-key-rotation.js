const { DATA_DIR } = require('./config');

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /throttl/i,
  /quota.?exceeded/i,
  /429/,
];

const AUTH_ERROR_PATTERNS = [
  /invalid.?api.?key/i,
  /unauthorized/i,
  /authentication.?fail/i,
  /401/,
];

const SERVER_ERROR_PATTERNS = [
  /internal.?server.?error/i,
  /service.?unavailable/i,
  /bad.?gateway/i,
  /gateway.?timeout/i,
  /50[023]/,
];

function isRateLimitError(message) {
  if (!message) return false;
  return RATE_LIMIT_PATTERNS.some(p => p.test(message));
}

function isAuthError(message) {
  if (!message) return false;
  return AUTH_ERROR_PATTERNS.some(p => p.test(message));
}

function isServerError(message) {
  if (!message) return false;
  return SERVER_ERROR_PATTERNS.some(p => p.test(message));
}

function formatErrorMessage(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function dedupeApiKeys(raw) {
  const seen = new Set();
  const keys = [];
  for (const value of raw) {
    const apiKey = (value || '').trim();
    if (!apiKey || seen.has(apiKey)) continue;
    seen.add(apiKey);
    keys.push(apiKey);
  }
  return keys;
}

function collectProviderApiKeys(provider) {
  const keys = [];

  const envMappings = {
    deepseek: ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY'],
    qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'ALIBABA_API_KEY'],
    glm: ['GLM_API_KEY', 'ZHIPU_API_KEY'],
    moonshot: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
    yi: ['YI_API_KEY', 'LINGYI_API_KEY'],
    baichuan: ['BAICHUAN_API_KEY'],
    minimax: ['MINIMAX_API_KEY'],
    spark: ['SPARK_API_KEY'],
    doubao: ['DOUBAO_API_KEY', 'VOLCENGINE_API_KEY'],
  };

  const envKeys = envMappings[provider] || [];
  for (const envKey of envKeys) {
    const val = process.env[envKey];
    if (val && val.trim()) {
      keys.push(val.trim());
    }
  }

  try {
    const fs = require('fs');
    const path = require('path');
    const keysPath = path.join(DATA_DIR, '.api_keys.json');
    if (fs.existsSync(keysPath)) {
      const data = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
      if (data[provider]) {
        if (typeof data[provider] === 'string') {
          keys.push(data[provider]);
        } else if (data[provider].apiKey) {
          keys.push(data[provider].apiKey);
        } else if (Array.isArray(data[provider].keys)) {
          keys.push(...data[provider].keys);
        }
      }
      if (data.extraKeys && Array.isArray(data.extraKeys[provider])) {
        keys.push(...data.extraKeys[provider]);
      }
    }
  } catch { console.warn('[api-key-rotation] 加载 API 密钥文件失败'); }

  return keys;
}

function collectProviderApiKeysForExecution(params) {
  const { primaryApiKey, provider } = params;
  return dedupeApiKeys([primaryApiKey?.trim() ?? '', ...collectProviderApiKeys(provider)]);
}

async function executeWithApiKeyRotation(params) {
  const keys = dedupeApiKeys(params.apiKeys);
  if (keys.length === 0) {
    throw new Error(`未配置 "${params.provider}" 的 API 密钥。请在设置中配置。`);
  }

  let lastError = null;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const apiKey = keys[attempt];
    try {
      return await params.execute(apiKey);
    } catch (error) {
      lastError = error;
      const message = formatErrorMessage(error);

      const retryable = params.shouldRetry
        ? params.shouldRetry({ apiKey, error, attempt, message })
        : isRateLimitError(message);

      if (!retryable || attempt + 1 >= keys.length) {
        break;
      }

      params.onRetry?.({ apiKey, error, attempt, message });
    }
  }

  if (lastError === undefined) {
    throw new Error(`${params.provider} 的 API 请求执行失败。`);
  }
  throw lastError;
}

class ApiKeyRotationManager {
  constructor() {
    this._keyStats = new Map();
    this._cooldownUntil = new Map();
  }

  recordKeyUsage(provider, keySuffix, success) {
    const key = `${provider}:${keySuffix}`;
    const stats = this._keyStats.get(key) || { success: 0, failure: 0, lastUsed: 0, lastError: null };
    if (success) {
      stats.success++;
    } else {
      stats.failure++;
    }
    stats.lastUsed = Date.now();
    this._keyStats.set(key, stats);
  }

  setCooldown(provider, keySuffix, durationMs) {
    const key = `${provider}:${keySuffix}`;
    this._cooldownUntil.set(key, Date.now() + durationMs);
  }

  isCoolingDown(provider, keySuffix) {
    const key = `${provider}:${keySuffix}`;
    const until = this._cooldownUntil.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
      this._cooldownUntil.delete(key);
      return false;
    }
    return true;
  }

  getAvailableKeys(provider, primaryApiKey) {
    const allKeys = collectProviderApiKeysForExecution({ primaryApiKey, provider });
    return allKeys.filter(key => {
      const suffix = key.slice(-8);
      return !this.isCoolingDown(provider, suffix);
    });
  }

  getStats() {
    const result = {};
    for (const [key, stats] of this._keyStats) {
      result[key] = { ...stats };
    }
    return result;
  }
}

const globalKeyRotationManager = new ApiKeyRotationManager();

module.exports = {
  ApiKeyRotationManager,
  globalKeyRotationManager,
  executeWithApiKeyRotation,
  collectProviderApiKeysForExecution,
  collectProviderApiKeys,
  dedupeApiKeys,
  isRateLimitError,
  isAuthError,
  isServerError,
  formatErrorMessage,
};
