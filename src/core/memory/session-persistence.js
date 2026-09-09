/**
 * Session Persistence - 会话持久化管理器
 * 
 * 解决问题：
 * - Session 跨天记忆：用户说"继续昨天"无法关联历史会话
 * - 会话ID按天生成，导致无法恢复历史会话
 * 
 * 功能：
 * - 用户ID关联：通过 userId 而非 sessionId 关联会话
 * - 历史会话查询：按用户、时间范围查询历史会话
 * - 智能匹配：支持"继续昨天"、"上次那个"等模糊匹配
 * - 会话摘要：自动生成会话摘要便于检索
 */

const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');
const { atomicWriteFile, atomicWriteJSON } = require('../atomic-write');

let ftsSearch = null;
function getFtsSearch() {
  if (!ftsSearch) {
    try { ftsSearch = require('./fts-search'); } catch { console.debug("best-effort: operation failed, continuing"); }
  }
  return ftsSearch;
}

// 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR
const { DATA_DIR } = require('../config');
const SESSIONS_DIR = path.join(DATA_DIR, 'memory', 'sessions');
const USER_SESSIONS_INDEX = path.join(SESSIONS_DIR, 'user-sessions-index.json');

class SessionPersistence extends EventEmitter {
  constructor(config = {}) {
    super();
    this.sessionsDir = config.sessionsDir || SESSIONS_DIR;
    this.indexPath = config.indexPath || USER_SESSIONS_INDEX;
    this._userIndex = new Map();
    this._sessionCache = new Map();
    this._maxCacheSize = config.maxCacheSize || 20; // 最多缓存20个会话
    this._initialized = false;
    this._writeLock = Promise.resolve(); // 串行化写入操作
  }

  async initialize() {
    await this._ensureDir();
    await this._loadUserIndex();
    this._initialized = true;
    this.emit('initialized');
    console.log('📦 会话持久化管理器已初始化');
  }

