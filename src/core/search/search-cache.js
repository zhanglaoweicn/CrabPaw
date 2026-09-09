/**
 * Search Cache - LRU 缓存
 *
 * 自主实现，用于缓存搜索结果，避免短时间内重复请求。
 * Map 的插入顺序即 LRU 顺序；写入时若超量则淘汰最老一条。
 */

const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const SEARCH_CACHE_MAX = 200; // 最多缓存 200 条

const _cache = new Map();

/**
 * 从缓存中获取结果
 * @param {string} key 缓存键 (格式: `${query}::${limit}`)
 * @returns {object|null} 缓存的结果对象，过期或不存在返回 null
 */
function searchCacheGet(key) {
 const entry = _cache.get(key);
 if (!entry) return null;
 if (Date.now() - entry.fetchedAt >= SEARCH_CACHE_TTL_MS) {
 _cache.delete(key);
 return null;
 }
 // LRU 提升：删除再插入，让该条出现在 Map 尾部
 _cache.delete(key);
 _cache.set(key, entry);
 return entry.payload;
}

/**
 * 写入缓存
 * @param {string} key 缓存键
 * @param {object} payload 要缓存的结果对象
 */
function searchCacheSet(key, payload) {
 _cache.set(key, { payload, fetchedAt: Date.now() });
 // 淘汰最老条目（Map 的第一个键）
 while (_cache.size > SEARCH_CACHE_MAX) {
 const oldest = _cache.keys().next().value;
 if (oldest === undefined) break;
 _cache.delete(oldest);
 }
}

/**
 * 清空缓存
 */
function searchCacheClear() {
 _cache.clear();
}

/**
 * 获取缓存统计信息
 */
function searchCacheStats() {
 return { size: _cache.size, max: SEARCH_CACHE_MAX, ttlMs: SEARCH_CACHE_TTL_MS };
}

module.exports = {
 searchCacheGet,
 searchCacheSet,
 searchCacheClear,
 searchCacheStats,
};
