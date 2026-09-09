/**
 * knowledge-system.test.js — 知识库读取链路 + SRS 学习循环（2026-08-20 DeepTutor 精华落地）
 *
 * 覆盖:
 *   1. srs-scheduler 纯函数（间隔表/等级转移/到期判定）
 *   2. unified-store 内容寻址（source_hash 列 + findByHash + 幂等保列）
 *   3. ingestion-pipeline 哈希去重（DEDUPED 阶段 + item:failed 补 type/metadata）
 *   4. knowledge-tools（KbSearch 溯源格式化 / KbList / 空库诚实提示）
 *   5. kb-bookkeeping（记账 FIFO + 清单注入文本）
 *   6. tool-router kb_query 意图路由
 */

const crypto = require('crypto');

// ==================== 1. srs-scheduler 纯函数 ====================

describe('srs-scheduler 纯函数（DeepTutor SRS 精华）', () => {
  const srs = require('../core/memory/srs-scheduler');

  test('间隔表与 DeepTutor 一致', () => {
    expect(srs.SRS_INTERVALS.memory).toEqual([0, 1, 3, 7, 14, 30, 60]);
    expect(srs.SRS_INTERVALS.concept).toEqual([3, 7, 14, 30]);
    expect(srs.SRS_INTERVALS.procedure).toEqual([3, 7, 14]);
    expect(srs.SRS_INTERVALS.design).toEqual([14, 28]);
  });

  test('答对连对 1 次跳 1 级, 连对 2 次起跳 2 级', () => {
    expect(srs.updateLevel(0, true, 0, 'concept')).toEqual({ index: 1, nextStreak: 1 });
    expect(srs.updateLevel(1, true, 1, 'concept')).toEqual({ index: 3, nextStreak: 2 });
    expect(srs.updateLevel(0, true, 1, 'concept')).toEqual({ index: 2, nextStreak: 2 });
  });

  test('答错降 1 级且不低于 0, 连对清零', () => {
    expect(srs.updateLevel(2, false, 3, 'concept')).toEqual({ index: 1, nextStreak: 0 });
    expect(srs.updateLevel(0, false, 0, 'concept')).toEqual({ index: 0, nextStreak: 0 });
  });

  test('末级封顶不越界', () => {
    const max = srs.SRS_INTERVALS.concept.length - 1;
    expect(srs.updateLevel(max, true, 9, 'concept').index).toBe(max);
  });

  test('nextReviewAt 按间隔表推进; isDue 边界', () => {
    const base = 1_700_000_000_000;
    // concept 首级 3 天; memory 首级 0 天(立即)
    expect(srs.nextReviewAt(0, 'concept', base)).toBe(base + 3 * 86_400_000);
    expect(srs.nextReviewAt(1, 'concept', base)).toBe(base + 7 * 86_400_000);
    expect(srs.nextReviewAt(0, 'memory', base)).toBe(base);
    expect(srs.nextReviewAt(1, 'memory', base)).toBe(base + 1 * 86_400_000);
    expect(srs.isDue(base - 1, base)).toBe(true);
    expect(srs.isDue(base + 1, base)).toBe(false);
    expect(srs.isDue(null, base)).toBe(false);
    expect(srs.isDue(undefined, base)).toBe(false);
  });

  test('rowToSrs 容错 null/非数值', () => {
    expect(srs.rowToSrs(null)).toBeNull();
    expect(srs.rowToSrs({})).toEqual({ index: 0, dueAt: null, streak: 0, kind: 'concept' });
    expect(srs.rowToSrs({ srs_interval: 2, srs_due_at: 123, srs_streak: 4, kind: 'memory' })).toEqual({ index: 2, dueAt: 123, streak: 4, kind: 'memory' });
  });

  test('未知 kind 回落 concept 间隔表', () => {
    expect(srs.intervalsFor('nope')).toEqual(srs.SRS_INTERVALS.concept);
  });
});

// ==================== 2. unified-store 内容寻址 ====================

