/**
 * Database Initialization Module (Phase 0-1 Foundation)
 * Inspired by: rusqlite (Grok Build)
 * 
 * Manages SQLite connection initialization and base schema setup.
 * Uses better-sqlite3 for synchronous, high-performance SQLite operations.
 * 
 * Note: Node.js 生态下的优化：
 * - 由于 better-sqlite3 是同步库，为避免阻塞事件循环，
 *   建议在 Phase 1 将密集 DB 操作迁移至 Worker Threads。
 * - 当前版本提供基础同步 API，用于非高频读写场景。
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Connection pool (singleton)
let dbInstance = null;

/**
 * Initialize the database connection
 * @param {string} dbPath - Path to the SQLite database file
 * @returns {Database} Database instance
 */
function initDatabase(dbPath = null) {
  if (dbInstance) {
    return dbInstance;
  }

  // Default path
  if (!dbPath) {
    const { DATA_DIR } = require('../core/config');
    const dbDir = path.join(DATA_DIR, 'db');
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    dbPath = path.join(dbDir, 'bossagent.db');
  }

  // Create connection
  dbInstance = new Database(dbPath);
  
  // Enable WAL mode for better concurrent read/write performance
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.pragma('synchronous = NORMAL'); // Balance between safety and performance
  
  // Set a busy timeout for handling concurrent access (useful for multi-process scenarios)
  dbInstance.pragma('busy_timeout = 5000');

  // Initialize base schema
  initializeSchema(dbInstance);

  // 执行数据库迁移（PRAGMA user_version 机制）
  runMigrations(dbInstance);
  
  return dbInstance;
}

/**
 * Initialize database schema (Phase 1 Memory Module foundation)
 */
function initializeSchema(db) {
  db.exec(`
    -- ============================================================
    -- Memory Index Tables
    -- ============================================================
    
    -- Main chunks table for storing memory fragments
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY,
      chunk_id TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('global', 'workspace', 'session')),
      session_id TEXT,
      start_line INTEGER,
      end_line INTEGER,
      text TEXT NOT NULL,
      hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch('now')),
      access_count INTEGER DEFAULT 0,
      is_evergreen INTEGER DEFAULT 0 -- 1 for non-expiring knowledge
    );

    -- FTS5 Virtual Table for Full-Text Search (Hybrid Search Phase)
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts 
    USING fts5(
      text,
      path,
      tokenize='porter'
    );

    -- Triggers to keep FTS index in sync with chunks table
    CREATE TRIGGER IF NOT EXISTS memory_chunks_ai 
    AFTER INSERT ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(rowid, text, path) 
      VALUES (new.rowid, new.text, new.path);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_chunks_ad 
    AFTER DELETE ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text, path) 
      VALUES ('delete', old.rowid, old.text, old.path);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_chunks_au 
    AFTER UPDATE OF text, path ON memory_chunks BEGIN
      INSERT INTO memory_chunks_fts(memory_chunks_fts, rowid, text, path) 
      VALUES ('delete', old.rowid, old.text, old.path);
      INSERT INTO memory_chunks_fts(rowid, text, path) 
      VALUES (new.rowid, new.text, new.path);
    END;

    -- ============================================================
    -- Metadata & State Tables
    -- ============================================================

    -- Memory Sources Table (for tracking knowledge bases)
    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT,
      description TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    -- Dream Consolidation Lock Table (Phase 2)
    CREATE TABLE IF NOT EXISTS dream_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_consolidated_at INTEGER,
      last_session_id TEXT,
      lock_owner TEXT,
      lock_acquired_at INTEGER
    );
    INSERT OR IGNORE INTO dream_lock (id, last_consolidated_at) 
    VALUES (1, 0);

    -- Session State Tracking
    CREATE TABLE IF NOT EXISTS session_states (
      session_id TEXT PRIMARY KEY,
      model TEXT,
      token_count INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      last_active_at INTEGER,
      created_at INTEGER
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON memory_chunks(source);
    CREATE INDEX IF NOT EXISTS idx_chunks_session ON memory_chunks(session_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_created_at ON memory_chunks(created_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_hash ON memory_chunks(hash);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_source ON memory_chunks(source);
  `);
}

