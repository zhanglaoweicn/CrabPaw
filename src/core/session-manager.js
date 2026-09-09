const { EventEmitter } = require('events');
const crypto = require('crypto');
const { SessionPersistence, getSharedSessionPersistence } = require('./memory/session-persistence');
const { GatewayRecoveryManager } = require('./gateway-recovery');

const PII_PATTERNS = [
  { name: 'phone', pattern: /1[3-9]\d{9}/g },
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'idcard', pattern: /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g },
  { name: 'bankcard', pattern: /(?:62|4\d|5[1-5])\d{14,17}/g },
];

const PII_HASH_SALT = process.env.CRABPAW_PII_SALT || 'crabpaw-pii-v1';
const SESSION_RESET_COOLDOWN_MS = 5000;

class SessionManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    // 2026-08-14 数据链审计 I4: 无自定义 config 时复用全局单例——与 memory-manager
    // 共用同一 SessionPersistence,避免索引/缓存分裂(列表、详情、落库各读各的快照)。
    this.persistence = config.persistence ? new SessionPersistence(config.persistence) : getSharedSessionPersistence();
    this.recovery = new GatewayRecoveryManager(config.recovery);
    this._sessions = new Map();
    this._maxSessions = config.maxSessions || 1000;
    this._sessionTTL = config.sessionTTL || 3600000;
    this._cleanupInterval = config.cleanupInterval || 300000;
    this._cleanupTimer = null;
  }

  async initialize() {
    await this.persistence.initialize();
    this._startCleanup();
    this.emit('initialized');
  }

  async createSession(sessionId, metadata = {}) {
    if (this._sessions.size >= this._maxSessions) {
      this._evictOldest();
    }

    const session = {
      sessionId,
      platform: metadata.platform || 'unknown',
      chatId: metadata.chatId || sessionId,
      userId: metadata.userId || 'default',
      messages: [],
      context: null,
      goalState: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messageCount: 0,
      metadata: { ...metadata },
    };

    this._sessions.set(sessionId, session);
    await this.persistence.registerSession(sessionId, session.userId);
    this.recovery.registerSession(sessionId, {
      platform: session.platform,
      chatId: session.chatId,
      startedAt: session.createdAt,
    });

    this.emit('session_created', session);
    return session;
  }

  getSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
    return session || null;
  }

  async getOrRestore(sessionId, userId) {
    let session = this._sessions.get(sessionId);
    if (session) return session;

    const history = await this.persistence.loadSession(sessionId);
    if (history) {
      session = await this.createSession(sessionId, {
        platform: history.platform || 'unknown',
        chatId: history.chatId || sessionId,
        userId: userId || history.userId || 'default',
      });
      return session;
    }

    return null;
  }

  updateSession(sessionId, updates = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    if (updates.messages) {
      session.messages = updates.messages;
    }
    if (updates.context !== undefined) {
      session.context = updates.context;
    }
    if (updates.goalState !== undefined) {
      session.goalState = updates.goalState;
    }
    if (updates.metadata) {
      session.metadata = { ...session.metadata, ...updates.metadata };
    }

    session.lastActivityAt = Date.now();
    session.messageCount = session.messages.length;

    this.recovery.updateSession(sessionId, {
      messageCount: session.messageCount,
      lastActivityAt: session.lastActivityAt,
      hasGoal: !!session.goalState,
      goalState: session.goalState,
    });

    this.emit('session_updated', { sessionId, updates });
    return true;
  }

  addMessage(sessionId, message) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    session.messages.push({
      ...message,
      timestamp: message.timestamp || Date.now(),
    });
    session.messageCount = session.messages.length;
    session.lastActivityAt = Date.now();

    // 同步持久化消息到磁盘（后台 fire-and-forget）
    if (this.persistence && this.persistence.saveSession) {
      this.persistence.saveSession(sessionId, session).catch(e =>
        console.warn('[SessionManager] 持久化消息失败:', e.message)
      );
    }

    this.emit('message_added', { sessionId, message });
    return true;
  }

  getMessages(sessionId, limit = 50) {
    const session = this._sessions.get(sessionId);
    if (!session) return [];
    if (limit <= 0) return session.messages;
    return session.messages.slice(-limit);
  }

  async closeSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    await this.persistence.updateSessionMeta(
      sessionId,
      { summary: this._generateSummary(session) },
      session.userId
    );

    this.recovery.unregisterSession(sessionId);
    this._sessions.delete(sessionId);
    this.emit('session_closed', { sessionId });
    return true;
  }

  getActiveSessions() {
    return Array.from(this._sessions.values()).map(s => ({
      sessionId: s.sessionId,
      platform: s.platform,
      chatId: s.chatId,
      userId: s.userId,
      messageCount: s.messageCount,
      lastActivityAt: s.lastActivityAt,
      hasGoal: !!s.goalState,
    }));
  }

  getSessionsByUser(userId) {
    return Array.from(this._sessions.values()).filter(s => s.userId === userId);
  }

  getSessionsByPlatform(platform) {
    return Array.from(this._sessions.values()).filter(s => s.platform === platform);
  }

  _generateSummary(session) {
    const messages = session.messages;
    if (messages.length === 0) return '空会话';

    const userMessages = messages.filter(m => m.role === 'user');
    const firstUserMsg = userMessages[0]?.content || '';
    const lastUserMsg = userMessages[userMessages.length - 1]?.content || '';

    return `会话共 ${messages.length} 条消息。首次: ${firstUserMsg.substring(0, 100)}。最近: ${lastUserMsg.substring(0, 100)}`;
  }

  _evictOldest() {
    let oldest = null;
    let oldestTime = Infinity;
    for (const [id, session] of this._sessions) {
      if (session.lastActivityAt < oldestTime) {
        oldest = id;
        oldestTime = session.lastActivityAt;
      }
    }
    if (oldest) {
      this.closeSession(oldest).catch(e => console.debug('[session] Close failed:', e?.message));
    }
  }

  _startCleanup() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      this._cleanup();
    }, this._cleanupInterval);
  }

  _cleanup() {
    const now = Date.now();
    const toClose = [];
    for (const [id, session] of this._sessions) {
      if (now - session.lastActivityAt > this._sessionTTL) {
        toClose.push(id);
      }
    }
    for (const id of toClose) {
      this.closeSession(id).catch(e => console.debug('[session] Close failed:', e?.message));
    }
    if (toClose.length > 0) {
      this.emit('cleanup', { closedSessions: toClose.length });
    }
  }

  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  getStats() {
    let totalMessages = 0;
    let withGoals = 0;
    for (const session of this._sessions.values()) {
      totalMessages += session.messageCount;
      if (session.goalState) withGoals++;
    }
    return {
      activeSessions: this._sessions.size,
      totalMessages,
      sessionsWithGoals: withGoals,
      maxSessions: this._maxSessions,
      sessionTTL: this._sessionTTL,
    };
  }

  hashPII(text) {
    if (!text || typeof text !== 'string') return text;

    let result = text;
    for (const { name, pattern } of PII_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      result = result.replace(regex, (match) => {
        const hash = crypto
          .createHash('sha256')
          .update(PII_HASH_SALT + match)
          .digest('hex')
          .slice(0, 8);
        return `[${name}:${hash}]`;
      });
    }
    return result;
  }

  detectPII(text) {
    if (!text || typeof text !== 'string') return [];

    const findings = [];
    for (const { name, pattern } of PII_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          type: name,
          value: match[0],
          index: match.index,
          length: match[0].length,
        });
      }
    }
    return findings;
  }

  sanitizeSessionPII(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    let sanitized = false;
    for (const msg of session.messages) {
      if (typeof msg.content === 'string') {
        const pii = this.detectPII(msg.content);
        if (pii.length > 0) {
          msg.content = this.hashPII(msg.content);
          msg._piiSanitized = true;
          sanitized = true;
        }
      }
    }

    if (session.metadata) {
      for (const key of Object.keys(session.metadata)) {
        if (typeof session.metadata[key] === 'string') {
          const pii = this.detectPII(session.metadata[key]);
          if (pii.length > 0) {
            session.metadata[key] = this.hashPII(session.metadata[key]);
            sanitized = true;
          }
        }
      }
    }

    if (sanitized) {
      this.emit('pii_sanitized', { sessionId });
    }
    return sanitized;
  }

  async resetSession(sessionId, options = {}) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;

    const now = Date.now();
    if (session._lastResetAt && now - session._lastResetAt < SESSION_RESET_COOLDOWN_MS) {
      this.emit('reset_cooldown', { sessionId, remainingMs: SESSION_RESET_COOLDOWN_MS - (now - session._lastResetAt) });
      return false;
    }

    const preserveGoal = options.preserveGoal || false;
    const preserveMetadata = options.preserveMetadata || false;
    const reason = options.reason || 'manual_reset';

    const oldGoal = preserveGoal ? session.goalState : null;
    const oldMetadata = preserveMetadata ? { ...session.metadata } : {};

    session.messages = [];
    session.context = null;
    session.goalState = oldGoal;
    session.messageCount = 0;
    session.lastActivityAt = now;
    session._lastResetAt = now;
    session._resetCount = (session._resetCount || 0) + 1;
    session._lastResetReason = reason;

    if (preserveMetadata) {
      session.metadata = {
        ...oldMetadata,
        _resetHistory: [
          ...(oldMetadata._resetHistory || []),
          { reason, timestamp: now },
        ].slice(-10),
      };
    } else {
      session.metadata = {
        _resetHistory: [{ reason, timestamp: now }],
      };
    }

    this.emit('session_reset', { sessionId, reason, resetCount: session._resetCount });
    return true;
  }

  getResetHistory(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return [];
    return session.metadata?._resetHistory || [];
  }

  async shutdown() {
    this.stopCleanup();
    for (const [id] of this._sessions) {
      await this.closeSession(id).catch(e => console.debug('[session] Close failed:', e?.message));
    }
    this.recovery.shutdown();
    this.emit('shutdown');
  }
}

module.exports = { SessionManager };
