/**
 * Cache Stats - 缓存统计工具模块
 *
 * 提供纯函数式统计工具，供各缓存类使用。
 * 不使用继承/混入，避免侵入性。
 *
 * 用法：
 *   const { createCacheStats, computeHitRate } = require('./caching/cache-stats');
 *   this._stats = createCacheStats('toolResult');
 *   this._stats.hit();
 *   this._stats.miss();
 *   this._stats.evict();
 *   this._stats.getStats({ size: this._cache.size, maxEntries: this._maxEntries });
 */

/**
 * 创建一个缓存统计计数器
 * @param {string} name 缓存名称（用于标识）
 * @returns {{hit:Function, miss:Function, evict:Function, getStats:Function, resetStats:Function, recordLLMCache:Function}}
 */
function createCacheStats(name) {
  let _hits = 0;
  let _misses = 0;
  let _evictions = 0;
  // LLM 服务端缓存专用（prompt-cache 使用）
  let _llmCacheHits = 0;
  let _llmCacheMisses = 0;
  let _llmCachedTokens = 0;
  let _llmTotalTokens = 0;

  return {
    hit() { _hits++; },
    miss() { _misses++; },
    evict() { _evictions++; },

    /**
     * 记录 LLM 服务端缓存命中（来自 LLM API 响应的 prompt_cache_hit_tokens）
     * @param {number} hitTokens 命中 token 数
     * @param {number} missTokens 未命中 token 数
     */
    recordLLMCache(hitTokens = 0, missTokens = 0) {
      if (hitTokens > 0) {
        _llmCacheHits++;
        _llmCachedTokens += hitTokens;
      }
      if (missTokens > 0) {
        _llmCacheMisses++;
      }
      _llmTotalTokens += hitTokens + missTokens;
    },

    /**
     * 获取统计快照
     * @param {object} extra 额外字段（如 size, maxEntries, ttlMs）
     * @returns {object} 统计对象
     */
    getStats(extra = {}) {
      const total = _hits + _misses;
      const llmTotal = _llmCacheHits + _llmCacheMisses;
      const stats = {
        name,
        hits: _hits,
        misses: _misses,
        hitRate: total > 0 ? +((_hits / total) * 100).toFixed(1) : 0,
        evictions: _evictions,
        totalRequests: total,
      };
      // LLM 缓存字段（仅当有数据时才输出，避免普通缓存输出无关字段）
      if (_llmTotalTokens > 0 || _llmCacheHits > 0 || _llmCacheMisses > 0) {
        stats.llmCacheHits = _llmCacheHits;
        stats.llmCacheMisses = _llmCacheMisses;
        stats.llmHitRate = llmTotal > 0 ? +((_llmCacheHits / llmTotal) * 100).toFixed(1) : 0;
        stats.llmCachedTokens = _llmCachedTokens;
        stats.llmTotalTokens = _llmTotalTokens;
        stats.llmCacheRatio = _llmTotalTokens > 0 ? +((_llmCachedTokens / _llmTotalTokens) * 100).toFixed(1) : 0;
      }
      return { ...stats, ...extra };
    },

    resetStats() {
      _hits = 0;
      _misses = 0;
      _evictions = 0;
      _llmCacheHits = 0;
      _llmCacheMisses = 0;
      _llmCachedTokens = 0;
      _llmTotalTokens = 0;
    },
  };
}

/**
 * 计算命中率的纯函数（用于多分项统计，如 context-cache 的 skills/toolDefs/prompt/history）
 * @param {number} hits
 * @param {number} misses
 * @returns {{hits:number, misses:number, hitRate:number, totalRequests:number}}
 */
function computeHitRate(hits, misses) {
  const total = hits + misses;
  return {
    hits,
    misses,
    hitRate: total > 0 ? +((hits / total) * 100).toFixed(1) : 0,
    totalRequests: total,
  };
}

/**
 * 创建多分项统计计数器（用于 context-cache 这类有多个子缓存的场景）
 * @param {string} name
 * @param {string[]} keys 子项名称列表，如 ['skills', 'toolDefs', 'prompt', 'history']
 * @returns {{hit:Function, miss:Function, evict:Function, getStats:Function, resetStats:Function}}
 */
function createMultiCacheStats(name, keys) {
  const counters = {};
  for (const k of keys) {
    counters[k] = { hits: 0, misses: 0, evictions: 0 };
  }

  return {
    hit(key) { if (counters[key]) counters[key].hits++; },
    miss(key) { if (counters[key]) counters[key].misses++; },
    evict(key) { if (counters[key]) counters[key].evictions++; },

    getStats(extra = {}) {
      const result = { name };
      for (const k of keys) {
        result[k] = computeHitRate(counters[k].hits, counters[k].misses);
        if (counters[k].evictions > 0) {
          result[k].evictions = counters[k].evictions;
        }
      }
      return { ...result, ...extra };
    },

    resetStats() {
      for (const k of keys) {
        counters[k].hits = 0;
        counters[k].misses = 0;
        counters[k].evictions = 0;
      }
    },

    /** 获取原始计数器（用于特殊场景） */
    _getCounter(key) { return counters[key]; },
  };
}

module.exports = {
  createCacheStats,
  createMultiCacheStats,
  computeHitRate,
};
