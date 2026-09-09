/**
 * Memory Tools — 记忆读写/搜索工具
 *
 * 让模型能够主动操作 CrabPaw 的记忆系统（unified-memory.db），
 * 而不是被动接收 system prompt 注入的记忆内容。
 *
 * action=read     → 通过 FTS5 搜索记忆，返回匹配条目
 * action=write    → 写入新的记忆条目（自动去重）
 * action=list     → 列出最近的记忆
 * action=stats    → 记忆系统统计
 */

const path = require('path');
const crypto = require('crypto');
const { registry } = require('./registry');

// 2026-08-31 Task1(数据目录统一): 此前 process.cwd() 拼接(cwd 偏移即漂移), 统一走 config.DATA_DIR
const { DATA_DIR } = require('../core/config');
const MEMORY_DB_PATH = path.join(DATA_DIR, 'unified-memory.db');

let _db = null;
function _getDb() {
  if (_db) return _db;
  try {
    const Database = require('better-sqlite3');
    _db = new Database(MEMORY_DB_PATH);
    return _db;
  } catch (e) {
    return null;
  }
}

function _now() { return Date.now(); }

// SP1: 写前 normalize 相等去重（与 MemoryManager._normalizeMemoryText 同款语义——去口语前缀/标点/小写）
function _normalizeText(s) {
  return String(s || '')
    .replace(/^用户(?:说|表示|认为|希望|需要|要求|想要|决定|选择|偏好|习惯|喜欢)/, '')
    .replace(/^(我|我们|用户)\s*/, '')
    .replace(/[，。！？、,.!?；;：:"“”'‘’\s]+/g, '')
    .toLowerCase();
}

const ALLOWED_NAMESPACES = ['default', 'global', 'personal', 'project', 'agent', 'session', 'channel', 'skill', 'system'];

function _validateNamespace(ns, context) {
  const callerNs = context?.namespace || 'default';
  if (ns === 'default' || ns === callerNs) return null;
  if (ALLOWED_NAMESPACES.includes(ns)) {
    if (context?.namespace && ns !== context.namespace && ns !== 'default') {
      return `不允许写入其他代理的命名空间 "${ns}"（当前: "${callerNs}"）`;
    }
    return null;
  }
  return null;
}

async function handleMemory(params, context) {
  const { action = 'read', query, content, title, type = 'general', tags, limit = 10, importance, namespace } = params;
  const db = _getDb();
  if (!db) return { success: false, error: '记忆数据库不可用' };
  const ns = namespace || 'default';

  // 命名空间校验（仅写入操作严格检查）
  if (action === 'write') {
    const nsError = _validateNamespace(ns, context);
    if (nsError) return { success: false, error: nsError };
    if (!content || typeof content !== 'string') {
      return { success: false, error: 'write 模式需要 content 参数（要保存的记忆内容）' };
    }

    const memoryId = `mem_${_now()}_${crypto.randomBytes(4).toString('hex').slice(0, 8)}`;
    const tagStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    const now = _now();

    // SP1: 去重补真实（文件头注释声称"自动去重"）——normalize 相等命中则不新增, touch 已存条目
    const normContent = _normalizeText(content);
    if (normContent) {
      const dup = db.prepare('SELECT id, content FROM memories WHERE namespace = ?').all(ns)
        .find((r) => _normalizeText(r.content) === normContent);
      if (dup) {
        db.prepare('UPDATE memories SET access_count = access_count + 1, last_accessed = ?, updated_at = ? WHERE id = ?')
          .run(now, now, dup.id);
        return { success: true, action: 'write', id: dup.id, deduplicated: true, content: content.substring(0, 200) };
      }
    }

    db.prepare(`
      INSERT INTO memories (id, type, title, content, scope, tags, importance, trust_score, source, namespace, access_count, last_accessed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryId, type, title || content.substring(0, 80), content,
      'personal', tagStr, importance || 0.5, 0.7,
      'tool', ns, 0, now, now, now
    );

    return { success: true, action: 'write', id: memoryId, content: content.substring(0, 200) };
  }

  // ── 读取/搜索 ──
  if (action === 'read' || action === 'search') {
    if (!query) return { success: false, error: 'read/search 模式需要 query 参数' };

    // FTS5 搜索
    const sanitized = query.trim()
      .replace(/['"]/g, '')
      .replace(/[^\w一-鿿\s]/g, ' ')
      .split(/\s+/).filter(Boolean).join(' ');

    if (!sanitized) return { success: true, action: 'search', results: [], total: 0 };

    const rows = db.prepare(`
      SELECT id, type, title, content, scope, tags, importance, trust_score, source, access_count, created_at, updated_at
      FROM memories
      WHERE id IN (
        SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
      )
      AND namespace = ?
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `).all(sanitized, ns, limit);

    return {
      success: true,
      action: 'search',
      query,
      results: rows.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: (r.content || '').substring(0, 1000),
        tags: r.tags ? r.tags.split(',') : [],
        importance: r.importance,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
      total: rows.length,
    };
  }

  // ── 列出最近的记忆 ──
  if (action === 'list') {
    const rows = db.prepare(`
      SELECT id, type, title, content, tags, importance, created_at
      FROM memories
      WHERE namespace = ?
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(ns, limit);

    return {
      success: true,
      action: 'list',
      results: rows.map(r => ({
        id: r.id,
        type: r.type,
        title: r.title,
        content: (r.content || '').substring(0, 300),
        tags: r.tags ? r.tags.split(',') : [],
        importance: r.importance,
        created_at: r.created_at,
      })),
      total: rows.length,
    };
  }

  // ── 统计 ──
  if (action === 'stats') {
    const stats = db.prepare(`
      SELECT type, COUNT(*) as cnt, AVG(importance) as avg_imp
      FROM memories WHERE namespace = ? GROUP BY type ORDER BY cnt DESC
    `).all(ns);
    const total = db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE namespace = ?').get(ns);

    return {
      success: true,
      action: 'stats',
      namespace: ns,
      totalMemories: total.cnt,
      byType: stats.map(s => ({ type: s.type, count: s.cnt, avgImportance: s.avg_imp?.toFixed(2) })),
    };
  }

  return { success: false, error: `未知 action: ${action}。支持: read/write/list/stats` };
}

registry.register({
  name: 'Memory',
  toolset: 'memory',
  category: 'interaction',
  description: '读写 CrabPaw 的记忆系统。写入的记忆会在后续对话中自动注入给 AI 参考。action=write 保存新记忆（需要 content）；action=read/search 按关键词搜索已有记忆；action=list 查看最近/重要记忆；action=stats 查看记忆系统统计。写入的是持久化记忆，跨会话有效。',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write', 'list', 'stats'], default: 'read', description: '操作类型' },
      query: { type: 'string', description: '搜索关键词（read/search 模式需要）' },
      content: { type: 'string', description: '要保存的记忆内容（write 模式需要）' },
      title: { type: 'string', description: '记忆标题（选填，write 模式）' },
      type: { type: 'string', default: 'general', description: '记忆类型（选填）：general(通用), preference(偏好), fact(事实), feedback(反馈), habit(习惯)' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签数组（选填）' },
      importance: { type: 'number', default: 0.5, description: '重要性 0-1（选填，默认 0.5）' },
      limit: { type: 'number', default: 10, description: '返回条数上限（search/list 模式）' },
      namespace: { type: 'string', default: 'default', description: '命名空间（选填，用于多 agent 隔离，默认 default）' },
    },
    required: ['action'],
  },
  handler: handleMemory,
  timeout: 10000,
  isReadOnly: false,
});

module.exports = { handleMemory };
