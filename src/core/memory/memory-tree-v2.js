const crypto = require('crypto');
const { EventEmitter } = require('events');

const TREE_KINDS = {
  SOURCE: 'source',
  GLOBAL: 'global',
  TOPIC: 'topic',
};

const BUCKET_SIZES = {
  [TREE_KINDS.SOURCE]: { maxLeaves: 20, maxSummaries: 8 },
  [TREE_KINDS.GLOBAL]: { maxLeaves: 40, maxSummaries: 12 },
  [TREE_KINDS.TOPIC]: { maxLeaves: 30, maxSummaries: 10 },
};

const SUMMARY_LEVELS = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
};

class TreeNode {
  constructor(opts = {}) {
    this.id = opts.id || `node_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.treeId = opts.treeId || '';
    this.level = opts.level ?? SUMMARY_LEVELS.L0;
    this.kind = opts.kind || 'leaf';
    this.content = opts.content || '';
    this.summary = opts.summary || '';
    this.tokenCount = opts.tokenCount || 0;
    this.children = opts.children || [];
    this.parentId = opts.parentId || null;
    this.metadata = opts.metadata || {};
    this.createdAt = opts.createdAt || Date.now();
    this.updatedAt = opts.updatedAt || Date.now();
    this.embedding = opts.embedding || null;
    this.score = opts.score || 0;
    this.timeRangeStart = opts.timeRangeStart || this.createdAt;
    this.timeRangeEnd = opts.timeRangeEnd || this.createdAt;
    this.entities = opts.entities || [];
    this.topics = opts.topics || [];
  }

  toJSON() {
    return {
      id: this.id,
      treeId: this.treeId,
      level: this.level,
      kind: this.kind,
      content: this.content,
      summary: this.summary,
      tokenCount: this.tokenCount,
      children: this.children,
      parentId: this.parentId,
      metadata: this.metadata,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      score: this.score,
      timeRangeStart: this.timeRangeStart,
      timeRangeEnd: this.timeRangeEnd,
      entities: this.entities,
      topics: this.topics,
    };
  }

  static fromJSON(data) {
    return new TreeNode(data);
  }
}

const TIME_SEAL_CONFIGS = {
  [TREE_KINDS.SOURCE]: { enabled: true, intervalMs: 24 * 60 * 60 * 1000 },
  [TREE_KINDS.GLOBAL]: { enabled: true, intervalMs: 24 * 60 * 60 * 1000 },
  [TREE_KINDS.TOPIC]: { enabled: true, intervalMs: 24 * 60 * 60 * 1000 },
};

const TIME_PERIODS = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  YEAR: 'year',
};

function _getPeriodBounds(period, referenceTime) {
  const ref = referenceTime || Date.now();
  const d = new Date(ref);
  let start, end;

  switch (period) {
    case TIME_PERIODS.DAY: {
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      end = start + 24 * 60 * 60 * 1000;
      break;
    }
    case TIME_PERIODS.WEEK: {
      const dayOfWeek = d.getDay() || 7;
      const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dayOfWeek + 1);
      start = monday.getTime();
      end = start + 7 * 24 * 60 * 60 * 1000;
      break;
    }
    case TIME_PERIODS.MONTH: {
      start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      break;
    }
    case TIME_PERIODS.YEAR: {
      start = new Date(d.getFullYear(), 0, 1).getTime();
      end = new Date(d.getFullYear() + 1, 0, 1).getTime();
      break;
    }
    default: {
      start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      end = start + 24 * 60 * 60 * 1000;
    }
  }

  return { start, end };
}

class MemoryTree extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.id = opts.id || `tree_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.kind = opts.kind || TREE_KINDS.GLOBAL;
    this.namespace = opts.namespace || 'global';
    this.topic = opts.topic || null;
    this.root = new TreeNode({ treeId: this.id, kind: 'root', level: SUMMARY_LEVELS.L3 });
    this.leaves = [];
    this.summaries = { [SUMMARY_LEVELS.L1]: [], [SUMMARY_LEVELS.L2]: [], [SUMMARY_LEVELS.L3]: [] };
    this.bucketConfig = BUCKET_SIZES[this.kind] || BUCKET_SIZES[TREE_KINDS.GLOBAL];
    this.timeSealConfig = { ...TIME_SEAL_CONFIGS[this.kind] || TIME_SEAL_CONFIGS[TREE_KINDS.GLOBAL], ...(opts.timeSealConfig || {}) };
    this._lastTimeSealAt = opts._lastTimeSealAt || null;
    this._store = opts.store || null;
    this._embedFn = opts.embedFn || null;
    this._summarizeFn = opts.summarizeFn || null;
    this._stats = {
      totalLeaves: 0,
      totalSummaries: 0,
      totalSeals: 0,
      lastSealAt: null,
      timeSeals: 0,
      recapQueries: 0,
    };
  }

