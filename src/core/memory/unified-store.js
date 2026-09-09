const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { scoreChunk, ScoringConfig, approxTokenCount } = require('./scoring');

const DATA_DIR = require('../config').DATA_DIR;
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'unified-memory.db');

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  source_hash TEXT,
  source_path TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  score_signals TEXT DEFAULT '{}',
  admission_decision TEXT DEFAULT 'admit',
  metadata TEXT DEFAULT '{}',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'concept',
  aliases TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  mention_count INTEGER DEFAULT 0,
  last_seen_at REAL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  source_entity TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'related_to',
  namespace TEXT NOT NULL DEFAULT 'global',
  confidence REAL DEFAULT 0.5,
  metadata TEXT DEFAULT '{}',
  valid_from REAL,
  valid_to REAL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  FOREIGN KEY (source_entity) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (target_entity) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tree_nodes (
  id TEXT PRIMARY KEY,
  tree_type TEXT NOT NULL,
  tree_scope TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  summary TEXT,
  embedding BLOB,
  item_ids TEXT DEFAULT '[]',
  labels TEXT DEFAULT '[]',
  sealed INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  scope TEXT DEFAULT 'private',
  tags TEXT DEFAULT '[]',
  importance REAL DEFAULT 0.5,
  trust_score REAL DEFAULT 0.5,
  source TEXT DEFAULT 'manual',
  namespace TEXT DEFAULT 'global',
  embedding BLOB,
  access_count INTEGER DEFAULT 0,
  last_accessed REAL,
  valid_from REAL,
  valid_to REAL,
  recorded_at REAL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  sections TEXT DEFAULT '{}',
  context TEXT DEFAULT '{}',
  token_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  created_at REAL NOT NULL,
  last_accessed REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp REAL NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_memory (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  content TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  source TEXT NOT NULL DEFAULT 'agent_learning',
  metadata TEXT DEFAULT '{}',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_ns ON documents(namespace);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at);

CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_ns ON chunks(namespace);

CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE INDEX IF NOT EXISTS idx_relations_src ON relations(source_entity);
CREATE INDEX IF NOT EXISTS idx_relations_tgt ON relations(target_entity);
CREATE INDEX IF NOT EXISTS idx_relations_ns ON relations(namespace);

CREATE INDEX IF NOT EXISTS idx_tree_type_scope ON tree_nodes(tree_type, tree_scope, level);
CREATE INDEX IF NOT EXISTS idx_tree_sealed ON tree_nodes(sealed);

CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_ns ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_trust ON memories(trust_score);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_messages_session ON session_messages(session_id);

CREATE INDEX IF NOT EXISTS idx_tool_memory_name ON tool_memory(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_memory_priority ON tool_memory(priority);

CREATE TABLE IF NOT EXISTS entity_index (
  entity_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_kind TEXT NOT NULL DEFAULT 'chunk',
  entity_kind TEXT NOT NULL DEFAULT 'unknown',
  surface TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0,
  timestamp_ms INTEGER NOT NULL DEFAULT 0,
  tree_id TEXT,
  PRIMARY KEY (entity_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_index_node ON entity_index(node_id);
CREATE INDEX IF NOT EXISTS idx_entity_index_entity ON entity_index(entity_id);

CREATE TABLE IF NOT EXISTS user_profile_facets (
  id TEXT PRIMARY KEY,
  facet_class TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  cue_family TEXT NOT NULL DEFAULT 'behavioral',
  evidence_count INTEGER NOT NULL DEFAULT 1,
  stability_score REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'candidate',
  has_explicit INTEGER NOT NULL DEFAULT 0,
  last_seen_at REAL NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'global',
  metadata TEXT DEFAULT '{}',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_facets_class ON user_profile_facets(facet_class);
CREATE INDEX IF NOT EXISTS idx_facets_state ON user_profile_facets(state);
CREATE INDEX IF NOT EXISTS idx_facets_key ON user_profile_facets(key);
CREATE INDEX IF NOT EXISTS idx_facets_ns ON user_profile_facets(namespace);

CREATE TABLE IF NOT EXISTS conversation_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'global',
  start_message_id TEXT,
  end_message_id TEXT,
  summary TEXT,
  embedding BLOB,
  topic_tags TEXT DEFAULT '[]',
  turn_count INTEGER DEFAULT 0,
  token_count INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_session ON conversation_segments(session_id);
CREATE INDEX IF NOT EXISTS idx_segments_ns ON conversation_segments(namespace);
-- 决策溯源（2026-08-20 semantica 范式）：run 级决策记录 + SHA-256 哈希链
CREATE TABLE IF NOT EXISTS decisions (
  run_id TEXT PRIMARY KEY,
  round_id TEXT,
  user_intent TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  tool_digest TEXT NOT NULL DEFAULT '[]',
  conclusion TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT 'unknown',
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  created_at REAL,
  recorded_at REAL NOT NULL,
  sequence_id INTEGER NOT NULL,
  previous_checksum TEXT NOT NULL DEFAULT 'GENESIS',
  checksum TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_sequence ON decisions(sequence_id);
CREATE INDEX IF NOT EXISTS idx_segments_archived ON conversation_segments(archived);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id, namespace, content, metadata,
  content=chunks,
  content_rowid=rowid
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id, type, title, content, tags, namespace,
  content=memories,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, id, namespace, content, metadata)
    VALUES (new.rowid, new.id, new.namespace, new.content, new.metadata);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, namespace, content, metadata)
    VALUES ('delete', old.rowid, old.id, old.namespace, old.content, old.metadata);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, id, namespace, content, metadata)
    VALUES ('delete', old.rowid, old.id, old.namespace, old.content, old.metadata);
  INSERT INTO chunks_fts(rowid, id, namespace, content, metadata)
    VALUES (new.rowid, new.id, new.namespace, new.content, new.metadata);
END;

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, id, type, title, content, tags, namespace)
    VALUES (new.rowid, new.id, new.type, new.title, new.content, new.tags, new.namespace);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, type, title, content, tags, namespace)
    VALUES ('delete', old.rowid, old.id, old.type, old.title, old.content, old.tags, old.namespace);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, type, title, content, tags, namespace)
    VALUES ('delete', old.rowid, old.id, old.type, old.title, old.content, old.tags, old.namespace);
  INSERT INTO memories_fts(rowid, id, type, title, content, tags, namespace)
    VALUES (new.rowid, new.id, new.type, new.title, new.content, new.tags, new.namespace);