describe('unified-store 内容寻址（hash 去重底座）', () => {
  const { UnifiedMemoryStore } = require('../core/memory/unified-store');
  let store;

  beforeEach(() => {
    store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    store.initialize();
  });

  test('upsertDocument 带 hash/path 后可 findByHash 命中, 缺失 hash 返回 null', () => {
    const hash = crypto.createHash('sha256').update('doc-a').digest('hex');
    const id = store.upsertDocument({ title: 'A', content: 'a', source_hash: hash, source_path: '/tmp/a.md' });
    const hit = store.findByHash(hash);
    expect(hit).toBeTruthy();
    expect(hit.id).toBe(id);
    expect(hit.source_hash).toBe(hash);
    expect(hit.source_path).toBe('/tmp/a.md');
    expect(store.findByHash('deadbeef')).toBeNull();
    expect(store.findByHash(null)).toBeNull();
  });

  test('无 hash 更新不覆写已有 hash（幂等保列）', () => {
    const hash = crypto.createHash('sha256').update('doc-b').digest('hex');
    const id = store.upsertDocument({ title: 'B', content: 'b', source_hash: hash });
    store.upsertDocument({ id, title: 'B2', content: 'b2' }); // 不带 hash
    const row = store.getDocument(id);
    expect(row.source_hash).toBe(hash);
  });

  test('documents 表含 source_hash/source_path 列（新库走 CREATE, 旧库走 ALTER）', () => {
    const cols = store.all('PRAGMA table_info(documents)').map((c) => c.name);
    expect(cols).toContain('source_hash');
    expect(cols).toContain('source_path');
  });

  test('entities SRS 列存在且可写可读', () => {
    const cols = store.all('PRAGMA table_info(entities)').map((c) => c.name);
    expect(cols).toContain('srs_interval');
    expect(cols).toContain('srs_due_at');
    expect(cols).toContain('srs_streak');
    const id = store.upsertEntity({ name: 'E1', kind: 'concept' });
    store.applySrsReview(id, { index: 2, dueAtMs: 123456, streak: 3 });
    const row = store.getEntity(id);
    expect(row.srs_interval).toBe(2);
    expect(row.srs_due_at).toBe(123456);
    expect(row.srs_streak).toBe(3);
    expect(store.listDueEntities(200000).map((e) => e.id)).toContain(id);
    expect(store.listDueEntities(1000)).toHaveLength(0);
  });
});

// ==================== 3. ingestion-pipeline 哈希去重 ====================

describe('ingestion-pipeline 哈希去重', () => {
  const { IngestionPipeline } = require('../core/memory/ingestion-pipeline');

  test('sourceHash 命中已有文档 → DEDUPED 跳过切块, 发 item:deduped', async () => {
    const fakeStore = { findByHash: () => ({ id: 'doc_existing' }) };
    const pipe = new IngestionPipeline({ store: fakeStore });
    const deduped = [];
    pipe.on('item:deduped', (e) => deduped.push(e));
    const item = await pipe.ingestNow({ type: 'document', content: 'x', metadata: { sourceHash: 'h1' } });
    expect(item.stage).toBe('deduped');
    expect(item.dedupedDocumentId).toBe('doc_existing');
    expect(pipe.getStats().deduped).toBe(1);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].documentId).toBe('doc_existing');
  });

  test('无 sourceHash 不做去重检查', async () => {
    const hit = jest.fn();
    const pipe = new IngestionPipeline({ store: { findByHash: hit, upsertChunk: () => {}, upsertEntity: () => {}, run: () => {} } });
    const item = await pipe.ingestNow({ type: 'memory', content: 'y', metadata: {} });
    expect(hit).not.toHaveBeenCalled();
    expect(item.stage).toBe('complete');
  });

  test('item:failed 携带 type/metadata（kb-bookkeeping 记账依赖）', async () => {
    // 事务路径: upsertChunk 抛错 → transaction catch → item:failed 带 type/metadata
    const boom = {
      findByHash: () => null,
      transaction: (fn) => fn({ upsertChunk: () => { throw new Error('db boom'); } }),
    };
    const pipe = new IngestionPipeline({ store: boom });
    const failed = [];
    pipe.on('item:failed', (e) => failed.push(e));
    await pipe.ingestNow({ type: 'document', content: 'z', metadata: { sourceHash: 'h2' } });
    expect(failed).toHaveLength(1);
    expect(failed[0].type).toBe('document');
    expect(failed[0].metadata.sourceHash).toBe('h2');
    expect(failed[0].error).toContain('db boom');
  });

  test('去重检查抛错不炸 ingestNow（降级正常摄取）', async () => {
    const boom = {
      findByHash: () => { throw new Error('hash db error'); },
      upsertChunk: () => {}, upsertEntity: () => {}, run: () => {},
    };
    const pipe = new IngestionPipeline({ store: boom });
    const dedupFailed = [];
    pipe.on('dedup:failed', (e) => dedupFailed.push(e));
    const item = await pipe.ingestNow({ type: 'document', content: 'z', metadata: { sourceHash: 'h3' } });
    expect(dedupFailed).toHaveLength(1);
    expect(item.stage).toBe('complete'); // 降级完成而非失败
  });
});

