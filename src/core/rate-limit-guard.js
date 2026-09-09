const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { atomicWriteFile, atomicReadJSON } = require('./atomic-write');

const RATE_LIMIT_DIR = path.join(DATA_DIR, 'rate_limits');
const STATE_FILE = path.join(RATE_LIMIT_DIR, 'providers.json');
const LOCK_FILE = path.join(RATE_LIMIT_DIR, 'providers.lock');

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const STALE_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

let _state = null;
let _lastLoad = 0;
const LOAD_INTERVAL_MS = 5000;

function _ensureDir() {
  if (!fs.existsSync(RATE_LIMIT_DIR)) {
    fs.mkdirSync(RATE_LIMIT_DIR, { recursive: true });
  }
}

function _acquireLock(timeoutMs = 3000) {
  _ensureDir();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, `${process.pid}\n${Date.now()}`);
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 5000) {
          try { fs.unlinkSync(LOCK_FILE); } catch { console.warn('[rate-limit-guard] silent catch, error swallowed'); }
        }
      } catch { console.warn('[rate-limit-guard] silent catch, error swallowed'); }
      // 使用 Atomics.wait 实现短暂等待，避- ?CPU 空转- ?execSync
      const remainMs = Math.min(50, timeoutMs - (Date.now() - start));
      if (remainMs > 0) {
        try {
          const buf = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(buf, 0, 0, remainMs);
        } catch {
          // SharedArrayBuffer 不可用时退化为忙等
          const spinEnd = Date.now() + remainMs;
          while (Date.now() < spinEnd) { /* noop */ }
        }
      }
    }
  }
  return false;
}

function _releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { console.warn('[rate-limit-guard] silent catch, error swallowed'); }
}

function _loadState() {
  const now = Date.now();
  if (_state && (now - _lastLoad) < LOAD_INTERVAL_MS) {
    return _state;
  }
  _ensureDir();
  const data = atomicReadJSON(STATE_FILE);
  _state = data && typeof data === 'object' ? data : {};
  _lastLoad = now;
  return _state;
}

function _saveState(state) {
  _ensureDir();
  if (!_acquireLock()) {
    console.error('[RateLimitGuard] 无法获取文件锁，跳过保存');
    return;
  }
  try {
    const now = Date.now();
    for (const [key, entry] of Object.entries(state)) {
      if (now >= entry.resetAt) {
        delete state[key];
      } else if (entry.limitedAt && now - entry.limitedAt > STALE_ENTRY_TTL_MS) {
        delete state[key];
      }
    }
    atomicWriteFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    _state = state;
    _lastLoad = Date.now();
  } catch (e) {
    console.error('[RateLimitGuard] 保存状态失败?', e.message);
  } finally {
    _releaseLock();
  }
}

function _parseResetSeconds(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const lowered = {};
  for (const [k, v] of Object.entries(headers)) {
    lowered[k.toLowerCase()] = v;
  }
  for (const key of [
    'x-ratelimit-reset-requests-1h',
    'x-ratelimit-reset-requests',
    'retry-after',
  ]) {
    const raw = lowered[key];
    if (raw != null) {
      const val = parseFloat(raw);
      if (val > 0) return val;
    }
  }
  return null;
}

function recordRateLimit({ provider, model, headers, errorCode, defaultCooldownMs }) {
  const state = _loadState();
  const resetSeconds = _parseResetSeconds(headers);
  const cooldown = (resetSeconds != null ? resetSeconds * 1000 : null) || defaultCooldownMs || DEFAULT_COOLDOWN_MS;
  const key = provider + (model ? ':' + model : '');
  state[key] = {
    provider,
    model: model || '',
    limitedAt: Date.now(),
    cooldownMs: cooldown,
    resetAt: Date.now() + cooldown,
    errorCode: errorCode || 429,
  };
  _saveState(state);
}

function isRateLimited({ provider, model }) {
  const state = _loadState();
  const key = provider + (model ? ':' + model : '');
  const entry = state[key];
  if (!entry) return { limited: false };
  if (Date.now() >= entry.resetAt) {
    delete state[key];
    _saveState(state);
    return { limited: false };
  }
  return {
    limited: true,
    resetAt: entry.resetAt,
    remainingMs: entry.resetAt - Date.now(),
    errorCode: entry.errorCode,
    provider: entry.provider,
    model: entry.model,
  };
}

function clearRateLimit({ provider, model }) {
  const state = _loadState();
  const key = provider + (model ? ':' + model : '');
  if (state[key]) {
    delete state[key];
    _saveState(state);
  }
}

