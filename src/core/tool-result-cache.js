const crypto = require('crypto');
const { getCrabPawSubDir } = require('./path-utils');
const { createCacheStats } = require('./caching/cache-stats');

const CACHEABLE_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch',
  'GlobSearch', 'FileSearch', 'ListFiles',
]);

const NON_CACHEABLE_PATTERNS = [
  /write/i, /edit/i, /delete/i, /create/i, /mkdir/i, /bash/i, /exec/i, /run/i,
  /move/i, /copy/i, /rename/i, /patch/i, /update/i, /remove/i,
];

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15min：工具结果（文件读取/搜索/网页抓取）通常稳定，延长 TTL 提升命中率
const DEFAULT_MAX_ENTRIES = 500; // 扩大容量，减少 LRU 驱逐导致的未命中
const DEFAULT_MAX_KEY_SIZE = 2048;

function _isCacheable(toolName, args) {
  if (!CACHEABLE_TOOLS.has(toolName)) return false;
  for (const pat of NON_CACHEABLE_PATTERNS) {
    if (pat.test(toolName)) return false;
  }
  if (args && typeof args === 'string') {
    try { args = JSON.parse(args); } catch { console.warn('[tool-result-cache] silent catch, error swallowed'); }
  }
  if (args && args._noCache) return false;
  return true;
}

function _makeCacheKey(toolName, args) {
  let argsStr = '';
  if (args) {
    argsStr = typeof args === 'string' ? args : JSON.stringify(args);
  }
  if (argsStr.length > DEFAULT_MAX_KEY_SIZE) {
    argsStr = argsStr.slice(0, DEFAULT_MAX_KEY_SIZE);
  }
  const hash = crypto.createHash('sha256').update(`${toolName}:${argsStr}`).digest('hex').slice(0, 16);
  return `${toolName}:${hash}`;
}

class ToolResultCache {
  constructor(opts = {}) {
    this._cache = new Map();
    this._ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this._maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
    this._stats = createCacheStats('toolResult');
    this._storePath = opts.storePath || null;
    this._dirty = false;
    this._persistTimer = null;

    if (opts.persist) {
      this._storePath = this._storePath || require('path').join(getCrabPawSubDir('cache'), 'tool-results.json');
      this._loadFromDisk();
      this._persistTimer = setInterval(() => this._persistToDisk(), 30000);
      this._persistTimer.unref();
    }
  }

  get(toolName, args) {
    if (!_isCacheable(toolName, args)) return null;

    const key = _makeCacheKey(toolName, args);
    const entry = this._cache.get(key);
    if (!entry) {
      this._stats.miss();
      return null;
    }

    if (Date.now() - entry.timestamp > this._ttlMs) {
      this._cache.delete(key);
      this._stats.miss();
      this._stats.evict();
      return null;
    }

    this._stats.hit();
    return { ...entry.result, _fromCache: true };
  }

  set(toolName, args, result) {
    if (!_isCacheable(toolName, args)) return;
    if (result && result.success === false) return;

    const key = _makeCacheKey(toolName, args);

    if (this._cache.size >= this._maxEntries) {
      this._evictOldest();
    }

    this._cache.set(key, {
      toolName,
      args: this._serializeResult(args), // 2026-08-01: 保存参数供 invalidateByPath 匹配路径
      result: this._serializeResult(result),
      timestamp: Date.now(),
    });
    this._dirty = true;
  }

  invalidate(toolName, args) {
    if (args) {
      const key = _makeCacheKey(toolName, args);
      this._cache.delete(key);
    } else {
      for (const [key, entry] of this._cache) {
        if (entry.toolName === toolName) {
          this._cache.delete(key);
        }
      }
    }
    this._dirty = true;
  }

  invalidateByPath(filePath) {
    if (!filePath) return;
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    for (const [key, entry] of this._cache) {
      // BUG FIX: 此前只匹配 result 内容（结果常不含路径，失效永不命中）。
      // 现在同时匹配保存的参数（file_path/filePath 字段）。
      const argsStr = entry.args ? JSON.stringify(entry.args).toLowerCase() : '';
      const resultStr = JSON.stringify(entry.result).toLowerCase();
      if (argsStr.includes(normalized) || resultStr.includes(normalized)) {
        this._cache.delete(key);
      }
    }
    this._dirty = true;
  }

  clear() {
    this._cache.clear();
    this._stats.resetStats();
    this._dirty = true;
  }

  getStats() {
    return this._stats.getStats({
      size: this._cache.size,
      maxEntries: this._maxEntries,
      ttlMs: this._ttlMs,
    });
  }

  resetStats() {
    this._stats.resetStats();
  }

  _serializeResult(result) {
    if (!result) return null;
    if (typeof result === 'string') return { content: result };
    if (result.content && typeof result.content === 'string' && result.content.length > 50000) {
      return {
        ...result,
        content: result.content.slice(0, 50000) + '\n... [缓存截断: 原始结果过大]',
        _truncated: true,
      };
    }
    return result;
  }

  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, entry] of this._cache) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._cache.delete(oldestKey);
      this._stats.evict();
    }
  }

  _loadFromDisk() {
    if (!this._storePath) return;
    try {
      const fs = require('fs');
      if (!fs.existsSync(this._storePath)) return;
      const data = JSON.parse(fs.readFileSync(this._storePath, 'utf-8'));
      const now = Date.now();
      for (const [key, entry] of Object.entries(data)) {
        if (now - entry.timestamp < this._ttlMs) {
          this._cache.set(key, entry);
        }
      }
    } catch { console.warn('[tool-result-cache] silent catch, error swallowed'); }
  }

  _persistToDisk() {
    if (!this._storePath || !this._dirty) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const { atomicWriteJSON } = require('./atomic-write');
      const dir = path.dirname(this._storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this._cache);
      atomicWriteJSON(this._storePath, data);
      this._dirty = false;
    } catch { console.warn('[tool-result-cache] silent catch, error swallowed'); }
  }

  destroy() {
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    this._persistToDisk();
  }
}

let _instance = null;

function getToolResultCache(opts) {
  if (!_instance) {
    _instance = new ToolResultCache(opts);
  }
  return _instance;
}

module.exports = {
  ToolResultCache,
  getToolResultCache,
  _isCacheable,
  _makeCacheKey,
  CACHEABLE_TOOLS,
};
