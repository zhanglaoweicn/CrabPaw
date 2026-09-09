/**
 * 统一记忆系统入口
 *
 * 整合 memory-system.js + EvolutionAwareMemory + HybridRetrievalEngine，
 * 提供语义向量 / FTS / 图谱三路并行检索的单一访问点。
 *
 * 架构：
 * - memoryManager: 三层记忆体系（Session/AutoMemory/AutoDream）+ FTS 全文检索，主存储
 * - evolutionAware: 进化感知增强层（重要性评估/智能检索/用户画像），辅助存储
 * - hybridRetrieval: 三路并行检索（FTS + 向量 + 图谱），语义理解补充
 * - 写入操作同时写入系统，读取优先从 memoryManager 获取
 */

const { memoryManager } = require('./memory-system');
const { getUnifiedStore } = require('./memory/unified-store');
const { HybridSearchEngine } = require('./hybrid-search');

let _hybridSearchEngine = null;

let _evolutionAware = null;
let _hybridRetrieval = null;
let _hybridRetrievalInit = false;

function _getHybridSearchEngine() {
  if (!_hybridSearchEngine) {
    _hybridSearchEngine = new HybridSearchEngine({
      ftsEnabled: true,
      vectorEnabled: true,
      temporalDecayEnabled: true,
      mmrEnabled: true,
    });
  }
  return _hybridSearchEngine;
}

/**
 * 获取进化感知记忆实例（懒加载）
 */
async function getEnhancedMemory() {
  if (!_evolutionAware) {
    try {
      const { getEvolutionAwareMemory } = require('./enhanced-memory');
      _evolutionAware = await getEvolutionAwareMemory();
    } catch (e) {
      console.warn('[unified-memory] 进化感知记忆不可用:', e.message);
    }
  }
  return _evolutionAware;
}

/**
 * 获取混合检索引擎实例（懒加载，含语义向量 + FTS + 图谱三路并行）
 */
async function getHybridRetrieval() {
  if (_hybridRetrievalInit) return _hybridRetrieval;
  _hybridRetrievalInit = true;
  try {
    const { getHybridRetrievalEngine } = require('./memory/hybrid-retrieval');
    _hybridRetrieval = await getHybridRetrievalEngine();
  } catch (e) {
    console.debug('[unified-memory] 混合检索引擎不可用:', e.message);
  }
  return _hybridRetrieval;
}

/**
 * 添加消息到记忆（同时写入两个系统 + 混合检索引擎）
 * 2026-08-13 P2-4: 增加 sessionId 参数——会话上下文与 userId 分离
 */