/**
 * 数据库迁移基础设施（基础版）
 *
 * 结构说明：MIGRATIONS 数组声明式定义增量迁移，每项为
 *   { version: 1, sql: 'ALTER TABLE memory_chunks ADD COLUMN example TEXT' }
 * 版本号必须严格递增（1, 2, 3...）。执行时机：initDatabase() 建表后。
 * 机制：PRAGMA user_version 记录当前 schema 版本；有未执行迁移时
 * 先在事务内执行全部 SQL（任一失败整体回滚），成功后再递增 user_version。
 *
 * 新增迁移步骤：向 MIGRATIONS 末尾追加 { version: N, sql: '...' }（N = 当前版本 + 1）。
 */
const MIGRATIONS = [
  // { version: 1, sql: 'ALTER TABLE memory_chunks ADD COLUMN example TEXT' },
];

function runMigrations(db) {
  let currentVersion = 0;
  try {
    currentVersion = db.pragma('user_version', { simple: true }) || 0;
  } catch (e) {
    console.warn('[db] 读取 user_version 失败，跳过迁移:', e.message);
    return;
  }

  const pending = MIGRATIONS
    .filter(m => m && Number.isInteger(m.version) && m.version > currentVersion && typeof m.sql === 'string')
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  console.log(`[db] 检测到 ${pending.length} 个待执行迁移 (user_version=${currentVersion})`);
  try {
    // 事务内执行全部迁移 SQL（任一失败整体回滚，user_version 保持旧值）
    const apply = db.transaction(() => {
      for (const migration of pending) {
        db.exec(migration.sql);
      }
    });
    apply();
    // 全部成功后递增版本号（PRAGMA user_version 为 DB 头字段，置于事务外写入更稳妥）
    for (const migration of pending) {
      db.pragma(`user_version = ${migration.version}`);
      console.log(`[db] ✅ 已执行迁移 v${migration.version}`);
    }
  } catch (e) {
    console.error(`[db] 迁移执行失败（当前 user_version=${currentVersion}）:`, e.message);
    throw e;
  }
}

/**
 * Get or create database instance
 */
