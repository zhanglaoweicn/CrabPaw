const EventEmitter = require('events')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const EVOLUTION_TYPES = {
  relation_discovery: { name: '关系发现', description: '从交互中自动发现实体间新关系' },
  entity_merge: { name: '实体合并', description: '合并相似或重复的实体' },
  knowledge_decay: { name: '知识衰减', description: '降低长期未使用知识的置信度' },
  knowledge_reinforce: { name: '知识强化', description: '提高频繁使用知识的置信度' },
  concept_abstraction: { name: '概念抽象', description: '从具体实体中抽象出更高层概念' },
  anomaly_detection: { name: '异常检测', description: '检测矛盾或异常的知识关系' },
}

const DECAY_RATE = 0.95
const REINFORCE_RATE = 1.05
const MIN_CONFIDENCE = 0.1
const MAX_CONFIDENCE = 1.0


class KnowledgeGraphEvolver extends EventEmitter {
  constructor(entityGraph, store = null) {
    super()
    this._graph = entityGraph
    /** @type {object|null} 统一存储（SQLite，UnifiedMemoryStore）——null 时内存态，重启归零 */
    this._store = store
    this._evolutionLog = []
    this._entityAccessCounts = new Map()
    this._relationAccessCounts = new Map()
    this._discoveredRelations = new Map()
    this._mergedEntities = new Map()
    this._maxLogSize = 200
    this._running = false
    this._intervalId = null
    this._stats = {
      relationsDiscovered: 0,
      entitiesMerged: 0,
      knowledgeDecayed: 0,
      knowledgeReinforced: 0,
      conceptsAbstracted: 0,
      anomaliesDetected: 0,
    }

    if (this._graph && typeof this._graph.setAccessCallback === 'function') {
      this._graph.setAccessCallback((entityId, relationId) => {
        this.recordEntityAccess(entityId)
        if (relationId) this.recordRelationAccess(relationId)
      })
    }

    // P1: 无 store 时显式标注内存态（重启归零），不再静默 typeof 跳过 SQLite 写入。
    // server.js 以 null 构造 EntityCoOccurrenceGraph → 此警告会打出，经 setStore() 补接。
    if (this._graph && !this._graph._store) {
      console.warn('[knowledge-graph-evolver] 图谱以内存态运行（graph 无统一存储）：关系/实体不落 SQLite，重启归零。请经 setStore() 注入 unified-store。')
    }
  }

  /**
   * P1 接线：注入统一存储并透传给底层图谱——addTypedRelation 的 SQLite 写入路径
   * 依赖 graph._store.run；构造传 null 时经此方法补接，使发现的关系真正持久化。
   * 另含记忆侧回源能力：仅保存引用 + 防御性校验，不重写进化逻辑。
   * @param {object|null} store - unified-store（UnifiedMemoryStore）
   */
  setStore(store) {
    this._store = store || null
    if (this._graph) {
      this._graph._store = this._store
    }
    if (this._store && typeof this._store.get !== 'function' && typeof this._store.all !== 'function') {
      console.warn('[knowledge-graph-evolver] setStore 收到的对象没有 get/all 方法，进化器将不使用该存储')
    }
    console.log('[knowledge-graph-evolver] store 已注入，图谱进化持久化启用')
  }
  start(intervalMs = 1800000) {
    if (this._running) return
    this._running = true
    this._intervalId = setInterval(() => this._evolutionCycle(), intervalMs)
    console.log('🧬 知识图谱进化器已启动')
  }

  stop() {
    if (!this._running) return
    this._running = false
    if (this._intervalId) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
    console.log('🧬 知识图谱进化器已停止')
  }

  recordEntityAccess(entityId) {
    this._entityAccessCounts.set(entityId, (this._entityAccessCounts.get(entityId) || 0) + 1)
  }

  recordRelationAccess(relationId) {
    this._relationAccessCounts.set(relationId, (this._relationAccessCounts.get(relationId) || 0) + 1)
  }