// ==================== 4. knowledge-tools ====================

jest.mock('../core/memory/hybrid-retrieval', () => ({
  getHybridRetrievalEngine: () => global.__kbEngine,
}));

describe('knowledge-tools（KbSearch/KbList）', () => {
  const { registry } = require('../tools/registry');
  require('../tools/knowledge-tools');

  const fakeStore = {
    getDocument: (id) => {
      if (id === 'doc_1') return { id: 'doc_1', title: '合同分析', metadata: JSON.stringify({ source: 'document_analysis', sourcePath: '/tmp/contract.pdf' }), source_path: '/tmp/contract.pdf' };
      return null;
    },
    queryDocuments: () => [{ id: 'doc_1', title: '合同分析' }],
    get: () => ({ c: 1 }),
  };

  test('KbSearch 注册于 knowledge 工具集且契约字段齐备', () => {
    const t = registry.get('KbSearch');
    expect(t).toBeTruthy();
    expect(t.toolset).toBe('knowledge');
    expect(typeof t.handler).toBe('function');
    expect(t.schema.required).toEqual(['query']);
    expect(Array.isArray(t.whenNotToUse)).toBe(true);
  });

  test('KbSearch 结果带溯源（文档标题/来源路径）', async () => {
    global.__kbEngine = {
      _store: fakeStore,
      search: async () => [
        { id: 'chunk_1', type: 'chunk', content: '合同金额 500 万元，付款周期 90 天。', documentId: 'doc_1', combinedScore: 0.042 },
      ],
    };
    const r = await registry.get('KbSearch').handler({ query: '合同金额', limit: 3 }, { userId: 'test' });
    expect(r.success).toBe(true);
    expect(r.results).toHaveLength(1);
    expect(r.results[0].title).toBe('合同分析');
    expect(r.results[0].sourcePath).toBe('/tmp/contract.pdf');
    expect(r.results[0].source).toBe('document_analysis');
    expect(r.results[0].snippet).toContain('合同金额 500 万元');
  });

  test('KbSearch 空库 → 诚实提示而非编造', async () => {
    global.__kbEngine = {
      _store: { getDocument: () => null, queryDocuments: () => [], get: () => ({ c: 0 }) },
      search: async () => [],
    };
    const r = await registry.get('KbSearch').handler({ query: '不存在的东西' }, {});
    expect(r.success).toBe(true);
    expect(r.total).toBe(0);
    expect(r.message).toContain('暂无分析文档');
  });

  test('KbSearch 空检索词 → 拒绝', async () => {
    const r = await registry.get('KbSearch').handler({ query: '   ' }, {});
    expect(r.success).toBe(false);
  });

  test('KbList 返回文档清单（清单≠检索证据）', async () => {
    global.__kbEngine = undefined; // KbList 不走引擎, 用真实 store mock
    const { getUnifiedStore } = require('../core/memory/unified-store');
    const store = new (require('../core/memory/unified-store').UnifiedMemoryStore)({ dbPath: ':memory:' });
    store.initialize();
    store.upsertDocument({ title: '清单文档', content: 'x', metadata: JSON.stringify({ source: 'document_analysis' }) });
    const realGet = require('../core/memory/unified-store').getUnifiedStore;
    const orig = Object.getOwnPropertyDescriptor(require('../core/memory/unified-store'), 'getUnifiedStore');
    Object.defineProperty(require('../core/memory/unified-store'), 'getUnifiedStore', { value: () => store, configurable: true });
    try {
      const r = await registry.get('KbList').handler({ limit: 10 });
      expect(r.success).toBe(true);
      expect(r.total).toBe(1);
      expect(r.documents[0].title).toBe('清单文档');
    } finally {
      Object.defineProperty(require('../core/memory/unified-store'), 'getUnifiedStore', orig);
    }
    void realGet;
  });
});

// ==================== 5. kb-bookkeeping ====================