END;
`;

class UnifiedMemoryStore extends EventEmitter {
  constructor(config = {}) {
    super();
    this.dbPath = config.dbPath || DEFAULT_DB_PATH;
    this.db = null;
    this._initialized = false;
    this._stmtCache = new Map();
    this._scoringEnabled = config.scoringEnabled !== false;
    this._scoringConfig = new ScoringConfig(config.scoringConfig || {});
    this._ALLOWED_ORDER_COLUMNS = new Set([
      'updated_at', 'updated_at DESC', 'updated_at ASC',
      'created_at', 'created_at DESC', 'created_at ASC',
      'importance', 'importance DESC', 'importance ASC',
      'trust_score', 'trust_score DESC', 'trust_score ASC',
      'access_count', 'access_count DESC', 'access_count ASC',
      'title', 'title ASC', 'title DESC',
      'id', 'id ASC', 'id DESC',
    ]);
  }

  initialize() {
    if (this._initialized) return;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      const Database = require('better-sqlite3');
      this.db = new Database(this.dbPath, {
        verbose: process.env.CRABPAW_SQL_VERBOSE ? console.log : null,
      });
    } catch (e) {
      console.warn('⚠️ better-sqlite3 不可用，降级到 sql.js:', e.message);
      return this._initWithSqlJs();
    }

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // 启动时完整性检查
    try {
      const integrity = this.db.pragma('integrity_check');
      if (integrity && integrity.length > 0) {
        const result = integrity[0];
        if (result && result.integrity_check !== 'ok') {
          console.error(`[unified-store] database integrity check FAILED: ${JSON.stringify(result)}`);
        }
      }
    } catch (e) {
      console.warn('[unified-store] integrity check unavailable (sql.js fallback?):', e.message);
    }

    this.db.exec(SCHEMA_SQL);

    // 时序列迁移：为 relations 表添加 valid_from / valid_to（安全，列已存在时静默失败）
    try { this.db.exec('ALTER TABLE relations ADD COLUMN valid_from REAL'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] 空 catch 补日志:', e && e.message);
    }

    try { this.db.exec('ALTER TABLE relations ADD COLUMN valid_to REAL'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] 空 catch 补日志:', e && e.message);
    }

    // 2026-08-25 semantica 五轴轮：memories 时态列（条目级时间窗与记录时刻，可空向后兼容）。
    try { this.db.exec('ALTER TABLE memories ADD COLUMN valid_from REAL'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] memories.valid_from 迁移:', e && e.message);
    }
    try { this.db.exec('ALTER TABLE memories ADD COLUMN valid_to REAL'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] memories.valid_to 迁移:', e && e.message);
    }
    try { this.db.exec('ALTER TABLE memories ADD COLUMN recorded_at REAL'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] memories.recorded_at 迁移:', e && e.message);
    }

    // 2026-08-20 DeepTutor 精华落地：documents 内容寻址列（哈希去重/溯源）。
    // 旧库 CREATE TABLE IF NOT EXISTS 不补列，需 ALTER；duplicate column 为预期。
    try { this.db.exec('ALTER TABLE documents ADD COLUMN source_hash TEXT'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] documents.source_hash 迁移:', e && e.message);
    }
    try { this.db.exec('ALTER TABLE documents ADD COLUMN source_path TEXT'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] documents.source_path 迁移:', e && e.message);
    }

    // 2026-08-20 DeepTutor 精华落地：entities SRS 复习列（间隔重复学习循环）。
    // srs_interval=间隔表下标 / srs_due_at=下次到期 ms / srs_streak=连对次数。
    try { this.db.exec('ALTER TABLE entities ADD COLUMN srs_interval INTEGER'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] entities.srs_interval 迁移:', e && e.message);
    }
    try { this.db.exec('ALTER TABLE entities ADD COLUMN srs_due_at REAL'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] entities.srs_due_at 迁移:', e && e.message);
    }
    try { this.db.exec('ALTER TABLE entities ADD COLUMN srs_streak INTEGER'); } catch (e) {
      /* already exists */
      console.warn('[unified-store.js] entities.srs_streak 迁移:', e && e.message);
    }


    try {
      this.db.exec(FTS_SQL);
    } catch (e) {
      console.warn('⚠️ FTS5 初始化失败（可能不支持）:', e.message);
    }

    // Schema 版本管理：记录当前版本，便于后续迁移
    this._ensureSchemaVersion();

    this._initialized = true;
    console.log(`✅ 统一记忆存储已初始化: ${this.dbPath} (WAL模式)`);
    this.emit('initialized', { dbPath: this.dbPath });
  }

  async _initWithSqlJs() {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      this._isSqlJs = true;
    } else {
      this.db = new SQL.Database();
      this._isSqlJs = true;
      this.db.run(SCHEMA_SQL);
      try {
        this.db.exec(FTS_SQL);
      } catch (e) {

        // FTS5 may not be available in sql.js

        console.warn('[unified-store.js] 空 catch 补日志:', e && e.message);
      }

      this._persistSqlJs();
    }

    this._initialized = true;
    console.log(`✅ 统一记忆存储已初始化 (sql.js 降级模式): ${this.dbPath}`);
    this.emit('initialized', { dbPath: this.dbPath, fallback: true });
  }

  _persistSqlJs() {
    if (!this._isSqlJs || !this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  /**
   * Schema 版本管理：在 store_meta 表中记录当前 schema 版本
   * 后续 schema 变更时，可在 _runMigrations 中添加增量迁移逻辑
   */
  _ensureSchemaVersion() {
    const CURRENT_SCHEMA_VERSION = 1;
    try {
      const row = this.db.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get();
      const currentVersion = row ? parseInt(row.value, 10) : 0;
      if (currentVersion < CURRENT_SCHEMA_VERSION) {
        this._runMigrations(currentVersion, CURRENT_SCHEMA_VERSION);
        this.db.prepare("INSERT OR REPLACE INTO store_meta (key, value, updated_at) VALUES ('schema_version', ?, ?)")
          .run(String(CURRENT_SCHEMA_VERSION), Date.now() / 1000);
        console.log(`📦 Schema 版本已更新: ${currentVersion} → ${CURRENT_SCHEMA_VERSION}`);
      }
    } catch (e) {
      console.warn('⚠️ Schema 版本检查失败:', e.message);
    }
  }

  /**
   * 增量迁移：从 fromVersion 升级到 toVersion
   * 每个版本的迁移逻辑独立，按顺序执行
   */
  _runMigrations(fromVersion, toVersion) {
    const migrations = {
      // 示例：版本 0→1 的迁移
      // 1: (db) => {
      //   db.exec('ALTER TABLE memories ADD COLUMN new_field TEXT DEFAULT NULL');
      // },
    };

    for (let v = fromVersion + 1; v <= toVersion; v++) {
      const migration = migrations[v];
      if (migration) {
        try {
          migration(this.db);
          console.log(`📦 Schema 迁移 v${v} 完成`);
        } catch (e) {
          console.error(`❌ Schema 迁移 v${v} 失败:`, e.message);
          throw e;
        }
      }
    }
  }

  close() {
    if (this._isSqlJs) {
      this._persistSqlJs();
    }
    if (this.db && !this._isSqlJs) {
      this.db.close();
    }
    this.db = null;
    this._initialized = false;
  }

  _now() {
    return Date.now() / 1000;
  }

  _json(obj) {
    return JSON.stringify(obj || {});
  }

  _parse(json) {
    try {
      return JSON.parse(json || '{}');
    } catch {
      return {};
    }
  }

  /**
   * 列名白名单 — 防止 ORDER BY SQL 注入
   */
  _sanitizeOrderBy(orderBy, fallback) {
    if (typeof orderBy !== 'string' || !orderBy.trim()) return fallback;
    if (this._ALLOWED_ORDER_COLUMNS.has(orderBy)) return orderBy;
    console.warn(`[unified-store] rejected unsafe orderBy: ${orderBy}`);
    return fallback;
  }

  _genId(prefix = 'id') {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
  }

  prepare(sql) {
    if (this._isSqlJs) return null;
    if (!this._stmtCache.has(sql)) {
      this._stmtCache.set(sql, this.db.prepare(sql));
    }
    return this._stmtCache.get(sql);
  }

  run(sql, params) {
    if (this._isSqlJs) {
      this.db.run(sql, params);
      this._schedulePersist();
      return { changes: this.db.getRowsModified() };
    }
    const stmt = this.db.prepare(sql);
    return params ? stmt.run(params) : stmt.run();
  }

  get(sql, params) {
    if (this._isSqlJs) {
      const results = this.db.exec(sql, params);
      if (!results.length || !results[0].values.length) return undefined;
      const cols = results[0].columns;
      const row = results[0].values[0];
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    }
    const stmt = this.db.prepare(sql);
    return params ? stmt.get(params) : stmt.get();
  }

  all(sql, params) {
    if (this._isSqlJs) {
      const results = this.db.exec(sql, params);
      if (!results.length) return [];
      const cols = results[0].columns;
      return results[0].values.map(row => {
        const obj = {};
        cols.forEach((c, i) => { obj[c] = row[i]; });
        return obj;
      });
    }
    const stmt = this.db.prepare(sql);
    return params ? stmt.all(params) : stmt.all();
  }

  _persistTimer = null;
  _schedulePersist() {
    if (!this._isSqlJs) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistSqlJs();
      this._persistTimer = null;
    }, 2000);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  flush() {
    if (this._isSqlJs) this._persistSqlJs();
  }

  // ==================== Documents ====================

  upsertDocument(input) {
    const now = this._now();
    const id = input.id || this._genId('doc');
    // 2026-08-20 DeepTutor 精华落地：内容寻址列 source_hash/source_path——
    // 幂等更新不覆写来源（INSERT OR REPLACE 会整行替换, 新写入无 hash 时保留旧 hash）
    const existing = this.getDocument(id);
    const hash = input.source_hash || (existing && existing.source_hash) || null;
    const sourcePath = input.source_path || (existing && existing.source_path) || null;
    this.run(
      `INSERT OR REPLACE INTO documents (id, namespace, title, content, metadata, source_hash, source_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM documents WHERE id = ?), ?), ?)`,
      [id, input.namespace || 'global', input.title || '', input.content || '',
       this._json(input.metadata), hash, sourcePath, id, now, now]
    );
    this.emit('document:upserted', { id, namespace: input.namespace });
    return id;
  }

  getDocument(id) {
    return this.get('SELECT * FROM documents WHERE id = ?', [id]);
  }

  /** 内容寻址查重：按 source_hash 精确找已存在的文档（DeepTutor content-hash dedup 精华） */
  findByHash(sourceHash) {
    if (!sourceHash) return null;
    // better-sqlite3 .get() 无行返回 undefined——统一归一为 null（调用方按 falsy 处理）
    return this.get('SELECT * FROM documents WHERE source_hash = ? ORDER BY updated_at DESC LIMIT 1', [sourceHash]) || null;
  }

  deleteDocument(id) {
    this.run('DELETE FROM documents WHERE id = ?', [id]);
    this.run('DELETE FROM chunks WHERE document_id = ?', [id]);
    this.emit('document:deleted', { id });
  }

  queryDocuments(opts = {}) {
    const conditions = [];
    const params = [];
    if (opts.namespace) { conditions.push('namespace = ?'); params.push(opts.namespace); }
    if (opts.titleContains) { conditions.push('title LIKE ?'); params.push(`%${opts.titleContains}%`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = this._sanitizeOrderBy(opts.orderBy, 'updated_at DESC');
    const limit = opts.limit || 50;

    return this.all(
      `SELECT * FROM documents ${where} ORDER BY ${orderBy} LIMIT ?`,
      [...params, limit]
    );
  }

  // ==================== Chunks ====================

  upsertChunk(input) {
    const now = this._now();
    const id = input.id || this._genId('chunk');

    let scoreSignals = input.score_signals;
    let admissionDecision = input.admission_decision;

    if (!scoreSignals && this._scoringEnabled) {
      const scoreResult = scoreChunk(
        {
          id,
          content: input.content,
          metadata: input.metadata || {},
          tokenCount: input.token_count || approxTokenCount(input.content),
        },
        this._scoringConfig
      );
      scoreSignals = scoreResult.signals.toJSON();
      admissionDecision = scoreResult.kept ? 'admit' : 'drop';
      if (!scoreResult.kept) {
        this.emit('chunk:dropped', {
          id,
          total: scoreResult.total,
          reason: scoreResult.dropReason,
        });
      }
    }

    this.run(
      `INSERT OR REPLACE INTO chunks (id, document_id, namespace, content, chunk_index, embedding, score_signals, admission_decision, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM chunks WHERE id = ?), ?), ?)`,
      [id, input.document_id, input.namespace || 'global', input.content || '',
       input.chunk_index || 0, input.embedding || null,
       this._json(scoreSignals), admissionDecision || 'admit',
       this._json(input.metadata), id, now, now]
    );
    this.emit('chunk:upserted', { id, document_id: input.document_id, admissionDecision: admissionDecision || 'admit' });
    return id;
  }

  getChunksByDocument(documentId) {
    return this.all(
      'SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index',
      [documentId]
    );
  }

  getChunksByNamespace(namespace, limit = 100) {
    return this.all(
      'SELECT * FROM chunks WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?',
      [namespace, limit]
    );
  }

  // ==================== Vector Search ====================

  searchVectors(namespace, queryEmbedding, limit = 10) {
    const ns = namespace || 'global';
    const rows = this.all(
      'SELECT id, document_id, namespace, content, embedding, metadata FROM chunks WHERE namespace = ? AND embedding IS NOT NULL',
      [ns]
    );

    if (!rows.length) return [];

    return rows
      .map(row => {
        let score = 0;
        try {
          const embBuffer = row.embedding;
          if (embBuffer && queryEmbedding) {
            const stored = embBuffer instanceof Buffer
              ? new Float32Array(embBuffer.buffer, embBuffer.byteOffset, embBuffer.byteLength / 4)
              : embBuffer;
            score = this._cosineSimilarity(queryEmbedding, stored);
          }
        } catch { score = 0; }
        return {
          id: row.id,
          document_id: row.document_id,
          content: row.content,
          score,
          metadata: this._parse(row.metadata),
        };
      })
      .filter(r => r.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  searchMemoryVectors(namespace, queryEmbedding, limit = 10) {
    const ns = namespace || 'global';
    const rows = this.all(
      'SELECT id, type, title, content, namespace, tags, importance, trust_score, embedding, metadata FROM memories WHERE namespace = ? AND embedding IS NOT NULL',
      [ns]
    );

    if (!rows.length) return [];

    return rows
      .map(row => {
        let score = 0;
        try {
          const embBuffer = row.embedding;
          if (embBuffer && queryEmbedding) {
            const stored = embBuffer instanceof Buffer
              ? new Float32Array(embBuffer.buffer, embBuffer.byteOffset, embBuffer.byteLength / 4)
              : embBuffer;
            score = this._cosineSimilarity(queryEmbedding, stored);
          }
        } catch { score = 0; }
        return {
          id: row.id,
          type: row.type,
          title: row.title,
          content: row.content,
          namespace: row.namespace,
          importance: row.importance,
          trust_score: row.trust_score,
          score,
          metadata: this._parse(row.metadata),
        };
      })
      .filter(r => r.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  searchAllVectors(queryEmbedding, limit = 20) {
    const chunkResults = this.searchVectors('global', queryEmbedding, Math.ceil(limit / 2));
    const memoryResults = this.searchMemoryVectors('global', queryEmbedding, Math.ceil(limit / 2));
    return [...chunkResults, ...memoryResults]
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, limit);
  }

  queryByNamespace(namespace, opts = {}) {
    const limit = opts.limit || 50;
    const results = {
      documents: this.all('SELECT * FROM documents WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?', [namespace, limit]),
      chunks: this.all('SELECT * FROM chunks WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?', [namespace, limit]),
      memories: this.all('SELECT * FROM memories WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?', [namespace, limit]),
      relations: this.all('SELECT * FROM relations WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?', [namespace, limit]),
    };
    return results;
  }

  deleteNamespace(namespace) {
    if (namespace === 'global') {
      throw new Error('Cannot delete the global namespace');
    }
    let total = 0;
    total += this.run('DELETE FROM chunks WHERE namespace = ?', [namespace]).changes || 0;
    total += this.run('DELETE FROM documents WHERE namespace = ?', [namespace]).changes || 0;
    total += this.run('DELETE FROM memories WHERE namespace = ?', [namespace]).changes || 0;
    total += this.run('DELETE FROM relations WHERE namespace = ?', [namespace]).changes || 0;
    total += this.run('DELETE FROM conversation_segments WHERE namespace = ?', [namespace]).changes || 0;
    total += this.run('DELETE FROM user_profile_facets WHERE namespace = ?', [namespace]).changes || 0;
    this.emit('namespace:deleted', { namespace, itemsRemoved: total });
    return total;
  }

  getNamespaceStats(namespace) {
    return {
      documents: (this.get('SELECT COUNT(*) as c FROM documents WHERE namespace = ?', [namespace]) || {}).c || 0,
      chunks: (this.get('SELECT COUNT(*) as c FROM chunks WHERE namespace = ?', [namespace]) || {}).c || 0,
      memories: (this.get('SELECT COUNT(*) as c FROM memories WHERE namespace = ?', [namespace]) || {}).c || 0,
      relations: (this.get('SELECT COUNT(*) as c FROM relations WHERE namespace = ?', [namespace]) || {}).c || 0,
      entities: (this.get('SELECT COUNT(*) as c FROM entity_index WHERE node_id IN (SELECT id FROM chunks WHERE namespace = ?)', [namespace]) || {}).c || 0,
    };
  }

  listNamespaces() {
    const nsSets = new Set(['global']);
    for (const table of ['documents', 'chunks', 'memories', 'relations']) {
      try {
        const rows = this.all(`SELECT DISTINCT namespace FROM ${table}`);
        for (const r of rows) nsSets.add(r.namespace);
      } catch { console.debug("best-effort: operation failed, continuing"); }
    }
    return [...nsSets];
  }

  // ==================== Conversation Segments ====================

  upsertConversationSegment(input) {
    const now = this._now();
    const id = input.id || this._genId('seg');
    this.run(
      `INSERT OR REPLACE INTO conversation_segments (id, session_id, namespace, start_message_id, end_message_id, summary, embedding, topic_tags, turn_count, token_count, archived, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM conversation_segments WHERE id = ?), ?), ?)`,
      [id, input.session_id, input.namespace || 'global',
       input.start_message_id || null, input.end_message_id || null,
       input.summary || null, input.embedding || null,
       this._json(input.topic_tags || []), input.turn_count || 0,
       input.token_count || 0, input.archived ? 1 : 0,
       this._json(input.metadata), id, now, now]
    );
    this.emit('segment:upserted', { id, session_id: input.session_id });
    return id;
  }

  getConversationSegments(sessionId, opts = {}) {
    const conditions = ['session_id = ?'];
    const params = [sessionId];
    if (opts.archived !== undefined) {
      conditions.push('archived = ?');
      params.push(opts.archived ? 1 : 0);
    }
    return this.all(
      `SELECT * FROM conversation_segments WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
      params
    );
  }

  archiveOldSegments(sessionId, beforeTimestamp) {
    return this.run(
      'UPDATE conversation_segments SET archived = 1, updated_at = ? WHERE session_id = ? AND created_at < ?',
      [this._now(), sessionId, beforeTimestamp]
    );
  }

  // ==================== User Profile Facets ====================

  upsertFacet(input) {
    const now = this._now();
    const id = input.id || this._genId('facet');
    this.run(
      `INSERT OR REPLACE INTO user_profile_facets (id, facet_class, key, value, cue_family, evidence_count, stability_score, state, has_explicit, last_seen_at, namespace, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM user_profile_facets WHERE id = ?), ?), ?)`,
      [id, input.facet_class, input.key, input.value,
       input.cue_family || 'behavioral', input.evidence_count || 1,
       input.stability_score || 0, input.state || 'candidate',
       input.has_explicit ? 1 : 0, input.last_seen_at || now,
       input.namespace || 'global', this._json(input.metadata),
       id, now, now]
    );
    this.emit('facet:upserted', { id, facet_class: input.facet_class, state: input.state });
    return id;
  }

  getFacets(opts = {}) {
    const conditions = [];
    const params = [];
    if (opts.facet_class) { conditions.push('facet_class = ?'); params.push(opts.facet_class); }
    if (opts.state) { conditions.push('state = ?'); params.push(opts.state); }
    if (opts.namespace) { conditions.push('namespace = ?'); params.push(opts.namespace); }
    if (opts.minStability) { conditions.push('stability_score >= ?'); params.push(opts.minStability); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.all(
      `SELECT * FROM user_profile_facets ${where} ORDER BY stability_score DESC, updated_at DESC`,
      params
    );
  }

  getFacet(id) {
    return this.get('SELECT * FROM user_profile_facets WHERE id = ?', [id]);
  }

  findFacetByKey(facetClass, key, namespace = 'global') {
    return this.get(
      'SELECT * FROM user_profile_facets WHERE facet_class = ? AND key = ? AND namespace = ?',
      [facetClass, key, namespace]
    );
  }

  updateFacetState(id, newState, newStability) {
    this.run(
      'UPDATE user_profile_facets SET state = ?, stability_score = ?, updated_at = ? WHERE id = ?',
      [newState, newStability, this._now(), id]
    );
    this.emit('facet:state_changed', { id, newState, newStability });
  }

  incrementFacetEvidence(id) {
    this.run(
      'UPDATE user_profile_facets SET evidence_count = evidence_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ?',
      [this._now(), this._now(), id]
    );
  }

  deleteFacet(id) {
    this.run('DELETE FROM user_profile_facets WHERE id = ?', [id]);
    this.emit('facet:deleted', { id });
  }

  getActiveFacets(namespace = 'global') {
    return this.all(
      "SELECT * FROM user_profile_facets WHERE state IN ('active', 'provisional') AND namespace = ? ORDER BY stability_score DESC",
      [namespace]
    );
  }

  renderFacetsAsMarkdown(namespace = 'global') {
    const facets = this.getActiveFacets(namespace);
    if (!facets.length) return '';

    const grouped = {};
    for (const f of facets) {
      if (!grouped[f.facet_class]) grouped[f.facet_class] = [];
      grouped[f.facet_class].push(f);
    }

    const lines = ['## User Profile', ''];
    for (const [cls, items] of Object.entries(grouped)) {
      lines.push(`### ${cls}`);
      for (const item of items) {
        const stateTag = item.state === 'active' ? '✓' : '○';
        lines.push(`- ${stateTag} **${item.key}**: ${item.value} (evidence: ${item.evidence_count}, stability: ${item.stability_score.toFixed(2)})`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  _cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  embeddingToBuffer(embedding) {
    if (!embedding) return null;
    const f32 = embedding instanceof Float32Array ? embedding : new Float32Array(embedding);
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  }

  bufferToEmbedding(buffer) {
    if (!buffer) return null;
    if (buffer instanceof Buffer) {
      return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    }
    return new Float32Array(buffer);
  }

  // ==================== FTS5 Search ====================

  searchFts(query, opts = {}) {
    const table = opts.table || 'memories_fts';
    const limit = opts.limit || 10;
    const namespace = opts.namespace;

    try {
      if (namespace) {
        return this.all(
          `SELECT m.* FROM memories m
           JOIN ${table} fts ON m.id = fts.id
           WHERE ${table} MATCH ? AND m.namespace = ?
           ORDER BY rank LIMIT ?`,
          [query, namespace, limit]
        );
      }
      return this.all(
        `SELECT m.* FROM memories m
         JOIN ${table} fts ON m.id = fts.id
         WHERE ${table} MATCH ?
         ORDER BY rank LIMIT ?`,
        [query, limit]
      );
    } catch (e) {
      return [];
    }
  }

  searchChunksFts(query, namespace, limit = 10) {
    try {
      if (namespace) {
        return this.all(
          `SELECT c.* FROM chunks c
           JOIN chunks_fts fts ON c.id = fts.id
           WHERE chunks_fts MATCH ? AND c.namespace = ?
           ORDER BY rank LIMIT ?`,
          [query, namespace, limit]
        );
      }
      return this.all(
        `SELECT c.* FROM chunks c
         JOIN chunks_fts fts ON c.id = fts.id
         WHERE chunks_fts MATCH ?
         ORDER BY rank LIMIT ?`,
        [query, limit]
      );
    } catch (e) {
      return [];
    }
  }

  // ==================== Entities ====================

  upsertEntity(input) {
    const now = this._now();
    const id = input.id || this._genId('ent');
    this.run(
      `INSERT OR REPLACE INTO entities (id, name, kind, aliases, metadata, mention_count, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM entities WHERE id = ?), ?), ?)`,
      [id, input.name, input.kind || 'concept', this._json(input.aliases || []),
       this._json(input.metadata), input.mention_count || 0, input.last_seen_at || now,
       id, now, now]
    );
    this.emit('entity:upserted', { id, name: input.name, kind: input.kind });
    return id;
  }

  getEntity(id) {
    return this.get('SELECT * FROM entities WHERE id = ?', [id]);
  }

  findEntityByName(name) {
    return this.get('SELECT * FROM entities WHERE name = ?', [name]);
  }

  searchEntities(query, limit = 20) {
    const q = `%${query}%`;
    return this.all(
      `SELECT * FROM entities WHERE name LIKE ? OR kind LIKE ? LIMIT ?`,
      [q, q, limit]
    );
  }

  incrementEntityMention(id) {
    this.run(
      'UPDATE entities SET mention_count = mention_count + 1, last_seen_at = ?, updated_at = ? WHERE id = ?',
      [this._now(), this._now(), id]
    );
  }

  // ==================== SRS 复习（2026-08-20 DeepTutor 精华落地）====================

  /** 到期实体清单：srs_due_at 非空且 <= nowMs（含从未设置 srs 的？不——未设置视为不参与复习） */
  listDueEntities(nowMs = Date.now(), limit = 20) {
    return this.all(
      `SELECT * FROM entities
       WHERE srs_due_at IS NOT NULL AND srs_due_at <= ?
       ORDER BY srs_due_at ASC LIMIT ?`,
      [nowMs, limit]
    );
  }

  /** 写入复习结果（等级/到期/连对由 srs-scheduler 纯函数算好后落库） */
  applySrsReview(id, { index, dueAtMs, streak }) {
    this.run(
      'UPDATE entities SET srs_interval = ?, srs_due_at = ?, srs_streak = ?, updated_at = ? WHERE id = ?',
      [index, dueAtMs, streak, this._now(), id]
    );
    this.emit('entity:srs_reviewed', { id, index, dueAtMs, streak });
  }

  /** 初始化实体 SRS 状态（新实体首次参与复习时调用） */
  initSrs(entityId, { index = 0, dueAtMs, streak = 0 } = {}) {
    this.run(
      'UPDATE entities SET srs_interval = ?, srs_due_at = ?, srs_streak = ?, updated_at = ? WHERE id = ?',
      [index, dueAtMs, streak, this._now(), entityId]
    );
  }

  // ==================== Relations ====================

  upsertRelation(input) {
    const now = this._now();
    const id = input.id || this._genId('rel');
    this.run(
      `INSERT OR REPLACE INTO relations (id, source_entity, target_entity, relation_type, namespace, confidence, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM relations WHERE id = ?), ?), ?)`,
      [id, input.source_entity, input.target_entity, input.relation_type || 'related_to',
       input.namespace || 'global', input.confidence || 0.5,
       this._json(input.metadata), id, now, now]
    );
    return id;
  }

  getRelationsForEntity(entityId, opts = {}) {
    const namespace = opts.namespace;
    if (namespace) {
      return this.all(
        `SELECT r.*, e.name as target_name, e.kind as target_kind
         FROM relations r
         JOIN entities e ON r.target_entity = e.id
         WHERE r.source_entity = ? AND r.namespace = ?
         ORDER BY r.confidence DESC`,
        [entityId, namespace]
      );
    }
    return this.all(
      `SELECT r.*, e.name as target_name, e.kind as target_kind
       FROM relations r
       JOIN entities e ON r.target_entity = e.id
       WHERE r.source_entity = ?
       ORDER BY r.confidence DESC`,
      [entityId]
    );
  }

  deriveCooccurrenceGraph(opts = {}) {
    const minCooccurrence = opts.minCooccurrence || 1;
    const rows = this.all(
      `SELECT r1.source_entity as e1, r1.target_entity as e2, COUNT(*) as co_count,
              MAX(r1.updated_at) as last_seen
       FROM relations r1
       JOIN relations r2 ON r1.source_entity = r2.source_entity
                          AND r1.target_entity != r2.target_entity
                          AND r1.namespace = r2.namespace
       GROUP BY r1.source_entity, r1.target_entity, r2.target_entity
       HAVING co_count >= ?
       ORDER BY co_count DESC`,
      [minCooccurrence]
    );

    const edges = [];
    const seen = new Set();
    for (const row of rows) {
      const key = [row.e1, row.e2].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const ageDays = (this._now() - row.last_seen) / 86400;
      const recencyDecay = ageDays <= 1 ? 1.0 : ageDays <= 7 ? 0.75 : ageDays <= 30 ? 0.5 : 0.25;
      edges.push({
        source: row.e1,
        target: row.e2,
        weight: row.co_count * recencyDecay,
        cooccurrenceCount: row.co_count,
      });
    }
    return edges.filter(e => e.weight > 0.5);
  }

  // ==================== Tree Nodes ====================

  upsertTreeNode(input) {
    const now = this._now();
    const id = input.id || this._genId('tn');
    this.run(
      `INSERT OR REPLACE INTO tree_nodes (id, tree_type, tree_scope, level, content, summary, embedding, item_ids, labels, sealed, token_count, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM tree_nodes WHERE id = ?), ?), ?)`,
      [id, input.tree_type, input.tree_scope || '', input.level || 0,
       input.content || '', input.summary || null, input.embedding || null,
       this._json(input.item_ids || []), this._json(input.labels || []),
       input.sealed ? 1 : 0, input.token_count || 0, this._json(input.metadata),
       id, now, now]
    );
    this.emit('tree_node:upserted', { id, tree_type: input.tree_type, level: input.level });
    return id;
  }

  getTreeNodes(opts = {}) {
    const conditions = [];
    const params = [];
    if (opts.tree_type) { conditions.push('tree_type = ?'); params.push(opts.tree_type); }
    if (opts.tree_scope !== undefined) { conditions.push('tree_scope = ?'); params.push(opts.tree_scope); }
    if (opts.level !== undefined) { conditions.push('level = ?'); params.push(opts.level); }
    if (opts.sealed !== undefined) { conditions.push('sealed = ?'); params.push(opts.sealed ? 1 : 0); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = this._sanitizeOrderBy(opts.orderBy, 'updated_at DESC');
    const limit = opts.limit || 100;

    return this.all(
      `SELECT * FROM tree_nodes ${where} ORDER BY ${orderBy} LIMIT ?`,
      [...params, limit]
    );
  }

  getTreeNode(id) {
    return this.get('SELECT * FROM tree_nodes WHERE id = ?', [id]);
  }

  sealTreeNode(id, summary, tokenCount) {
    this.run(
      'UPDATE tree_nodes SET sealed = 1, summary = ?, token_count = ?, updated_at = ? WHERE id = ?',
      [summary, tokenCount || 0, this._now(), id]
    );
  }

  // ==================== Memories (legacy compat) ====================

  /**
   * 系统错误/配置错误类文本不应成为记忆——LLM 提取会把
   * "模型提供商 \"deepseek\" 未配置。请在设置中配置 API 密钥。" 当事实写入，
   * 造成记忆图谱常驻过时错误（实测复发两轮）。在统一写入入口拦截。
   */
  static isSystemErrorMemory(memory) {
    const text = `${memory.title || ''} ${memory.content || ''}`;
    return /模型提供商[^。\n]{0,30}(未配置|缺少 API 密钥)|请在设置中(配置|填写)/.test(text);
  }

  addMemory(memory) {
    if (UnifiedMemoryStore.isSystemErrorMemory(memory)) {
      console.log('[UnifiedStore] 跳过系统错误类记忆写入:', String(memory.title || memory.content || '').slice(0, 60));
      return null;
    }
    const now = this._now();
    const id = memory.id || this._genId('mem');
    // 2026-08-08 fix: 字段类型消毒——模型提取的事实可能传对象/数组给
    // title/content/importance 等,SQLite bind 直接抛 "can only bind numbers,
    // strings..."(日志 unified-store write failed 反复出现,记忆写入全失败)。
    // 对象序列化、非法数字回退默认值,store 层统一兜底所有调用方。
    const str = (v, fallback) => {
      if (typeof v === 'string') return v;
      if (v === undefined || v === null) return fallback;
      try { return JSON.stringify(v); } catch { return fallback; }
    };
    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
    this.run(
      `INSERT OR REPLACE INTO memories (id, type, title, content, scope, tags, importance, trust_score, source, namespace, access_count, last_accessed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, str(memory.type, 'general'), str(memory.title, ''), str(memory.content, ''),
       str(memory.scope, 'private'), this._json(memory.tags || []),
       num(memory.importance, 0.5), num(memory.trust_score, 0.5),
       str(memory.source, 'manual'), str(memory.namespace, 'global'),
       now, now, now]
    );
    this.emit('memory:added', { id, type: memory.type });
    return id;
  }

  getMemory(id) {
    const row = this.get('SELECT * FROM memories WHERE id = ?', [id]);
    if (!row) return null;
    return this._rowToMemory(row);
  }

  getAllMemories(opts = {}) {
    const namespace = opts.namespace;
    const type = opts.type;
    const conditions = [];
    const params = [];
    if (namespace) { conditions.push('namespace = ?'); params.push(namespace); }
    if (type) { conditions.push('type = ?'); params.push(type); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit || 200;

    const rows = this.all(
      `SELECT * FROM memories ${where} ORDER BY updated_at DESC LIMIT ?`,
      [...params, limit]
    );
    return rows.map(r => this._rowToMemory(r));
  }

  updateMemory(id, updates) {
    const fields = [];
    const params = [];
    const allowedFields = ['type', 'title', 'content', 'scope', 'tags', 'importance', 'trust_score', 'source', 'namespace', 'access_count', 'last_accessed'];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        fields.push(`${field} = ?`);
        if (field === 'tags') {
          params.push(this._json(updates[field]));
        } else {
          params.push(updates[field]);
        }
      }
    }

    if (fields.length === 0) return null;

    fields.push('updated_at = ?');
    params.push(this._now());
    params.push(id);

    this.run(
      `UPDATE memories SET ${fields.join(', ')} WHERE id = ?`,
      params
    );
    this.emit('memory:updated', { id });
    return this.getMemory(id);
  }

  deleteMemory(id) {
    this.run('DELETE FROM memories WHERE id = ?', [id]);
    this.emit('memory:deleted', { id });
  }

  searchMemories(query, opts = {}) {
    const limit = opts.limit || 10;
    const namespace = opts.namespace;
    const type = opts.type;
    const queryLower = query.toLowerCase();

    let ftsResults = [];
    try {
      const ftsQuery = queryLower.replace(/"/g, '""');
      if (namespace) {
        ftsResults = this.all(
          `SELECT m.* FROM memories m
           JOIN memories_fts fts ON m.id = fts.id
           WHERE memories_fts MATCH ? AND m.namespace = ?
           ORDER BY rank LIMIT ?`,
          [`"${ftsQuery}"`, namespace, limit * 2]
        );
      } else {
        ftsResults = this.all(
          `SELECT m.* FROM memories m
           JOIN memories_fts fts ON m.id = fts.id
           WHERE memories_fts MATCH ?
           ORDER BY rank LIMIT ?`,
          [`"${ftsQuery}"`, limit * 2]
        );
      }
    } catch { ftsResults = []; }

    const keywordResults = this.all(
      `SELECT * FROM memories WHERE (title LIKE ? OR content LIKE ?) ${namespace ? 'AND namespace = ?' : ''} ${type ? 'AND type = ?' : ''} ORDER BY importance DESC, updated_at DESC LIMIT ?`,
      namespace && type
        ? [`%${queryLower}%`, `%${queryLower}%`, namespace, type, limit]
        : namespace
          ? [`%${queryLower}%`, `%${queryLower}%`, namespace, limit]
          : type
            ? [`%${queryLower}%`, `%${queryLower}%`, type, limit]
            : [`%${queryLower}%`, `%${queryLower}%`, limit]
    );

    const seen = new Set();
    const merged = [];
    for (const row of [...ftsResults, ...keywordResults]) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        merged.push(this._rowToMemory(row));
      }
    }

    return merged.slice(0, limit);
  }

  touchMemory(id) {
    this.run(
      'UPDATE memories SET access_count = access_count + 1, last_accessed = ?, updated_at = ? WHERE id = ?',
      [this._now(), this._now(), id]
    );
  }

  /**
   * 更新记忆的向量嵌入（供 EmbeddingPipeline 写入）。
   * embedding 为 number[] | Float32Array | null；
   * 传入 null 或空数组时跳过写入返回 false。
   */
  updateMemoryEmbedding(id, embedding) {
    if (!id || !embedding || (Array.isArray(embedding) && embedding.length === 0)) return false;
    try {
      const buffer = this.embeddingToBuffer(embedding);
      if (!buffer) return false;
      this.run(
        'UPDATE memories SET embedding = ?, updated_at = ? WHERE id = ?',
        [buffer, this._now(), id]
      );
      return true;
    } catch (e) {
      console.warn('[unified-store] updateMemoryEmbedding 失败:', e.message);
      return false;
    }
  }

  /**
   * 更新 chunks 表的向量嵌入（供 IngestionPipeline 使用）。
   */
  updateChunkEmbedding(id, embedding) {
    if (!id || !embedding || (Array.isArray(embedding) && embedding.length === 0)) return false;
    try {
      const buffer = this.embeddingToBuffer(embedding);
      if (!buffer) return false;
      this.run(
        'UPDATE chunks SET embedding = ?, updated_at = ? WHERE id = ?',
        [buffer, this._now(), id]
      );
      return true;
    } catch (e) {
      console.warn('[unified-store] updateChunkEmbedding 失败:', e.message);
      return false;
    }
  }

  _rowToMemory(row) {
    return {
      ...row,
      tags: this._parse(row.tags),
      metadata: this._parse(row.metadata),
    };
  }

  // ==================== Sessions (legacy compat) ====================

  saveSession(session) {
    const now = this._now();
    this.run(
      `INSERT OR REPLACE INTO sessions (id, user_id, sections, context, token_count, message_count, created_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM sessions WHERE id = ?), ?), ?)`,
      [session.id || session.sessionId, session.user_id || 'default',
       this._json(session.sections || {}), this._json(session.context || {}),
       session.token_count || 0, session.message_count || 0,
       session.id || session.sessionId, now, now]
    );
  }

  getSession(id) {
    const row = this.get('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!row) return null;
    return {
      ...row,
      sections: this._parse(row.sections),
      context: this._parse(row.context),
    };
  }

  addSessionMessage(sessionId, msg) {
    const id = msg.id || this._genId('msg');
    this.run(
      'INSERT OR REPLACE INTO session_messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
      [id, sessionId, msg.role, msg.content, msg.timestamp || this._now()]
    );
    return id;
  }

  getSessionMessages(sessionId, limit = 100) {
    return this.all(
      'SELECT * FROM session_messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?',
      [sessionId, limit]
    );
  }

  // ==================== Tool Memory ====================

  addToolMemory(input) {
    const now = this._now();
    const id = input.id || this._genId('tm');
    this.run(
      `INSERT OR REPLACE INTO tool_memory (id, tool_name, content, priority, source, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.tool_name, input.content, input.priority || 'normal',
       input.source || 'agent_learning', this._json(input.metadata), now, now]
    );
    this.emit('tool_memory:added', { id, tool_name: input.tool_name, priority: input.priority });
    return id;
  }

  getToolMemories(toolName, opts = {}) {
    const priority = opts.priority;
    if (priority) {
      return this.all(
        'SELECT * FROM tool_memory WHERE tool_name = ? AND priority = ? ORDER BY updated_at DESC',
        [toolName, priority]
      );
    }
    return this.all(
      'SELECT * FROM tool_memory WHERE tool_name = ? ORDER BY priority DESC, updated_at DESC',
      [toolName]
    );
  }

  getCriticalToolRules(toolNames) {
    if (!toolNames || !toolNames.length) return [];
    const placeholders = toolNames.map(() => '?').join(',');
    return this.all(
      `SELECT * FROM tool_memory WHERE tool_name IN (${placeholders}) AND priority IN ('critical', 'high') ORDER BY priority DESC, updated_at DESC`,
      toolNames
    );
  }

  deleteToolMemory(id) {
    this.run('DELETE FROM tool_memory WHERE id = ?', [id]);
  }

  getToolMemory(id) {
    return this.get('SELECT * FROM tool_memory WHERE id = ?', [id]);
  }

  listToolMemory(toolName) {
    if (toolName) {
      return this.all(
        'SELECT * FROM tool_memory WHERE tool_name = ? ORDER BY priority DESC, updated_at DESC',
        [toolName]
      );
    }
    return this.all(
      'SELECT * FROM tool_memory ORDER BY priority DESC, updated_at DESC LIMIT 500'
    );
  }

  // ==================== Store Meta ====================

  setMeta(key, value) {
    this.run(
      'INSERT OR REPLACE INTO store_meta (key, value, updated_at) VALUES (?, ?, ?)',
      [key, String(value), this._now()]
    );
  }

  getMeta(key) {
    const row = this.get('SELECT value FROM store_meta WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  // ==================== Stats ====================

  getStats() {
    const stats = {};
    const tables = ['documents', 'chunks', 'entities', 'relations', 'tree_nodes', 'memories', 'sessions', 'tool_memory'];
    for (const table of tables) {
      try {
        const row = this.get(`SELECT COUNT(*) as count FROM ${table}`);
        stats[table] = row ? row.count : 0;
      } catch {
        stats[table] = 0;
      }
    }
    return stats;
  }

  // ==================== Transaction ====================

  transaction(fn) {
    if (this._isSqlJs) {
      this.db.run('BEGIN');
      try {
        const result = fn(this);
        this.db.run('COMMIT');
        this._schedulePersist();
        return result;
      } catch (e) {
        this.db.run('ROLLBACK');
        throw e;
      }
    }
    return this.db.transaction(fn)(this);
  }
}

let _instance = null;

function getUnifiedStore(config) {
  if (!_instance) {
    _instance = new UnifiedMemoryStore(config);
    _instance.initialize();
  }
  return _instance;
}

module.exports = { UnifiedMemoryStore, getUnifiedStore, DEFAULT_DB_PATH };
