/**
 * knowledge-tools.js — 知识库检索工具集（2026-08-20 DeepTutor 精华落地：读取链路闭环）
 *
 * 背景：知识库写入链路完整（文档分析入库 → chunks/FTS/向量/实体），但读取链路
 * 长期断裂——hybrid-retrieval 无生产调用方。本文件提供两个工具打通闭环：
 *   - KbSearch：混合检索（FTS + 向量 + 实体图 RRF 融合），返回带溯源的结果
 *   - KbList：知识库文档清单（「清单≠检索证据」——LLM 引用必须基于检索结果，
 *     而不是凭清单脑补文档内容）
 *
 * 对齐 DeepTutor 精华：
 *   - SmartRetriever 查询改写（≤3 queries Map-Reduce）——此处以 query 归一化
 *     + 文档级聚合近似实现（不做多查询扩写，避免成本失控）
 *   - 溯源（provenance）：每条结果携带来源文档/文件路径，防幻觉引用
 */
const { registry } = require('./registry');

const KB_NAMESPACE = 'global';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

/** 摘要：截取内容片段（≈200 字符），保留首段语义 */
function _snippet(content, maxLen = 200) {
  if (!content) return '';
  const text = String(content).replace(/\s+/g, ' ').trim();
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

/** 归一化检索请求：剥离寒暄/命令前缀，避免把整句丢进 FTS（DeepTutor 查询改写精华的轻量版） */
function _normalizeQuery(query) {
  const q = String(query || '').trim();
  // 常见命令前缀剥离：「查一下」「搜一下」「帮我找找」「知识库里」等
  return q.replace(/^(请|帮我|给我|我想|我要)?\s*(查(一下|一查|查)?|搜(一下|一搜|搜)?|找(一下|一找|找)?|看看|检索|查询|知识库(里|中)?(有|关于)?|有没有|关于|介绍(一下)?)\s*(一下|一[下个]|下)?\s*(有关|相关|关于)?\s*/, '').trim() || q;
}

// ============================================================
// KbSearch 工具
// ============================================================

registry.register({
  name: 'KbSearch',
  toolset: 'knowledge',
  category: 'knowledge',
  description:
    '检索本地知识库（混合检索：全文 FTS + 向量相似 + 实体图 RRF 融合）。知识库收录了用户通过 DocumentAnalyze 分析的文档（合同/报告/表格等）。用于回答「之前分析的 XX 文档里提到什么」「知识库中关于 XX 的内容」。返回带来源（文档名/文件路径）的片段。',
  whenNotToUse: [
    '不要用于搜索互联网，改用 WebSearch',
    '不要用于搜索本地文件内容，改用 Grep',
    '不要只为了看有哪些文档而调用（用 KbList）',
    '知识库为空时不要编造结果，如实返回空',
  ],
  riskLevel: 'low',
  timeout: 30000,
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索内容，如「合同金额」「项目风险」「某组织名称」' },
      limit: { type: 'number', description: `返回结果数（默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}）` },
      namespace: { type: 'string', description: '命名空间（默认 global）' },
    },
    required: ['query'],
  },
  async handler(params, context) {
    const query = _normalizeQuery(params.query);
    if (!query) {
      return { success: false, error: '检索词不能为空' };
    }
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const namespace = params.namespace || KB_NAMESPACE;

    let engine = null;
    try {
      const { getHybridRetrievalEngine } = require('../core/memory/hybrid-retrieval');
      engine = getHybridRetrievalEngine();
    } catch (e) {
      console.error('[KbSearch] 混合检索引擎不可用:', e.message);
      return { success: false, error: '知识库检索引擎不可用（' + e.message + '）' };
    }

    let results;
    try {
      results = await engine.search(query, {
        namespace,
        types: ['document', 'chunk', 'memory'],
        limit,
      });
    } catch (e) {
      console.error('[KbSearch] 检索失败:', e.message);
      return { success: false, error: '检索失败（' + e.message + '）' };
    }

    // 溯源格式化：文档检索结果按 documentId 补文档标题；chunk 携带来源路径
    const store = engine._store;
    const docsById = new Map();
    if (store && typeof store.getDocument === 'function') {
      for (const r of results) {
        if (r.documentId && !docsById.has(r.documentId)) {
          try {
            const doc = store.getDocument(r.documentId);
            if (doc) docsById.set(r.documentId, doc);
          } catch (e) {
            console.warn('[KbSearch] 读取文档元数据失败:', e.message);
          }
        }
      }
    }

    const formatted = results.map((r) => {
      const doc = r.documentId ? docsById.get(r.documentId) : null;
      let sourcePath = '';
      let sourceLabel = '';
      try {
        const meta = doc && doc.metadata ? JSON.parse(doc.metadata) : {};
        sourcePath = meta.sourcePath || doc.source_path || '';
        sourceLabel = meta.source || '';
      } catch { /* metadata 非 JSON 时静默忽略 */ }
      return {
        id: r.id,
        kind: r.type || 'chunk',
        title: r.title || (doc && doc.title) || '',
        snippet: _snippet(r.content),
        score: Math.round((r.combinedScore || 0) * 1000) / 1000,
        documentId: r.documentId || null,
        source: sourceLabel,
        sourcePath: sourcePath || null,
      };
    });

    // 知识库存量快照：让 LLM 知道检索覆盖范围（清单≠证据，但空库要诚实）。
    // documents 总行数含聊天记忆等非分析文档，kbDocs 才是文档分析入库数——
    // metadata 为 JSON 文本，LIKE 扫描即可（行数级开销可忽略）。
    let kbDocs = 0;
    let docCount = 0;
    try {
      if (store && typeof store.queryDocuments === 'function') {
        docCount = store.queryDocuments({ limit: 1000 }).length;
      }
      if (store && typeof store.get === 'function') {
        const row = store.get("SELECT COUNT(*) AS c FROM documents WHERE metadata LIKE '%document_analysis%'");
        kbDocs = row ? row.c : 0;
      }
    } catch (e) {
      console.warn('[KbSearch] 统计文档数失败:', e.message);
    }

    if (formatted.length === 0) {
      return {
        success: true,
        query,
        total: 0,
        documents: docCount,
        kbDocs,
        results: [],
        message: kbDocs === 0
          ? '知识库暂无分析文档，可先用 DocumentAnalyze 分析文档入库'
          : '知识库中未找到相关内容',
      };
    }

    return { success: true, query, total: formatted.length, documents: docCount, kbDocs, results: formatted };
  },
});

