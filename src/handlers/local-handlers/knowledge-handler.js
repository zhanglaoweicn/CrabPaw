// knowledge-handler.js — 知识库 API（2026-08-20 DeepTutor 精华落地：读取链路闭环）
//
// 知识库此前只有写入链路（DocumentAnalyze 入库），读取链路断裂（hybrid-retrieval
// 无生产调用方）。本端点打通 HTTP 读取：
//   GET    /api/kb/search?q=…&limit=…   → 混合检索（FTS+向量+实体图 RRF 融合）
//   GET    /api/kb/list?limit=…          → 文档清单（清单≠检索证据）
//   GET    /api/kb/stats                 → 存量快照（documents/chunks/entities）
//   DELETE /api/kb/:id                   → 删除文档（级联 chunks）
//
// 统一响应 { success, data | error }。检索逻辑与 KbSearch 工具共用同一 handler
// （单一事实源，前端 API 与 LLM 工具结果口径一致）。

const { sendJson, readJsonBody } = require('../http-utils');

/** 惰性加载工具 handler（避免模块加载期 require 依赖循环） */
function _kbTools() {
  return require('../../tools/knowledge-tools');
}

/** 惰性加载 store */
function _store() {
  return require('../../core/memory/unified-store').getUnifiedStore();
}

function _sendError(res, status, error) {
  console.error('[knowledge] API:', error);
  return sendJson(res, status, { success: false, error });
}

async function handleKnowledgeRoute(req, res, ctx) {
  const pathname = ctx.url.pathname;
  const method = req.method;
  try {
    // GET /api/kb/search?q=…&limit=…
    if (method === 'GET' && /^\/api\/kb\/search$/.test(pathname)) {
      const q = ctx.url.searchParams.get('q') || ctx.url.searchParams.get('query') || '';
      const limit = parseInt(ctx.url.searchParams.get('limit'), 10) || undefined;
      if (!q.trim()) {
        return _sendError(res, 400, '缺少检索词 q');
      }
      const result = await _kbTools().KbSearch().handler({ query: q, limit }, { userId: ctx.userId });
      if (!result.success) return _sendError(res, 500, result.error);
      return sendJson(res, 200, { success: true, data: { query: result.query, total: result.total, documents: result.documents, results: result.results } });
    }

    // GET /api/kb/list
    if (method === 'GET' && /^\/api\/kb\/list$/.test(pathname)) {
      const limit = parseInt(ctx.url.searchParams.get('limit'), 10) || undefined;
      const titleContains = ctx.url.searchParams.get('titleContains') || undefined;
      const result = await _kbTools().KbList().handler({ limit, titleContains, namespace: 'global' });
      if (!result.success) return _sendError(res, 500, result.error);
      return sendJson(res, 200, { success: true, data: result });
    }

    // GET /api/kb/stats
    if (method === 'GET' && /^\/api\/kb\/stats$/.test(pathname)) {
      const store = _store();
      const count = (sql) => {
        try {
          const row = store.get(sql);
          return row ? row.c : 0;
        } catch (e) {
          console.warn('[knowledge] 统计查询失败:', sql, e.message);
          return -1;
        }
      };
      const data = {
        documents: count('SELECT COUNT(*) AS c FROM documents'),
        chunks: count('SELECT COUNT(*) AS c FROM chunks'),
        entities: count('SELECT COUNT(*) AS c FROM entities'),
        memories: count('SELECT COUNT(*) AS c FROM memories'),
      };
      // 2026-08-20 DeepTutor 精华落地: failures/processed 记账摘要
      try {
        const bookkeeping = require('../../core/memory/kb-bookkeeping').getBookkeeping();
        data.failures = bookkeeping.failures;
        data.processed = bookkeeping.processed;
      } catch (e) {
        console.warn('[knowledge] 记账读取失败:', e.message);
      }
      return sendJson(res, 200, { success: true, data });
    }

    // GET /api/kb/due —— SRS 到期复习清单（2026-08-20 DeepTutor 学习循环）
    if (method === 'GET' && /^\/api\/kb\/due$/.test(pathname)) {
      const limit = Math.min(Math.max(parseInt(ctx.url.searchParams.get('limit'), 10) || 20, 1), 100);
      // 2026-08-22 实机修复: 解构调用丢 this 绑定——listDueEntities 内部用
      // this.all(), 无绑定调用时 this=undefined → "Cannot read properties of
      // undefined (reading 'all')" 500（SRS 复习面板每次打开都报）。方法调用保留 this。
      const due = _store().listDueEntities(Date.now(), limit);
      return sendJson(res, 200, {
        success: true,
        data: {
          total: due.length,
          entities: due.map((e) => ({
            id: e.id,
            name: e.name,
            kind: e.kind || 'concept',
            dueAt: e.srs_due_at || null,
            interval: e.srs_interval || 0,
            streak: e.srs_streak || 0,
          })),
        },
      });
    }

    // POST /api/kb/review —— 记录复习结果（答对/答错 → SRS 等级转移）
    if (method === 'POST' && /^\/api\/kb\/review$/.test(pathname)) {
      const body = await readJsonBody(req);
      const entityId = body && body.entityId;
      const correct = !!(body && body.correct);
      if (!entityId) return _sendError(res, 400, '缺少 entityId');
      const store = _store();
      const entity = store.getEntity(entityId);
      if (!entity) return _sendError(res, 404, '实体不存在');

      const srs = require('../../core/memory/srs-scheduler');
      const cur = srs.rowToSrs(entity);
      const { index, nextStreak } = srs.updateLevel(cur.index, correct, cur.streak, cur.kind);
      const dueAtMs = srs.nextReviewAt(index, cur.kind);
      store.applySrsReview(entityId, { index, dueAtMs: dueAtMs, streak: nextStreak });
      return sendJson(res, 200, {
        success: true,
        data: { entityId, index, streak: nextStreak, dueAt: dueAtMs, kind: cur.kind },
      });
    }

    // DELETE /api/kb/:id
    let m = pathname.match(/^\/api\/kb\/([^/]+)$/);
    if (method === 'DELETE' && m) {
      const store = _store();
      const doc = store.getDocument(m[1]);
      if (!doc) return _sendError(res, 404, '文档不存在');
      store.deleteDocument(m[1]);
      return sendJson(res, 200, { success: true, data: { id: m[1] } });
    }

    return _sendError(res, 404, 'Knowledge API Not Found');
  } catch (e) {
    return _sendError(res, 500, `知识库 API 错误: ${e.message}`);
  }
}

module.exports = { handleKnowledgeRoute };