  async _evolutionCycle() {
    const results = []

    const decayResult = this._applyDecay()
    if (decayResult.changes > 0) results.push(decayResult)

    const reinforceResult = this._applyReinforcement()
    if (reinforceResult.changes > 0) results.push(reinforceResult)

    const discoveryResult = this._discoverRelations()
    if (discoveryResult.discoveries > 0) results.push(discoveryResult)

    const mergeResult = this._mergeSimilarEntities()
    if (mergeResult.merges > 0) results.push(mergeResult)

    const anomalyResult = this._detectAnomalies()
    if (anomalyResult.anomalies > 0) results.push(anomalyResult)

    if (results.length > 0) {
      globalSignalBus.emit({
        type: 'knowledge_graph_evolved',
        source: 'knowledge_graph_evolver',
        severity: SIGNAL_SEVERITY.INFO,
        detail: `知识图谱进化周期完成: ${results.map(r => r.type).join(', ')}`,
        metrics: { cycleResults: results.length },
      })
    }

    return results
  }

  _applyDecay() {
    if (!this._graph || !this._graph._typedRelations) {
      return { type: 'knowledge_decay', changes: 0 }
    }

    let changes = 0
    const now = Date.now()

    for (const [id, relation] of this._graph._typedRelations) {
      const accessCount = this._relationAccessCounts.get(id) || 0
      if (accessCount === 0) {
        const age = now - relation.createdAt
        const ageDays = age / 86400000
        if (ageDays > 7) {
          const oldConfidence = relation.confidence
          relation.confidence = Math.max(MIN_CONFIDENCE, relation.confidence * DECAY_RATE)
          if (relation.confidence !== oldConfidence) {
            changes++
            this._stats.knowledgeDecayed++
            this._logEvolution('knowledge_decay', {
              relationId: id,
              oldConfidence,
              newConfidence: relation.confidence,
              reason: `未访问 ${ageDays.toFixed(1)} 天`,
            })
          }
        }
      }
    }

    return { type: 'knowledge_decay', changes }
  }

  _applyReinforcement() {
    let changes = 0

    for (const [id, count] of this._relationAccessCounts) {
      if (count >= 3) {
        if (!this._graph || !this._graph._typedRelations) continue
        const relation = this._graph._typedRelations.get(id)
        if (!relation) continue

        const oldConfidence = relation.confidence
        relation.confidence = Math.min(MAX_CONFIDENCE, relation.confidence * REINFORCE_RATE)
        if (relation.confidence !== oldConfidence) {
          changes++
          this._stats.knowledgeReinforced++
          this._logEvolution('knowledge_reinforce', {
            relationId: id,
            oldConfidence,
            newConfidence: relation.confidence,
            accessCount: count,
          })
        }
      }
    }

    return { type: 'knowledge_reinforce', changes }
  }

