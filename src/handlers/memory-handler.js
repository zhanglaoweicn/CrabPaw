const { DEFAULT_PORT } = require('../core/config');
const { memoryManager } = require('../core/memory-system');

async function handleMemoryTags(req, res, ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');
  
  if (req.method === 'GET') {
    const tags = ctx.memoryTags.getTagList();
    return sendJson(res, 200, { success: true, data: { tags } });
  }

  if (req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const { id, tag } = data;
      const result = ctx.memoryTags.addTag(id, tag);
      return sendJson(res, result.success ? 200 : 400, result);
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const pathParts = url.pathname.split('/').filter(Boolean);
    const tagId = pathParts[pathParts.length - 1];
    if (!tagId || tagId === 'tags') {
      return sendError(res, 400, '缺少标签 ID');
    }

    const result = ctx.memoryTags.removeTag(tagId);
    return sendJson(res, result.success ? 200 : 400, result);
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleMemoryEntries(req, res, ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');
  
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const tag = url.searchParams.get('tag');
    const query = url.searchParams.get('query');
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    
    let entries;
    if (query) {
      entries = ctx.memoryEntries.searchEntries(query);
    } else if (tag) {
      entries = ctx.memoryEntries.getEntriesByTag(tag);
    } else {
      entries = ctx.memoryEntries.getRecentEntries(limit);
    }
    
    return sendJson(res, 200, { success: true, data: { entries } });
  }

  if (req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const { content, tags, metadata } = data;
      const result = ctx.memoryEntries.addEntry(content, tags, metadata);
      return sendJson(res, 200, result);
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  if (req.method === 'PUT') {
    try {
      const data = await readJsonBody(req);
      const { id, updates } = data;
      const result = ctx.memoryEntries.updateEntry(id, updates);
      return sendJson(res, result.success ? 200 : 404, result);
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
    const entryId = url.pathname.split('/').pop();
    
    const result = ctx.memoryEntries.removeEntry(entryId);
    return sendJson(res, result.success ? 200 : 404, result);
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleMemoryImportant(req, res, ctx) {
  const { sendJson } = require('./http-utils');
  
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  const threshold = parseInt(url.searchParams.get('threshold') || '5', 10);
  
  const entries = ctx.memoryEntries.getImportantEntries(threshold);
  
  return sendJson(res, 200, { success: true, data: { entries } });
}

async function handleMemoryStats(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');
  
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    // 2026-08-21: getStats() 已 async 化(修复 enhanced stats 恒 0), 调用点补 await
    const stats = await memoryManager.getStats();
    return sendJson(res, 200, { success: true, ...stats });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemoryNotes(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');
  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  
  if (req.method === 'GET') {
    try {
      const notes = memoryManager.getNotes();
      return sendJson(res, 200, { success: true, notes });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  if (req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const result = await memoryManager.addNote({
        title: data.title || '笔记',
        content: data.content || '',
        tags: data.tags || [],
        type: data.type || 'note'
      });
      return sendJson(res, 200, { success: true, note: result });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  if (req.method === 'PUT') {
    try {
      const pathParts = url.pathname.split('/').filter(Boolean);
      const noteId = pathParts[pathParts.length - 1];
      // Guard against PUT /api/memory/notes without ID (pop would return 'notes')
      if (!noteId || noteId === 'notes') {
        return sendError(res, 400, '缺少笔记 ID');
      }
      const data = await readJsonBody(req);
      const result = memoryManager.updateNote(noteId, {
        title: data.title,
        content: data.content,
        tags: data.tags
      });
      return sendJson(res, result.success ? 200 : 404, result);
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  if (req.method === 'DELETE') {
    try {
      const pathParts = url.pathname.split('/').filter(Boolean);
      const noteId = pathParts[pathParts.length - 1];
      if (!noteId || noteId === 'notes') {
        return sendError(res, 400, '缺少笔记 ID');
      }
      const result = memoryManager.deleteNote(noteId);
      return sendJson(res, result.success ? 200 : 404, result);
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleMemoryDream(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');
  
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    const result = await memoryManager.triggerDream();
    const dreams = memoryManager.getDreams();
    return sendJson(res, 200, { 
      success: true, 
      dreams: dreams || { insights: [], consolidated: 0, timestamp: Date.now() },
      result
    });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemorySearch(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');
  
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  const query = url.searchParams.get('q') || '';
  const limit = parseInt(url.searchParams.get('limit') || '10', 10);
  
  if (!query) {
    return sendJson(res, 200, { success: true, results: [] });
  }

  try {
    const results = await memoryManager.searchMemories(query, limit);
    return sendJson(res, 200, { success: true, results });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

/**
 * 直读 unified-store entities 表取实体清单（与 memory-graph 面板同源同序，
 * 见 src/core/panels/memory-graph.js `_extractEntityGraphData` 的取数实现）。
 *
 * 修复背景（发布 P1-1，恒空双 bug）：
 * - Bug A：enhancedMemory.getStats() 是 async，此前未 await 拿到 Promise，`.entities` 恒 undefined；
 * - Bug B：即使 await，getStats() 返回 { totalEntities, totalAliases, totalLinks, entitiesByType }，
 *   无 `.all` 字段——两案叠加使 /api/memory/entities 恒返回空列表（DB 实际有 39376 行实体）。
 *
 * 排序与面板一致：ORDER BY mention_count DESC, created_at DESC（mention_count 真实参与排序；
 * 全 0 时退化为 created_at——与面板同款行为，非本函数问题）。
 *
 * @param {object} store UnifiedMemoryStore 实例（或具 all() 的同形 store）
 * @param {number} limit 返回上限（默认 500，与面板实体提取窗口一致）
 * @returns {Array<{name:string,type:string,factCount:number,mention_count:number}>}
 */
function fetchEntityListFromStore(store, limit = 500) {
  if (!store || typeof store.all !== 'function') return [];
  const rows = store.all(
    `SELECT e.id, e.name, e.kind, e.mention_count,
            COUNT(r.id) AS relation_count
     FROM entities e
     LEFT JOIN relations r ON r.source_entity = e.id
     GROUP BY e.id
     ORDER BY e.mention_count DESC, e.created_at DESC
     LIMIT ?`,
    [limit]
  );
  return (rows || []).map((row) => ({
    name: row.name || row.id,
    type: row.kind || 'concept',
    // factCount = 真实关联数（relations 表实count）——前端 Memory 页显示「N 条关联记忆」
    factCount: row.relation_count || 0,
    mention_count: row.mention_count || 0,
  }));
}

async function handleMemoryEntities(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  const limitParam = parseInt(url.searchParams.get('limit') || '500', 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 500;

  try {
    const { getUnifiedStore } = require('../core/memory/unified-store');
    const store = getUnifiedStore();
    const entityList = fetchEntityListFromStore(store, limit);
    let total = entityList.length;
    try {
      const row = store.get('SELECT COUNT(*) AS c FROM entities');
      if (row && typeof row.c === 'number') total = row.c;
    } catch (countErr) {
      console.warn('[memory-handler.js] entities 总数统计失败（回退为列表长度）:', countErr && countErr.message);
    }
    return sendJson(res, 200, { success: true, data: { entities: entityList, total } });
  } catch (e) {
    console.error('[memory-handler.js] handleMemoryEntities 失败:', e && e.message);
    return sendError(res, 500, e.message);
  }
}

async function handleMemoryEntityProbe(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');
  
  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  const entityName = url.pathname.split('/').pop();
  
  try {
    let result = { entity: { name: entityName, type: 'unknown' }, facts: [] };
    
    if (memoryManager.enhancedMemory) {
      try {
        const probeResult = await memoryManager.enhancedMemory.probeEntity(entityName);
        if (probeResult) {
          result = probeResult;
        }
      } catch (e) {

        // ignore

        console.warn('[memory-handler.js] 空 catch 补日志:', e && e.message);
      }

    }
    
    return sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemoryGraph(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    // 统一走共享图谱模块（entity-graph + memory-tree + notes + documents + skills + sessions）
    const { globalMemoryGraph } = require('../core/panels/memory-graph');
    const refresh = req.url.includes('refresh=1') || req.url.includes('refresh=true');
    const data = await globalMemoryGraph.getGraphData({ forceRefresh: refresh });
    return sendJson(res, 200, { success: true, nodes: data.nodes, edges: data.edges, stats: data.stats });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemoryTimeline(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    // 统一走共享时间线构建器（unified-store memories + notes + documents）
    const { buildMemoryTimeline } = require('../core/memory/timeline');
    const entries = await buildMemoryTimeline(50);
    return sendJson(res, 200, { success: true, data: { entries } });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

// ── 跨会话搜索 API（2026-08-01 从 cli/handlers/memory-handlers.js 移植合并）──

async function handleMemorySearchSessions(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url, `http://localhost:${process.env.PORT || DEFAULT_PORT}`);
  const query = url.searchParams.get('q') || '';
  if (!query.trim()) {
    return sendJson(res, 200, { success: true, data: { results: [], count: 0 } });
  }
  try {
    // P1-8: 原 memory-sqlite.js 是第二个闲置 SQLite 后端——queueMemoryUpdate 全仓零调用，
    // memory.db 永不写入，此接口读空库。统一到真实 FTS 后端 fts-search：
    // session-persistence 落盘会话时同步索引 session_fts，数据真实。
    // 响应包装 { success, data: { results, count } } 不变；行字段为 fts-search 真实形状。
    const { searchSessions } = require('../core/memory/fts-search');
    const sessionId = url.searchParams.get('sessionId');
    const role = url.searchParams.get('role');
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit = Math.min(limitParam ? parseInt(limitParam) : 20, 200);
    const offset = Math.max(offsetParam ? parseInt(offsetParam) : 0, 0);

    let results = await searchSessions(query, Math.min(limit + offset, 200));
    if (sessionId) results = results.filter(r => r.sessionId === sessionId);
    if (role) results = results.filter(r => r.role === role);
    results = results.slice(offset, offset + limit);

    const rows = results.map(r => ({
      session_id: r.sessionId,
      role: r.role,
      content: r.content,
      highlight: r.highlightSnippet || null,
      score: r.score,
    }));
    return sendJson(res, 200, { success: true, data: { results: rows, count: rows.length } });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

// ── 记忆进化 API（2026-08-01 从 cli/handlers/memory-handlers.js 移植合并）──

/**
 * 获取记忆快照实例
 */
function getMemorySnapshot() {
  try {
    const { MemorySnapshot } = require('../core/memory/memory-snapshot');
    return new MemorySnapshot();
  } catch (e) {
    console.debug('[memory-handler] MemorySnapshot 不可用:', e.message);
    return null;
  }
}

async function handleMemoryEvolutionStatus(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    const status = { available: false, engine: {}, decay: {}, tier: {} };

    try {
      const { getMemoryEvolutionEngine } = require('../core/evolution/memory-evolution');
      const engine = await getMemoryEvolutionEngine();
      status.available = true;
      status.engine = engine.getReport();
      status.hasEnhancedMemory = !!engine._enhancedMemory;
      status.hasDecayEngine = !!engine._decayEngine;
    } catch (e) {
      /* 记忆引擎状态查询失败，跳过 */
      console.warn('[memory-handler.js] 空 catch 补日志:', e && e.message);
    }


    try {
      const { memoryManager } = require('../core/memory-system');
      const em = memoryManager.enhancedMemory;
      if (em) {
        status.enhancedMemory = await em.getStats();
      }
    } catch (e) {
      /* 增强记忆状态查询失败，跳过 */
      console.warn('[memory-handler.js] 空 catch 补日志:', e && e.message);
    }


    return sendJson(res, 200, { success: true, status });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemoryEvolutionTrigger(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    let result;
    try {
      const { getMemoryEvolutionEngine } = require('../core/evolution/memory-evolution');
      const engine = await getMemoryEvolutionEngine();
      result = await engine.evolve();
    } catch (err) {
      return sendError(res, 500, '记忆进化引擎不可用: ' + err.message);
    }
    return sendJson(res, 200, { success: true, result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemoryEvolutionProfile(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    let profile = {};
    try {
      const { getMemoryEvolutionEngine } = require('../core/evolution/memory-evolution');
      const engine = await getMemoryEvolutionEngine();
      profile = engine.getUserProfile();
    } catch (e) {
      /* 进化引擎不可用，跳过 */
      console.warn('[memory-handler.js] 空 catch 补日志:', e && e.message);
    }


    return sendJson(res, 200, { success: true, profile });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

// ── 记忆快照 API（从 cli/handlers/memory-handlers.js 移植合并）──

async function handleMemorySnapshot(req, res, _ctx) {
  const { sendJson, sendError } = require('./http-utils');

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    const snapshot = getMemorySnapshot();
    if (!snapshot) {
      return sendJson(res, 200, {
        success: true,
        agent: [],
        user: [],
        usage: {
          agent: { chars: 0, limit: 2200, usage: 0, entries: 0, needsMerge: false },
          user: { chars: 0, limit: 1375, usage: 0, entries: 0, needsMerge: false },
        },
      });
    }
    return sendJson(res, 200, {
      success: true,
      agent: snapshot.getAgentEntries(),
      user: snapshot.getUserEntries(),
      usage: snapshot.getUsageReport(),
    });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemorySnapshotAdd(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { type, entry } = body;
    if (!type || !entry) {
      return sendJson(res, 400, { success: false, error: '缺少 type 或 entry' });
    }
    const snapshot = getMemorySnapshot();
    if (!snapshot) {
      return sendJson(res, 500, { success: false, error: '记忆快照模块不可用' });
    }
    const result = type === 'agent' ? snapshot.addAgentMemory(entry) : snapshot.addUserMemory(entry);
    if (result.ok) snapshot.unfreeze();
    return sendJson(res, 200, { success: result.ok, error: result.error, ...result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemorySnapshotReplace(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { type, oldStr, newStr } = body;
    if (!type || !oldStr) {
      return sendJson(res, 400, { success: false, error: '缺少 type 或 oldStr' });
    }
    const snapshot = getMemorySnapshot();
    if (!snapshot) {
      return sendJson(res, 500, { success: false, error: '记忆快照模块不可用' });
    }
    const result = type === 'agent' ? snapshot.replaceAgentMemory(oldStr, newStr || '') : snapshot.replaceUserMemory(oldStr, newStr || '');
    if (result.ok) snapshot.unfreeze();
    return sendJson(res, 200, { success: result.ok, error: result.error, ...result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemorySnapshotRemove(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { type, oldStr } = body;
    if (!type || !oldStr) {
      return sendJson(res, 400, { success: false, error: '缺少 type 或 oldStr' });
    }
    const snapshot = getMemorySnapshot();
    if (!snapshot) {
      return sendJson(res, 500, { success: false, error: '记忆快照模块不可用' });
    }
    const result = type === 'agent' ? snapshot.removeAgentMemory(oldStr) : snapshot.removeUserMemory(oldStr);
    if (result.ok) snapshot.unfreeze();
    return sendJson(res, 200, { success: result.ok, error: result.error, ...result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

async function handleMemorySnapshotMerge(req, res, _ctx) {
  const { readJsonBody, sendJson, sendError } = require('./http-utils');

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { type, entries, mergedContent } = body;
    if (!type || !entries || !mergedContent) {
      return sendJson(res, 400, { success: false, error: '缺少 type, entries 或 mergedContent' });
    }
    const snapshot = getMemorySnapshot();
    if (!snapshot) {
      return sendJson(res, 500, { success: false, error: '记忆快照模块不可用' });
    }
    const result = snapshot.mergeEntries(type, entries, mergedContent);
    if (result.ok) snapshot.unfreeze();
    return sendJson(res, 200, { success: result.ok, error: result.error, ...result });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
}

module.exports = {
  handleMemoryTags,
  handleMemoryEntries,
  handleMemoryImportant,
  handleMemoryStats,
  handleMemoryNotes,
  handleMemoryDream,
  handleMemorySearch,
  handleMemorySearchSessions,
  handleMemoryEntities,
  fetchEntityListFromStore,
  handleMemoryEntityProbe,
  handleMemoryGraph,
  handleMemoryTimeline,
  handleMemoryEvolutionStatus,
  handleMemoryEvolutionTrigger,
  handleMemoryEvolutionProfile,
  handleMemorySnapshot,
  handleMemorySnapshotAdd,
  handleMemorySnapshotReplace,
  handleMemorySnapshotRemove,
  handleMemorySnapshotMerge
};