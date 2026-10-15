const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars
const { cosineSimilarity, embeddingToBuffer, bufferToEmbedding } = require('./embedding-router');
const { NamespaceManager, GLOBAL_NAMESPACE } = require('./namespace-manager');
// OpenViking 工程逻辑思想移植（2026-10-15）：时间衰减排序 / 召回排除 / 分层摘要
const { applyEventTimeDecay } = require('./time-decay-ranking');
const { applyRecallExclusion, SessionRecallLedger } = require('./recall-exclusion');
const { applyLayeredSummary } = require('./layered-summary');

const DEFAULT_FTS_WEIGHT = 0.4;
const DEFAULT_VECTOR_WEIGHT = 0.4;
const DEFAULT_RECENCY_WEIGHT = 0.1;
const DEFAULT_IMPORTANCE_WEIGHT = 0.1;
const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_MAX_RESULTS = 20;

// RRF 融合参数
const RRF_K = 60; // Reciprocal Rank Fusion 的 k 参数

class HybridRetrievalEngine extends EventEmitter {
  constructor(config = {}) {
    super();
    this._store = config.store || null;
    this._embeddingRouter = config.embeddingRouter || null;
    this._namespaceManager = config.namespaceManager || new NamespaceManager();
    this._entityGraph = config.entityGraph || null; // Graph 通道

    this._ftsWeight = config.ftsWeight ?? DEFAULT_FTS_WEIGHT;
    this._vectorWeight = config.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    this._recencyWeight = config.recencyWeight ?? DEFAULT_RECENCY_WEIGHT;
    this._importanceWeight = config.importanceWeight ?? DEFAULT_IMPORTANCE_WEIGHT;
    this._minScore = config.minScore ?? DEFAULT_MIN_SCORE;
    this._maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS;

    // RRF 融合模式（默认启用）
    this._useRRF = config.useRRF !== false;

    // 事件时间衰减排序（OpenViking 思想，默认关闭）：
    // config.eventDecay = { halfLifeDays, weight, floor }，weight>0 才生效，
    // 保证既有 eval 基线零回归；启用前建议先跑 npm run eval A/B 对比。
    this._eventDecay = config.eventDecay || null;

    this._queryCache = new Map();
    this._queryCacheMax = 500;
    this._queryCacheTTL = 60000;
  }

  setStore(store) {
    this._store = store;
  }

  setEmbeddingRouter(router) {
    this._embeddingRouter = router;
  }

  setEntityGraph(graph) {
    this._entityGraph = graph;
  }

  async search(query, opts = {}) {
    const namespace = this._namespaceManager.resolve(opts.namespace || GLOBAL_NAMESPACE);
    const limit = opts.limit || this._maxResults;
    const searchTypes = opts.types || ['memory', 'chunk', 'document'];
    const minScore = opts.minScore ?? this._minScore;

    // 检索命名空间集合：个人命名空间查询时补 global 兜底
    // （提取事实等共享记忆写入 global 命名空间，个人查询也应收录）
    const namespaces =
      namespace === GLOBAL_NAMESPACE ? [namespace] : [namespace, GLOBAL_NAMESPACE];

    // 三路并行检索（跨命名空间聚合，RRF 融合按 id 去重）
    const ftsResults = [];
    const vectorResults = [];
    for (const ns of namespaces) {
      ftsResults.push(...(await this._searchFts(query, ns, searchTypes, limit * 3)));
      vectorResults.push(...(await this._searchVector(query, ns, searchTypes, limit * 3)));
    }
    // Graph 通道基于全局实体共现图，不按命名空间隔离
    const graphResults = await this._searchGraph(query, namespace, limit * 2);
    // 2026-10-09 目录感知第四路（TrieHI 思路）: 记忆树摘要级联先按"目录"(树/命名空间)
    // 收敛候选,再与 FTS/向量/图谱做 RRF 融合——摘要命中时内容以摘要层参与排序,
    // 全文经 ContextDrillDown 下钻,避免全文灌上下文。
    const treeResults = opts.includeTree === false
      ? []
      : await this._searchTree(query, namespace, limit * 2);

    if (this._useRRF) {
      // RRF 融合模式
      const fused = this._rrfFusion(ftsResults, vectorResults, graphResults, query, minScore, limit, treeResults);
      return this._postProcess(fused, opts, namespace);
    }

    // 原始加权融合模式（降级兼容）
    const merged = this._mergeResults(ftsResults, vectorResults, query);

    const scored = merged.map(item => {
      const recencyScore = this._computeRecencyScore(item);
      const importanceScore = this._computeImportanceScore(item);

      item.scores = {
        fts: item._ftsScore || 0,
        vector: item._vectorScore || 0,
        recency: recencyScore,
        importance: importanceScore,
      };

      item.combinedScore =
        this._ftsWeight * (item._ftsScore || 0) +
        this._vectorWeight * (item._vectorScore || 0) +
        this._recencyWeight * recencyScore +
        this._importanceWeight * importanceScore;

      return item;
    });

    const filtered = scored
      .filter(item => item.combinedScore >= minScore)
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, limit);

