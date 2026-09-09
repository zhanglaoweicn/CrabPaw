// kb-bookkeeping.js — 知识库记账（2026-08-20 DeepTutor 精华落地: failures bookkeeping）
//
// DeepTutor 维护 processed_files / failures 两份记录（摄取韧性: 成功去重、失败可查）。
// 本模块等价实现，持久化在 unified-store 的 store_meta（JSON 值，FIFO 上限）：
//   - kb_processed: 已入库文档（path + hash + documentId），供去重审计
//   - kb_failures:  摄取/分析失败（kind + path + hash + error），供诊断与重试
//
// 数据面向: /api/kb/stats 扩展、KbSearch 空结果时的诚实提示、运维排障。
// 订阅 ingestion-pipeline 的 item:failed/completed（仅 type=document）自动记账。

const MAX_PROCESSED = 200;
const MAX_FAILURES = 50;

let _store = null;
let _subscribed = false;

function _getStore() {
  if (!_store) {
    try {
      _store = require('./unified-store').getUnifiedStore();
    } catch (e) {
      console.warn('[kb-bookkeeping] unified-store 不可用:', e.message);
    }
  }
  return _store;
}

function _read(key, fallback) {
  const store = _getStore();
  if (!store || typeof store.getMeta !== 'function') return fallback;
  try {
    const raw = store.getMeta(key);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch (e) {
    console.warn('[kb-bookkeeping] 读取', key, '失败:', e.message);
    return fallback;
  }
}

function _write(key, list) {
  const store = _getStore();
  if (!store || typeof store.setMeta !== 'function') return;
  try {
    store.setMeta(key, JSON.stringify(list));
  } catch (e) {
    console.warn('[kb-bookkeeping] 写入', key, '失败:', e.message);
  }
}

function recordProcessed(entry) {
  const list = _read('kb_processed', []);
  list.unshift({
    path: entry.path || '',
    hash: entry.hash || '',
    documentId: entry.documentId || '',
    title: entry.title || '',
    at: Date.now(),
  });
  if (list.length > MAX_PROCESSED) list.length = MAX_PROCESSED;
  _write('kb_processed', list);
}

function recordFailure(entry) {
  const list = _read('kb_failures', []);
  list.unshift({
    kind: entry.kind || 'unknown',
    path: entry.path || '',
    hash: entry.hash || '',
    error: String(entry.error || '').slice(0, 300),
    at: Date.now(),
  });
  if (list.length > MAX_FAILURES) list.length = MAX_FAILURES;
  _write('kb_failures', list);
}

function getBookkeeping() {
  return {
    processed: _read('kb_processed', []),
    failures: _read('kb_failures', []),
  };
}

const MANIFEST_MAX = 20;

/**
 * 知识库清单注入文本（DeepTutor 精华「清单≠检索证据」）。
 * 让 LLM 知道知识库有哪些文档（标题/来源/时间），但明确要求回答内容前必须
 * KbSearch 检索——防止模型凭清单脑补文档内容（幻觉引用）。
 * 仅返回分析文档（source=document_analysis），上限 20 条；空库返回 ''。
 */
function buildKnowledgeManifest() {
  const store = _getStore();
  if (!store || typeof store.queryDocuments !== 'function') return '';
  let docs;
  try {
    docs = store.queryDocuments({ limit: 1000, orderBy: 'updated_at DESC' })
      .filter((d) => {
        try {
          const m = d.metadata ? JSON.parse(d.metadata) : {};
          return m.source === 'document_analysis';
        } catch { return false; }
      })
      .slice(0, MANIFEST_MAX);
  } catch (e) {
    console.warn('[kb-bookkeeping] 清单读取失败:', e.message);
    return '';
  }
  if (docs.length === 0) return '';

  const rows = docs.map((d) => {
    const at = d.updated_at ? new Date(d.updated_at * 1000).toISOString().slice(0, 10) : '';
    return `- 「${d.title}」${at ? `（收录于 ${at}）` : ''}`;
  });
  return [
    '## 📚 知识库文档清单',
    '以下是知识库已收录的文档。**清单只说明"有哪些文档"，不等于文档内容**：',
    '回答任何涉及文档内容的问题时，必须先调用 KbSearch 检索对应片段，',
    '严格基于检索结果回答，禁止凭本清单臆造或编造文档内容。',
    '',
    rows.join('\n'),
    '',
  ].join('\n');
}

/** 订阅摄取管道失败/成功事件（幂等）。仅关注 type=document 的 KB 文档摄取。 */
function init() {
  if (_subscribed) return;
  _subscribed = true;
  try {
    const { getIngestionPipeline } = require('./ingestion-pipeline');
    const pipeline = getIngestionPipeline();
    pipeline.on('item:failed', (e) => {
      if (e && e.type === 'document') {
        recordFailure({
          kind: 'ingest',
          path: (e.metadata && e.metadata.sourcePath) || '',
          hash: (e.metadata && e.metadata.sourceHash) || '',
          error: e.error || 'ingestion failed',
        });
      }
    });
    pipeline.on('item:completed', (e) => {
      if (e && e.type === 'document' && e.metadata && e.metadata.sourceHash) {
        recordProcessed({
          path: e.metadata.sourcePath || '',
          hash: e.metadata.sourceHash,
          documentId: e.metadata.documentId || '',
          title: e.metadata.title || '',
        });
      }
    });
  } catch (e) {
    console.warn('[kb-bookkeeping] 管道订阅失败:', e.message);
  }
}

module.exports = { recordProcessed, recordFailure, getBookkeeping, init, buildKnowledgeManifest };