describe('kb-bookkeeping（记账 + 清单注入）', () => {
  // kb-bookkeeping 模块级缓存 _store/_subscribed——每用例 resetModules 拿全新模块
  const freshBk = () => { jest.resetModules(); return require('../core/memory/kb-bookkeeping'); };
  const withStore = (store, fn) => {
    const storeMod = require('../core/memory/unified-store');
    const orig = Object.getOwnPropertyDescriptor(storeMod, 'getUnifiedStore');
    Object.defineProperty(storeMod, 'getUnifiedStore', { value: () => store, configurable: true });
    return Promise.resolve(fn()).finally(() => {
      Object.defineProperty(storeMod, 'getUnifiedStore', orig);
    });
  };

  test('recordFailure/recordProcessed FIFO 上限', async () => {
    const bk = freshBk();
    const mem = new Map();
    const store = {
      getMeta: (k) => (mem.has(k) ? mem.get(k) : null),
      setMeta: (k, v) => mem.set(k, v),
      queryDocuments: () => [],
    };
    await withStore(store, () => {
      // 压过 50 上限
      for (let i = 0; i < 60; i++) bk.recordFailure({ kind: 'test', path: `/f${i}`, hash: `h${i}`, error: `e${i}` });
      expect(bk.getBookkeeping().failures).toHaveLength(50);
      expect(bk.getBookkeeping().failures[0].path).toBe('/f59'); // 最新在前
      for (let i = 0; i < 250; i++) bk.recordProcessed({ path: `/p${i}`, hash: `hp${i}`, documentId: `d${i}` });
      expect(bk.getBookkeeping().processed).toHaveLength(200);
    });
  });

  test('buildKnowledgeManifest: 空库返回空串, 有分析文档则含清单且强调须 KbSearch', async () => {
    const bk = freshBk();
    const store = {
      queryDocuments: () => [{ id: 'd1', title: '报告A', updated_at: 1750000000, metadata: JSON.stringify({ source: 'document_analysis' }) }],
    };
    await withStore(store, () => {
      const m = bk.buildKnowledgeManifest();
      expect(m).toContain('报告A');
      expect(m).toContain('KbSearch');
      expect(m).toContain('清单');
    });

    const bk2 = freshBk();
    const storeEmpty = { queryDocuments: () => [] };
    await withStore(storeEmpty, () => {
      expect(bk2.buildKnowledgeManifest()).toBe('');
    });
  });
});

// ==================== 6. tool-router kb_query 意图 ====================

describe('tool-router kb_query 意图（知识库读取路由）', () => {
  const { selectToolsForContext } = require('../core/ai/tool-router');
  const tsMap = {
    knowledge: [{ name: 'KbSearch' }, { name: 'KbList' }],
    interaction: [{ name: 'T' }], agent: [{ name: 'A' }], memory: [{ name: 'M' }],
    panel: [{ name: 'ShowHotspot' }], web: [{ name: 'WebSearch' }],
    file: [{ name: 'F' }], document: [{ name: 'D' }],
  };
  const toolSystem = { getByToolset: (t) => tsMap[t] || [], get: (n) => ({ name: n }) };
  const route = (message) => selectToolsForContext({ message, channel: 'gui', toolSystem });

  test('知识库问题 → kb_query 意图 + knowledge 工具可见', () => {
    const r = route('知识库里之前分析的合同里金额是多少');
    expect(r.intent).toBe('kb_query');
    expect(r.tools.map((t) => t.name)).toContain('KbSearch');
  });

  test('kb_query 不含 panel/web 集（弹卡守卫 + 不触发网络搜索）', () => {
    const r = route('查一下知识库中的文档');
    expect(r.toolsets).toContain('knowledge');
    expect(r.toolsets).not.toContain('panel');
    expect(r.tools.map((t) => t.name)).not.toContain('ShowHotspot');
    expect(r.tools.map((t) => t.name)).not.toContain('WebSearch');
  });

  test('general 意图含 knowledge 可选集, 不弹卡（KbSearch 纯文本, 任意话题可检索知识库）', () => {
    const r = route('帮我处理一下这个');
    expect(r.intent).toBe('general');
    expect(r.toolsets).toContain('knowledge');
    expect(r.toolsets).not.toContain('panel');
    expect(r.tools.map((t) => t.name)).toContain('KbSearch');
  });

  test('greeting 意图无 knowledge/panel（窄意图不加负载）', () => {
    const r = route('你好呀');
    expect(r.intent).toBe('greeting');
    expect(r.toolsets).not.toContain('knowledge');
    expect(r.toolsets).not.toContain('panel');
  });
});
