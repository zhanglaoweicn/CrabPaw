'use strict';

/**
 * memory-audit-tool.js — AI 可调用的记忆审计工具
 *
 * 工具:
 *   MemoryRecall    — 检索相关记忆（关键词/概念/时间/重要性）
 *   MemoryExtract   — 从文本提取可入记忆的实体/事实
 *   MemoryAudit     — 审计记忆库健康度（重复/冲突/孤岛/覆盖率）
 *   MemorySummarize — 生成人类可读的记忆库摘要报告
 *
 * 设计要点:
 *   - 使用 in-memory MemoryAuditor 作为审计引擎（快速、可控制）
 *   - 可选与 UnifiedMemoryStore 双向同步（持久化、跨会话）
 *   - recall/extract/audit 三个核心操作互不依赖，可独立使用
 */

const { registry } = require('./registry');
const {
  // eslint-disable-next-line no-unused-vars
  getMemoryAuditor, MemoryAuditor, MemoryEntry, IMPORTANCE, MEMORY_TYPES,
} = require('../core/memory-audit');

function _unwrap(res) {
  if (!res) return res;
  if (res.data && typeof res.data === 'object') return res.data;
  return res;
}

/**
 * 尝试同步到 UnifiedMemoryStore（若可用）
 */
async function _syncToUnifiedStore(auditor, namespace) {
  try {
    const { getUnifiedStore } = require('../core/memory/unified-store');
    const store = getUnifiedStore();
    if (!store || !store._initialized) return { synced: false, reason: 'store not initialized' };

    const memories = auditor.list();
    let count = 0;
    for (const m of memories) {
      try {
        store.addMemory({
          id: m.id,
          type: m.type || 'general',
          title: (m.text || '').slice(0, 60),
          content: m.text || '',
          scope: 'private',
          tags: m.tags || [],
          importance: IMPORTANCE_LEVEL_TO_NUM[m.importance] || 0.5,
          trust_score: 0.7,
          source: `audit:${m.source || 'manual'}`,
          namespace: namespace || 'default',
        });
        count++;
      } catch (e) {
        console.error('[memory-audit-tool] sync failed for', m.id, e.message);
      }
    }
    try { store.flush(); } catch (e) {
      /* ignore */
      console.warn('[memory-audit-tool.js] 空 catch 补日志:', e && e.message);
    }

    return { synced: true, count };
  } catch (e) {
    return { synced: false, reason: e.message };
  }
}

const IMPORTANCE_LEVEL_TO_NUM = {
  critical: 1.0,
  high: 0.8,
  medium: 0.5,
  low: 0.3,
  trivial: 0.1,
};

// ── MemoryRecall ──────────────────────────────────
registry.register({
  name: 'MemoryRecall',
  toolset: 'system',
  category: 'memory',
  description: '从记忆库中检索与查询相关的记忆条目。基于概念指纹 + 关键词 + 重要性 + 时间四维评分，返回 top N 条记忆。可按 type/tag/minImportance 过滤。',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '查询文本（自然语言）' },
      type: { type: 'string', enum: Object.values(MEMORY_TYPES), description: '按类型过滤' },
      tag: { type: 'string', description: '按标签过滤' },
      minImportance: { type: 'string', enum: Object.values(IMPORTANCE), description: '最低重要性' },
      limit: { type: 'number', description: '返回条数（默认 10）', default: 10 },
    },
    required: ['query'],
  },
  handler: async (params) => {
    const query = String(params.query || '').trim();
    if (!query) return { success: false, error: 'query 不能为空' };

    const auditor = getMemoryAuditor();
    const opts = { limit: params.limit || 10 };
    if (params.type) opts.type = params.type;
    if (params.tag) opts.tag = params.tag;
    if (params.minImportance) opts.minImportance = params.minImportance;

    const results = auditor.recall(query, opts);

    // 补充检索 unified-store（持久化主库）。MemoryAuditor 为进程内存，
    // 重启即失；真实记忆（MEMORY.md 提取事实/对话文档）都落盘在
    // unified-memory.db，合并后 LLM 才能搜到跨会话的持久记忆。
    try {
      const { getUnifiedStore } = require('../core/memory/unified-store');
      const store = getUnifiedStore();
      if (store && typeof store.searchMemories === 'function') {
        const storeResults = store.searchMemories(query, { limit: params.limit || 10 });
        const seen = new Set(results.map(r => String(r.text || r.content || '').substring(0, 100)));
        for (const r of storeResults || []) {
          const key = String(r.content || '').substring(0, 100);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          let tags = r.tags;
          if (typeof tags === 'string') {
            try { tags = JSON.parse(tags); } catch { tags = []; }
          }
          results.push({
            id: r.id,
            text: r.content || '',
            title: r.title || '',
            type: r.type || 'general',
            importance: r.importance ?? 0.5,
            tags: tags || [],
            timestamp: r.updated_at ? r.updated_at * 1000 : Date.now(),
            source: 'unified-store',
          });
        }
      }
    } catch (e) {
      console.warn('[MemoryRecall] unified-store search failed:', e.message);
    }

    return {
      success: true,
      query,
      count: results.length,
      results,
    };
  },
  isReadOnly: true,
  timeout: 5000,
});