    for (const item of filtered) {
      item.provenance = this._buildProvenance(item, namespace);
    }

    this._namespaceManager.recordAccess(namespace, 'query');
    this.emit('search:completed', {
      query: query.slice(0, 100),
      namespace,
      ftsCount: ftsResults.length,
      vectorCount: vectorResults.length,
      graphCount: graphResults.length,
      resultCount: filtered.length,
    });

    return this._postProcess(filtered, opts, namespace);
  }

  /**
   * 检索后处理管线（OpenViking 工程逻辑思想移植接线，2026-10-15）。
   * 三步全部可选、默认旁路，保证既有检索行为与 eval 基线零回归：
   *   ① 事件时间衰减排序 —— 仅当构造时传入 config.eventDecay（weight>0）生效；
   *   ② 目录级召回排除 —— 仅当调用方传 opts.excludeUris / opts.sessionLedger 生效；
   *      会话账本命中冷却的条目被剔除，最终结果回写账本（markServed）形成闭环；
   *   ③ 分层摘要注入 —— 仅当传 opts.summaryDepth（'auto'|'abstract'|'overview'）生效，
   *      注入层写入 item.injectedText，item.content 原文保留供下钻。
   * @private
   */
  _postProcess(results, opts = {}, _namespace = '') {
    let items = results || [];

    // ① 事件时间衰减（检索侧，平滑指数半衰期）
    if (this._eventDecay && items.length) {
      items = applyEventTimeDecay(items, {
        weight: this._eventDecay.weight,
        halfLifeDays: this._eventDecay.halfLifeDays,
        floor: this._eventDecay.floor,
      });
    }

    // ② 目录级召回排除 + 会话冷却账本
    const wantsExclusion =
      (Array.isArray(opts.excludeUris) && opts.excludeUris.length > 0) || opts.sessionLedger;
    if (wantsExclusion && items.length) {
      const part = applyRecallExclusion(items, { excludeUris: opts.excludeUris, ledger: opts.sessionLedger });
      items = part.kept;
      if (part.excluded.length) {
        this.emit('recall:excluded', { count: part.excluded.length, items: part.excluded.slice(0, 20) });
      }
      // 服务闭环：本次真正返回的条目回写会话账本（仅记有 URI 的条目）
      if (opts.sessionLedger instanceof SessionRecallLedger) {
        for (const item of items) {
          const uri = item.uri || item.sourceUri || item.source_uri || item.path;
          if (uri) opts.sessionLedger.markServed(uri);
        }
      }
    }

    // ③ 分层摘要注入（abstract/overview 选层，原文保留）
    if (opts.summaryDepth && items.length) {
      items = applyLayeredSummary(items, {
        depth: opts.summaryDepth,
        budgetChars: opts.summaryBudgetChars,
        // 强制层缺失时从原文现算，预算沿用 summaryBudgetChars（缺省走模块默认值）
        abstractChars: opts.summaryBudgetChars,
        overviewChars: opts.summaryBudgetChars,
      });
    }

    return items;
  }

  async _searchFts(query, namespace, types, limit) {
    if (!this._store) return [];

    const results = [];
    const escapedQuery = query.replace(/"/g, '""');

    if (types.includes('memory')) {
      try {
        const memResults = this._store.searchMemories(query, {
          namespace: namespace !== GLOBAL_NAMESPACE ? namespace : undefined,
          limit,
        });
        for (const r of memResults) {
          results.push({
            id: r.id,
            type: 'memory',
            content: r.content,
            title: r.title || '',
            namespace: r.namespace || namespace,
            importance: r.importance || 0.5,
            trustScore: r.trust_score || 0.5,
            updatedAt: r.updated_at || r.updatedAt || Date.now() / 1000,
            _ftsScore: 0.7,
            _source: 'fts',
          });
        }
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    if (types.includes('chunk')) {
      try {
        const chunkResults = this._store.searchChunksFts(
          escapedQuery,
          namespace !== GLOBAL_NAMESPACE ? namespace : undefined,
          limit
        );
        for (const r of chunkResults) {
          results.push({
            id: r.id,
            type: 'chunk',
            content: r.content,
            documentId: r.document_id,
            namespace: r.namespace || namespace,
            importance: 0.5,
            updatedAt: r.updated_at || Date.now() / 1000,
            _ftsScore: 0.6,
            _source: 'fts',
          });
        }
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    return results;
  }

  async _searchVector(query, namespace, types, limit) {
    if (!this._store || !this._embeddingRouter) return [];

    let queryEmbedding;
    try {
      queryEmbedding = await this._embeddingRouter.embed(query);
    } catch {
      return [];
    }

    if (!queryEmbedding || queryEmbedding.every(v => v === 0)) return [];

    const results = [];

    if (types.includes('chunk')) {
      try {
        const vectorResults = this._store.searchVectors(namespace, queryEmbedding, limit);
        for (const r of vectorResults) {
          results.push({
            id: r.id,
            type: 'chunk',
            content: r.content,
            documentId: r.document_id,
            namespace: r.namespace || namespace,
            importance: 0.5,
            updatedAt: r.updated_at || Date.now() / 1000,
            _vectorScore: r.score || 0,
            _source: 'vector',
          });
        }
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    if (types.includes('memory')) {
      try {
        const memVectorResults = this._store.searchMemoryVectors(namespace, queryEmbedding, limit);
        for (const r of memVectorResults) {
          results.push({
            id: r.id,
            type: 'memory',
            content: r.content,
            title: r.title || '',
            namespace: r.namespace || namespace,
            importance: r.importance || 0.5,
            trustScore: r.trust_score || 0.5,
            updatedAt: r.updated_at || Date.now() / 1000,
            _vectorScore: r.score || 0,
            _source: 'vector',
          });
        }
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    return results;
  }

  /**
   * Graph 通道：通过实体链接扩展发现关联记忆
   * 参考 Hindsight 的 Link Expansion Retrieval
   */
  async _searchGraph(query, namespace, limit) {
    if (!this._entityGraph) return [];

    try {
      // 从查询中提取实体
      const queryEntities = this._entityGraph.extractEntities
        ? this._entityGraph.extractEntities(query)
        : this._simpleEntityExtract(query);

      if (queryEntities.length === 0) return [];

      // 通过实体共现图扩展：找到与查询实体关联的记忆节点
      const expandedIds = new Set();
      for (const entity of queryEntities.slice(0, 5)) {
        // 获取包含该实体的节点
        const relatedNodes = this._entityGraph.getNodesForEntity
          ? this._entityGraph.getNodesForEntity(entity)
          : [];

        for (const nodeId of relatedNodes.slice(0, limit)) {
          expandedIds.add(nodeId);
        }

        // 获取共现实体关联的节点。注意：coOccurringEntities 返回 GraphEdge 对象数组，
        // getNodesForEntity 期待字符串实体名——必须经 neighbors 映射为实体名
        // （2026-08-20 终审 I2：旧实现直接传 GraphEdge 对象 → store 绑定抛错被外层
        // catch 吞掉、内存索引字符串比对恒空，图谱通道整体失效）。
        const coEntities = this._entityGraph.neighbors
          ? this._entityGraph.neighbors(entity, 5)
          : [];

        for (const coEntity of coEntities) {
          const coNodes = this._entityGraph.getNodesForEntity
            ? this._entityGraph.getNodesForEntity(coEntity)
            : [];
          for (const nodeId of coNodes.slice(0, 3)) {
            expandedIds.add(nodeId);
          }
        }
      }

      // 从 store 中获取这些节点的详情
      if (!this._store || expandedIds.size === 0) return [];

      const results = [];
      for (const id of Array.from(expandedIds).slice(0, limit)) {
        try {
          const item = this._store.getMemory
            ? this._store.getMemory(id)
            : this._store.getChunk
              ? this._store.getChunk(id)
              : null;

          if (item) {
            results.push({
              id: item.id || id,
              type: item.type || 'memory',
              content: item.content || '',
              title: item.title || '',
              namespace: item.namespace || namespace,
              importance: item.importance || 0.5,
              updatedAt: item.updated_at || item.updatedAt || Date.now() / 1000,
              _graphScore: 0.5,
              _source: 'graph',
            });
          }
        } catch { console.debug("best-effort: operation failed, continuing"); }
      }

      return results;
    } catch (e) {
      // 图谱通道 best-effort：失败仅降级为空结果，但必须留痕（I2 曾在此吞掉 store 绑定抛错）
      console.warn('[hybrid-retrieval] _searchGraph 失败，返回空:', e.message || e);
      return [];
    }
  }

  /**
   * 简单实体提取（当 entityGraph 无 extractEntities 方法时降级）
   */
  _simpleEntityExtract(query) {
    const entities = [];
    // 提取大写开头的词组
    const capMatch = query.match(/[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g);
    if (capMatch) entities.push(...capMatch);

    // 提取中文关键词（2-4字）
    const cnMatch = query.match(/[\u4e00-\u9fff]{2,4}/g);
    if (cnMatch) entities.push(...cnMatch);

    // 提取技术术语
    const techMatch = query.match(/\b(?:React|Vue|Node|Python|Docker|API|SQL|Redis|MongoDB|TypeScript|JavaScript)\b/gi);
    if (techMatch) entities.push(...techMatch);

    return [...new Set(entities)].slice(0, 10);
  }

  /**
   * 2026-10-09 目录感知检索第四路：记忆树（memory-tree-v2）摘要级联。
   * best-effort：树未初始化/为空时返回 []，不影响主检索。
   * 结果 id 采用 treenode: 前缀避免与其他通道冲突；treeId 供下钻定位。
   */
  async _searchTree(query, namespace, limit) {
    try {
      const { getMemoryTreeOrchestrator } = require('./memory-tree-v2');
      const orch = getMemoryTreeOrchestrator();
      if (!orch || typeof orch.queryTrees !== 'function') return [];

      const hits = await orch.queryTrees(namespace, query, {
        limit,
        minLevel: 0,
        maxLevel: 3,
      });
      if (!Array.isArray(hits)) return [];

      return hits
        .filter(h => h && (h.score || 0) > 0.05)
        .map(h => ({
          id: `treenode:${h.id}`,
          type: 'tree_node',
          content: h.content || '',
          title: h.kind === 'summary' ? `记忆树摘要(L${h.level})` : '记忆树条目',
          namespace: h.namespace || namespace,
          treeId: h.treeId || null,
          nodeLevel: h.level,
          importance: 0.5,
          updatedAt: (h.timeRangeEnd || Date.now()) / 1000,
          _treeScore: Math.min(h.score || 0, 1),
          _source: 'tree',
        }));
    } catch (e) {
      // 树通道 best-effort：记忆树不可用时静默降级为空（首次部署常态）
      console.debug('[hybrid-retrieval] tree 通道不可用，降级为空:', e.message);
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF)
   * 参考 Hindsight 的多路检索融合算法
   *
   * 公式: rrf_score(d) = Σ 1/(k + rank_i(d))
   * 其中 k=60 是平滑参数，rank_i(d) 是文档 d 在第 i 路检索中的排名
   */
  _rrfFusion(ftsResults, vectorResults, graphResults, query, minScore, limit, treeResults = []) {
    const rrfScores = new Map();
    const itemMap = new Map();

    // 收集所有结果
    const allItems = [
      ...ftsResults.map(r => ({ ...r })),
      ...vectorResults.map(r => ({ ...r })),
      ...graphResults.map(r => ({ ...r })),
      ...treeResults.map(r => ({ ...r })),
    ];

    for (const item of allItems) {
      itemMap.set(item.id, item);
    }

    // FTS 路排序和 RRF 评分
    const ftsSorted = [...ftsResults].sort((a, b) => (b._ftsScore || 0) - (a._ftsScore || 0));
    for (let rank = 0; rank < ftsSorted.length; rank++) {
      const id = ftsSorted[rank].id;
      const score = rrfScores.get(id) || 0;
      rrfScores.set(id, score + 1 / (RRF_K + rank + 1));
    }

    // Vector 路排序和 RRF 评分
    const vecSorted = [...vectorResults].sort((a, b) => (b._vectorScore || 0) - (a._vectorScore || 0));
    for (let rank = 0; rank < vecSorted.length; rank++) {
      const id = vecSorted[rank].id;
      const score = rrfScores.get(id) || 0;
      rrfScores.set(id, score + 1 / (RRF_K + rank + 1));
    }

    // Graph 路排序和 RRF 评分
    const graphSorted = [...graphResults].sort((a, b) => (b._graphScore || 0) - (a._graphScore || 0));
    for (let rank = 0; rank < graphSorted.length; rank++) {
      const id = graphSorted[rank].id;
      const score = rrfScores.get(id) || 0;
      rrfScores.set(id, score + 1 / (RRF_K + rank + 1));
    }

    // Tree 路排序和 RRF 评分（目录感知第四路，2026-10-09）
    const treeSorted = [...treeResults].sort((a, b) => (b._treeScore || 0) - (a._treeScore || 0));
    for (let rank = 0; rank < treeSorted.length; rank++) {
      const id = treeSorted[rank].id;
      const score = rrfScores.get(id) || 0;
      rrfScores.set(id, score + 1 / (RRF_K + rank + 1));
    }

    // 合并最终结果
    const results = [];
    for (const [id, rrfScore] of rrfScores) {
      const item = itemMap.get(id);
      if (!item) continue;

      // 叠加时效和重要性微调
      const recencyScore = this._computeRecencyScore(item);
      const importanceScore = this._computeImportanceScore(item);
      const finalScore = rrfScore + recencyScore * 0.01 + importanceScore * 0.01;

      item.scores = {
        rrf: rrfScore,
        fts: item._ftsScore || 0,
        vector: item._vectorScore || 0,
        graph: item._graphScore || 0,
        recency: recencyScore,
        importance: importanceScore,
      };

      item.combinedScore = finalScore;
      item._source = this._determineSource(item);

      if (finalScore >= minScore * 0.1) { // RRF 分数尺度不同，调整阈值
        results.push(item);
      }
    }

    results.sort((a, b) => b.combinedScore - a.combinedScore);

    const filtered = results.slice(0, limit);
    for (const item of filtered) {
      item.provenance = this._buildProvenance(item, '');
    }

    this.emit('search:completed', {
      query: query.slice(0, 100),
      ftsCount: ftsResults.length,
      vectorCount: vectorResults.length,
      graphCount: graphResults.length,
      treeCount: treeResults.length,
      resultCount: filtered.length,
      fusionMethod: 'rrf',
    });

    return filtered;
  }

  _determineSource(item) {
    const sources = [];
    if (item._ftsScore) sources.push('fts');
    if (item._vectorScore) sources.push('vector');
    if (item._graphScore) sources.push('graph');
    if (item._treeScore) sources.push('tree');
    if (sources.length > 1) return 'hybrid';
    return sources[0] || item._source || 'unknown';
  }

  _mergeResults(ftsResults, vectorResults, _query) {
    const merged = new Map();

    for (const item of ftsResults) {
      merged.set(item.id, { ...item });
    }

    for (const item of vectorResults) {
      const existing = merged.get(item.id);
      if (existing) {
        existing._vectorScore = item._vectorScore || 0;
        existing._ftsScore = existing._ftsScore || item._ftsScore || 0;
        existing._source = 'hybrid';
      } else {
        merged.set(item.id, { ...item });
      }
    }

    return [...merged.values()];
  }

  _computeRecencyScore(item) {
    const updatedAt = item.updatedAt || item.updated_at || 0;
    if (!updatedAt) return 0.5;

    const ageSeconds = Date.now() / 1000 - updatedAt;
    const ageDays = ageSeconds / 86400;

    if (ageDays <= 1) return 1.0;
    if (ageDays <= 7) return 0.8;
    if (ageDays <= 30) return 0.6;
    if (ageDays <= 90) return 0.4;
    if (ageDays <= 365) return 0.2;
    return 0.1;
  }

  _computeImportanceScore(item) {
    const importance = item.importance || 0.5;
    const trustScore = item.trustScore || item.trust_score || 0.5;
    return (importance + trustScore) / 2;
  }

  async indexContent(id, content, opts = {}) {
    if (!this._store || !this._embeddingRouter) return;

    const namespace = this._namespaceManager.resolve(opts.namespace || GLOBAL_NAMESPACE);

    try {
      const embedding = await this._embeddingRouter.embed(content);
      const buffer = embeddingToBuffer(embedding);

      if (opts.type === 'chunk') {
        this._store.run(
          'UPDATE chunks SET embedding = ? WHERE id = ?',
          [buffer, id]
        );
      } else if (opts.type === 'memory') {
        this._store.run(
          'UPDATE memories SET embedding = ? WHERE id = ?',
          [buffer, id]
        );
      } else if (opts.type === 'tree_node') {
        this._store.run(
          'UPDATE tree_nodes SET embedding = ? WHERE id = ?',
          [buffer, id]
        );
      }

      this.emit('content:indexed', { id, type: opts.type, namespace });
    } catch (e) {
      this.emit('index:error', { id, error: e.message });
    }
  }

  async indexBatch(items) {
    if (!this._store || !this._embeddingRouter) return;

    const texts = items.map(item => item.content);
    const embeddings = await this._embeddingRouter.embedBatch(texts);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const embedding = embeddings[i];
      const buffer = embeddingToBuffer(embedding);

      try {
        if (item.type === 'chunk') {
          this._store.run('UPDATE chunks SET embedding = ? WHERE id = ?', [buffer, item.id]);
        } else if (item.type === 'memory') {
          this._store.run('UPDATE memories SET embedding = ? WHERE id = ?', [buffer, item.id]);
        }
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    this.emit('batch:indexed', { count: items.length });
  }

  _buildProvenance(item, namespace) {
    const sourceMap = {
      fts: '全文检索',
      vector: '向量语义检索',
      graph: '图谱关联检索',
      tree: '记忆树目录检索',
      hybrid: '混合检索(FTS+向量+图谱+记忆树)',
    };

    return {
      treeType: item.type === 'chunk' || item.type === 'tree_node' ? 'source' : item.type === 'memory' ? 'topic' : 'global',
      treeScope: namespace || 'global',
      nodeLevel: item.type === 'tree_node' ? (item.nodeLevel ?? 0) : item.type === 'chunk' ? 0 : item.type === 'memory' ? 1 : 2,
      nodeId: item.id,
      source: sourceMap[item._source] || item._source,
      searchMethod: item._source,
      documentId: item.documentId || null,
      treeId: item.treeId || null,
      scores: item.scores || {},
      // 引用溯源：供模型在回答时标注来源
      citation: item.citation || {
        id: item.id,
        title: item.title || item.id,
        type: item.type,
        category: item.category || '',
        source: sourceMap[item._source] || item._source,
        updatedAt: item.updatedAt || null,
      },
    };
  }

  async explainRetrieval(query, opts = {}) {
    const results = await this.search(query, { ...opts, limit: opts.limit || 5 });
    const explanation = {
      query,
      timestamp: Date.now(),
      weights: this.getWeights(),
      resultCount: results.length,
      explanations: [],
    };

    for (const result of results) {
      const prov = result.provenance || {};
      const scores = result.scores || {};
      const dominantSource = (scores.fts || 0) >= (scores.vector || 0) ? '全文检索' : '向量语义检索';
      const isHybrid = result._source === 'hybrid';

      const parts = [];
      parts.push(`来源: ${prov.source || '未知'}`);
      if (isHybrid) parts.push('(FTS和向量双路命中)');
      parts.push(`记忆类型: ${prov.treeType}`);
      parts.push(`层级: L${prov.nodeLevel}`);
      if (prov.documentId) parts.push(`文档ID: ${prov.documentId}`);

      parts.push(`评分详情: FTS=${(scores.fts || 0).toFixed(3)} × ${this._ftsWeight}, 向量=${(scores.vector || 0).toFixed(3)} × ${this._vectorWeight}, 时效=${(scores.recency || 0).toFixed(3)} × ${this._recencyWeight}, 重要性=${(scores.importance || 0).toFixed(3)} × ${this._importanceWeight}`);
      parts.push(`综合得分: ${(result.combinedScore || 0).toFixed(3)}`);

      explanation.explanations.push({
        id: result.id,
        contentPreview: (result.content || '').slice(0, 100),
        provenance: prov,
        dominantSource,
        isHybrid,
        combinedScore: result.combinedScore,
        humanReadable: parts.join(' | '),
      });
    }

    return explanation;
  }

  getWeights() {
    return {
      fts: this._ftsWeight,
      vector: this._vectorWeight,
      recency: this._recencyWeight,
      importance: this._importanceWeight,
    };
  }

  setWeights(weights) {
    if (weights.fts !== undefined) this._ftsWeight = weights.fts;
    if (weights.vector !== undefined) this._vectorWeight = weights.vector;
    if (weights.recency !== undefined) this._recencyWeight = weights.recency;
    if (weights.importance !== undefined) this._importanceWeight = weights.importance;
  }
}

let _engineInstance = null;

function getHybridRetrievalEngine(config) {
  if (!_engineInstance) {
    _engineInstance = new HybridRetrievalEngine(config);
    // 接线默认依赖：unified-store（数据源）+ embedding-router（向量通道）。
    // 历史 BUG：工厂不 setStore，导致三路检索全部空转（_store 恒为 null）。
    try {
      const { getUnifiedStore } = require('./unified-store');
      _engineInstance.setStore(getUnifiedStore());
    } catch (e) {
      console.warn('[hybrid-retrieval] unified-store unavailable:', e.message);
    }
    try {
      const { getEmbeddingRouter } = require('./embedding-router');
      _engineInstance.setEmbeddingRouter(getEmbeddingRouter());
    } catch (e) {
      console.warn('[hybrid-retrieval] embedding-router unavailable:', e.message);
    }
  }
  return _engineInstance;
}

module.exports = {
  HybridRetrievalEngine,
  getHybridRetrievalEngine,
  // OpenViking 思想移植模块（2026-10-15）随引擎一并导出，便于上层组合使用
  timeDecay: require('./time-decay-ranking'),
  recallExclusion: require('./recall-exclusion'),
  layeredSummary: require('./layered-summary'),
};
