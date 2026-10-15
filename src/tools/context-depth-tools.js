/**
 * context-depth-tools.js — 上下文分层加载工具（OpenViking ov_find/ov_read 精华落地）
 *
 * 与 KbSearch 的 depth 参数共同构成统一分层加载协议（src/core/memory/context-depths.js）：
 *   - KbSearch/混合检索默认只回 abstract 层摘要 + ref（省 token）
 *   - 本文件两个工具负责"升级深度"与"浏览目录"：
 *     ContextDrillDown — 按 ref 下钻取更完整内容（tree 节点展开子级 / kb 全文 /
 *                        memory 全文 / archive 存档原文），即 OpenViking 的 ov_read
 *     ContextBrowse   — 浏览记忆树目录（各树的层级分布 + 摘要）与知识库覆盖，
 *                       即 OpenViking 的 ls/tree；下钻前先逛目录
 */
const fs = require('fs');
const { registry } = require('./registry');
const { DEPTHS, normalizeDepth, renderAtDepth } = require('../core/memory/context-depths');

// 下钻内容单条上限（full 层读原文的护栏，超过截断并提示用 Read 分段）
const DRILL_MAX_CHARS = 8000;
// 存档原文读取上限（存档本身可达数万字符）
const ARCHIVE_MAX_CHARS = 20000;

/** 解析 ref 入参：兼容模型直接平铺传参（source/id 在顶层） */
function _normalizeRef(params) {
  const raw = params.ref && typeof params.ref === 'object' ? params.ref : params;
  return {
    source: raw.source || raw.type || null,
    id: raw.id || raw.nodeId || null,
    treeId: raw.treeId || null,
    path: raw.path || raw.file_path || null,
  };
}