  async appendLeaf(content, metadata = {}) {
    const tokenCount = this._estimateTokens(content);
    const leaf = new TreeNode({
      treeId: this.id,
      kind: 'leaf',
      level: SUMMARY_LEVELS.L0,
      content,
      tokenCount,
      metadata: { ...metadata, appendedAt: Date.now() },
    });

    this.leaves.push(leaf);
    this._stats.totalLeaves++;

    this.emit('leaf_appended', { treeId: this.id, leafId: leaf.id, tokenCount });

    if (this.timeSealConfig.enabled && this._shouldTimeSeal()) {
      await this._sealBucket();
    } else if (this.leaves.length >= this.bucketConfig.maxLeaves) {
      await this._sealBucket();
    }

    if (this._store) {
      await this._persistNode(leaf);
    }

    return leaf;
  }

  async _sealBucket() {
    if (this.leaves.length === 0) return;

    const bucketContent = this.leaves.map(l => l.content).join('\n\n---\n\n');
    const bucketTokenCount = this.leaves.reduce((sum, l) => sum + l.tokenCount, 0);

    let summary = '';
    if (this._summarizeFn) {
      try {
        summary = await this._summarizeFn(bucketContent, {
          treeKind: this.kind,
          leafCount: this.leaves.length,
          targetTokens: Math.ceil(bucketTokenCount * 0.3),
        });
      } catch (e) {
        summary = bucketContent.slice(0, 2000);
        this.emit('seal_summarize_error', { treeId: this.id, error: e.message });
      }
    } else {
      summary = bucketContent.slice(0, 2000);
    }

    const l1Node = new TreeNode({
      treeId: this.id,
      kind: 'summary',
      level: SUMMARY_LEVELS.L1,
      content: bucketContent,
      summary,
      tokenCount: this._estimateTokens(summary),
      children: this.leaves.map(l => l.id),
      timeRangeStart: this.leaves.length > 0 ? Math.min(...this.leaves.map(l => l.timeRangeStart)) : Date.now(),
      timeRangeEnd: this.leaves.length > 0 ? Math.max(...this.leaves.map(l => l.timeRangeEnd)) : Date.now(),
      entities: [...new Set(this.leaves.flatMap(l => l.entities || []))],
      topics: [...new Set(this.leaves.flatMap(l => l.topics || []))],
      metadata: {
        sealedAt: Date.now(),
        sourceLeafCount: this.leaves.length,
        sourceTokenCount: bucketTokenCount,
        compressionRatio: bucketTokenCount > 0 ? this._estimateTokens(summary) / bucketTokenCount : 0,
        sealReason: this.timeSealConfig.enabled && this._shouldTimeSeal() ? 'time' : 'count',
      },
    });

    if (this._embedFn) {
      try {
        l1Node.embedding = await this._embedFn(summary);
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    this.summaries[SUMMARY_LEVELS.L1].push(l1Node);
    this._stats.totalSummaries++;
    this._stats.totalSeals++;
    this._stats.lastSealAt = Date.now();

    this.emit('bucket_sealed', {
      treeId: this.id,
      level: SUMMARY_LEVELS.L1,
      nodeId: l1Node.id,
      leafCount: this.leaves.length,
      compressionRatio: l1Node.metadata.compressionRatio,
    });

    this.leaves = [];

    if (this.summaries[SUMMARY_LEVELS.L1].length >= this.bucketConfig.maxSummaries) {
      await this._cascadeSeal(SUMMARY_LEVELS.L1, SUMMARY_LEVELS.L2);
    }

    if (this._store) {
      await this._persistNode(l1Node);
    }

    return l1Node;
  }

  async _cascadeSeal(fromLevel, toLevel) {
    const sourceNodes = this.summaries[fromLevel];
    if (sourceNodes.length === 0) return;

    const combinedContent = sourceNodes.map(n => n.summary || n.content).join('\n\n---\n\n');
    const combinedTokenCount = sourceNodes.reduce((sum, n) => sum + n.tokenCount, 0);

    let summary = '';
    if (this._summarizeFn) {
      try {
        summary = await this._summarizeFn(combinedContent, {
          treeKind: this.kind,
          fromLevel,
          toLevel,
          sourceNodeCount: sourceNodes.length,
          targetTokens: Math.ceil(combinedTokenCount * 0.3),
        });
      } catch (e) {
        summary = combinedContent.slice(0, 2000);
      }
    } else {
      summary = combinedContent.slice(0, 2000);
    }

    const higherNode = new TreeNode({
      treeId: this.id,
      kind: 'summary',
      level: toLevel,
      content: combinedContent,
      summary,
      tokenCount: this._estimateTokens(summary),
      children: sourceNodes.map(n => n.id),
      timeRangeStart: sourceNodes.length > 0 ? Math.min(...sourceNodes.map(n => n.timeRangeStart)) : Date.now(),
      timeRangeEnd: sourceNodes.length > 0 ? Math.max(...sourceNodes.map(n => n.timeRangeEnd)) : Date.now(),
      entities: [...new Set(sourceNodes.flatMap(n => n.entities || []))],
      topics: [...new Set(sourceNodes.flatMap(n => n.topics || []))],
      metadata: {
        sealedAt: Date.now(),
        sourceLevel: fromLevel,
        sourceNodeCount: sourceNodes.length,
        sourceTokenCount: combinedTokenCount,
        compressionRatio: combinedTokenCount > 0 ? this._estimateTokens(summary) / combinedTokenCount : 0,
      },
    });

    if (this._embedFn) {
      try {
        higherNode.embedding = await this._embedFn(summary);
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }

    this.summaries[toLevel].push(higherNode);
    this._stats.totalSummaries++;

    this.emit('cascade_sealed', {
      treeId: this.id,
      fromLevel,
      toLevel,
      nodeId: higherNode.id,
      sourceNodeCount: sourceNodes.length,
    });

    this.summaries[fromLevel] = [];

    if (this._store) {
      await this._persistNode(higherNode);
    }

    return higherNode;
  }

  async query(queryText, opts = {}) {
    const limit = opts.limit || 10;
    const minLevel = opts.minLevel ?? SUMMARY_LEVELS.L0;
    const maxLevel = opts.maxLevel ?? SUMMARY_LEVELS.L3;
    const queryEmbedding = opts.queryEmbedding || null;

    let candidates = [];

    if (minLevel <= SUMMARY_LEVELS.L0) {
      for (const leaf of this.leaves) {
        let score = this._textRelevance(queryText, leaf.content);
        if (queryEmbedding && leaf.embedding) {
          const vecScore = this._cosineSimilarity(queryEmbedding, leaf.embedding);
          score = score * 0.4 + vecScore * 0.6;
        }
        candidates.push({ node: leaf, score, level: SUMMARY_LEVELS.L0 });
      }
    }

    for (const level of [SUMMARY_LEVELS.L1, SUMMARY_LEVELS.L2, SUMMARY_LEVELS.L3]) {
      if (level < minLevel || level > maxLevel) continue;
      for (const node of this.summaries[level]) {
        const text = node.summary || node.content;
        let score = this._textRelevance(queryText, text);
        if (queryEmbedding && node.embedding) {
          const vecScore = this._cosineSimilarity(queryEmbedding, node.embedding);
          score = score * 0.4 + vecScore * 0.6;
        }
        candidates.push({ node, score, level });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    candidates = candidates.slice(0, limit);

    return candidates.map(c => ({
      id: c.node.id,
      content: c.level === SUMMARY_LEVELS.L0 ? c.node.content : (c.node.summary || c.node.content),
      level: c.level,
      score: c.score,
      kind: c.node.kind,
      metadata: c.node.metadata,
      children: c.node.children,
      timeRangeStart: c.node.timeRangeStart,
      timeRangeEnd: c.node.timeRangeEnd,
      entities: c.node.entities,
      topics: c.node.topics,
    }));
  }

  async recap(timeRange, opts = {}) {
    const { start, end } = timeRange;
    const limit = opts.limit || 20;
    const minLevel = opts.minLevel ?? SUMMARY_LEVELS.L0;
    const maxLevel = opts.maxLevel ?? SUMMARY_LEVELS.L3;
    const preferLevel = opts.preferLevel ?? SUMMARY_LEVELS.L1;

    this._stats.recapQueries++;

    const candidates = [];

    if (minLevel <= SUMMARY_LEVELS.L0) {
      for (const leaf of this.leaves) {
        if (leaf.timeRangeStart >= start && leaf.timeRangeEnd <= end) {
          candidates.push({ node: leaf, level: SUMMARY_LEVELS.L0, timeMatch: 1.0 });
        } else if (leaf.timeRangeStart < end && leaf.timeRangeEnd > start) {
          const overlapStart = Math.max(leaf.timeRangeStart, start);
          const overlapEnd = Math.min(leaf.timeRangeEnd, end);
          const leafSpan = leaf.timeRangeEnd - leaf.timeRangeStart || 1;
          const overlap = (overlapEnd - overlapStart) / leafSpan;
          if (overlap > 0.1) {
            candidates.push({ node: leaf, level: SUMMARY_LEVELS.L0, timeMatch: overlap });
          }
        }
      }
    }

    for (const level of [SUMMARY_LEVELS.L1, SUMMARY_LEVELS.L2, SUMMARY_LEVELS.L3]) {
      if (level < minLevel || level > maxLevel) continue;
      for (const node of this.summaries[level]) {
        if (node.timeRangeStart >= start && node.timeRangeEnd <= end) {
          const levelBoost = level === preferLevel ? 0.2 : 0;
          candidates.push({ node, level, timeMatch: 1.0 + levelBoost });
        } else if (node.timeRangeStart < end && node.timeRangeEnd > start) {
          const overlapStart = Math.max(node.timeRangeStart, start);
          const overlapEnd = Math.min(node.timeRangeEnd, end);
          const nodeSpan = node.timeRangeEnd - node.timeRangeStart || 1;
          const overlap = (overlapEnd - overlapStart) / nodeSpan;
          if (overlap > 0.1) {
            const levelBoost = level === preferLevel ? 0.2 : 0;
            candidates.push({ node, level, timeMatch: overlap + levelBoost });
          }
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return b.timeMatch - a.timeMatch;
    });

    const deduped = [];
    const seenIds = new Set();
    for (const c of candidates) {
      if (!seenIds.has(c.node.id)) {
        seenIds.add(c.node.id);
        deduped.push(c);
      }
    }

    return deduped.slice(0, limit).map(c => ({
      id: c.node.id,
      content: c.level === SUMMARY_LEVELS.L0 ? c.node.content : (c.node.summary || c.node.content),
      level: c.level,
      timeMatch: c.timeMatch,
      kind: c.node.kind,
      timeRangeStart: c.node.timeRangeStart,
      timeRangeEnd: c.node.timeRangeEnd,
      entities: c.node.entities,
      topics: c.node.topics,
      children: c.node.children,
      metadata: c.node.metadata,
    }));
  }

  _shouldTimeSeal() {
    if (!this.timeSealConfig.enabled) return false;
    if (this.leaves.length === 0) return false;

    const now = Date.now();
    const intervalMs = this.timeSealConfig.intervalMs;

    if (!this._lastTimeSealAt) {
      const oldestLeaf = this.leaves.reduce((min, l) => l.timeRangeStart < min ? l.timeRangeStart : min, Infinity);
      if (now - oldestLeaf >= intervalMs) {
        this._lastTimeSealAt = now;
        this._stats.timeSeals++;
        return true;
      }
      return false;
    }

    if (now - this._lastTimeSealAt >= intervalMs) {
      this._lastTimeSealAt = now;
      this._stats.timeSeals++;
      return true;
    }

    return false;
  }

  async dailyDigest(opts = {}) {
    const referenceTime = opts.referenceTime || Date.now();
    const { start, end } = _getPeriodBounds(TIME_PERIODS.DAY, referenceTime);

    const recapResults = await this.recap({ start, end }, {
      minLevel: SUMMARY_LEVELS.L0,
      maxLevel: SUMMARY_LEVELS.L3,
      preferLevel: SUMMARY_LEVELS.L1,
      limit: 30,
    });

    if (recapResults.length === 0) {
      return {
        date: new Date(start).toISOString().split('T')[0],
        treeId: this.id,
        kind: this.kind,
        summary: null,
        entryCount: 0,
      };
    }

    const contentToSummarize = recapResults
      .filter(r => r.level <= SUMMARY_LEVELS.L1)
      .map(r => r.content)
      .join('\n\n---\n\n');

    let digest = '';
    if (this._summarizeFn && contentToSummarize) {
      try {
        digest = await this._summarizeFn(contentToSummarize, {
          treeKind: this.kind,
          period: TIME_PERIODS.DAY,
          targetTokens: 500,
        });
      } catch {
        digest = contentToSummarize.slice(0, 1000);
      }
    } else {
      digest = contentToSummarize.slice(0, 1000);
    }

    return {
      date: new Date(start).toISOString().split('T')[0],
      treeId: this.id,
      kind: this.kind,
      summary: digest,
      entryCount: recapResults.length,
      entities: [...new Set(recapResults.flatMap(r => r.entities || []))],
      topics: [...new Set(recapResults.flatMap(r => r.topics || []))],
      timeRange: { start, end },
    };
  }

  async drillDown(nodeId, opts = {}) {
    const depth = opts.depth || 1;
    const results = [];

    const searchInLevel = (nodes, id) => nodes.find(n => n.id === id);

    let target = searchInLevel(this.leaves, nodeId);
    if (target) {
      results.push({ node: target, level: SUMMARY_LEVELS.L0 });
      return results;
    }

    for (const level of [SUMMARY_LEVELS.L1, SUMMARY_LEVELS.L2, SUMMARY_LEVELS.L3]) {
      target = searchInLevel(this.summaries[level], nodeId);
      if (target) {
        results.push({ node: target, level });
        if (depth > 0 && target.children.length > 0) {
          const childLevel = level - 1;
          const childNodes = childLevel === SUMMARY_LEVELS.L0
            ? this.leaves
            : this.summaries[childLevel] || [];
          for (const childId of target.children) {
            const child = childNodes.find(n => n.id === childId);
            if (child) {
              results.push({ node: child, level: childLevel });
            }
          }
        }
        break;
      }
    }

    return results;
  }

  getDigest() {
    const topSummary = this.summaries[SUMMARY_LEVELS.L3][0]
      || this.summaries[SUMMARY_LEVELS.L2][0]
      || this.summaries[SUMMARY_LEVELS.L1][0];

    return {
      treeId: this.id,
      kind: this.kind,
      namespace: this.namespace,
      topic: this.topic,
      totalLeaves: this._stats.totalLeaves,
      totalSummaries: this._stats.totalSummaries,
      pendingLeaves: this.leaves.length,
      digest: topSummary ? (topSummary.summary || topSummary.content) : null,
      levels: {
        L0: this.leaves.length,
        L1: this.summaries[SUMMARY_LEVELS.L1].length,
        L2: this.summaries[SUMMARY_LEVELS.L2].length,
        L3: this.summaries[SUMMARY_LEVELS.L3].length,
      },
      stats: { ...this._stats },
    };
  }

  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  _textRelevance(query, text) {
    if (!query || !text) return 0;
    const qLower = query.toLowerCase();
    const tLower = text.toLowerCase();
    const qWords = qLower.split(/\s+/).filter(Boolean);
    if (qWords.length === 0) return 0;
    let matches = 0;
    for (const word of qWords) {
      if (tLower.includes(word)) matches++;
    }
    return matches / qWords.length;
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  async _persistNode(node) {
    if (!this._store) return;
    try {
      await this._store.saveTreeNode(this.id, node);
    } catch (e) {
      this.emit('persist_error', { treeId: this.id, nodeId: node.id, error: e.message });
    }
  }
}

class MemoryTreeOrchestrator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._trees = new Map();
    this._store = opts.store || null;
    this._embedFn = opts.embedFn || null;
    this._summarizeFn = opts.summarizeFn || null;
    this._autoSealInterval = opts.autoSealInterval || 300000;
    this._autoSealTimer = null;
  }

  async initialize() {
    if (this._store) {
      const trees = await this._store.loadAllTrees();
      for (const treeData of trees) {
        const tree = this._reconstructTree(treeData);
        this._trees.set(tree.id, tree);
      }
    }
    this._startAutoSeal();
    this.emit('initialized', { treeCount: this._trees.size });
  }

  _startAutoSeal() {
    if (this._autoSealTimer) clearInterval(this._autoSealTimer);
    this._autoSealTimer = setInterval(() => {
      this._autoSealAll();
    }, this._autoSealInterval);
  }

  async _autoSealAll() {
    for (const [id, tree] of this._trees) {
      if (tree.leaves.length > 0) {
        try {
          await tree._sealBucket();
        } catch (e) {
          this.emit('auto_seal_error', { treeId: id, error: e.message });
        }
      }
    }
  }

  getOrCreateTree(namespace, opts = {}) {
    const key = `${namespace}:${opts.topic || 'default'}`;
    if (this._trees.has(key)) return this._trees.get(key);

    const tree = new MemoryTree({
      id: key,
      kind: opts.kind || TREE_KINDS.GLOBAL,
      namespace,
      topic: opts.topic || null,
      store: this._store,
      embedFn: this._embedFn,
      summarizeFn: this._summarizeFn,
    });

    this._trees.set(key, tree);
    return tree;
  }

  async appendToTree(namespace, content, metadata = {}) {
    const tree = this.getOrCreateTree(namespace, {
      kind: metadata.treeKind || TREE_KINDS.SOURCE,
      topic: metadata.topic || null,
    });

    const leaf = await tree.appendLeaf(content, metadata);
    this.emit('content_appended', { namespace, treeId: tree.id, leafId: leaf.id });
    return leaf;
  }

  async queryTrees(namespace, queryText, opts = {}) {
    const results = [];
    // eslint-disable-next-line no-unused-vars
    for (const [key, tree] of this._trees) {
      if (tree.namespace !== namespace && namespace !== 'global') continue;
      const hits = await tree.query(queryText, opts);
      results.push(...hits.map(h => ({ ...h, treeId: tree.id, namespace: tree.namespace })));
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, opts.limit || 10);
  }

  async recapTrees(namespace, timeRange, opts = {}) {
    const results = [];
    // eslint-disable-next-line no-unused-vars
    for (const [key, tree] of this._trees) {
      if (tree.namespace !== namespace && namespace !== 'global') continue;
      const hits = await tree.recap(timeRange, opts);
      results.push(...hits.map(h => ({ ...h, treeId: tree.id, namespace: tree.namespace })));
    }
    results.sort((a, b) => {
      if (a.level !== b.level) return a.level - b.level;
      return (b.timeMatch || 0) - (a.timeMatch || 0);
    });
    return results.slice(0, opts.limit || 20);
  }

  async dailyDigestAll(namespace, opts = {}) {
    const digests = [];
    // eslint-disable-next-line no-unused-vars
    for (const [key, tree] of this._trees) {
      if (tree.namespace !== namespace && namespace !== 'global') continue;
      const digest = await tree.dailyDigest(opts);
      digests.push(digest);
    }
    return digests;
  }

  getTreeDigests(namespace) {
    const digests = [];
    // eslint-disable-next-line no-unused-vars
    for (const [key, tree] of this._trees) {
      if (tree.namespace !== namespace && namespace !== 'global') continue;
      digests.push(tree.getDigest());
    }
    return digests;
  }

  _reconstructTree(data) {
    const tree = new MemoryTree({
      id: data.id,
      kind: data.kind,
      namespace: data.namespace,
      topic: data.topic,
      store: this._store,
      embedFn: this._embedFn,
      summarizeFn: this._summarizeFn,
    });
    tree._stats = data.stats || tree._stats;
    return tree;
  }

  shutdown() {
    if (this._autoSealTimer) {
      clearInterval(this._autoSealTimer);
      this._autoSealTimer = null;
    }
    this.emit('shutdown');
  }
}

let _instance = null;

function getMemoryTreeOrchestrator(opts = {}) {
  if (!_instance) {
    _instance = new MemoryTreeOrchestrator(opts);
  }
  return _instance;
}


// === Merged from memory-tree-bridge.js ===
class MemoryTreeBridge {
  constructor(config = {}) {
    this._v1 = config.v1Engine || null;
    this._v2Trees = config.v2Trees || new Map();
    this._dedupCache = new Map();
    this._dedupTTL = config.dedupTTL || 3600000;
    this._lastDedupCleanup = Date.now();
  }

  setV1Engine(engine) {
    this._v1 = engine;
  }

  addV2Tree(tree) {
    this._v2Trees.set(tree.id, tree);
  }

  async append(content, opts = {}) {
    const contentHash = this._hashContent(content);

    if (this._isDuplicate(contentHash)) {
      return { duplicate: true, hash: contentHash };
    }

    this._dedupCache.set(contentHash, { timestamp: Date.now(), content: content.slice(0, 100) });

    const target = opts.target || 'v2';
    const treeKind = opts.treeKind || TREE_KINDS.GLOBAL;
    const namespace = opts.namespace || 'global';

    if (target === 'v2' || target === 'both') {
      const tree = this._findOrCreateV2Tree(treeKind, namespace, opts.topic);
      if (tree) {
        await tree.appendLeaf(content, opts.metadata || {});
      }
    }

    if (target === 'v1' || target === 'both') {
      if (this._v1) {
        const tree = this._v1.getOrCreateTree(treeKind, namespace);
        this._v1.appendLeaf(tree, {
          content,
          tokenCount: opts.tokenCount,
          entities: opts.entities || [],
          topics: opts.topics || [],
          score: opts.score || 0,
          timestamp: opts.timestamp || Date.now(),
        });
      }
    }

    return { duplicate: false, hash: contentHash, target };
  }

  async retrieve(query, opts = {}) {
    const limit = opts.limit || 10;
    const sources = opts.sources || ['v2', 'v1'];
    const allResults = [];

    if (sources.includes('v2')) {
      const v2Results = this._retrieveFromV2(query, opts);
      allResults.push(...v2Results.map(r => ({ ...r, source: 'v2' })));
    }

    if (sources.includes('v1') && this._v1) {
      const v1Results = this._v1.retrieve(query, opts);
      allResults.push(...v1Results.map(r => ({ ...r, source: 'v1' })));
    }

    const deduped = this._deduplicateResults(allResults);
    deduped.sort((a, b) => (b.relevance || b.score || 0) - (a.relevance || a.score || 0));

    return deduped.slice(0, limit);
  }

  async recap(timeRange, opts = {}) {
    const results = [];

    for (const [id, tree] of this._v2Trees) {
      if (typeof tree.recap === 'function') {
        try {
          const treeResults = await tree.recap(timeRange, opts);
          results.push(...treeResults.map(r => ({ ...r, treeId: id, source: 'v2' })));
        } catch { console.debug("best-effort: operation failed, continuing"); }
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    return results.slice(0, opts.limit || 20);
  }

  // eslint-disable-next-line no-unused-vars
  async migrateV1ToV2(opts = {}) {
    if (!this._v1) return { migrated: 0, errors: 0 };

    const migrated = [];
    const errors = [];

    for (const [key, tree] of this._v1.trees) {
      const [kind, scope] = key.includes(':') ? key.split(':') : [key, 'global'];
      const v2Tree = this._findOrCreateV2Tree(kind, scope);

      if (!v2Tree) {
        errors.push({ key, error: '无法创建V2树' });
        continue;
      }

      for (const [level, buffer] of tree.levels) {
        for (const item of buffer.items) {
          try {
            const contentHash = this._hashContent(item.content);
            if (this._isDuplicate(contentHash)) continue;

            await v2Tree.appendLeaf(item.content, {
              tokenCount: item.tokenCount,
              entities: item.entities || [],
              topics: item.topics || [],
              score: item.score || 0,
              timestamp: item.timestamp || item.createdAt || Date.now(),
            });

            this._dedupCache.set(contentHash, { timestamp: Date.now(), content: (item.content || '').slice(0, 100) });
            migrated.push({ v1Key: key, v1Level: level, itemId: item.id });
          } catch (e) {
            errors.push({ key, level, itemId: item.id, error: e.message });
          }
        }
      }

      for (const [nodeId, node] of this._v1.nodes) {
        try {
          const contentHash = this._hashContent(node.content);
          if (this._isDuplicate(contentHash)) continue;

          this._dedupCache.set(contentHash, { timestamp: Date.now(), content: (node.content || '').slice(0, 100) });
          migrated.push({ v1Key: key, nodeId, type: 'summary_node' });
        } catch (e) {
          errors.push({ key, nodeId, error: e.message });
        }
      }
    }

    return {
      migrated: migrated.length,
      errors: errors.length,
      details: { migrated, errors: errors.slice(0, 10) },
    };
  }

  getUnifiedStats() {
    const v1Stats = this._v1 ? this._v1.getStats() : { treeCount: 0, nodeCount: 0, leavesAppended: 0, summariesCreated: 0 };
    const v2Stats = { treeCount: this._v2Trees.size, trees: {} };

    for (const [id, tree] of this._v2Trees) {
      v2Stats.trees[id] = {
        kind: tree.kind,
        namespace: tree.namespace,
        leafCount: tree.leaves?.length || 0,
        stats: tree._stats || {},
      };
    }

    return {
      v1: v1Stats,
      v2: v2Stats,
      dedupCacheSize: this._dedupCache.size,
    };
  }

  _findOrCreateV2Tree(kind, namespace, topic) {
    // eslint-disable-next-line no-unused-vars
    for (const [id, tree] of this._v2Trees) {
      if (tree.kind === kind && tree.namespace === namespace && (tree.topic || null) === (topic || null)) {
        return tree;
      }
    }
    return null;
  }

  _retrieveFromV2(query, opts) {
    const results = [];
    // eslint-disable-next-line no-unused-vars
    for (const [id, tree] of this._v2Trees) {
      if (typeof tree.retrieve === 'function') {
        try {
          const treeResults = tree.retrieve(query, opts);
          results.push(...treeResults);
        } catch { console.debug("best-effort: operation failed, continuing"); }
      }
    }
    return results;
  }

  _isDuplicate(contentHash) {
    this._cleanupDedupCache();
    return this._dedupCache.has(contentHash);
  }

  _cleanupDedupCache() {
    const now = Date.now();
    if (now - this._lastDedupCleanup < 60000) return;

    for (const [hash, entry] of this._dedupCache) {
      if (now - entry.timestamp > this._dedupTTL) {
        this._dedupCache.delete(hash);
      }
    }
    this._lastDedupCleanup = now;
  }

  _deduplicateResults(results) {
    const seen = new Set();
    return results.filter(r => {
      const key = this._hashContent(r.content || r.summary || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _hashContent(content) {
    if (!content) return 'empty';
    const normalized = content.trim().toLowerCase().replace(/\s+/g, ' ');
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `h_${Math.abs(hash).toString(36)}`;
  }
}

let _bridgeInstance = null;

function _getMemoryTreeBridge(config) {
  if (!_bridgeInstance) {
    _bridgeInstance = new MemoryTreeBridge(config);
  }
  return _bridgeInstance;
}


module.exports = {
  MemoryTree,
  MemoryTreeOrchestrator,
  TreeNode,
  TREE_KINDS,
  SUMMARY_LEVELS,
  BUCKET_SIZES,
  TIME_SEAL_CONFIGS,
  TIME_PERIODS,
  getPeriodBounds: _getPeriodBounds,
  getMemoryTreeOrchestrator,
};
