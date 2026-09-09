const { getUnifiedStore } = require('./unified-store');
const { queryStateAt } = require('./temporal-state');
const { rewriteTemporal } = require('./temporal-rewrite');
const crypto = require('crypto');

class TemporalGraph {
  constructor() {
    this._store = null;
  }

  get store() {
    if (!this._store) {
      this._store = getUnifiedStore();
    }
    return this._store;
  }

  _genId() {
    return `tfact_${Date.now()}_${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;
  }

  addFact(subject, predicate, object, validFrom, options = {}) {
    const store = this.store;
    const now = Date.now();
    const validFromTs = typeof validFrom === 'number' ? validFrom : new Date(validFrom).getTime();
    const validTo = options.validTo || null;

    store.upsertEntity({ name: subject, kind: 'concept', aliases: [subject] });
    store.upsertEntity({ name: object, kind: 'concept', aliases: [object] });

    const subEntity = store.get('SELECT id FROM entities WHERE name = ?', [subject]);
    const objEntity = store.get('SELECT id FROM entities WHERE name = ?', [object]);

    if (!subEntity || !objEntity) return null;

    if (options.autoClose !== false) {
      const open = store.all(
        `SELECT * FROM relations
         WHERE source_entity = ? AND relation_type = 'temporal_fact'
         AND metadata LIKE ? AND valid_to IS NULL`,
        [subEntity.id, `%"predicate":"${predicate}"%`]
      );
      for (const rel of open) {
        store.run('UPDATE relations SET valid_to = ?, updated_at = ? WHERE id = ?', [validFromTs, now, rel.id]);
      }
    }

    const id = this._genId();
    store.run(
      `INSERT INTO relations (id, source_entity, target_entity, relation_type, namespace, confidence, metadata, valid_from, valid_to, created_at, updated_at)
       VALUES (?, ?, ?, 'temporal_fact', 'global', ?, ?, ?, ?, ?, ?)`,
      [id, subEntity.id, objEntity.id,
       options.confidence || 1.0,
       JSON.stringify({ subject, predicate, object, ...options.metadata }),
       validFromTs, validTo, now, now]
    );

    return { id, subject, predicate, object, validFrom: validFromTs, validTo };
  }

  queryAtTime(subject, predicate, pointInTime) {
    const store = this.store;
    const pit = typeof pointInTime === 'number' ? pointInTime : new Date(pointInTime).getTime();

    const subEntity = store.get('SELECT id FROM entities WHERE name = ?', [subject]);
    if (!subEntity) return [];

    const rows = store.all(
      `SELECT r.*, e.name as target_name
       FROM relations r
       JOIN entities e ON r.target_entity = e.id
       WHERE r.source_entity = ? AND r.relation_type = 'temporal_fact'
       AND r.valid_from <= ?
       AND (r.valid_to IS NULL OR r.valid_to > ?)
       ORDER BY r.valid_from DESC`,
      [subEntity.id, pit, pit]
    );

    return rows.map(r => {
      const meta = JSON.parse(r.metadata || '{}');
      return {
        id: r.id,
        subject: meta.subject || subject,
        predicate: meta.predicate,
        object: meta.object || r.target_name,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        confidence: r.confidence,
      };
    });
  }

  getTimeline(subject, predicate) {
    const store = this.store;
    const subEntity = store.get('SELECT id FROM entities WHERE name = ?', [subject]);
    if (!subEntity) return [];

    const rows = store.all(
      `SELECT r.*, e.name as target_name
       FROM relations r
       JOIN entities e ON r.target_entity = e.id
       WHERE r.source_entity = ? AND r.relation_type = 'temporal_fact'
       ${predicate ? "AND r.metadata LIKE ?" : ""}
       ORDER BY r.valid_from ASC`,
      predicate
        ? [subEntity.id, `%"predicate":"${predicate}"%`]
        : [subEntity.id]
    );

    return rows.map(r => {
      const meta = JSON.parse(r.metadata || '{}');
      return {
        id: r.id,
        subject: meta.subject || subject,
        predicate: meta.predicate,
        object: meta.object || r.target_name,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        confidence: r.confidence,
      };
    });
  }

  /**
   * 全图时点快照（semantica reconstruct_at_time 范式）：返回 t 时刻的活跃子图，
   * 覆盖全部 relation_type（不限 temporal_fact），关系自动剔除悬边/端点已失效者。
   * @param {number} t epoch 毫秒
   * @returns {{entities: Array, relations: Array}}
   */
  stateAt(t) {
    return queryStateAt(this.store, t);
  }

  /**
   * 时间意图查询（semantica TemporalQueryRewriter + temporal 检索闭环）：先改写查询中的
   * 时间短语（截至/之前/Q2 2022/上个月…），再用改写出的时点做 queryAtTime。
   * @param {string} subject
   * @param {string} predicate
   * @param {string} query 含时间意图的查询文本
   * @param {{now?: Date}} [opts]
   * @returns {{result: Array, rewrite: object}} rewrite 为 rewriteTemporal 的完整输出
   */
  queryWithTimeIntent(subject, predicate, query, opts = {}) {
    const rewrite = rewriteTemporal(query, opts);
    if (!rewrite.matched || rewrite.atTime == null) return { result: [], rewrite };
    return { result: this.queryAtTime(subject, predicate, rewrite.atTime), rewrite };
  }

  getStats() {
    const store = this.store;
    const factCount = store.get("SELECT COUNT(*) as cnt FROM relations WHERE relation_type = 'temporal_fact'");
    const openFacts = store.get("SELECT COUNT(*) as cnt FROM relations WHERE relation_type = 'temporal_fact' AND valid_to IS NULL");
    return {
      facts: factCount?.cnt || 0,
      openFacts: openFacts?.cnt || 0,
    };
  }
}

let _defaultTemporal = null;

function getTemporalGraph() {
  if (!_defaultTemporal) {
    _defaultTemporal = new TemporalGraph();
  }
  return _defaultTemporal;
}

module.exports = { TemporalGraph, getTemporalGraph };