function getAllRateLimits() {
  const state = _loadState();
  const now = Date.now();
  const active = {};
  for (const [key, entry] of Object.entries(state)) {
    if (now >= entry.resetAt) {
      delete state[key];
    } else {
      active[key] = {
        ...entry,
        remainingMs: entry.resetAt - now,
      };
    }
  }
  _saveState(state);
  return active;
}

function formatRateLimitStatus() {
  const limits = getAllRateLimits();
  const entries = Object.values(limits);
  if (entries.length === 0) return '- ?无速率限制';
  return entries.map(e => {
    const mins = Math.ceil(e.remainingMs / 60000);
    return `- ?${e.provider}${e.model ? '/' + e.model : ''} - ?冷却中，剩余 ${mins} 分钟`;
  }).join('\n');
}

function wrapApiCall({ provider, model, fn }) {
  const check = isRateLimited({ provider, model });
  if (check.limited) {
    const err = new Error(`${provider} 当前处于速率限制冷却中，剩余 ${Math.ceil(check.remainingMs / 60000)} 分钟`);
    err.code = 'RATE_LIMITED';
    err.rateLimitInfo = check;
    return Promise.reject(err);
  }
  return fn().catch(err => {
    if (err.status === 429 || err.statusCode === 429 || err.code === 429) {
      const headers = err.headers || err.response?.headers || {};
      recordRateLimit({ provider, model, headers, errorCode: 429 });
    }
    throw err;
  });
}

class RateLimitTracker {
  constructor(config = {}) {
    this._requestTimestamps = new Map();
    this._windowMs = config.windowMs || 60000;
    this._maxRequestsPerWindow = config.maxRequestsPerWindow || 60;
    this._maxTokensPerWindow = config.maxTokensPerWindow || 200000;
    this._tokenUsage = new Map();
  }

  recordRequest(provider, model, tokens = 0) {
    const key = `${provider}:${model || 'default'}`;
    const now = Date.now();

    if (!this._requestTimestamps.has(key)) {
      this._requestTimestamps.set(key, []);
    }
    this._requestTimestamps.get(key).push(now);

    if (!this._tokenUsage.has(key)) {
      this._tokenUsage.set(key, []);
    }
    if (tokens > 0) {
      this._tokenUsage.get(key).push({ timestamp: now, tokens });
    }

    this._cleanup(key);
  }

  _cleanup(key) {
    const now = Date.now();
    const cutoff = now - this._windowMs;

    const timestamps = this._requestTimestamps.get(key);
    if (timestamps) {
      const filtered = timestamps.filter(t => t > cutoff);
      this._requestTimestamps.set(key, filtered);
    }

    const tokenUsage = this._tokenUsage.get(key);
    if (tokenUsage) {
      const filtered = tokenUsage.filter(t => t.timestamp > cutoff);
      this._tokenUsage.set(key, filtered);
    }
  }

  getRequestCount(provider, model) {
    const key = `${provider}:${model || 'default'}`;
    this._cleanup(key);
    return (this._requestTimestamps.get(key) || []).length;
  }

  getTokenCount(provider, model) {
    const key = `${provider}:${model || 'default'}`;
    this._cleanup(key);
    const entries = this._tokenUsage.get(key) || [];
    return entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  isNearLimit(provider, model, threshold = 0.8) {
    const requestCount = this.getRequestCount(provider, model);
    const tokenCount = this.getTokenCount(provider, model);
    return requestCount >= this._maxRequestsPerWindow * threshold ||
           tokenCount >= this._maxTokensPerWindow * threshold;
  }

  getWaitTime(provider, model) {
    const key = `${provider}:${model || 'default'}`;
    const timestamps = this._requestTimestamps.get(key) || [];
    if (timestamps.length < this._maxRequestsPerWindow) return 0;

    const oldest = timestamps[0];
    const waitMs = oldest + this._windowMs - Date.now();
    return Math.max(0, waitMs);
  }

  getStats(provider, model) {
    return {
      requestCount: this.getRequestCount(provider, model),
      maxRequests: this._maxRequestsPerWindow,
      tokenCount: this.getTokenCount(provider, model),
      maxTokens: this._maxTokensPerWindow,
      nearLimit: this.isNearLimit(provider, model),
      waitTimeMs: this.getWaitTime(provider, model),
    };
  }

  reset(provider, model) {
    const key = `${provider}:${model || 'default'}`;
    this._requestTimestamps.delete(key);
    this._tokenUsage.delete(key);
  }

  resetAll() {
    this._requestTimestamps.clear();
    this._tokenUsage.clear();
  }
}

module.exports = {
  recordRateLimit,
  isRateLimited,
  clearRateLimit,
  getAllRateLimits,
  formatRateLimitStatus,
  wrapApiCall,
  RateLimitTracker,
};
