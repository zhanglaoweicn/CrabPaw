const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { createCacheStats } = require('./caching/cache-stats');

const CACHE_PATH = path.join(DATA_DIR, 'sticker_cache.json');

const STICKER_VISION_PROMPT = '用1-2句话描述这个表情包。重点关注它描绘的内容——角色、动作、情感。保持简洁客观。';

// 模块级统计计数器
const _stats = createCacheStats('sticker');

function _loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    }
  } catch { console.warn('[sticker-cache] silent catch, error swallowed'); }
  return {};
}

function _saveCache(cache) {
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = CACHE_PATH + '.tmp.' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    fs.renameSync(tmp, CACHE_PATH);
  } catch (e) {
    console.error('[StickerCache] 保存缓存失败:', e.message);
  }
}

function getCachedDescription(fileUniqueId) {
  const cache = _loadCache();
  const entry = cache[fileUniqueId];
  if (entry) {
    _stats.hit();
    return entry;
  }
  _stats.miss();
  return null;
}

function cacheStickerDescription(fileUniqueId, { description, emoji, setName }) {
  const cache = _loadCache();
  cache[fileUniqueId] = {
    description,
    emoji: emoji || '',
    setName: setName || '',
    cachedAt: Date.now(),
  };
  _saveCache(cache);
  return cache[fileUniqueId];
}

// eslint-disable-next-line no-unused-vars
function getOrAnalyzeSticker({ fileUniqueId, imageUrl, visionTool }) {
  const cached = getCachedDescription(fileUniqueId);
  if (cached) return cached;
  if (!visionTool) return null;
  return null;
}

function cleanOldEntries(maxAgeMs) {
  maxAgeMs = maxAgeMs || 30 * 24 * 60 * 60 * 1000;
  const cache = _loadCache();
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of Object.entries(cache)) {
    if (now - entry.cachedAt > maxAgeMs) {
      delete cache[key];
      cleaned++;
      _stats.evict();
    }
  }
  if (cleaned > 0) _saveCache(cache);
  return cleaned;
}

function getStats() {
  const cache = _loadCache();
  return _stats.getStats({
    entries: Object.keys(cache).length,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  });
}

function resetStats() {
  _stats.resetStats();
}

module.exports = {
  getCachedDescription,
  cacheStickerDescription,
  getOrAnalyzeSticker,
  cleanOldEntries,
  getStats,
  resetStats,
  STICKER_VISION_PROMPT,
};
