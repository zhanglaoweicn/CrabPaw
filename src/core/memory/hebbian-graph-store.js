const { getUnifiedStore } = require('./unified-store');

// 2026-08-08 fix: 0.75→0.2——bigram jaccard 下 0.75 意味着内容 75% 相同,
// 现实记忆几乎不可能达到,waypoint 关联实际从未触发(与 FK/分词 bug 叠加三重失效)
const WAYPOINT_THRESHOLD = 0.2;
const WAYPOINT_BOOST = 0.05;
const WAYPOINT_MAX = 1.0;

const DEFAULT_CONFIG = {
  pruneThreshold: 0.1,
  pruneInterval: 100,
  entityKindMemory: 'memory',
  relationTypeWaypoint: 'waypoint',
};

class HebbianGraphStore {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._counter = 0;
    this._initialized = false;
  }

  get store() {
    if (!this._store) {
      this._store = getUnifiedStore();
    }
    return this._store;
  }

  async initialize() {
    if (this._initialized) return;
    this._initialized = true;
  }

  // 2026-08-08 fix: 中文分词——旧实现按空白/标点切分,中文无空格导致
  // 整句一个 token,jaccard 相似度恒≈0,waypoint 关联从未触发。
  // 改为: 英文按词 + 中文按字符 bigram。
  _tokenize(text) {
    const s = (text || '').toLowerCase();
    const enTokens = s.split(/[\s,.;:!?()[\]{}"'，。；：！？（）【】《》、·、-]+/)
      .filter(w => w.length >= 3 && !/^\d+$/.test(w));
    const cnChars = s.replace(/[a-z0-9\s,.;:!?()[\]{}"'，。；：！？（）【】《》、·-]+/g, '').split('');
    const cnBigrams = [];
    for (let i = 0; i + 1 < cnChars.length; i++) cnBigrams.push(cnChars[i] + cnChars[i + 1]);
    return [...enTokens, ...cnBigrams];
  }

  _jaccard(a, b) {
    const sa = new Set(a);
    const sb = new Set(b);
    const intersection = new Set([...sa].filter(x => sb.has(x)));
    const union = new Set([...sa, ...sb]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  _computeSimilarity(resultA, resultB) {
    const tokensA = this._tokenize((resultA.content || '') + ' ' + (resultA.title || ''));
    const tokensB = this._tokenize((resultB.content || '') + ' ' + (resultB.title || ''));
    return this._jaccard(tokensA, tokensB);
  }

  async associate(results, query) {
    if (!results || results.length < 2) return;

    const store = this.store;

    for (const r of results) {
      if (!r.id) continue;
      const entities = this._extractEntities(r);
      for (const e of entities) {
        store.upsertEntity({ name: e, kind: this.config.entityKindMemory, aliases: [e] });
      }
    }

    let bestPair = null;
    let bestScore = 0;

    for (let i = 0; i < results.length; i++) {
      for (let j = i + 1; j < results.length; j++) {
        const a = results[i], b = results[j];
        if (!a.id || !b.id) continue;
        const sim = this._computeSimilarity(a, b);
        if (sim > bestScore) {
          bestScore = sim;
          bestPair = { a, b };
        }
      }
    }

    if (!bestPair || bestScore < WAYPOINT_THRESHOLD) return;

    const { a, b } = bestPair;
    // 2026-08-08 fix: relations FK 要求 source/target 为 entities(id)——
    // 此前直接塞记忆 id(mem_xxx)导致每次写入 FOREIGN KEY constraint failed
    // (日志 26 次,waypoint 关联从未生效)。为记忆建实体,用实体 id 作关系端点。
    const srcEntityId = store.upsertEntity({ name: a.id, kind: this.config.entityKindMemory, aliases: [a.title || String(a.id)] });
    const tgtEntityId = store.upsertEntity({ name: b.id, kind: this.config.entityKindMemory, aliases: [b.title || String(b.id)] });
    const existing = store.getRelationsForEntity(srcEntityId, { namespace: 'global' });
    const prev = existing.find(r => r.target_entity === tgtEntityId && r.relation_type === this.config.relationTypeWaypoint);
    const newWeight = Math.min((prev?.confidence || 0) + WAYPOINT_BOOST, WAYPOINT_MAX);

    store.upsertRelation({
      source_entity: srcEntityId,
      target_entity: tgtEntityId,
      relation_type: this.config.relationTypeWaypoint,
      namespace: 'global',
      confidence: newWeight,
      metadata: { lastQuery: query, score: bestScore, direction: 'forward' },
    });

    // cross-type 双向链接（不同 sector 的记忆建立双向）
    if (a.type !== b.type) {
      store.upsertRelation({
        source_entity: tgtEntityId,
        target_entity: srcEntityId,
        relation_type: this.config.relationTypeWaypoint,
        namespace: 'global',
        confidence: newWeight,
        metadata: { lastQuery: query, score: bestScore, direction: 'reverse' },
      });
    }

    this._counter++;
    if (this._counter >= this.config.pruneInterval) {
      this._prune();
      this._counter = 0;
    }
  }

  getRelated(memoryId, limit = 5) {
    const store = this.store;
    // 2026-08-08 fix: 记忆实体 name 即记忆 id——先解析实体,relations 的
    // source/target 是实体 id,返回时把 target 实体名(记忆 id)作为结果 id
    const entity = store.findEntityByName(memoryId);
    if (!entity) return [];
    const relations = store.getRelationsForEntity(entity.id, { namespace: 'global' });
    return relations
      .filter(r => r.relation_type === this.config.relationTypeWaypoint)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, limit)
      .map(r => ({
        id: r.target_name || r.target_entity,
        weight: r.confidence,
        relationType: r.relation_type,
      }));
  }

  getStats() {
    const store = this.store;
    const entityCount = store.get('SELECT COUNT(*) as cnt FROM entities WHERE kind = ?', [this.config.entityKindMemory]);
    const relationCount = store.get('SELECT COUNT(*) as cnt FROM relations WHERE relation_type = ?', [this.config.relationTypeWaypoint]);
    return {
      entities: entityCount?.cnt || 0,
      relations: relationCount?.cnt || 0,
    };
  }

  _prune() {
    const store = this.store;
    store.run('DELETE FROM relations WHERE relation_type = ? AND confidence < ?', [this.config.relationTypeWaypoint, this.config.pruneThreshold]);
    store.run(`DELETE FROM entities WHERE kind = ? AND id NOT IN (SELECT DISTINCT source_entity FROM relations UNION SELECT DISTINCT target_entity FROM relations)`, [this.config.entityKindMemory]);
  }

  _extractEntities(memory) {
    const names = new Set();
    const text = [memory.title || '', memory.content || '', ...(memory.tags || []), memory.type || ''].join(' ');
    const words = text.split(/[\s,.;:!?()[\]{}"']+/).filter(w => w.length >= 3);
    for (const w of words) {
      const lower = w.toLowerCase();
      if (this._isStopWord(lower)) continue;
      if (/^\d+$/.test(w)) continue;
      names.add(w.slice(0, 100));
    }
    if (memory.tags) {
      for (const t of memory.tags) {
        if (t && t.length >= 2) names.add(t);
      }
    }
    return [...names].slice(0, 10);
  }

  _isStopWord(word) {
    const STOP_WORDS = new Set([
      'the', 'this', 'that', 'and', 'for', 'with', 'from', 'was',
      'are', 'have', 'has', 'had', 'not', 'but', 'all', 'can',
      'use', 'used', 'using', 'will', 'would', 'could', 'should',
      'about', 'which', 'what', 'when', 'where', 'how', 'who',
      'very', 'just', 'also', 'than', 'then', 'each', 'some',
      'these', 'those', 'into', 'over', 'such', 'only', 'other',
    ]);
    return STOP_WORDS.has(word) || word.length <= 2;
  }
}

module.exports = { HebbianGraphStore };