// ============================================================
// KbList 工具
// ============================================================

registry.register({
  name: 'KbList',
  toolset: 'knowledge',
  category: 'knowledge',
  description:
    '列出知识库中的文档清单（标题/来源/更新时间）。用于「知识库有哪些文档」、确认某文档是否已分析入库、或作为检索前的覆盖检查。「清单≠检索证据」：清单只回答"有什么"，引用内容必须先 KbSearch。',
  whenNotToUse: [
    '需要文档具体内容时改用 KbSearch（清单不含正文）',
    '知识库为空时如实返回空列表',
  ],
  riskLevel: 'low',
  timeout: 15000,
  schema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: `返回条数（默认 20，最大 100）` },
      titleContains: { type: 'string', description: '按标题关键字过滤' },
      namespace: { type: 'string', description: '命名空间（默认 global）' },
    },
  },
  async handler(params) {
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || 20, 1), 100);
    const namespace = params.namespace || KB_NAMESPACE;

    let store = null;
    try {
      const { getUnifiedStore } = require('../core/memory/unified-store');
      store = getUnifiedStore();
    } catch (e) {
      console.error('[KbList] 知识库不可用:', e.message);
      return { success: false, error: '知识库不可用（' + e.message + '）' };
    }

    let docs;
    try {
      docs = store.queryDocuments({
        namespace,
        titleContains: params.titleContains || undefined,
        limit,
        orderBy: 'updated_at DESC',
      });
    } catch (e) {
      console.error('[KbList] 查询失败:', e.message);
      return { success: false, error: '查询失败（' + e.message + '）' };
    }

    const formatted = docs.map((d) => {
      let source = '';
      let sourcePath = '';
      try {
        const meta = d.metadata ? JSON.parse(d.metadata) : {};
        source = meta.source || '';
        sourcePath = meta.sourcePath || d.source_path || '';
      } catch { /* 非 JSON 静默 */ }
      return {
        id: d.id,
        title: d.title,
        updatedAt: d.updated_at || d.updatedAt || null,
        source,
        sourcePath: sourcePath || null,
        charCount: (d.content || '').length,
      };
    });

    return { success: true, total: formatted.length, documents: formatted };
  },
});

module.exports = { KbSearch: () => registry.get('KbSearch'), KbList: () => registry.get('KbList') };