  async _ensureDir() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  async _loadUserIndex() {
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = JSON.parse(await fsPromises.readFile(this.indexPath, 'utf-8'));
        for (const [userId, sessions] of Object.entries(data)) {
          this._userIndex.set(userId, sessions);
        }
      } catch (e) {
        console.warn('⚠️ 加载用户会话索引失败:', e.message);
      }
    }
  }

  async _saveUserIndex() {
    // 串行化写入，防止并发覆盖
    this._writeLock = this._writeLock.then(async () => {
      const data = {};
      for (const [userId, sessions] of this._userIndex) {
        data[userId] = sessions;
      }
      atomicWriteJSON(this.indexPath, data);
    }).catch(e => {
      console.warn('⚠️ 保存用户索引失败:', e.message);
    });
    return this._writeLock;
  }

  async registerSession(sessionId, userId = 'default', extraMeta = {}) {
    const sessionMeta = {
      sessionId,
      userId,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      messageCount: 0,
      summary: null,
      ...extraMeta,
    };

    if (!this._userIndex.has(userId)) {
      this._userIndex.set(userId, []);
    }

    const userSessions = this._userIndex.get(userId);
    const existingIndex = userSessions.findIndex(s => s.sessionId === sessionId);
    
    if (existingIndex >= 0) {
      userSessions[existingIndex] = sessionMeta;
    } else {
      userSessions.unshift(sessionMeta);
    }

    userSessions.sort((a, b) => b.lastAccessed - a.lastAccessed);
    
    if (userSessions.length > 100) {
      userSessions.splice(100);
    }

    await this._saveUserIndex();
    this.emit('session:registered', { sessionId, userId });
    
    return sessionMeta;
  }

  async updateSessionAccess(sessionId, userId = 'default') {
    const userSessions = this._userIndex.get(userId) || [];
    const session = userSessions.find(s => s.sessionId === sessionId);
    
    if (session) {
      session.lastAccessed = Date.now();
      userSessions.sort((a, b) => b.lastAccessed - a.lastAccessed);
      await this._saveUserIndex();
    }
  }

  async updateSessionMeta(sessionId, updates, userId = 'default') {
    const userSessions = this._userIndex.get(userId) || [];
    const session = userSessions.find(s => s.sessionId === sessionId);
    
    if (session) {
      Object.assign(session, updates);
      session.lastAccessed = Date.now();
      if (updates.projectId) {
        console.debug('[session-persistence] 更新会话元数据 projectId:', { sessionId, projectId: updates.projectId });
      }
      await this._saveUserIndex();
    }
  }

  _evictCacheIfNeeded() {
    // LRU 淘汰：当缓存超过上限时，删除最早添加的条目
    if (this._sessionCache.size <= this._maxCacheSize) return;
    const keysToDelete = [];
    let count = this._sessionCache.size - this._maxCacheSize;
    for (const key of this._sessionCache.keys()) {
      if (count <= 0) break;
      keysToDelete.push(key);
      count--;
    }
    for (const key of keysToDelete) {
      this._sessionCache.delete(key);
    }
  }

  async loadSession(sessionId) {
    const filePath = path.join(this.sessionsDir, `${sessionId}.json`);

    // 2026-08-14 数据链审计 C2: 磁盘文件存在时总是重读最新内容——旧实现先命中
    // _sessionCache(创建时写入的空快照,运行期无人刷新),导致详情接口恒返 messages: []。
    // 缓存仅作磁盘缺失时的回退(会话仅注册未落盘)。
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(await fsPromises.readFile(filePath, 'utf-8'));
        this._sessionCache.set(sessionId, data);
        this._evictCacheIfNeeded();
        return data;
      } catch (e) {
        console.warn(`⚠️ 加载会话 ${sessionId} 失败:`, e.message);
        return this._sessionCache.has(sessionId) ? this._sessionCache.get(sessionId) : null;
      }
    }

    return this._sessionCache.has(sessionId) ? this._sessionCache.get(sessionId) : null;
  }

  async saveSession(sessionId, sessionData, userId = 'default') {
    await this._ensureDir();
    const filePath = path.join(this.sessionsDir, `${sessionId}.json`);

    // 保留归档/置顶/未读标记
    const existing = this._sessionCache.get(sessionId)
    const data = {
      ...sessionData,
      sessionId,
      userId,
      savedAt: Date.now(),
      // 归档概念：持久化保留归档/置顶/未读状态
      archived: sessionData.archived ?? existing?.archived ?? false,
      pinned: sessionData.pinned ?? existing?.pinned ?? false,
      unread: sessionData.unread ?? existing?.unread ?? false,
      archivedAt: sessionData.archivedAt ?? existing?.archivedAt ?? null,
    };

    await atomicWriteFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    
    this._sessionCache.set(sessionId, data);
    this._evictCacheIfNeeded();

    // FTS5 索引会话消息
    try {
      const fts = getFtsSearch();
      if (fts && sessionData.messages) {
        for (const msg of sessionData.messages) {
          if (msg.content && typeof msg.content === 'string') {
            fts.indexSessionMessage(sessionId, msg.role || 'unknown', msg.content.slice(0, 2000));
          }
        }
      }
    } catch { console.debug("best-effort: operation failed, continuing"); }
    
    await this.updateSessionMeta(sessionId, {
      messageCount: sessionData.messages?.length || 0,
      summary: this._generateSummary(sessionData),
    }, userId);

    this.emit('session:saved', { sessionId, userId });
  }

  _generateSummary(sessionData) {
    const messages = sessionData.messages || [];
    if (messages.length === 0) return null;

    const firstUserMsg = messages.find(m => m.role === 'user');
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');

    return {
      firstMessage: firstUserMsg?.content?.slice(0, 100) || '',
      lastMessage: lastUserMsg?.content?.slice(0, 100) || '',
      messageCount: messages.length,
      createdAt: sessionData.createdAt,
    };
  }

  async getUserSessions(userId = 'default', options = {}) {
    const userSessions = this._userIndex.get(userId) || [];
    let result = [...userSessions];

    if (options.since) {
      const since = typeof options.since === 'string' 
        ? this._parseTimeExpression(options.since)
        : options.since;
      result = result.filter(s => s.createdAt >= since);
    }

    if (options.until) {
      result = result.filter(s => s.createdAt <= options.until);
    }

    if (options.limit) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  /**
   * 统计用户的会话总数（limit 之前的真实数量）
   * 用于前端卡片展示「总会话数」等需要真实总数的场景
   * @param {string} userId
   * @param {Object} options
   * @param {string} [options.projectId] - 按项目过滤
   * @returns {Promise<number>}
   */
  async countUserSessions(userId = 'default', options = {}) {
    const all = await this.getUserSessions(userId); // 不传 limit
    if (options.projectId) {
      return all.filter(s => s.projectId === options.projectId).length;
    }
    return all.length;
  }

  /**
   * 清空某用户全部会话历史（CLI history clear / 前端清空历史共用，2026-08-18 残留修复）
   * @param {string} userId
   * @returns {number} 删除的会话数
   */
  async clearUserSessions(userId = 'default') {
    const all = await this.getUserSessions(userId);
    if (!all.length) return 0;
    this._userIndex.set(userId, []);
    await this._saveUserIndex();
    // 清理缓存中的该用户会话（_sessionCache key 为 sessionId，与 userId 无直接映射——
    // 通过 sessionId 前缀/usersIndex 无法反查，此处仅逐条尝试删除已知 id）
    for (const s of all) {
      if (s.id) this._sessionCache.delete(s.id);
    }
    this.emit('sessions:cleared', { userId, count: all.length });
    return all.length;
  }

  _parseTimeExpression(expr) {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    const patterns = {
      '今天': now - (now % day),
      '昨天': now - day - (now % day),
      '前天': now - 2 * day - (now % day),
      '本周': now - 7 * day,
      '上周': now - 14 * day,
      '本月': now - 30 * day,
      'today': now - (now % day),
      'yesterday': now - day - (now % day),
      'this_week': now - 7 * day,
      'this_month': now - 30 * day,
    };

    for (const [pattern, timestamp] of Object.entries(patterns)) {
      if (expr.toLowerCase().includes(pattern)) {
        return timestamp;
      }
    }

    const daysAgo = parseInt(expr.match(/(\d+)\s*天前/)?.[1] || '0');
    if (daysAgo > 0) {
      return now - daysAgo * day;
    }

    return 0;
  }

  async findSessionByKeyword(keyword, userId = 'default') {
    // 优先使用 FTS5 全文检索
    try {
      const fts = getFtsSearch();
      if (fts) {
        const ftsResults = await fts.searchSessions(keyword, 20);
        if (ftsResults.length > 0) {
          // 按 sessionId 聚合
          const sessionMap = new Map();
          for (const r of ftsResults) {
            const sid = r.sessionId;
            if (!sessionMap.has(sid)) {
              sessionMap.set(sid, { sessionId: sid, matchedCount: 0, matchedMessages: [], score: 0 });
            }
            const entry = sessionMap.get(sid);
            entry.matchedCount++;
            entry.score += r.score;
            if (entry.matchedMessages.length < 3) {
              entry.matchedMessages.push({ role: r.role, content: r.content });
            }
          }
          // 补充元数据
          const results = [];
          for (const [sid, entry] of sessionMap) {
            const userSessions = this._userIndex.get(userId) || [];
            const meta = userSessions.find(s => s.sessionId === sid);
            results.push({
              ...entry,
              createdAt: meta?.createdAt || null,
            });
          }
          results.sort((a, b) => b.score - a.score);
          return results;
        }
      }
    } catch { console.debug("best-effort: operation failed, continuing"); }

    // 回退到线性扫描
    const userSessions = await this.getUserSessions(userId, { limit: 20 });
    const results = [];

    for (const meta of userSessions) {
      const session = await this.loadSession(meta.sessionId);
      if (!session) continue;

      const messages = session.messages || [];
      const matchedMessages = messages.filter(m => 
        m.content?.toLowerCase().includes(keyword.toLowerCase())
      );

      if (matchedMessages.length > 0) {
        results.push({
          sessionId: meta.sessionId,
          createdAt: meta.createdAt,
          matchedCount: matchedMessages.length,
          matchedMessages: matchedMessages.slice(0, 3),
        });
      }
    }

    return results;
  }

  async continueLastSession(userId = 'default', timeExpression = '昨天') {
    const since = this._parseTimeExpression(timeExpression);
    const sessions = await this.getUserSessions(userId, { 
      since,
      limit: 5,
    });

    if (sessions.length === 0) {
      return null;
    }

    const mostRecent = sessions[0];
    const sessionData = await this.loadSession(mostRecent.sessionId);

    if (sessionData) {
      await this.updateSessionAccess(mostRecent.sessionId, userId);
    }

    return {
      sessionId: mostRecent.sessionId,
      session: sessionData,
      meta: mostRecent,
    };
  }

  async getRecentContext(userId = 'default', days = 7) {
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions = await this.getUserSessions(userId, { since });

    const context = {
      totalSessions: sessions.length,
      totalMessages: 0,
      topics: [],
      recentFiles: [],
      recentCommands: [],
    };

    for (const meta of sessions.slice(0, 5)) {
      const session = await this.loadSession(meta.sessionId);
      if (!session) continue;

      context.totalMessages += session.messages?.length || 0;

      if (session.sections) {
        const filesSection = session.sections['Files and Functions'];
        if (filesSection?.content) {
          context.recentFiles.push(filesSection.content.slice(0, 200));
        }

        const workflowSection = session.sections['Workflow'];
        if (workflowSection?.content) {
          context.recentCommands.push(workflowSection.content.slice(0, 200));
        }
      }
    }

    return context;
  }

  async mergeSessions(targetSessionId, sourceSessionIds, userId = 'default') {
    const targetSession = await this.loadSession(targetSessionId);
    if (!targetSession) {
      throw new Error(`目标会话 ${targetSessionId} 不存在`);
    }

    const mergedMessages = [...(targetSession.messages || [])];
    const mergedSections = { ...targetSession.sections };

    for (const sourceId of sourceSessionIds) {
      const sourceSession = await this.loadSession(sourceId);
      if (!sourceSession) continue;

      mergedMessages.push(...(sourceSession.messages || []));

      if (sourceSession.sections) {
        for (const [sectionName, section] of Object.entries(sourceSession.sections)) {
          if (!mergedSections[sectionName]) {
            mergedSections[sectionName] = section;
          } else if (section.content && !mergedSections[sectionName].content.includes(section.content)) {
            mergedSections[sectionName].content += `\n\n--- 来自会话 ${sourceId} ---\n${section.content}`;
          }
        }
      }
    }

    mergedMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const mergedSession = {
      ...targetSession,
      messages: mergedMessages,
      sections: mergedSections,
      mergedFrom: sourceSessionIds,
      mergedAt: Date.now(),
    };

    await this.saveSession(targetSessionId, mergedSession, userId);
    
    return mergedSession;
  }

  getStats() {
    let totalSessions = 0;
    let totalUsers = this._userIndex.size;

    for (const sessions of this._userIndex.values()) {
      totalSessions += sessions.length;
    }

    return {
      totalUsers,
      totalSessions,
      cacheSize: this._sessionCache.size,
    };
  }
}

let _sharedInstance = null;
/**
 * 2026-08-14 数据链审计 I4: 共享单例——session-manager 与 memory-manager 此前各自
 * new SessionPersistence,内存索引/缓存分裂导致列表、详情、落库三端各读各的快照。
 * 显式传入自定义 config 的场景仍各自独立(测试/定制目录)。
 */
function getSharedSessionPersistence() {
  if (!_sharedInstance) {
    _sharedInstance = new SessionPersistence();
  }
  return _sharedInstance;
}

module.exports = {
  SessionPersistence,
  getSharedSessionPersistence,
};