  _discoverRelations() {
    if (!this._graph || !this._graph._entityIndex) {
      return { type: 'relation_discovery', discoveries: 0 }
    }

    let discoveries = 0
    const coOccurrence = new Map()

    // eslint-disable-next-line no-unused-vars -- 数组解构的 nodeId 未使用（遍历仅需 entities）
    for (const [nodeId, entities] of this._graph._entityIndex) {
      if (!entities || entities.length < 2) continue
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          const e1 = typeof entities[i] === 'string' ? entities[i] : (entities[i].canonicalId || entities[i].id || String(entities[i]))
          const e2 = typeof entities[j] === 'string' ? entities[j] : (entities[j].canonicalId || entities[j].id || String(entities[j]))
          const key = [e1, e2].sort().join('::')
          coOccurrence.set(key, (coOccurrence.get(key) || 0) + 1)
        }
      }
    }

    for (const [key, count] of coOccurrence) {
      if (count >= 2) {
        const [subject, object] = key.split('::')
        const existingKey = `${subject}_co_occurs_with_${object}`
        if (!this._discoveredRelations.has(existingKey)) {
          this._discoveredRelations.set(existingKey, {
            subject,
            object,
            relationType: 'co_occurs_with',
            confidence: Math.min(0.9, 0.3 + count * 0.1),
            coOccurrenceCount: count,
            discoveredAt: Date.now(),
          })
          discoveries++
          this._stats.relationsDiscovered++
          this._logEvolution('relation_discovery', {
            subject,
            object,
            relationType: 'co_occurs_with',
            confidence: Math.min(0.9, 0.3 + count * 0.1),
            coOccurrenceCount: count,
          })

          if (this._graph && typeof this._graph.addTypedRelation === 'function') {
            try {
              this._graph.addTypedRelation({
                subject,
                relationType: 'co_occurs_with',
                object,
                confidence: Math.min(0.9, 0.3 + count * 0.1),
                source: 'auto_discovery',
              })
            } catch (e) { console.warn('[knowledge-graph-evolver] failed to add relation:', e.message); }
          }
        }
      }
    }

    return { type: 'relation_discovery', discoveries }
  }

  _mergeSimilarEntities() {
    if (!this._graph || !this._graph._entityIndex) {
      return { type: 'entity_merge', merges: 0 }
    }

    let merges = 0
    const entityNames = new Map()

    for (const [nodeId, entities] of this._graph._entityIndex) {
      for (const entity of entities) {
        const name = typeof entity === 'string' ? entity : (entity.surface || entity.name || entity.canonicalId || String(entity))
        const normalizedName = name.toLowerCase().trim()
        if (!entityNames.has(normalizedName)) {
          entityNames.set(normalizedName, [])
        }
        entityNames.get(normalizedName).push({ nodeId, entity, originalName: name })
      }
    }

    const nameGroups = [...entityNames.entries()].filter(([_, entries]) => entries.length >= 2)
    for (const [normalizedName, entries] of nameGroups) {
      if (entries.length < 2) continue
      const uniqueNames = [...new Set(entries.map(e => e.originalName))]
      if (uniqueNames.length >= 2) {
        const canonicalName = uniqueNames.reduce((a, b) => a.length >= b.length ? a : b)
        if (!this._mergedEntities.has(normalizedName)) {
          this._mergedEntities.set(normalizedName, {
            canonicalName,
            variants: uniqueNames,
            count: entries.length,
            mergedAt: Date.now(),
          })
          merges++
          this._stats.entitiesMerged++
          this._logEvolution('entity_merge', {
            canonicalName,
            variants: uniqueNames,
            count: entries.length,
          })
        }
      }
    }

    return { type: 'entity_merge', merges }
  }

  _detectAnomalies() {
    if (!this._graph || !this._graph._typedRelations) {
      return { type: 'anomaly_detection', anomalies: 0 }
    }

    let anomalies = 0
    const relationPairs = new Map()

    // eslint-disable-next-line no-unused-vars -- 数组解构的 id 未使用（遍历仅需 relation）
    for (const [id, relation] of this._graph._typedRelations) {
      const pairKey = [relation.subject, relation.object].sort().join('::')
      if (!relationPairs.has(pairKey)) {
        relationPairs.set(pairKey, [])
      }
      relationPairs.get(pairKey).push(relation)
    }

    for (const [pairKey, relations] of relationPairs) {
      if (relations.length < 2) continue
      const types = new Set(relations.map(r => r.relationType))
      if (types.size > 1) {
        const conflictingTypes = [...types]
        anomalies++
        this._stats.anomaliesDetected++
        this._logEvolution('anomaly_detection', {
          pairKey,
          conflictingTypes,
          relationCount: relations.length,
          recommendation: `实体对 ${pairKey} 存在 ${conflictingTypes.length} 种关系类型, 可能需要消歧`,
        })
      }
    }

    return { type: 'anomaly_detection', anomalies }
  }

  _logEvolution(type, detail) {
    this._evolutionLog.push({
      type,
      detail,
      timestamp: Date.now(),
    })
    if (this._evolutionLog.length > this._maxLogSize) {
      this._evolutionLog = this._evolutionLog.slice(-this._maxLogSize / 2)
    }
  }

  getEvolutionLog(limit = 30) {
    return this._evolutionLog.slice(-limit)
  }

  getDiscoveredRelations() {
    return [...this._discoveredRelations.values()]
  }

  getMergedEntities() {
    return [...this._mergedEntities.values()]
  }

  getStats() {
    return { ...this._stats }
  }

  getStatus() {
    return {
      running: this._running,
      stats: this._stats,
      discoveredRelations: this._discoveredRelations.size,
      mergedEntities: this._mergedEntities.size,
      evolutionLogSize: this._evolutionLog.length,
    }
  }
}

let globalKnowledgeGraphEvolver = null

function initKnowledgeGraphEvolver(entityGraph, store = null) {
  globalKnowledgeGraphEvolver = new KnowledgeGraphEvolver(entityGraph, store)
  return globalKnowledgeGraphEvolver
}

module.exports = {
  KnowledgeGraphEvolver,
  initKnowledgeGraphEvolver,
  getGlobalKnowledgeGraphEvolver: () => globalKnowledgeGraphEvolver,
  EVOLUTION_TYPES,
}
