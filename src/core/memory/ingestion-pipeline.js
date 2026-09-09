const crypto = require('crypto');
const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars -- require 解构中 getEmbeddingRouter 未用（不可删 require）
const { getEmbeddingRouter } = require('./embedding-router');
const { NamespaceManager, GLOBAL_NAMESPACE } = require('./namespace-manager');

const QUEUE_MAX_SIZE = 10000;
const WORKER_INTERVAL_MS = 500;
const BATCH_SIZE = 8;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

const INGESTION_STAGES = {
  CHUNK: 'chunk',
  EXTRACT_ENTITIES: 'extract_entities',
  EMBED: 'embed',
  INDEX: 'index',
  COMPLETE: 'complete',
  FAILED: 'failed',
  // 2026-08-20 DeepTutor 精华落地：内容哈希命中已存在文档 → 直接跳过切块/实体/嵌入
  DEDUPED: 'deduped',
};

class IngestionItem {
  constructor(opts) {
    this.id = opts.id || `ing_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.type = opts.type;
    this.content = opts.content || '';
    this.namespace = opts.namespace || GLOBAL_NAMESPACE;
    this.metadata = opts.metadata || {};
    this.stage = INGESTION_STAGES.CHUNK;
    this.retries = 0;
    this.createdAt = Date.now();
    this.processedAt = null;
    this.error = null;
    this.chunkIds = [];
    this.entityIds = [];
    this.embeddingGenerated = false;
  }
}

class IngestionPipeline extends EventEmitter {
  constructor(config = {}) {
    super();
    this._store = config.store || null;
    this._embeddingRouter = config.embeddingRouter || null;
    this._namespaceManager = config.namespaceManager || new NamespaceManager();

    this._queue = [];
    this._processing = false;
    this._workerTimer = null;
    this._maxQueueSize = config.maxQueueSize || QUEUE_MAX_SIZE;
    this._batchSize = config.batchSize || BATCH_SIZE;
    this._maxRetries = config.maxRetries || MAX_RETRIES;
    this._retryDelay = config.retryDelay || RETRY_DELAY_MS;
    this._chunkSize = config.chunkSize || 512;
    this._chunkOverlap = config.chunkOverlap || 64;

    this._stats = {
      ingested: 0,
      failed: 0,
      chunksCreated: 0,
      entitiesExtracted: 0,
      embeddingsGenerated: 0,
      avgProcessingTimeMs: 0,
      // 2026-08-20 内容哈希命中跳过计数（DeepTutor dedup 精华）
      deduped: 0,
    };

    this._entityPatterns = this._buildEntityPatterns();
  }

  setStore(store) {
    this._store = store;
  }

  setEmbeddingRouter(router) {
    this._embeddingRouter = router;
  }

  start() {
    if (this._workerTimer) return;
    this._processing = true;
    this._workerTimer = setInterval(() => this._processBatch(), WORKER_INTERVAL_MS);
    if (this._workerTimer.unref) this._workerTimer.unref();
    this.emit('pipeline:started');
  }

  stop() {
    this._processing = false;
    if (this._workerTimer) {
      clearInterval(this._workerTimer);
      this._workerTimer = null;
    }
    this.emit('pipeline:stopped');
  }

  enqueue(opts) {
    if (this._queue.length >= this._maxQueueSize) {
      this._queue.shift();
      this.emit('queue:overflow', { type: opts.type });
    }

    const item = new IngestionItem(opts);
    this._queue.push(item);
    this.emit('item:enqueued', { id: item.id, type: item.type, queueSize: this._queue.length });
    return item.id;
  }

  enqueueBatch(items) {
    const ids = [];
    for (const item of items) {
      ids.push(this.enqueue(item));
    }
    return ids;
  }

  async ingestNow(opts) {
    const item = new IngestionItem(opts);
    await this._processItem(item);
    return item;
  }

  getQueueSize() {
    return this._queue.length;
  }

  getStats() {
    return { ...this._stats, queueSize: this._queue.length };
  }

  async _processBatch() {
    if (!this._processing || this._queue.length === 0) return;
    if (!this._store) return;

    const batch = this._queue.splice(0, this._batchSize);

    for (const item of batch) {
      try {
        await this._processItem(item);
      } catch (e) {
        item.error = e.message;
        item.stage = INGESTION_STAGES.FAILED;
        this._stats.failed++;
        // 2026-08-20 补 type/metadata——kb-bookkeeping 按 type=document 记账
        this.emit('item:failed', { id: item.id, type: item.type, metadata: item.metadata, error: e.message });
      }
    }
  }

  async _processItem(item) {
    const startTime = Date.now();

    // 2026-08-20 DeepTutor 精华落地：内容哈希去重——同一来源内容不重复切块/建实体/嵌入。
    // 调用方已用 findByHash 前置跳过时这里也不会命中；双保险防并发重复写入。
    // sourceHash(camelCase, DocumentAnalyze) / source_hash(snake_case) 双兼容。
    // 去重检查失败降级为正常摄取（查重是优化不是闸门，不能因查重炸掉 ingestNow）。
    const sourceHash = (item.metadata && (item.metadata.sourceHash || item.metadata.source_hash)) || null;
    if (sourceHash && this._store && this._store.findByHash) {
      try {
        const existing = this._store.findByHash(sourceHash);
        if (existing) {
          item.stage = INGESTION_STAGES.DEDUPED;
          item.dedupedDocumentId = existing.id;
          item.processedAt = Date.now();
          this._stats.deduped = (this._stats.deduped || 0) + 1;
          this.emit('item:deduped', { id: item.id, documentId: existing.id, sourceHash });
          return;
        }
      } catch (e) {
        this.emit('dedup:failed', { id: item.id, error: e.message });
        console.warn('[ingestion-pipeline] 去重检查失败,降级正常摄取:', e.message);
      }
    }

    // Chunk content (pure computation, no DB)
    const chunks = this._chunkContent(item.content, item.metadata);
    item.chunkIds = chunks.map(c => c.id);
    item.stage = INGESTION_STAGES.CHUNK;

    // Extract entities (pure computation, no DB)
    const entities = this._extractEntities(item.content);
    item.entityIds = entities.map(e => e.id);
    item.stage = INGESTION_STAGES.EXTRACT_ENTITIES;

    // Wrap sequential DB operations in a transaction for atomicity
    if (this._store && typeof this._store.transaction === 'function') {
      try {
        this._store.transaction((store) => {
          for (const chunk of chunks) {
            chunk.namespace = item.namespace;
            store.upsertChunk(chunk);
          }
          for (const entity of entities) {
            store.upsertEntity(entity);
          }
          for (const entity of entities) {
            for (const chunkId of item.chunkIds) {
              store.run(
                `INSERT OR IGNORE INTO entity_index (entity_id, node_id, node_kind, entity_kind, surface, score, timestamp_ms)
                 VALUES (?, ?, 'chunk', ?, ?, ?, ?)`,
                [entity.id, chunkId, entity.kind, entity.name, 1.0, Date.now()]
              );
            }
          }
        });
      } catch (dbErr) {
        item.error = dbErr.message;
        item.stage = INGESTION_STAGES.FAILED;
        this._stats.failed++;
        // 2026-08-20 补 type/metadata——kb-bookkeeping 按 type=document 记账
        this.emit('item:failed', { id: item.id, type: item.type, metadata: item.metadata, error: dbErr.message });
        return;
      }
    } else {
      // Fallback: no transaction support, execute sequentially
      for (const chunk of chunks) {
        chunk.namespace = item.namespace;
        this._store.upsertChunk(chunk);
      }
      for (const entity of entities) {
        this._store.upsertEntity(entity);
      }
      for (const entity of entities) {
        for (const chunkId of item.chunkIds) {
          this._store.run(
            `INSERT OR IGNORE INTO entity_index (entity_id, node_id, node_kind, entity_kind, surface, score, timestamp_ms)
             VALUES (?, ?, 'chunk', ?, ?, ?, ?)`,
            [entity.id, chunkId, entity.kind, entity.name, 1.0, Date.now()]
          );
        }
      }
    }

    // Update stats after successful DB operations
    this._stats.chunksCreated += chunks.length;
    this._stats.entitiesExtracted += entities.length;

    // 2026-08-20: 图谱实喂——文档实体同步喂入图谱（best-effort）
    try {
      const { feedChunkEntities } = require('./knowledge-feed');
      for (const chunk of item.chunkIds || []) {
        feedChunkEntities({ nodeId: chunk, entities: item.entityIds || [] });
      }
    } catch (e) { console.error('[ingestion-pipeline] 图谱喂入失败（已忽略）:', e.message); }

    item.stage = INGESTION_STAGES.EMBED;

    if (this._embeddingRouter) {
      try {
        const chunkTexts = chunks.map(c => c.content);
        const embeddings = await this._embeddingRouter.embedBatch(chunkTexts);

        for (let i = 0; i < chunks.length; i++) {
          const buffer = this._embeddingToBuffer(embeddings[i]);
          if (buffer) {
            this._store.run('UPDATE chunks SET embedding = ? WHERE id = ?', [buffer, chunks[i].id]);
          }
        }
        item.embeddingGenerated = true;
        this._stats.embeddingsGenerated += chunks.length;
      } catch (e) {
        this.emit('embed:failed', { id: item.id, error: e.message });
      }
    }

    item.stage = INGESTION_STAGES.COMPLETE;
    item.processedAt = Date.now();
    this._stats.ingested++;

    const processingTime = item.processedAt - startTime;
    this._stats.avgProcessingTimeMs =
      this._stats.avgProcessingTimeMs === 0
        ? processingTime
        : (this._stats.avgProcessingTimeMs * 0.9 + processingTime * 0.1);

    this.emit('item:completed', {
      id: item.id,
      type: item.type,
      chunks: item.chunkIds.length,
      entities: item.entityIds.length,
      embedded: item.embeddingGenerated,
      processingTimeMs: processingTime,
    });
  }

  _chunkContent(content, metadata = {}) {
    if (!content || content.length === 0) return [];

    const chunkSize = metadata.chunkSize || this._chunkSize;
    const overlap = metadata.chunkOverlap || this._chunkOverlap;

    const chunks = [];
    let start = 0;
    let index = 0;

    while (start < content.length) {
      const end = Math.min(start + chunkSize, content.length);
      const chunkContent = content.slice(start, end);

      if (chunkContent.trim().length > 0) {
        const id = `chunk_${Date.now()}_${index}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;
        chunks.push({
          id,
          content: chunkContent,
          chunk_index: index,
          document_id: metadata.documentId || null,
          namespace: metadata.namespace || GLOBAL_NAMESPACE,
          metadata: { ...metadata, chunkStart: start, chunkEnd: end },
        });
      }

