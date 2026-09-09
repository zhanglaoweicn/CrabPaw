const fs = require('fs');
const path = require('path');

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const { DATA_DIR } = require('../config');
const DB_DIR = DATA_DIR;
const DB_PATH = path.join(DB_DIR, 'fts-memory.db');

let db = null;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 2000;

// Register flush-on-exit handler once at module load
let _exitHandlerRegistered = false;
function _ensureExitHandler() {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  const onExit = () => { flushSave(); };
  process.on('beforeExit', onExit);
  process.on('exit', onExit);
}

async function initDatabase() {
  if (db) return db;

  _ensureExitHandler();

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();

    db.run(`
      CREATE TABLE IF NOT EXISTS memory_index (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'general',
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT DEFAULT '[]',
        category TEXT DEFAULT 'general',
        trust_score REAL DEFAULT 0.5,
        importance REAL DEFAULT 0.5,
        source TEXT DEFAULT 'auto',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_mi_type ON memory_index(type)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mi_category ON memory_index(category)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mi_updated ON memory_index(updated)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mi_importance ON memory_index(importance)`);

    // 尝试使用 trigram 分词器（对中文友好），降级为默认分词器
    let ftsTokenizer = '';
    try {
      // 测试 trigram 是否可用
      const testDb = new SQL.Database();
      testDb.run(`CREATE VIRTUAL TABLE test_trigram USING fts5(x, tokenize="trigram")`);
      testDb.run(`INSERT INTO test_trigram(x) VALUES('测试')`);
      const r = testDb.exec(`SELECT * FROM test_trigram WHERE test_trigram MATCH '测试'`);
      testDb.close();
      if (r.length > 0) {
        ftsTokenizer = ', tokenize="trigram"';
        console.log('🔍 FTS5 trigram 分词器可用，启用中文优化');
      }
    } catch (e) {
      console.log('🔍 FTS5 trigram 不可用，使用默认分词器');
    }

    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
        USING fts5(id, title, content, tags, category${ftsTokenizer})
      `);
    } catch (e) {
      // trigram 创建失败时降级为默认
      try {
      db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
      USING fts5(id, title, content, tags, category)
      `);
      } catch (e2) {
        // FTS5 may not be available at all
        console.warn('[fts-search.js] 空 catch 补日志:', e2 && e2.message);
      }

    }

    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_fts
        USING fts5(session_id, role, content${ftsTokenizer})
      `);
    } catch (e) {
      try {
      db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts
      USING fts5(session_id, role, content)
      `);
      } catch (e2) {
        // ignore
        console.warn('[fts-search.js] 空 catch 补日志:', e2 && e2.message);
      }

    }

    flushSave();
  }

  console.log('🔍 FTS5 全文检索数据库已初始化');
  return db;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushSave();
    saveTimer = null;
  }, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  if (db) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (e) {

      // ignore

      console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
    }

  }
}