// ── MemoryExtract ──────────────────────────────────
registry.register({
  name: 'MemoryExtract',
  toolset: 'system',
  category: 'memory',
  description: '从一段对话/文本中提取可入记忆的实体/事实。按句子切分，自动分类（fact/preference/instruction/event/todo/entity/conversation）、估算重要性、抽取概念关键词、解析时间引用。',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要抽取的文本' },
      types: {
        type: 'array',
        items: { type: 'string', enum: Object.values(MEMORY_TYPES) },
        description: '仅抽取指定类型（默认全部）',
      },
      includeTime: { type: 'boolean', default: true, description: '是否解析时间引用' },
      autoAdd: { type: 'boolean', default: false, description: '抽取后是否自动加入审计库' },
      syncToStore: { type: 'boolean', default: false, description: '是否同步到 UnifiedMemoryStore' },
      namespace: { type: 'string', default: 'default', description: '同步目标命名空间（选填）' },
    },
    required: ['text'],
  },
  handler: async (params) => {
    const text = String(params.text || '');
    if (!text) return { success: false, error: 'text 不能为空' };

    const auditor = getMemoryAuditor();
    const opts = {};
    if (params.types) opts.types = params.types;
    if (params.includeTime === false) opts.includeTime = false;

    const entries = auditor.extract(text, opts);

    let added = 0;
    if (params.autoAdd) {
      for (const e of entries) {
        auditor.add(e);
        added++;
      }
    }

    let syncResult = null;
    if (params.syncToStore && added > 0) {
      syncResult = await _syncToUnifiedStore(auditor, params.namespace);
    }

    return {
      success: true,
      count: entries.length,
      added,
      entries,
      sync: syncResult,
    };
  },
  isReadOnly: true,
  timeout: 5000,
});

// ── MemoryAudit ──────────────────────────────────
registry.register({
  name: 'MemoryAudit',
  toolset: 'system',
  category: 'memory',
  description: '审计记忆库健康度。检测重复条目（同概念指纹）、冲突条目（矛盾词+共享主题）、孤岛条目（无标签/关键词），计算覆盖率。返回结构化报告。',
  schema: {
    type: 'object',
    properties: {
      syncToStore: { type: 'boolean', default: false, description: '审计前是否先同步到 UnifiedMemoryStore' },
      namespace: { type: 'string', default: 'default', description: '同步目标命名空间（选填）' },
    },
  },
  handler: async (params) => {
    const auditor = getMemoryAuditor();

    if (params.syncToStore) {
      await _syncToUnifiedStore(auditor, params.namespace);
    }

    if (auditor.size === 0) {
      return {
        success: true,
        empty: true,
        message: '记忆库为空，可使用 MemoryExtract 工具提取文本为记忆',
        summary: { total: 0, duplicateGroups: 0, conflictPairs: 0, orphanCount: 0, coverageRatio: '0%' },
        stats: { total: 0, byType: {}, byImportance: {} },
        duplicates: [],
        conflicts: [],
        orphans: [],
      };
    }

    const report = auditor.audit();
    return {
      success: true,
      empty: false,
      ...report,
    };
  },
  isReadOnly: true,
  timeout: 10000,
});

// ── MemorySummarize ──────────────────────────────────
registry.register({
  name: 'MemorySummarize',
  toolset: 'system',
  category: 'memory',
  description: '生成人类可读的记忆库摘要报告，含总数、重复/冲突/孤岛数、覆盖率、按类型/重要性分布、问题示例。',
  schema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const auditor = getMemoryAuditor();
    const text = auditor.summarize();
    const audit = auditor.audit();
    return {
      success: true,
      text,
      summary: audit.summary,
    };
  },
  isReadOnly: true,
  timeout: 5000,
});

console.log('🧠 memory-audit 工具已注册 (MemoryRecall, MemoryExtract, MemoryAudit, MemorySummarize)');

module.exports = {
  MemoryRecall: 'MemoryRecall',
  MemoryExtract: 'MemoryExtract',
  MemoryAudit: 'MemoryAudit',
  MemorySummarize: 'MemorySummarize',
};
