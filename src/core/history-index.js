const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

let db = null;
let dbPath = path.join(DATA_DIR, 'history.db');
let initialized = false;

function _getDb() {
  if (db) return db;
  try {
    const betterSqlite3 = require('better-sqlite3');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = betterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    return db;
  } catch (e) {
    console.warn('better-sqlite3 不可用，历史搜索将使用文件模- ?', e.message);
    return null;
  }
}

function _initDB() {
  if (initialized) return;
  const d = _getDb();
  if (!d) { initialized = true; return; }

  d.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      session_id TEXT,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_user_timestamp ON messages(user_id, timestamp);
  `);

  try {
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
  } catch (e) {
    console.warn('FTS5 创建失败，全文搜索不可用:', e.message);
  }

  initialized = true;
}

async function addMessage(userId, role, content, sessionId = null, metadata = null) {
  _initDB();
  const d = _getDb();
  if (!d) return;

  const timestamp = Date.now();
  const metaStr = metadata ? JSON.stringify(metadata) : null;

  try {
    d.prepare(
      'INSERT INTO messages (user_id, role, content, timestamp, session_id, metadata) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(userId, role, content, timestamp, sessionId, metaStr);
  } catch (e) {
    console.warn('历史消息写入失败:', e.message);
  }
}

async function getRecentMessages(userId, limit = 20, sessionId = null) {
  _initDB();
  const d = _getDb();
  if (!d) return [];

  try {
    // 2026-08-13 P2-4: sessionId 非空时按会话过滤。
    // (session_id IS NULL OR session_id = ?) 刻意包含 NULL——升级前的历史消息
    // 无 session_id,保证首次恢复会话时上下文不断档(v1 接受旧消息混入)。
    const sql = sessionId
      ? 'SELECT id, role, content, timestamp, session_id, metadata FROM messages WHERE user_id = ? AND (session_id IS NULL OR session_id = ?) ORDER BY timestamp DESC LIMIT ?'
      : 'SELECT id, role, content, timestamp, session_id, metadata FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?';
    const rows = sessionId
      ? d.prepare(sql).all(userId, sessionId, limit)
      : d.prepare(sql).all(userId, limit);
    return rows.reverse();
  } catch (e) {
    console.warn('获取历史消息失败:', e.message);
    return [];
  }
}

/**
 * P2-1(2026-08-25) 压缩写回摘要：删除被中段压缩替换的历史消息(按 id),落一条 isSummary 记录。
 * 下一轮上下文从「原始历史重建」变为「摘要+尾部重建」——结构性根治压缩振荡。
 * @param {string} userId
 * @param {string|null} sessionId
 * @param {{removedIds: Array<string>, summaryText: string, summaryRole?: string}} persist
 * @returns {Promise<boolean>}
 */
async function replaceWithSummary(userId, sessionId, persist) {
  if (!persist || !Array.isArray(persist.removedIds) || persist.removedIds.length === 0) return false;
  _initDB();
  const d = _getDb();
  if (!d) return false;
  const ids = persist.removedIds.filter(Boolean);
  if (ids.length > 0) {
    try {
      const placeholders = ids.map(() => String.fromCharCode(63)).join(
);
      d.prepare('DELETE FROM messages WHERE user_id = ? AND id IN (' + placeholders + ')').run(userId, ...ids);
    } catch (e) { console.warn('历史摘要替换-删除失败:', e.message); }
  }
  try {
    d.prepare('INSERT INTO messages (user_id, role, content, timestamp, session_id, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, persist.summaryRole || 'user', persist.summaryText || '', Date.now(), sessionId || null,
        JSON.stringify({ isSummary: true, persistedAt: new Date().toISOString() }));
  } catch (e) { console.warn('历史摘要替换-写入失败:', e.message); }
  return true;
}

async function searchMessages(userId, query, options = {}) {
  _initDB();
  const d = _getDb();
  if (!d) return _fallbackSearch(userId, query, options);

  const limit = options.limit || 10;
  const role = options.role || null;
  const since = options.since || null;
  const until = options.until || null;

  try {
    let sql;
    let params;

    const escapedQuery = query.replace(/"/g, '""');

    if (role || since || until) {
      let whereParts = ['m.user_id = ?'];
      params = [userId];

      if (role) {
        whereParts.push('m.role = ?');
        params.push(role);
      }
      if (since) {
        whereParts.push('m.timestamp >= ?');
        params.push(since);
      }
      if (until) {
        whereParts.push('m.timestamp <= ?');
        params.push(until);
      }

      sql = `
        SELECT m.id, m.role, m.content, m.timestamp, m.session_id, m.metadata,
               rank
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE fts.content MATCH ?
        AND ${whereParts.join(' AND ')}
        ORDER BY rank
        LIMIT ?
      `;
      params.push(`"${escapedQuery}"`);
      params.push(limit);
    } else {
      sql = `
        SELECT m.id, m.role, m.content, m.timestamp, m.session_id, m.metadata,
               rank
        FROM messages_fts fts
        JOIN messages m ON m.id = fts.rowid
        WHERE fts.content MATCH ?
        AND m.user_id = ?
        ORDER BY rank
        LIMIT ?
      `;
      params = [`"${escapedQuery}"`, userId, limit];
    }

    const rows = d.prepare(sql).all(...params);

    return rows.map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      sessionId: row.session_id,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      relevanceScore: -row.rank,
    }));
  } catch (e) {
    console.warn('FTS5 搜索失败，回退到简单搜- ?', e.message);
    return _fallbackSearch(userId, query, options);
  }
}

function _fallbackSearch(userId, query, options = {}) {
  const limit = options.limit || 10;
  const sessionDir = path.join(DATA_DIR, 'memory', 'sessions');
  if (!fs.existsSync(sessionDir)) return [];

  const results = [];
  const queryLower = query.toLowerCase();

  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      if (results.length >= limit) break;
      try {
        const content = fs.readFileSync(path.join(sessionDir, file), 'utf-8');
        const data = JSON.parse(content);
        const messages = data.messages || data;
        for (const msg of messages) {
          if (results.length >= limit) break;
          const text = (msg.content || '').toLowerCase();
          if (text.includes(queryLower)) {
            results.push({
              id: msg.id || null,
              role: msg.role,
              content: msg.content,
              timestamp: msg.timestamp || null,
              sessionId: file.replace('.json', ''),
              metadata: null,
              relevanceScore: 1,
            });
          }
        }
      } catch { console.warn('[history-index] silent catch, error swallowed'); }
    }
  } catch { console.warn('[history-index] silent catch, error swallowed'); }

  return results;
}

async function getConversationContext(userId, query, maxMessages = 5) {
  const searchResults = await searchMessages(userId, query, { limit: maxMessages * 2 });
  if (searchResults.length === 0) return '';

  const contextParts = searchResults.slice(0, maxMessages).map(msg => {
    const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : '未知时间';
    const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : msg.role;
    return `[${time}] [${roleLabel}]: ${msg.content.slice(0, 500)}`;
  });

  return `找到以下相关历史对话:\n${contextParts.join('\n\n')}`;
}

async function deleteOldMessages(userId, olderThanDays = 90) {
  _initDB();
  const d = _getDb();
  if (!d) return 0;

  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  try {
    const result = d.prepare(
      'DELETE FROM messages WHERE user_id = ? AND timestamp < ?'
    ).run(userId, cutoff);
    return result.changes;
  } catch (e) {
    console.warn('删除旧消息失败?', e.message);
    return 0;
  }
}

async function getStats(userId) {
  _initDB();
  const d = _getDb();
  if (!d) return { total: 0, oldest: null, newest: null };

  try {
    const row = d.prepare(
      'SELECT COUNT(*) as total, MIN(timestamp) as oldest, MAX(timestamp) as newest FROM messages WHERE user_id = ?'
    ).get(userId);
    return row;
  } catch {
    return { total: 0, oldest: null, newest: null };
  }
}

module.exports = {
  addMessage,
  getRecentMessages,
  replaceWithSummary,
  searchMessages,
  getConversationContext,
  deleteOldMessages,
  getStats,
};