function getDatabase() {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Close database connection
 */
function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Generate a unique ID
 */
function generateId() {
  return crypto.randomUUID();
}

// ============================================================================
// Repository Classes
// ============================================================================

/**
 * Memory Repository - Handles CRUD operations for memory chunks
 */
class MemoryRepository {
  constructor(db) {
    this.db = db || getDatabase();
  }

  /**
   * Insert or update a memory chunk
   */
  upsertChunk(chunk) {
    const stmt = this.db.prepare(`
      INSERT INTO memory_chunks (
        id, chunk_id, path, source, session_id, 
        start_line, end_line, text, hash, created_at, is_evergreen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        updated_at = CURRENT_TIMESTAMP,
        access_count = access_count + 1
    `);
    
    const id = chunk.id || generateId();
    const now = Date.now();
    
    const info = stmt.run(
      id,
      chunk.chunk_id || id,
      chunk.path || 'unknown',
      chunk.source || 'session',
      chunk.session_id || null,
      chunk.start_line || 0,
      chunk.end_line || 0,
      chunk.text,
      chunk.hash || null,
      chunk.created_at || now,
      chunk.is_evergreen ? 1 : 0
    );
    
    return { id, changes: info.changes };
  }

  /**
   * Insert multiple chunks in a single transaction
   */
  batchUpsertChunks(chunks) {
    const transaction = this.db.transaction((items) => {
      const stmt = this.db.prepare(`
        INSERT INTO memory_chunks (
          id, chunk_id, path, source, session_id, 
          start_line, end_line, text, hash, created_at, is_evergreen
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text,
          updated_at = CURRENT_TIMESTAMP,
          access_count = access_count + 1
      `);
      
      for (const chunk of items) {
        const id = chunk.id || generateId();
        stmt.run(
          id,
          chunk.chunk_id || id,
          chunk.path || 'unknown',
          chunk.source || 'session',
          chunk.session_id || null,
          chunk.start_line || 0,
          chunk.end_line || 0,
          chunk.text,
          chunk.hash || null,
          chunk.created_at || Date.now(),
          chunk.is_evergreen ? 1 : 0
        );
      }
    });
    
    return transaction(chunks);
  }

  /**
   * Search chunks by FTS query (BM25 ranking)
   */
  searchByText(query, limit = 10) {
    const sql = `
      SELECT 
        c.*,
        rank
      FROM memory_chunks c
      JOIN memory_chunks_fts fts ON c.rowid = fts.rowid
      WHERE memory_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `;
    return this.db.prepare(sql).all(query, limit);
  }

  /**
   * Get chunks by source with temporal decay support
   */
  getDecayedChunks(source, halfLifeDays = 30) {
    const decayFactor = Math.log(2) / (halfLifeDays * 24 * 60 * 60 * 1000);
    const now = Date.now();
    
    return this.db.prepare(`
      SELECT 
        *,
        CASE 
          WHEN is_evergreen = 1 THEN 1.0
          WHEN source IN ('global', 'workspace') THEN 1.0
          ELSE EXP(-? * (? - created_at))
        END as temporal_score
      FROM memory_chunks
      WHERE source = ?
      ORDER BY temporal_score DESC
    `).all(decayFactor, now, source);
  }

  /**
   * Get chunks by session
   */
  getSessionChunks(sessionId) {
    return this.db.prepare(`
      SELECT * FROM memory_chunks 
      WHERE session_id = ?
      ORDER BY created_at DESC
    `).all(sessionId);
  }

  /**
   * Update access count for a chunk
   */
  incrementAccessCount(chunkId) {
    const info = this.db.prepare(`
      UPDATE memory_chunks 
      SET access_count = access_count + 1 
      WHERE id = ?
    `).run(chunkId);
    return info.changes > 0;
  }

  /**
   * Delete chunks by session
   */
  deleteSessionChunks(sessionId) {
    const info = this.db.prepare(`
      DELETE FROM memory_chunks 
      WHERE session_id = ? AND source = 'session'
    `).run(sessionId);
    return info.changes;
  }

  /**
   * Clean old session chunks based on age
   */
  cleanOldSessions(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.db.prepare(`
      DELETE FROM memory_chunks 
      WHERE source = 'session' AND created_at < ?
    `).run(cutoff);
    return info.changes;
  }

  /**
   * Get statistics
   */
  getStats() {
    const stats = {
      total_chunks: 0,
      by_source: {},
      total_size_bytes: 0
    };
    
    // Count by source
    const counts = this.db.prepare(`
      SELECT source, COUNT(*) as count, SUM(LENGTH(text)) as total_size
      FROM memory_chunks 
      GROUP BY source
    `).all();
    
    for (const row of counts) {
      stats.by_source[row.source] = {
        count: row.count,
        size: row.total_size || 0
      };
      stats.total_chunks += row.count;
      stats.total_size_bytes += row.total_size || 0;
    }
    
    return stats;
  }

  /**
   * Check if a chunk exists by hash
   */
  existsByHash(hash) {
    const row = this.db.prepare(`
      SELECT id FROM memory_chunks WHERE hash = ? LIMIT 1
    `).get(hash);
    return !!row;
  }
}

/**
 * Dream Consolidation Repository
 * Note: In Node.js, we use a simpler lock mechanism (in-memory flag or DB row)
 * compared to Rust's OS-level file locking.
 */
class DreamRepository {
  constructor(db) {
    this.db = db || getDatabase();
    this._lockOwner = null;
    this._lockAcquiredAt = 0;
    this._LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max hold
  }

  /**
   * Get last consolidation time
   */
  getLastConsolidation() {
    const row = this.db.prepare('SELECT * FROM dream_lock WHERE id = 1').get();
    return row ? row.last_consolidated_at : 0;
  }

  /**
   * Update consolidation timestamp
   */
  updateConsolidation(sessionId) {
    this.db.prepare(`
      UPDATE dream_lock 
      SET last_consolidated_at = ?, last_session_id = ?
      WHERE id = 1
    `).run(Date.now(), sessionId);
  }

  /**
   * Acquire dream lock (simplified for Node.js single-process model)
   * Note: For multi-process scenarios, use Redis or similar distributed lock.
   */
  acquireLock(ownerId) {
    const now = Date.now();
    
    // Check if we already own the lock
    if (this._lockOwner === ownerId) {
      if (now - this._lockAcquiredAt < this._LOCK_TIMEOUT_MS) {
        return true;
      }
    }
    
    // Check if another owner holds it
    if (this._lockOwner && now - this._lockAcquiredAt < this._LOCK_TIMEOUT_MS) {
      return false; // Lock held by another process
    }
    
    // Acquire lock
    this._lockOwner = ownerId;
    this._lockAcquiredAt = now;
    
    // Also update DB for persistence
    this.db.prepare(`
      UPDATE dream_lock 
      SET lock_owner = ?, lock_acquired_at = ?
      WHERE id = 1
    `).run(ownerId, now);
    
    return true;
  }

  /**
   * Release dream lock
   */
  releaseLock(ownerId) {
    if (this._lockOwner === ownerId) {
      this._lockOwner = null;
      this._lockAcquiredAt = 0;
      
      this.db.prepare(`
        UPDATE dream_lock 
        SET lock_owner = NULL, lock_acquired_at = 0
        WHERE id = 1
      `).run();
      
      return true;
    }
    return false;
  }

  /**
   * Force release lock (for cleanup during startup)
   */
  forceReleaseLock() {
    this._lockOwner = null;
    this._lockAcquiredAt = 0;
    
    this.db.prepare(`
      UPDATE dream_lock 
      SET lock_owner = NULL, lock_acquired_at = 0
      WHERE id = 1
    `).run();
  }

  /**
   * Check if dream consolidation is due
   */
  isConsolidationDue(minHours, minSessions) {
    const lastConsolidated = this.getLastConsolidation();
    const hoursSinceLast = (Date.now() - lastConsolidated) / (1000 * 60 * 60);
    
    if (hoursSinceLast < minHours) {
      return { due: false, reason: 'too_soon', hoursSinceLast };
    }
    
    // Count sessions since last consolidation
    const sessionsCount = this.db.prepare(`
      SELECT COUNT(DISTINCT session_id) as count
      FROM memory_chunks
      WHERE source = 'session' AND created_at > ?
    `).get(lastConsolidated);
    
    if (sessionsCount.count < minSessions) {
      return { due: false, reason: 'too_few_sessions', sessionCount: sessionsCount.count };
    }
    
    return { due: true, sessionsCount: sessionsCount.count };
  }
}

/**
 * Session State Repository
 */
class SessionRepository {
  constructor(db) {
    this.db = db || getDatabase();
  }

  /**
   * Update or create session state
   */
  upsertSession(sessionId, state) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO session_states (
        session_id, model, token_count, message_count, 
        last_active_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        model = excluded.model,
        token_count = excluded.token_count,
        message_count = excluded.message_count,
        last_active_at = excluded.last_active_at
    `).run(
      sessionId,
      state.model || 'unknown',
      state.tokenCount || 0,
      state.messageCount || 0,
      now,
      state.createdAt || now
    );
  }

  /**
   * Get session state
   */
  getSession(sessionId) {
    return this.db.prepare(`
      SELECT * FROM session_states WHERE session_id = ?
    `).get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(activeWithinMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - activeWithinMs;
    return this.db.prepare(`
      SELECT * FROM session_states WHERE last_active_at > ?
    `).all(cutoff);
  }

  /**
   * Get token and message counts for a session
   */
  getSessionUsage(sessionId) {
    return this.db.prepare(`
      SELECT token_count, message_count FROM session_states WHERE session_id = ?
    `).get(sessionId) || { token_count: 0, message_count: 0 };
  }
}

// ============================================================================
// Export
// ============================================================================

module.exports = {
  // Core
  initDatabase,
  getDatabase,
  closeDatabase,
  generateId,
  runMigrations,
  MIGRATIONS,
  
  // Repositories
  MemoryRepository,
  DreamRepository,
  SessionRepository,
  
  // Utility: create repositories with default DB
  createMemoryRepository: () => new MemoryRepository(getDatabase()),
  createDreamRepository: () => new DreamRepository(getDatabase()),
  createSessionRepository: () => new SessionRepository(getDatabase())
};