      start += chunkSize - overlap;
      index++;

      if (index > 100) break;
    }

    return chunks;
  }

  _extractEntities(content) {
    const entities = [];
    const seen = new Set();

    for (const [patternName, pattern] of Object.entries(this._entityPatterns)) {
      const matches = content.matchAll(pattern.regex);
      for (const match of matches) {
        const name = match[0].trim();
        if (name.length < 2 || name.length > 100) continue;
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());

        entities.push({
          id: `ent_${patternName}_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
          name,
          kind: pattern.kind,
          metadata: { pattern: patternName, confidence: pattern.confidence },
        });
      }
    }

    return entities;
  }

  _buildEntityPatterns() {
    return {
      email: {
        regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        kind: 'email',
        confidence: 0.95,
      },
      url: {
        regex: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
        kind: 'url',
        confidence: 0.9,
      },
      phone: {
        regex: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}/g,
        kind: 'phone',
        confidence: 0.7,
      },
      date: {
        regex: /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g,
        kind: 'date',
        confidence: 0.85,
      },
      person: {
        regex: /(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g,
        kind: 'person',
        confidence: 0.8,
      },
      organization: {
        regex: /(?:Inc\.|LLC|Corp\.|Ltd\.|Co\.|Group|Team|Department)\s+(?:of\s+)?[A-Z][a-zA-Z\s]+/g,
        kind: 'organization',
        confidence: 0.75,
      },
      technical: {
        regex: /(?:API|SDK|CLI|REST|GraphQL|OAuth|JWT|WebSocket|gRPC|SQL|NoSQL|Redis|Kafka|Docker|Kubernetes|AWS|GCP|Azure)/g,
        kind: 'technical',
        confidence: 0.85,
      },
      chinesePerson: {
        regex: /[\u4e00-\u9fff]{2,4}(?:老师|先生|女士|教授|博士|经理|总监|工程师)/g,
        kind: 'person',
        confidence: 0.8,
      },
    };
  }

  _embeddingToBuffer(embedding) {
    if (!embedding) return null;
    const f32 = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }
}

let _pipelineInstance = null;

function getIngestionPipeline(config) {
  if (!_pipelineInstance) {
    _pipelineInstance = new IngestionPipeline(config);
    // 接线默认依赖（与 hybrid-retrieval 修复一致）：
    // 历史 BUG：工厂不 setStore，pipeline 的 store 恒为 null，全部处理空转。
    try {
      const { getUnifiedStore } = require('./unified-store');
      _pipelineInstance.setStore(getUnifiedStore());
    } catch (e) {
      console.warn('[ingestion-pipeline] unified-store unavailable:', e.message);
    }
    try {
      const { getEmbeddingRouter } = require('./embedding-router');
      _pipelineInstance.setEmbeddingRouter(getEmbeddingRouter());
    } catch (e) {
      console.warn('[ingestion-pipeline] embedding-router unavailable:', e.message);
    }
  }
  return _pipelineInstance;
}

module.exports = {
  IngestionPipeline,
  IngestionItem,
  INGESTION_STAGES,
  getIngestionPipeline,
};
