const crypto = require('crypto');
const { EventEmitter } = require('events');

class GraphEdge {
  constructor(subject, object, weight = 1) {
    this.subject = subject;
    this.object = object;
    this.weight = weight;
  }

  toJSON() {
    return { subject: this.subject, object: this.object, weight: this.weight };
  }
}

class TypedRelation {
  constructor(opts = {}) {
    this.id = opts.id || `rel_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.subject = opts.subject || '';
    this.relationType = opts.relationType || 'related_to';
    this.object = opts.object || '';
    this.confidence = opts.confidence ?? 0.5;
    this.source = opts.source || '';
    this.namespace = opts.namespace || 'global';
    this.createdAt = opts.createdAt || Date.now();
    this.metadata = opts.metadata || {};
  }

  toJSON() {
    return {
      id: this.id,
      subject: this.subject,
      relationType: this.relationType,
      object: this.object,
      confidence: this.confidence,
      source: this.source,
      namespace: this.namespace,
      createdAt: this.createdAt,
      metadata: this.metadata,
    };
  }

  static fromJSON(data) {
    return new TypedRelation(data);
  }
}

class EntityCoOccurrenceGraph extends EventEmitter {
  constructor(unifiedStore) {
    super();
    this._store = unifiedStore;
    this._edgeCache = new Map();
    this._entityIndex = new Map();
    this._typedRelations = new Map();
    this._relationIndex = new Map();
    this._llmExtractFn = null;
    this._accessCallback = null;
    this._entityReverseIndex = new Map();
  }

  setAccessCallback(fn) {
    this._accessCallback = fn
  }

  _recordAccess(entityId, relationId) {
    if (this._accessCallback) {
      try {
        this._accessCallback(entityId, relationId)
      } catch (e) { console.warn('访问回调执行失败:', e.message) }
    }
  }

  setLLMExtractFn(fn) {
    this._llmExtractFn = fn;
  }

  extractEntities(text, hotwords = []) {
    // 委托零依赖 pattern 抽取器（2026-08-20）
    const { extractEntities } = require('./entity-extractor');
    return extractEntities(text, hotwords);
  }

  getNodesForEntity(entityId) {
    if (this._store && typeof this._store.all === 'function') {
      try {
        const rows = this._store.all('SELECT node_id FROM entity_index WHERE entity_id = ?', [entityId]);
        return (rows || []).map((r) => r.node_id);
      } catch (e) { console.warn('getNodesForEntity 查询失败，回退内存索引:', e.message); }
    }
    const out = [];
    for (const [nodeId, entities] of this._entityIndex.entries()) {
      if (entities.some((en) => (typeof en === 'string' ? en : (en.canonicalId || en.id || String(en))) === entityId)) out.push(nodeId);
    }
    return out;
  }

  indexEntities(nodeId, entities, metadata = {}) {
    if (!entities || entities.length === 0) return;

    this._entityIndex.set(nodeId, entities);

    // 反向索引：entityId -> nodeIds（供 getNodesForEntity / 检索图谱通道）
    if (!this._entityReverseIndex) this._entityReverseIndex = new Map();
    for (const entity of entities) {
      const eid = typeof entity === 'string' ? entity : (entity.canonicalId || entity.id || String(entity));
      const set = this._entityReverseIndex.get(eid) || new Set();
      set.add(nodeId);
      this._entityReverseIndex.set(eid, set);
    }

    if (this._store && typeof this._store.run === 'function') {
      for (const entity of entities) {
        try {
          const eid = typeof entity === 'string' ? entity : (entity.canonicalId || entity.id || String(entity));
          const ekind = typeof entity === 'string' ? 'unknown' : (entity.kind || 'unknown');
          const esurface = typeof entity === 'string' ? entity : (entity.surface || entity.name || eid);
          const escore = typeof entity === 'number' ? 0 : (entity.score || 0);
          this._store.run(
            `INSERT OR REPLACE INTO entity_index (entity_id, node_id, node_kind, entity_kind, surface, score, timestamp_ms, tree_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              eid,
              nodeId,
              metadata.nodeKind || 'chunk',
              ekind,
              esurface,
              escore,
              metadata.timestampMs || Date.now(),
              metadata.treeId || null,
            ]
          );
        } catch (e) { console.warn('实体索引写入失败:', e.message) }
      }
    }

    this._updateEdgeCache(nodeId, entities);
    this.emit('entities:indexed', { nodeId, count: entities.length });
  }

  _updateEdgeCache(nodeId, entities) {
    for (const entity of entities) {
      const eid = entity.canonicalId || entity.id || entity;
      for (const other of entities) {
        const oid = other.canonicalId || other.id || other;
        if (eid === oid) continue;

        const key = eid < oid ? `${eid}|${oid}` : `${oid}|${eid}`;
        if (!this._edgeCache.has(key)) {
          this._edgeCache.set(key, { nodes: new Set(), weight: 0 });
        }
        const entry = this._edgeCache.get(key);
        if (!entry.nodes.has(nodeId)) {
          entry.nodes.add(nodeId);
          entry.weight++;
        }
      }
    }
  }

  coOccurringEntities(subjectEntity, limit = 100) {
    const results = [];

    // 实体级访问记录：共现查询返回的是缓存边（GraphEdge），无单一 TypedRelation，
    // 无 relationId 可传；typed relation 的访问计数在 graphQuery/findPath/
    // getRelatedEntities 的 rel 解析处补传（P1 知识强化数据源）
    this._recordAccess(subjectEntity)

    if (this._store && typeof this._store.all === 'function') {
      try {
        const rows = this._store.all(
          `SELECT b.entity_id AS object, COUNT(DISTINCT a.node_id) AS weight
             FROM entity_index a
             JOIN entity_index b ON a.node_id = b.node_id
            WHERE a.entity_id = ?
              AND b.entity_id <> ?
            GROUP BY b.entity_id
            ORDER BY weight DESC, object ASC
            LIMIT ?`,
          [subjectEntity, subjectEntity, limit]
        );
        for (const row of rows) {
          results.push(new GraphEdge(subjectEntity, row.object, row.weight || 1));
        }
        if (results.length > 0) return results;
      } catch (e) { console.warn('共现查询失败，回退到缓存:', e.message) }
    }

    for (const [key, entry] of this._edgeCache) {
      const [a, b] = key.split('|');
      if (a === subjectEntity) {
        results.push(new GraphEdge(a, b, entry.weight));
      } else if (b === subjectEntity) {
        results.push(new GraphEdge(b, a, entry.weight));
      }
    }

    results.sort((x, y) => y.weight - x.weight || x.object.localeCompare(y.object));
    return results.slice(0, limit);
  }

  neighbors(subjectEntity, limit = 100) {
    return this.coOccurringEntities(subjectEntity, limit).map(e => e.object);
  }

  groupByWeight(edges) {
    const groups = new Map();
    for (const edge of edges) {
      if (!groups.has(edge.weight)) {
        groups.set(edge.weight, []);
      }
      groups.get(edge.weight).push(edge.object);
    }
    return groups;
  }

  getEntityStats() {
    const entitySet = new Set();
    // eslint-disable-next-line no-unused-vars
    for (const [key, entry] of this._edgeCache) {
      const [a, b] = key.split('|');
      entitySet.add(a);
      entitySet.add(b);
    }
    return {
      entityCount: entitySet.size,
      edgeCount: this._edgeCache.size,
      nodeCount: this._entityIndex.size,
    };
  }

  clearNode(nodeId) {
    const entities = this._entityIndex.get(nodeId);
    if (!entities) return;

    for (const entity of entities) {
      const eid = entity.canonicalId || entity.id || entity;
      for (const other of entities) {
        const oid = other.canonicalId || other.id || other;
        if (eid === oid) continue;

        const key = eid < oid ? `${eid}|${oid}` : `${oid}|${eid}`;
        const entry = this._edgeCache.get(key);
        if (entry) {
          entry.nodes.delete(nodeId);
          entry.weight = Math.max(0, entry.weight - 1);
          if (entry.weight === 0) {
            this._edgeCache.delete(key);
          }
        }
      }
    }

    this._entityIndex.delete(nodeId);

    // 反向索引同步清理：防止残留 nodeId 幽灵关联（2026-08-20）
    for (const entity of entities) {
      const eid = typeof entity === 'string' ? entity : (entity.canonicalId || entity.id || String(entity));
      const set = this._entityReverseIndex.get(eid);
      if (set) {
        set.delete(nodeId);
        if (set.size === 0) this._entityReverseIndex.delete(eid);
      }
    }

    if (this._store && typeof this._store.run === 'function') {
      try {
        this._store.run('DELETE FROM entity_index WHERE node_id = ?', [nodeId]);
      } catch (e) { console.warn('清理实体索引失败:', e.message) }
    }
  }

  addTypedRelation(relationData) {
    const rel = relationData instanceof TypedRelation
      ? relationData
      : new TypedRelation(relationData);

    this._typedRelations.set(rel.id, rel);

    const subjectKey = rel.subject.toLowerCase();
    const objectKey = rel.object.toLowerCase();

    if (!this._relationIndex.has(subjectKey)) {
      this._relationIndex.set(subjectKey, []);
    }
    this._relationIndex.get(subjectKey).push(rel.id);

    if (!this._relationIndex.has(objectKey)) {
      this._relationIndex.set(objectKey, []);
    }
    this._relationIndex.get(objectKey).push(rel.id);

    if (this._store && typeof this._store.run === 'function') {
      try {
        // 2026-08-20 落库列修正：relations 表真实列为 source_entity/target_entity/namespace，
        // 旧语句写 subject_entity/object_entity/source 必抛且被吞（relations 从未持久化）。
        // created_at/updated_at 为 NOT NULL 无默认值，需显式写入（与 store.upsertRelation 同构）。
        const now = Date.now() / 1000;
        this._store.run(
          `INSERT OR REPLACE INTO relations (id, source_entity, relation_type, target_entity, confidence, namespace, metadata, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM relations WHERE id = ?), ?), ?)`,
          [rel.id, rel.subject, rel.relationType, rel.object, rel.confidence, rel.namespace,
            JSON.stringify(Object.assign({}, rel.metadata, { source: rel.source })),
            rel.id, now, now]
        );
      } catch (e) { console.warn('写入关系数据失败:', e.message) }
    }

    this.emit('relation:added', { id: rel.id, subject: rel.subject, type: rel.relationType, object: rel.object });
    return rel;
  }

  async extractAndAddRelations(text, opts = {}) {
    if (!this._llmExtractFn) return [];

    try {
      const triples = await this._llmExtractFn(text, {
        namespace: opts.namespace || 'global',
        source: opts.source || '',
      });

      const relations = [];
      for (const triple of triples) {
        const rel = this.addTypedRelation({
          subject: triple.subject,
          relationType: triple.relation || triple.predicate || 'related_to',
          object: triple.object,
          confidence: triple.confidence || 0.6,
          source: opts.source || 'llm_extraction',
          namespace: opts.namespace || 'global',
          metadata: { extractedAt: Date.now(), textSnippet: text.slice(0, 200) },
        });
        relations.push(rel);
      }

      return relations;
    } catch {
      return [];
    }
  }

  graphQuery(entity, relationType, depth = 2) {
    const results = [];
    const visited = new Set();
    const queue = [{ entity: entity.toLowerCase(), currentDepth: 0, path: [] }];

    this._recordAccess(entity)

    while (queue.length > 0) {
      const { entity: current, currentDepth, path } = queue.shift();

      if (visited.has(current)) continue;
      visited.add(current);

      const relIds = this._relationIndex.get(current) || [];
      for (const relId of relIds) {
        const rel = this._typedRelations.get(relId);
        if (!rel) continue;

        // P1: 补传 relationId——访问真实关系时计数，知识强化才可能发生
        this._recordAccess(entity, rel.id)

        if (relationType && rel.relationType !== relationType) continue;

        const nextEntity = rel.subject.toLowerCase() === current ? rel.object : rel.subject;
        const edge = {
          from: rel.subject,
          relationType: rel.relationType,
          to: rel.object,
          confidence: rel.confidence,
          direction: rel.subject.toLowerCase() === current ? 'outgoing' : 'incoming',
        };

        results.push({
          ...edge,
          depth: currentDepth + 1,
          path: [...path, edge],
        });

        if (currentDepth + 1 < depth && !visited.has(nextEntity.toLowerCase())) {
          queue.push({
            entity: nextEntity.toLowerCase(),
            currentDepth: currentDepth + 1,
            path: [...path, edge],
          });
        }
      }

      const coOccurring = this.coOccurringEntities(current, 10);
      for (const edge of coOccurring) {
        if (relationType && relationType !== 'co_occurrence') continue;

        const nextEntity = edge.object.toLowerCase();
        if (visited.has(nextEntity)) continue;

        results.push({
          from: current,
          relationType: 'co_occurrence',
          to: edge.object,
          confidence: edge.weight / 10,
          direction: 'undirected',
          depth: currentDepth + 1,
          path: [...path, { from: current, relationType: 'co_occurrence', to: edge.object }],
        });

        if (currentDepth + 1 < depth) {
          queue.push({
            entity: nextEntity,
            currentDepth: currentDepth + 1,
            path: [...path, { from: current, relationType: 'co_occurrence', to: edge.object }],
          });
        }
      }
    }

    return results;
  }

  findPath(entityA, entityB, maxDepth = 4) {
    const start = entityA.toLowerCase();
    const end = entityB.toLowerCase();

    this._recordAccess(entityA)
    this._recordAccess(entityB)

    if (start === end) return { found: true, path: [], distance: 0 };

    const visited = new Set([start]);
    const queue = [{ entity: start, path: [] }];

    while (queue.length > 0) {
      const { entity: current, path } = queue.shift();

      if (path.length >= maxDepth) continue;

      const relIds = this._relationIndex.get(current) || [];
      for (const relId of relIds) {
        const rel = this._typedRelations.get(relId);
        if (!rel) continue;

        // P1: 补传 relationId（findPath 实为访问 entityA 的关系）
        this._recordAccess(entityA, rel.id)

        const nextEntity = rel.subject.toLowerCase() === current ? rel.object.toLowerCase() : rel.subject.toLowerCase();
        if (visited.has(nextEntity)) continue;

        const edge = {
          from: rel.subject,
          relationType: rel.relationType,
          to: rel.object,
          confidence: rel.confidence,
        };

        const newPath = [...path, edge];

        if (nextEntity === end) {
          return { found: true, path: newPath, distance: newPath.length };
        }

        visited.add(nextEntity);
        queue.push({ entity: nextEntity, path: newPath });
      }

      const coOccurring = this.coOccurringEntities(current, 5);
      for (const edge of coOccurring) {
        const nextEntity = edge.object.toLowerCase();
        if (visited.has(nextEntity)) continue;

        const step = { from: current, relationType: 'co_occurrence', to: edge.object, confidence: edge.weight / 10 };
        const newPath = [...path, step];

        if (nextEntity === end) {
          return { found: true, path: newPath, distance: newPath.length };
        }

        visited.add(nextEntity);
        queue.push({ entity: nextEntity, path: newPath });
      }
    }

    return { found: false, path: [], distance: Infinity };
  }

  getRelatedEntities(entity, opts = {}) {
    const limit = opts.limit || 20;
    const minConfidence = opts.minConfidence || 0.3;
    const results = [];
    const entityLower = entity.toLowerCase();

    this._recordAccess(entity)

    const relIds = this._relationIndex.get(entityLower) || [];
    for (const relId of relIds) {
      const rel = this._typedRelations.get(relId);
      if (!rel || rel.confidence < minConfidence) continue;

      // P1: 补传 relationId——知识强化数据源
      this._recordAccess(entity, rel.id)

      const isSubject = rel.subject.toLowerCase() === entityLower;
      results.push({
        entity: isSubject ? rel.object : rel.subject,
        relationType: rel.relationType,
        confidence: rel.confidence,
        direction: isSubject ? 'outgoing' : 'incoming',
        source: rel.source,
      });
    }

    const coOccurring = this.coOccurringEntities(entity, limit);
    for (const edge of coOccurring) {
      results.push({
        entity: edge.object,
        relationType: 'co_occurrence',
        confidence: edge.weight / 10,
        direction: 'undirected',
        source: 'co_occurrence',
      });
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results.slice(0, limit);
  }

  getRelationStats() {
    const typeCounts = {};
    for (const rel of this._typedRelations.values()) {
      typeCounts[rel.relationType] = (typeCounts[rel.relationType] || 0) + 1;
    }

    return {
      totalRelations: this._typedRelations.size,
      totalEntities: this._relationIndex.size,
      byType: typeCounts,
      coOccurrenceEdges: this._edgeCache.size,
    };
  }
}

module.exports = {
  EntityCoOccurrenceGraph,
  GraphEdge,
  TypedRelation,
};