async function indexMemory(id, data) {
      await initDatabase();
      const now = Date.now();
      db.run(
      `INSERT OR REPLACE INTO memory_index
      (id, type, title, content, tags, category, trust_score, importance, source, created, updated, access_count, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
      id,
      data.type || 'general',
      data.title || '',
      data.content || '',
      JSON.stringify(data.tags || []),
      data.category || data.type || 'general',
      data.trustScore || 0.5,
      data.importance || 0.5,
      data.source || 'auto',
      data.created || now,
      data.updated || now,
      data.accessCount || 0,
      data.lastAccessed || now,
      ]
      );
      try {
      db.run(
      `INSERT OR REPLACE INTO memory_fts (id, title, content, tags, category) VALUES (?, ?, ?, ?, ?)`,
      [
      id,
      data.title || '',
      data.content || '',
      (data.tags || []).join(' '),
      data.category || data.type || 'general',
      ]
      );
      } catch (e) {
        // FTS may not be available
        console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
      }


  scheduleSave();
  return { id, indexed: true };
}

async function indexSessionMessage(sessionId, role, content) {
  await initDatabase();

  try {
    db.run(
      `INSERT INTO session_fts (session_id, role, content) VALUES (?, ?, ?)`,
      [sessionId, role, content]
    );
    scheduleSave();
  } catch (e) {

    // session_fts may not be available

    console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
  }

}

async function search(query, limit = 10, options = {}) {
  await initDatabase();

  const results = [];

  try {
    // trigram 模式不支持引号短语查询，需用 OR/AND 连接关键词
    const hasChinese = /[\u4e00-\u9fff]/.test(query);
    let ftsQuery;
    if (hasChinese) {
      // 中文查询：将查询拆分为字符三元组片段，用 AND 连接提升精度
      const tokens = query.trim().split(/\s+/).filter(Boolean);
      ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    } else {
      const escapedQuery = query.replace(/"/g, '""');
      ftsQuery = `"${escapedQuery}"`;
    }

    let sql = `SELECT m.*, rank as fts_rank,
               snippet(memory_fts, 2, '<mark>', '</mark>', '...', 64) as highlight_snippet
               FROM memory_fts f
               JOIN memory_index m ON f.id = m.id
               WHERE memory_fts MATCH ?`;
    const params = [ftsQuery];

    if (options.category) {
      sql += ` AND m.category = ?`;
      params.push(options.category);
    }

    if (options.minTrust) {
      sql += ` AND m.trust_score >= ?`;
      params.push(options.minTrust);
    }

    sql += ` ORDER BY fts_rank DESC LIMIT ?`;
    params.push(limit);

    const stmt = db.prepare(sql);
    stmt.bind(params);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        highlightSnippet: row.highlight_snippet,
        tags: JSON.parse(row.tags || '[]'),
        category: row.category,
        trustScore: row.trust_score,
        importance: row.importance,
        source: row.source,
        created: row.created,
        updated: row.updated,
        accessCount: row.access_count,
        score: Math.abs(row.fts_rank || 0),
        // 引用溯源信息
        citation: {
          id: row.id,
          title: row.title || row.id,
          type: row.type,
          category: row.category,
          source: row.source,
          updatedAt: row.updated,
        },
      });
    }
    stmt.free();
  } catch (e) {
    // FTS search failed, fallback to LIKE
    try {
      let sql = `SELECT * FROM memory_index WHERE (title LIKE ? OR content LIKE ?)`;
      const likeQuery = `%${query}%`;
      const params = [likeQuery, likeQuery];

      if (options.category) {
        sql += ` AND category = ?`;
        params.push(options.category);
      }

      sql += ` ORDER BY importance DESC, updated DESC LIMIT ?`;
      params.push(limit);

      const stmt = db.prepare(sql);
      stmt.bind(params);

      while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push({
          id: row.id,
          type: row.type,
          title: row.title,
          content: row.content,
          tags: JSON.parse(row.tags || '[]'),
          category: row.category,
          trustScore: row.trust_score,
          importance: row.importance,
          source: row.source,
          created: row.created,
          updated: row.updated,
          accessCount: row.access_count,
          score: row.importance || 0.5,
        });
      }
      stmt.free();
    } catch (e2) {
      // both FTS and LIKE failed
    }
  }

  return results;
}

async function searchSessions(query, limit = 10) {
  await initDatabase();

  const results = [];

  try {
    const escapedQuery = query.replace(/"/g, '""');
    const stmt = db.prepare(
      `SELECT session_id, role, content, rank,
       snippet(session_fts, 2, '<mark>', '</mark>', '...', 64) as highlight_snippet
       FROM session_fts
       WHERE session_fts MATCH ?
       ORDER BY rank DESC
       LIMIT ?`
    );
    stmt.bind([`"${escapedQuery}"`, limit]);

    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        highlightSnippet: row.highlight_snippet,
        score: Math.abs(row.rank || 0),
      });
    }
    stmt.free();
  } catch (e) {

    // session_fts may not be available

    console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
  }


  return results;
}

async function updateAccessCount(id) {
  await initDatabase();

  db.run(
    `UPDATE memory_index SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`,
    [Date.now(), id]
  );
  scheduleSave();
}

async function removeIndex(id) {
  await initDatabase();

  db.run(`DELETE FROM memory_index WHERE id = ?`, [id]);

  try {
    db.run(`DELETE FROM memory_fts WHERE id = ?`, [id]);
  } catch (e) {

    // ignore

    console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
  }


  scheduleSave();
}

async function getStats() {
    await initDatabase();
    const stats = {
    totalIndexed: 0,
    byCategory: {},
    byType: {},
    ftsAvailable: false,
    };
    try {
    const stmt = db.prepare('SELECT COUNT(*) as cnt FROM memory_index');
    if (stmt.step()) {
    stats.totalIndexed = stmt.getAsObject().cnt;
    }
    stmt.free();
    const catStmt = db.prepare('SELECT category, COUNT(*) as cnt FROM memory_index GROUP BY category');
    while (catStmt.step()) {
    const row = catStmt.getAsObject();
    stats.byCategory[row.category] = row.cnt;
    }
    catStmt.free();
    const typeStmt = db.prepare('SELECT type, COUNT(*) as cnt FROM memory_index GROUP BY type');
    while (typeStmt.step()) {
    const row = typeStmt.getAsObject();
    stats.byType[row.type] = row.cnt;
    }
    typeStmt.free();
    try {
    const ftsStmt = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'");
    stats.ftsAvailable = ftsStmt.step();
    ftsStmt.free();
    } catch (e) {
      // ignore
      console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
    }
  } catch (e) {

    // ignore

    console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
  }


  return stats;
}

async function rebuildIndex(memories) {
    await initDatabase();
    try {
    db.run('DELETE FROM memory_fts');
    db.run('DELETE FROM memory_index');
    } catch (e) {
      // ignore
      console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
    }


  let indexed = 0;
  for (const memory of memories) {
    try {
      await indexMemory(memory.id || `mem_${indexed}`, {
        type: memory.type || 'general',
        title: memory.title || '',
        content: memory.content || '',
        tags: memory.tags || [],
        category: memory.category || memory.type || 'general',
        trustScore: memory.trustScore || 0.5,
        importance: memory.importance || 0.5,
        source: memory.source || 'auto',
        created: memory.created || Date.now(),
        updated: memory.updated || Date.now(),
      });
      indexed++;
    } catch (e) {

      // skip

      console.warn('[fts-search.js] 空 catch 补日志:', e && e.message);
    }

  }

  flushSave();
  return { rebuilt: indexed };
}

module.exports = {
  initDatabase,
  indexMemory,
  indexSessionMessage,
  search,
  searchSessions,
  updateAccessCount,
  removeIndex,
  getStats,
  rebuildIndex,
  flushSave,
};
