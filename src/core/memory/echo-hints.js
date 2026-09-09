/**
 * EchoHints — 记忆回响
 *
 * 回复生成前检索相关记忆，产出"自然引用"提示块注入 LLM：
 * 例如"按您上个月定的预算方向，这个方案压到 12 万"。
 *
 * 检索策略：
 *   1) unified-memory（四路并行：FTS + 向量 + 图谱 + enhanced）
 *   2) autoMemory.search（降级）
 */

const ECHO_MAX = 3;

/**
 * 构建回响提示块。
 * @param {string} query - 用户当前查询
 * @param {Array<{id, content}>} relatedMemories - 已检索的相关记忆
 * @returns {{ hints: Array<{memoryId, snippet, rel}>, promptBlock: string }}
 */
function buildEchoHints(query, relatedMemories) {
  const list = (Array.isArray(relatedMemories) ? relatedMemories : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(0, ECHO_MAX);
  if (list.length === 0) return { hints: [], promptBlock: '' };
  const hints = list.map((m) => ({ memoryId: m.id, snippet: m.content.slice(0, 80), rel: 1 }));
  const lines = hints.map((h, i) => `- 相关记忆${i + 1}（可自然引用，勿编造细节）: ${h.snippet}`);
  const block = `【记忆回响——可引用但不臆造】\n${lines.join('\n')}\n`;
  return { hints, promptBlock: block };
}

/**
 * 检索与查询相关的历史记忆。
 * 优先 unified-memory（四路并行），降级 autoMemory FTS。
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Array>} 相关记忆数组（失败时降级为空数组）
 */
async function getRelatedMemories(query, { limit = 3 } = {}) {
  // 1) 优先 unified-memory（unified-memory.js 导出 getUnifiedMemories）
  try {
    const { getUnifiedMemories } = require('../unified-memory');
    if (typeof getUnifiedMemories === 'function') {
      const { results } = await getUnifiedMemories('default', query, { limit });
      if (Array.isArray(results) && results.length) return results;
    }
  } catch (e) {
    console.warn('[echo-hints] unified-memory 不可用:', e.message || e);
  }

  // 2) 降级 autoMemory.search
  try {
    const { memoryManager } = require('../memory-system');
    const auto = memoryManager && memoryManager.autoMemory;
    if (auto && typeof auto.search === 'function') {
      const res = auto.search(query, limit);
      if (Array.isArray(res) && res.length) return res;
    }
  } catch (e) {
    console.warn('[echo-hints] autoMemory 降级失败:', e.message || e);
  }

  return [];
}

module.exports = { buildEchoHints, getRelatedMemories };