registry.register({
  name: 'ContextDrillDown',
  toolset: 'knowledge',
  category: 'context',
  description:
    '按 ref 下钻获取上下文资产的更完整内容（分层加载协议的"升级深度"步骤）。检索类工具（KbSearch 等）默认只返回摘要层并附带 ref；确认某条相关后，用本工具取其概览/全文。支持 source=kb（知识库片段/文档全文）、memory（记忆条目全文）、tree（记忆树节点及其子级摘要）、archive（历史长消息存档原文）。',
  whenNotToUse: [
    '不要用来代替 KbSearch 做检索——本工具只按 ref 精确取已定位的内容',
    '摘要已够回答时不要下钻（省 token 是分层加载的目的）',
    'archive 来源的 path 必须来自工具结果中的存档引用，不接受任意文件路径（读文件用 Read）',
  ],
  riskLevel: 'low',
  timeout: 15000,
  schema: {
    type: 'object',
    properties: {
      ref: {
        type: 'object',
        description: '下钻目标引用，来自检索结果中的 ref 字段: {source:"kb"|"memory"|"tree"|"archive", id, treeId?, path?}',
        properties: {
          source: { type: 'string', enum: ['kb', 'memory', 'tree', 'archive'] },
          id: { type: 'string' },
          treeId: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['source'],
      },
      depth: { type: 'string', description: '目标深度: overview/full(默认 full)' },
    },
    required: ['ref'],
  },
  async handler(params) {
    const ref = _normalizeRef(params);
    if (!ref.source) return { success: false, error: 'ref.source 必填（kb/memory/tree/archive）' };
    const depth = normalizeDepth(params.depth || DEPTHS.FULL);

    // ── kb：知识库 chunk / document 全文 ──
    if (ref.source === 'kb') {
      if (!ref.id) return { success: false, error: 'kb 下钻需要 ref.id' };
      let store = null;
      try {
        store = require('../core/memory/unified-store').getUnifiedStore();
      } catch (e) {
        return { success: false, error: '知识库不可用（' + e.message + '）' };
      }
      try {
        let content = null;
        let meta = {};
        const chunk = store.get('SELECT id, document_id, content, namespace, metadata FROM chunks WHERE id = ?', [ref.id]);
        if (chunk) {
          content = chunk.content;
          meta = { kind: 'chunk', documentId: chunk.document_id, namespace: chunk.namespace };
        } else {
          const doc = store.getDocument(ref.id);
          if (doc) {
            content = doc.content;
            meta = { kind: 'document', namespace: doc.namespace, title: doc.title };
          }
        }
        if (content == null) return { success: false, error: `未找到知识库内容 ${ref.id}（可能已过期清理）` };
        const rendered = renderAtDepth(content, depth, { maxChars: DRILL_MAX_CHARS });
        return {
          success: true,
          source: 'kb',
          ...meta,
          ...rendered,
          ref,
          truncatedNote: rendered.truncated && rendered.originalChars > rendered.content.length
            ? `原文 ${rendered.originalChars} 字，已按深度截断；如需超限部分可用 Read 工具直接读来源文件`
            : null,
        };
      } catch (e) {
        console.warn('[ContextDrillDown] kb 下钻失败:', e.message);
        return { success: false, error: '下钻失败（' + e.message + '）' };
      }
    }

    // ── memory：记忆条目全文 ──
    if (ref.source === 'memory') {
      if (!ref.id) return { success: false, error: 'memory 下钻需要 ref.id' };
      let store = null;
      try {
        store = require('../core/memory/unified-store').getUnifiedStore();
      } catch (e) {
        return { success: false, error: '记忆库不可用（' + e.message + '）' };
      }
      try {
        const mem = store.getMemory(ref.id);
        if (!mem) return { success: false, error: `未找到记忆 ${ref.id}` };
        const rendered = renderAtDepth(mem.content, depth, { maxChars: DRILL_MAX_CHARS });
        return {
          success: true,
          source: 'memory',
          id: mem.id,
          type: mem.type,
          title: mem.title,
          tags: mem.tags,
          namespace: mem.namespace,
          ...rendered,
          ref,
        };
      } catch (e) {
        console.warn('[ContextDrillDown] memory 下钻失败:', e.message);
        return { success: false, error: '下钻失败（' + e.message + '）' };
      }
    }

    // ── tree：记忆树节点 + 子级摘要 ──
    if (ref.source === 'tree') {
      if (!ref.id) return { success: false, error: 'tree 下钻需要 ref.id（节点 id）' };
      let orch = null;
      try {
        orch = require('../core/memory/memory-tree-v2').getMemoryTreeOrchestrator();
      } catch (e) {
        return { success: false, error: '记忆树不可用（' + e.message + '）' };
      }
      try {
        const hits = await orch.drillDown(ref.treeId || null, ref.id, { depth: 1 });
        if (hits.length === 0) return { success: false, error: `未找到树节点 ${ref.id}` };
        const target = hits[0];
        return {
          success: true,
          source: 'tree',
          treeId: target.treeId,
          nodeId: target.node.id,
          level: target.level,
          content: (target.level === 0 ? target.node.content : (target.node.summary || target.node.content)) || '',
          tokenCount: target.node.tokenCount,
          children: hits.slice(1).map((h) => ({
            nodeId: h.node.id,
            level: h.level,
            summary: (h.level === 0 ? h.node.content : (h.node.summary || h.node.content)) || '',
            tokenCount: h.node.tokenCount,
          })),
          ref,
        };
      } catch (e) {
        console.warn('[ContextDrillDown] tree 下钻失败:', e.message);
        return { success: false, error: '下钻失败（' + e.message + '）' };
      }
    }

    // ── archive：历史长消息存档原文（路径白名单校验）──
    if (ref.source === 'archive') {
      const { isArchivePath } = require('../core/history-compactor');
      if (!ref.path) return { success: false, error: 'archive 下钻需要 ref.path（存档引用中的文件路径）' };
      if (!isArchivePath(ref.path)) {
        return { success: false, error: 'path 不是合法的历史存档引用（须为 tool-results/history-*.txt），如需读文件请用 Read 工具' };
      }
      try {
        const text = fs.readFileSync(ref.path, 'utf-8');
        const rendered = renderAtDepth(text, DEPTHS.FULL, { maxChars: ARCHIVE_MAX_CHARS });
        return {
          success: true,
          source: 'archive',
          path: ref.path,
          ...rendered,
          truncatedNote: rendered.truncated
            ? `存档原文 ${rendered.originalChars} 字，已截断至 ${ARCHIVE_MAX_CHARS}；余下部分可用 Read 工具读取该文件`
            : null,
          ref,
        };
      } catch (e) {
        return { success: false, error: '存档读取失败（' + e.message + '）——存档保留 7 天后清理' };
      }
    }

    return { success: false, error: `不支持的 ref.source: ${ref.source}（可选 kb/memory/tree/archive）` };
  },
});

registry.register({
  name: 'ContextBrowse',
  toolset: 'knowledge',
  category: 'context',
  description:
    '浏览上下文资产目录（分层加载协议的"ls/tree"步骤）：记忆树清单（各树的层级分布/待密封叶子/顶层摘要）+ 知识库覆盖概况。用于回答"你记得哪些会话/上下文里有什么"、下钻前先看目录结构。',
  whenNotToUse: [
    '不要用本工具找具体内容——浏览只给结构与摘要，内容请 KbSearch 或下钻',
    '不要为普通检索先跑一遍浏览（检索结果自带 ref，无需先逛目录）',
  ],
  riskLevel: 'low',
  timeout: 15000,
  schema: {
    type: 'object',
    properties: {
      namespace: { type: 'string', description: '命名空间（默认 global）' },
    },
  },
  async handler(params) {
    const namespace = params.namespace || 'global';
    const result = { success: true, namespace, trees: [], treeCount: 0, kb: null };

    // 记忆树目录
    try {
      const { getMemoryTreeOrchestrator } = require('../core/memory/memory-tree-v2');
      const orch = getMemoryTreeOrchestrator();
      const digests = orch.getTreeDigests(namespace);
      result.trees = digests.map((d) => ({
        treeId: d.treeId,
        topic: d.topic,
        levels: d.levels,
        pendingLeaves: d.pendingLeaves,
        digest: d.digest ? String(d.digest).slice(0, 300) : null,
      }));
      result.treeCount = result.trees.length;
    } catch (e) {
      console.warn('[ContextBrowse] 记忆树目录失败:', e.message);
    }

    // 知识库覆盖概况
    try {
      const store = require('../core/memory/unified-store').getUnifiedStore();
      const docs = store.queryDocuments({ namespace, limit: 1000 });
      result.kb = {
        documentCount: docs.length,
        recent: docs.slice(0, 5).map((d) => ({ id: d.id, title: d.title, updatedAt: d.updated_at || d.updatedAt || null })),
      };
    } catch (e) {
      console.warn('[ContextBrowse] 知识库概况失败:', e.message);
    }

    if (result.treeCount === 0 && !result.kb) {
      result.message = '上下文库为空：尚无会话归档树与知识库文档';
    }
    return result;
  },
});

module.exports = {
  ContextDrillDown: () => registry.get('ContextDrillDown'),
  ContextBrowse: () => registry.get('ContextBrowse'),
};