async function addMessage(userId, role, content, sessionId = null) {
  try { require('./memory-smart-loader').invalidateMemoryCache(userId); } catch (e) { console.warn('[unified-memory] Failed to invalidate cache:', e.message); }

  if (_memoryCache.size > 0) {
    const prefix = `${userId || 'default'}::`;
    for (const key of _memoryCache.keys()) {
      if (key.startsWith(prefix)) {
        _memoryCache.delete(key);
      }
    }
  }

  // 主系统写入(存量三参调用 user_id 仍等于 sessionId,行为不变)
  memoryManager.addMessage(sessionId || userId, role, content, userId);

  // 增强系统写入（异步，不阻塞主流程）
  const enhanced = await getEnhancedMemory();
  if (enhanced && enhanced.initialized) {
    try {
      await enhanced.store({
        userId,
        type: 'conversation',
        content: `[${role}] ${content}`,
        importance: role === 'user' ? 0.5 : 0.3,
      });
    } catch (e) {
      console.debug('[unified-memory] 增强系统写入失败:', e.message);
    }
  }

  let hybridIndexed = false;

  // 同步写入 unified-store SQLite + 混合检索引擎
  try {
    const { getUnifiedStore } = require('./memory/unified-store');
    const store = await getUnifiedStore();
    if (store) {
      const doc = {
        // P2: 同毫秒同 role 会碰撞覆盖——补随机后缀
        id: `${userId || 'default'}_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        namespace: userId || 'default',
        title: `${role} message`,
        content: content,
        metadata: JSON.stringify({
          role,
          userId,
          type: 'conversation',
          timestamp: Date.now(),
        }),
      };
      await store.upsertDocument(doc);

      // 2026-08-20: 图谱实喂——会话消息实体喂入图谱（best-effort，失败不阻断）
      try {
        const { feedConversationMessage } = require('./memory/knowledge-feed');
        feedConversationMessage({ messageId: doc.id, text: content });
      } catch (e) { console.error('[unified-memory] 图谱喂入失败（已忽略）:', e.message); }

      // 同时索引到混合检索引擎（向量 + FTS + 图谱）
      const hybrid = await getHybridRetrieval();
      if (hybrid) {
        try {
          await hybrid.indexContent(doc.id, content, {
            namespace: doc.namespace,
            type: 'memory',
            metadata: { role, userId, timestamp: Date.now() },
          });
          hybridIndexed = true;
        } catch (e) {
          console.debug('[unified-memory] 混合检索引擎索引失败:', e.message);
        }
      }
    }
  } catch (e) {
    // unified-store 写入失败不影响主流程
    console.warn('[unified-memory] unified-store write failed, cross-backend divergence possible:', e.message);
  }

  // 写一致性追踪：记录各后端写入状态
  const writeStatus = {
    main: true,
    enhanced: !!(enhanced && enhanced.initialized),
    unified: true,
    hybrid: hybridIndexed,
  };
  console.debug('[unified-memory] write consistency:', JSON.stringify(writeStatus));

  // 自动修复：检测到分歧时排队补写
  const allOk = writeStatus.main && writeStatus.unified;
  const degraded = !writeStatus.enhanced || !writeStatus.hybrid;
  if (allOk && degraded) {
    _scheduleConsistencyRepair({
      userId, role, content, timestamp: Date.now(),
      missing: {
        enhanced: !writeStatus.enhanced,
        hybrid: !writeStatus.hybrid,
      },
    });
  }
}

let _repairQueue = [];
let _repairTimer = null;

function _scheduleConsistencyRepair(entry) {
  _repairQueue.push(entry);
  if (_repairQueue.length > 50) _repairQueue = _repairQueue.slice(-50);
  if (!_repairTimer) {
    _repairTimer = setTimeout(async () => {
      const batch = _repairQueue.splice(0);
      _repairTimer = null;
      for (const e of batch) {
        try {
          if (e.missing?.enhanced) {
            const enhanced = await getEnhancedMemory();
            if (enhanced?.initialized) {
              await enhanced.store({
                userId: e.userId, type: 'conversation',
                content: `[${e.role}] ${e.content}`,
                importance: e.role === 'user' ? 0.5 : 0.3,
              });
            }
          }
          if (e.missing?.hybrid) {
            const hybrid = await getHybridRetrieval();
            if (hybrid) {
              await hybrid.indexContent(
                `${e.userId}_${e.role}_${e.timestamp}`,
                e.content,
                { namespace: e.userId || 'default', type: 'memory' }
              );
            }
          }
        } catch (repairErr) {
          console.debug('[unified-memory] consistency repair failed:', repairErr.message);
        }
      }
    }, 5000);
  }
}

/**
 * 获取完整上下文（优先从主系统获取）
 */
async function getFullContext(userId, message) {
  return memoryManager.getFullContext(userId, message);
}

/**
 * 获取相关记忆（四路并行：主系统 FTS + 增强系统 + 混合检索向量 + 图谱）
 */
async function getRelevantMemories(userId, query, options = {}) {
  const cacheKey = _getCacheKey(userId, query, options);
  const cached = _getCachedMemories(cacheKey);
  if (cached) {
    return cached;
  }

  const mainResults = await memoryManager.searchMemories(query, options.limit || 10, options);

  const enhanced = await getEnhancedMemory();
  if (enhanced && enhanced.initialized) {
    try {
      const enhancedResults = await enhanced.retrieve(query, { limit: 5, ...options });
      if (enhancedResults && enhancedResults.memories) {
        const existingContents = new Set(mainResults.map(m => m.content?.substring(0, 100)));
        for (const mem of enhancedResults.memories) {
          // P0 污染修复：type==='conversation' 为原始对话裸消息，不作为"相关记忆"合并注入
          if (mem.type === 'conversation') continue;
          if (mem.content && !existingContents.has(mem.content.substring(0, 100))) {
            mainResults.push(mem);
          }
        }
      }
    } catch (e) {
      console.debug('[unified-memory] 增强检索失败:', e.message);
    }
  }

  const hybrid = await getHybridRetrieval();
  if (hybrid) {
    try {
      const hybridResults = await hybrid.search(query, {
        namespace: userId || 'default',
        limit: options.limit || 10,
        types: ['memory', 'chunk'],
        minScore: options.minScore || 0,
      });
      if (hybridResults && hybridResults.length > 0) {
        const existingIds = new Set(mainResults.map(m => m.id));
        const existingContents = new Set(mainResults.map(m => m.content?.substring(0, 100)));
        for (const r of hybridResults) {
          if (r.id && existingIds.has(r.id)) continue;
          if (r.content && existingContents.has(r.content.substring(0, 100))) continue;
          mainResults.push({
            id: r.id,
            content: r.content,
            type: r.type || 'memory',
            score: r.score || r._score || 0,
            source: r._source || 'hybrid',
            hrrSim: r.hrrSim,
            tags: r.tags || [],
            updated: r.updatedAt || r.timestamp || Date.now(),
          });
        }
      }
    } catch (e) {
      console.debug('[unified-memory] 混合检索失败:', e.message);
    }
  }

  // Hebbian 关联：检索结果中共同出现的记忆建立关联（异步，不阻塞）
  if (mainResults.length >= 2) {
    getHebbianStore().associate(mainResults, query).catch(e => console.debug('[memory] Operation failed:', e?.message));
  }

  // New: Hybrid Search Engine (FTS + Vector + Temporal Decay + MMR)
  try {
    const hybridEngine = _getHybridSearchEngine();
    const chunksForSearch = mainResults.map(m => ({
      id: m.id,
      text: m.content || m.text || '',
      source: m.source || 'session',
      created_at: m.updated || m.timestamp || Date.now(),
      embedding: m.embedding || null,
    }));

    if (chunksForSearch.length > 0) {
      const hybridResults = hybridEngine.search(query, chunksForSearch, {
        limit: options.limit || 10,
      });
      if (hybridResults && hybridResults.length > 0) {
        const existingIds = new Set(mainResults.map(m => m.id));
        for (const r of hybridResults) {
          if (r.id && existingIds.has(r.id)) continue;
          if (r.combinedScore && r.combinedScore > 0.3) {
            mainResults.push({
              id: r.id,
              content: r.text || r.content,
              type: 'hybrid_ranked',
              score: r.combinedScore,
              source: 'hybrid_v2',
              ftsScore: r._ftsScore,
              vectorScore: r._vectorScore,
              temporalScore: r._temporalScore,
              mmrScore: r._mmrScore,
            });
          }
        }
      }
    }
  } catch (e) {
    console.debug('[unified-memory] Hybrid v2 search failed:', e.message);
  }

  _setCachedMemories(cacheKey, mainResults);

  return mainResults;
}

/**
 * getUnifiedMemories — Harness 合规要求的统一记忆检索入口
 *
 * 返回 { results, source } 其中 source 指示检索来源：
 * - 'unified': 四路并行检索（主系统 + 增强 + 混合向量 + 图谱）
 * - 'fallback': 仅主系统 FTS（增强/混合不可用时的降级）
 */
async function getUnifiedMemories(userId, query, options = {}) {
  const results = await getRelevantMemories(userId, query, options);
  const hybrid = await getHybridRetrieval();
  const enhanced = await getEnhancedMemory();
  const source = (hybrid || enhanced) ? 'unified' : 'fallback';
  return { results, source };
}

/**
 * 获取用户画像（从增强系统获取）
 */
async function getUserProfile() {
  const enhanced = await getEnhancedMemory();
  if (enhanced && enhanced.initialized) {
    return enhanced.getUserProfile();
  }
  return {};
}

/**
 * 触发记忆进化
 */
async function evolve() {
  const enhanced = await getEnhancedMemory();
  if (enhanced && enhanced.initialized) {
    return await enhanced.evolve();
  }
  return { improvement: 0 };
}

let _hebbianStore = null;

const MEMORY_CACHE_TTL_MS = 30 * 1000;
const _memoryCache = new Map();

function _getCacheKey(userId, query, options = {}) {
  const src = options.source || options.namespace || '';
  const limit = options.limit || 10;
  return `${userId || 'default'}::${query}::${src}::${limit}`;
}

function _getCachedMemories(key) {
  const entry = _memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > MEMORY_CACHE_TTL_MS) {
    _memoryCache.delete(key);
    return null;
  }
  return entry.data;
}

function _setCachedMemories(key, data) {
  if (_memoryCache.size > 200) {
    const oldestKey = _memoryCache.keys().next().value;
    _memoryCache.delete(oldestKey);
  }
  _memoryCache.set(key, { data, time: Date.now() });
}

function getHebbianStore() {
  if (!_hebbianStore) {
    const { HebbianGraphStore } = require('./memory/hebbian-graph-store');
    _hebbianStore = new HebbianGraphStore();
    _hebbianStore.initialize().catch(e => console.debug('[memory] Operation failed:', e?.message));
  }
  return _hebbianStore;
}

/**
 * 初始化会话结束记忆巩固订阅
 */
let _reconciliationInit = false;

function initReconciliation(force) {
  if (_reconciliationInit && !force) return;

  try {
    const { EventBus } = require('./events');
    const bus = EventBus.global;
    if (!bus) { console.debug('[unified-memory] EventBus not available, reconciliation deferred'); return; }
    _reconciliationInit = true;

    bus.subscribe('memory:pre_compact', async (event) => {
      try {
        const sessionId = event?.payload?.sessionId;
        if (!sessionId) return;
        const session = memoryManager.getSession(sessionId);
        if (!session || session.messages.length === 0) return;
        const result = await memoryManager.flushMemories(sessionId);
        if (result.flushed > 0) {
          console.log(`[unified-memory] pre-compact flushed ${result.flushed} facts`);
        }
      } catch (e) {
        /* graceful */
        console.warn('[unified-memory.js] 空 catch 补日志:', e && e.message);
      }

    });

    bus.subscribe('session:end', async (event) => {
        try {
        const sessionId = event?.payload?.sessionId;
        if (!sessionId) return;
        const session = memoryManager.getSession(sessionId);
        if (!session || session.messages.length === 0) return;
        // 1. Flush salient facts before the session context is lost
        await memoryManager.flushMemories(sessionId);
        // 2. Record session messages as documents for vector search
        const store = getUnifiedStore();
        for (const msg of session.messages.slice(-30)) {
        try {
        store.upsertChunk({
        document_id: `session_${sessionId}_msg_${msg.timestamp || Date.now()}`,
        namespace: sessionId,
        content: msg.content || '',
        chunk_index: 0,
        metadata: { role: msg.role, sessionId },
        });
        } catch (e) {
          /* per-message insert failure non-fatal */
          console.warn('[unified-memory.js] 空 catch 补日志:', e && e.message);
        }
        }
        // 3. Increment AutoDream session count
        memoryManager.autoDream.incrementSessionCount();
        console.log(`[unified-memory] session reconciled: ${sessionId}`);
      } catch (e) {
        console.debug('[unified-memory] reconciliation failed:', e.message);
      }
    });
  } catch (e) {
    console.debug('[unified-memory] reconciliation init failed:', e.message);
  }
}

// 初始化 reconciliation 订阅
try { initReconciliation(); } catch (e) {
  /* deferred */
  console.warn('[unified-memory.js] 空 catch 补日志:', e && e.message);
}


module.exports = {
  memoryManager,
  addMessage,
  getFullContext,
  getRelevantMemories,
  getUnifiedMemories,
  getUserProfile,
  evolve,
  getEnhancedMemory,
  getHybridRetrieval,
  getHebbianStore,
  initReconciliation,
};
