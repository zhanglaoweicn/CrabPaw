/**
 * Memory Timeline — 记忆时间线构建器（双 Handler 共享）
 *
 * 统一 /api/memory/timeline 的数据来源，替代 Express/CLI 两套重复实现：
 * - unified-store memories（提取事实，持久化）
 * - memoryManager notes（笔记）
 * - unified-store documents（对话，补充）
 *
 * 返回条目统一结构：{ id, content, type, timestamp(ms), category, entities }
 */

const { getUnifiedStore } = require('./unified-store');

function parseJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function buildMemoryTimeline(limit = 100) {
  const entries = [];
  const seenIds = new Set();

  const push = (entry) => {
    if (!entry || !entry.id || seenIds.has(entry.id)) return;
    seenIds.add(entry.id);
    entries.push(entry);
  };

  // 1. unified-store memories（提取事实，持久化主库）
  try {
    const store = getUnifiedStore();
    if (store && typeof store.all === 'function') {
      const rows = store.all(
        `SELECT id, title, content, type, tags, importance, created_at, updated_at
         FROM memories
         WHERE content IS NOT NULL AND length(content) > 0
         ORDER BY updated_at DESC LIMIT ?`,
        [Math.max(limit, 50)]
      );
      for (const r of rows) {
        push({
          id: r.id,
          content: r.content || r.title || '',
          type: r.type || 'memory',
          timestamp: (r.updated_at || r.created_at || 0) * 1000,
          category: r.type || 'memory',
          entities: parseJson(r.tags),
          importance: r.importance,
        });
      }
    }
  } catch (e) {
    console.warn('[timeline] unified-store memories failed:', e.message);
  }

  // 2. memoryManager notes（笔记/用户手动记录）
  try {
    const { memoryManager } = require('../memory-system');
    const notes = memoryManager.getNotes();
    for (const n of notes) {
      push({
        id: n.id,
        content: n.content || n.title || '',
        type: n.type || 'note',
        timestamp: n.updated || n.created || Date.now(),
        category: n.category || n.type || 'note',
        entities: n.tags || [],
        importance: n.importance,
      });
    }
  } catch (e) {
    console.warn('[timeline] notes failed:', e.message);
  }

  // 3. unified-store documents（对话补充，最多补 1/4 配额）
  try {
    const store = getUnifiedStore();
    if (store && typeof store.all === 'function') {
      const rows = store.all(
        `SELECT id, title, content, metadata, created_at
         FROM documents
         WHERE content IS NOT NULL AND length(content) > 0
         ORDER BY created_at DESC LIMIT ?`,
        [Math.max(Math.floor(limit / 4), 20)]
      );
      for (const r of rows) {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (e) {
          /* ignore */
          console.warn('[timeline.js] 空 catch 补日志:', e && e.message);
        }

        push({
          id: `doc_${r.id}`,
          content: String(r.content || '').slice(0, 200),
          type: meta.role === 'user' ? 'message_user' : 'message',
          timestamp: (r.created_at || 0) * 1000,
          category: 'conversation',
          entities: [],
        });
      }
    }
  } catch (e) {
    console.warn('[timeline] documents failed:', e.message);
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, limit);
}

module.exports = { buildMemoryTimeline };
