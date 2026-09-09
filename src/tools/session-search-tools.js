/**
 * SessionSearch — 跨会话对话历史语义搜索
 *
 * 基于 SQLite FTS5 全文索引。零 LLM 成本，每次搜索直接查询已有索引。
 *
 * 三种模式（自动推断）：
 *   1. search — query 参数 → FTS5 匹配 → 返回匹配内容 + ±3 消息上下文窗口
 *   2. browse — 无参数 → 返回近期会话摘要
 *   3. session — session_id 参数 → 返回该会话的消息列表
 */

const path = require('path');
const { registry } = require('./registry');

// 2026-08-31 Task1(数据目录统一): 此前 process.cwd() 拼接(cwd 偏移即漂移), 统一走 config.DATA_DIR
const { DATA_DIR } = require('../core/config');
const HISTORY_DB_PATH = path.join(DATA_DIR, 'history.db');

let _db = null;
function _getDb() {
  if (_db) return _db;
  try {
    const Database = require('better-sqlite3');
    _db = new Database(HISTORY_DB_PATH, { readonly: true });
    return _db;
  } catch (e) {
    return null;
  }
}

// ── 搜索模式 ──

async function handleSessionSearch(params, _context) {
  const { query, session_id, limit = 10, offset = 0 } = params;
  const db = _getDb();
  if (!db) return { success: false, error: 'SQLite 不可用（需要 better-sqlite3 模块）' };

  // 模式 1: 显示某个会话的完整消息
  if (session_id) {
    const msgs = db.prepare(`
      SELECT id, user_id, role, content, timestamp, metadata
      FROM messages
      WHERE session_id = ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `).all(session_id, limit, offset);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(session_id);
    return {
      success: true,
      mode: 'session',
      session_id,
      messages: msgs.map(m => ({
        id: m.id,
        role: m.role,
        content: (m.content || '').substring(0, 2000),
        timestamp: m.timestamp,
      })),
      total: count.cnt,
      limit,
      offset,
    };
  }

  // 模式 2: 关键词搜索（FTS5）
  if (query && query.trim()) {
    // FTS5 需要转义特殊字符
    const sanitized = query.trim()
      .replace(/['"]/g, '')
      .replace(/[^\w一-鿿\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .join(' ');

    if (!sanitized) return { success: true, mode: 'search', query, results: [], total: 0 };

    // 查询匹配的消息ID
    const matchIds = db.prepare(`
      SELECT rowid, rank FROM messages_fts
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit);

    if (matchIds.length === 0) return { success: true, mode: 'search', query, results: [], total: 0 };

    // 获取每条消息及其上下文（前后各3条）
    const results = [];
    for (const { rowid } of matchIds) {
      const msg = db.prepare('SELECT id, user_id, role, content, timestamp, session_id FROM messages WHERE id = ?').get(rowid);
      if (!msg) continue;

      // 获取上下文窗口
      const contextWindow = db.prepare(`
        SELECT id, role, content, timestamp
        FROM messages
        WHERE id >= ? AND id <= ? AND session_id = ?
        ORDER BY id ASC
      `).all(
        Math.max(1, rowid - 3),
        rowid + 3,
        msg.session_id || ''
      );

      results.push({
        message: {
          id: msg.id,
          role: msg.role,
          content: (msg.content || '').substring(0, 2000),
          timestamp: msg.timestamp,
        },
        session_id: msg.session_id,
        context: contextWindow.map(m => ({
          id: m.id,
          role: m.role,
          content: (m.content || '').substring(0, 500),
        })),
      });
    }

    return {
      success: true,
      mode: 'search',
      query,
      results,
      total: matchIds.length,
    };
  }

  // 模式 3: 浏览近期会话
  const recentSessions = db.prepare(`
    SELECT session_id,
           MIN(timestamp) as first_time,
           MAX(timestamp) as last_time,
           COUNT(*) as msg_count,
           (SELECT content FROM messages m2 WHERE m2.session_id = messages.session_id ORDER BY id ASC LIMIT 1) as first_content
    FROM messages
    WHERE session_id IS NOT NULL AND session_id != ''
    GROUP BY session_id
    ORDER BY last_time DESC
    LIMIT 20 OFFSET ?
  `).all(offset);

  return {
    success: true,
    mode: 'browse',
    sessions: recentSessions.map(s => ({
      session_id: s.session_id,
      firstTime: s.first_time,
      lastTime: s.last_time,
      messageCount: s.msg_count,
      preview: (s.first_content || '').substring(0, 200),
    })),
    total: recentSessions.length,
  };
}

registry.register({
  name: 'SessionSearch',
  toolset: 'memory',
  category: 'interaction',
  description: '搜索对话历史。三种模式：1) 传 query → FTS5 全文搜索对话内容，返回匹配消息及其上下文窗口；2) 传 session_id → 查看某个会话的完整消息列表；3) 不传参数 → 浏览近期会话摘要。零 LLM 成本。',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（模式1：全文搜索）。支持中文和英文' },
      session_id: { type: 'string', description: '会话 ID（模式2：查看某会话的完整消息）' },
      limit: { type: 'number', default: 10, description: '返回条数上限' },
      offset: { type: 'number', default: 0, description: '分页偏移量' },
    },
  },
  handler: handleSessionSearch,
  timeout: 10000,
  isReadOnly: true,
  // P0-5(2026-08-25) 可用性探测缓存 60s：此前每轮对话真实打开一次 better-sqlite3
  // （5-30ms/轮）——判"能否用"无需反复开库，进程级 TTL 缓存即可。
  checkFn: (() => {
    let _usable = null;
    let _checkedAt = 0;
    return () => {
      const now = Date.now();
      if (_usable !== null && now - _checkedAt < 60000) return _usable;
      _checkedAt = now;
      try {
        const Database = require('better-sqlite3');
        const db = new Database(HISTORY_DB_PATH, { readonly: true });
        db.close();
        _usable = true;
      } catch { _usable = false; }
      return _usable;
    };
  })(),
});

module.exports = { handleSessionSearch };
