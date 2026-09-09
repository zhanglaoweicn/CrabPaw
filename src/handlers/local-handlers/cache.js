// cache.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { sendJson } = require('../http-utils');

async function handleCacheStats(req, res, _ctx) {
  const caches = {};
  try {
    const { contextCache } = require('../../core/context-cache');
    caches.context = contextCache.getStats();
  } catch (e) {
    /* cache module optional */
    console.warn('[cache.js] 空 catch 补日志:', e && e.message);
  }

  try {
    const { getPersonalizationCache } = require('../../core/personalization-cache');
    caches.personalization = getPersonalizationCache().getStats();
  } catch (e) {
    /* cache module optional */
    console.warn('[cache.js] 空 catch 补日志:', e && e.message);
  }

  try {
    const { getCrossSessionPromptCache } = require('../../core/cross-session-prompt-cache');
    caches.crossSessionPrompt = getCrossSessionPromptCache().getStats();
  } catch (e) {
    /* cache module optional */
    console.warn('[cache.js] 空 catch 补日志:', e && e.message);
  }

  try {
    const { getSkillSnapshotCache } = require('../../core/skill-snapshot-cache');
    caches.skillSnapshot = getSkillSnapshotCache().getStats();
  } catch (e) {
    /* cache module optional */
    console.warn('[cache.js] 空 catch 补日志:', e && e.message);
  }

  try {
    const stickerCache = require('../../core/sticker-cache');
    caches.sticker = stickerCache.getStats();
  } catch (e) {
    /* cache module optional */
    console.warn('[cache.js] 空 catch 补日志:', e && e.message);
  }

  try {
    const { getLLMCacheStats } = require('../../core/caching/prompt-cache');
    caches.llmPromptCache = getLLMCacheStats();
  } catch (e) {
    /* cache module optional */
    console.warn('[cache.js] 空 catch 补日志:', e && e.message);
  }

  return sendJson(res, 200, { success: true, caches });
}

async function handleCacheReset(req, res, _ctx) {
  try {
    const results = {};

    try {
      const { getToolResultCache } = require('../../core/tool-result-cache');
      getToolResultCache().resetStats();
      results.toolResult = 'ok';
    } catch (e) { results.toolResult = e.message; }

    try {
      const { contextCache } = require('../../core/context-cache');
      contextCache.resetStats();
      results.context = 'ok';
    } catch (e) { results.context = e.message; }

    try {
      const { getPersonalizationCache } = require('../../core/personalization-cache');
      getPersonalizationCache().resetStats();
      results.personalization = 'ok';
    } catch (e) { results.personalization = e.message; }

    try {
      const { getCrossSessionPromptCache } = require('../../core/cross-session-prompt-cache');
      getCrossSessionPromptCache().resetStats();
      results.crossSessionPrompt = 'ok';
    } catch (e) { results.crossSessionPrompt = e.message; }

    try {
      const { getSkillSnapshotCache } = require('../../core/skill-snapshot-cache');
      getSkillSnapshotCache().resetStats();
      results.skillSnapshot = 'ok';
    } catch (e) { results.skillSnapshot = e.message; }

    try {
      const stickerCache = require('../../core/sticker-cache');
      stickerCache.resetStats();
      results.sticker = 'ok';
    } catch (e) { results.sticker = e.message; }

    try {
      const { resetLLMCacheStats } = require('../../core/caching/prompt-cache');
      resetLLMCacheStats();
      results.llmPromptCache = 'ok';
    } catch (e) { results.llmPromptCache = e.message; }

    sendJson(res, 200, { success: true, results });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

module.exports = {
  handleCacheStats,
  handleCacheReset,
};
