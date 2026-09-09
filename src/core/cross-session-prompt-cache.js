const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { atomicWriteFile, atomicReadJSON } = require('./atomic-write');
const { createCacheStats } = require('./caching/cache-stats');

const CROSS_SESSION_CACHE_DIR = path.join(DATA_DIR, 'prompt-cache');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h：跨会话提示缓存，延长 TTL 提升跨会话命中率
const MAX_CACHE_ENTRIES = 200; // 扩大容量，容纳更多会话的提示缓存

class CrossSessionPromptCache {
  constructor(config = {}) {
    this.cacheDir = config.cacheDir || CROSS_SESSION_CACHE_DIR;
    this.ttlMs = config.ttlMs || CACHE_TTL_MS;
    this.maxEntries = config.maxEntries || MAX_CACHE_ENTRIES;
    this._memoryCache = new Map();
    this._initialized = false;
    this._stats = createCacheStats('crossSessionPrompt');
  }

  _ensureDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  _hashKey(key) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  }

  _getCachePath(hashedKey) {
    return path.join(this.cacheDir, `${hashedKey}.json`);
  }

  get(key) {
    const memEntry = this._memoryCache.get(key);
    if (memEntry && Date.now() - memEntry.cachedAt < this.ttlMs) {
      this._stats.hit();
      return memEntry.value;
    }

    this._ensureDir();
    const hashedKey = this._hashKey(key);
    const cachePath = this._getCachePath(hashedKey);

    try {
      if (!fs.existsSync(cachePath)) {
        this._stats.miss();
        return null;
      }
      const entry = atomicReadJSON(cachePath);
      if (!entry || Date.now() - entry.cachedAt > this.ttlMs) {
        try { fs.unlinkSync(cachePath); } catch { console.warn('[cross-session-prompt-cache] 删除过期缓存文件失败'); }
        this._stats.miss();
        this._stats.evict();
        return null;
      }
      this._memoryCache.set(key, entry);
      this._stats.hit();
      return entry.value;
    } catch {
      this._stats.miss();
      return null;
    }
  }

  set(key, value) {
    const entry = {
      key,
      value,
      cachedAt: Date.now(),
    };

    this._memoryCache.set(key, entry);

    this._ensureDir();
    const hashedKey = this._hashKey(key);
    const cachePath = this._getCachePath(hashedKey);

    try {
      atomicWriteFile(cachePath, JSON.stringify(entry), 'utf-8');
    } catch { console.warn('[cross-session-prompt-cache] 写入缓存文件失败'); }

    this._evictIfNeeded();
  }

  _evictIfNeeded() {
    this._ensureDir();
    try {
      const files = fs.readdirSync(this.cacheDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(this.cacheDir, f),
          mtime: fs.statSync(path.join(this.cacheDir, f)).mtimeMs,
        }))
        .sort((a, b) => a.mtime - b.mtime);

      if (files.length > this.maxEntries) {
        const toRemove = files.slice(0, files.length - this.maxEntries);
        for (const file of toRemove) {
          try { fs.unlinkSync(file.path); } catch { console.warn('[cross-session-prompt-cache] 删除超出容量限制的缓存文件失败'); }
        }
      }

      const now = Date.now();
      for (const file of files) {
        if (now - file.mtime > this.ttlMs) {
          try { fs.unlinkSync(file.path); } catch { console.warn('[cross-session-prompt-cache] 删除过期缓存文件失败'); }
        }
      }
    } catch { console.warn('[cross-session-prompt-cache] 清理缓存目录失败'); }
  }

  invalidate(key) {
    this._memoryCache.delete(key);
    this._ensureDir();
    const hashedKey = this._hashKey(key);
    const cachePath = this._getCachePath(hashedKey);
    try {
      if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    } catch { console.warn('[cross-session-prompt-cache] 失效缓存文件删除失败'); }
  }

  clear() {
    this._memoryCache.clear();
    this._ensureDir();
    try {
      const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try { fs.unlinkSync(path.join(this.cacheDir, f)); } catch { console.warn('[cross-session-prompt-cache] 清空缓存时删除文件失败'); }
      }
    } catch { console.warn('[cross-session-prompt-cache] 读取缓存目录失败'); }
  }

  getStats() {
    let diskCount = 0;
    let diskSize = 0;
    this._ensureDir();
    try {
      const files = fs.readdirSync(this.cacheDir).filter(f => f.endsWith('.json'));
      diskCount = files.length;
      for (const f of files) {
        try { diskSize += fs.statSync(path.join(this.cacheDir, f)).size; } catch { console.warn('[cross-session-prompt-cache] 统计缓存大小时读取文件失败'); }
      }
    } catch { console.warn('[cross-session-prompt-cache] 获取缓存统计信息失败'); }
    return this._stats.getStats({
      memoryEntries: this._memoryCache.size,
      diskEntries: diskCount,
      diskSizeBytes: diskSize,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
    });
  }

  resetStats() {
    this._stats.resetStats();
  }
}

let _instance = null;

function getCrossSessionPromptCache(config) {
  if (!_instance) {
    _instance = new CrossSessionPromptCache(config);
  }
  return _instance;
}

module.exports = { CrossSessionPromptCache, getCrossSessionPromptCache };
