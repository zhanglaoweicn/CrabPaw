/**
 * SessionIsolation - 跨会话隔离
 * 
 * 确保不同用户的数据相互隔离
 * 防止路径遍历攻击
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class SessionIsolation {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      strictMode: config.strictMode || false,
      sessionTimeout: config.sessionTimeout || 24 * 60 * 60 * 1000,
      maxSessionsPerUser: config.maxSessionsPerUser || 10,
      ...config
    };
    
    this._baseDir = process.cwd();
    this._dataDir = path.join(this._baseDir, 'data');
    this._sessionsDir = path.join(this._dataDir, '.crabpaw', 'sessions');
    
    this._sessions = new Map();
    this._userSessions = new Map();
    
    this._stats = {
      sessionsCreated: 0,
      sessionsExpired: 0,
      accessDenied: 0,
      pathTraversalsBlocked: 0
    };
  }

  async initialize() {
    if (!fs.existsSync(this._sessionsDir)) {
      fs.mkdirSync(this._sessionsDir, { recursive: true });
    }
    
    await this._loadExistingSessions();
    
    this._cleanupTimer = setInterval(() => this._cleanupExpiredSessions(), 60 * 60 * 1000);
    if (this._cleanupTimer && typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
    
    console.log('🔐 会话隔离已初始化');
  }

  async _loadExistingSessions() {
    try {
      const userDirs = fs.readdirSync(this._sessionsDir);
      for (const userId of userDirs) {
        const userDir = path.join(this._sessionsDir, userId);
        if (fs.statSync(userDir).isDirectory()) {
          this._userSessions.set(userId, {
            dataPath: userDir,
            createdAt: Date.now()
          });
        }
      }
    } catch (e) {
      console.warn('加载现有会话失败:', e.message);
    }
  }

  createSession(userId) {
    if (!this.config.enabled) {
      return {
        sessionId: this._generateSessionId(userId),
        dataPath: this._dataDir
      };
    }
    
    const safeUserId = this._sanitizeUserId(userId);
    const sessionId = this._generateSessionId(safeUserId);
    const userDir = path.join(this._sessionsDir, safeUserId);
    
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
      
      const subDirs = ['history', 'memory', 'config', 'cache'];
      for (const subDir of subDirs) {
        fs.mkdirSync(path.join(userDir, subDir), { recursive: true });
      }
    }
    
    const session = {
      id: sessionId,
      userId: safeUserId,
      dataPath: userDir,
      createdAt: Date.now(),
      lastAccess: Date.now()
    };
    
    this._sessions.set(sessionId, session);
    this._userSessions.set(safeUserId, session);
    this._stats.sessionsCreated++;
    
    return session;
  }

  checkAccess(userId, sessionId) {
    if (!this.config.enabled) {
      return { allowed: true, reason: '会话隔离未启用' };
    }
    
    const session = this._sessions.get(sessionId);
    if (!session) {
      return { allowed: false, reason: '会话不存在' };
    }
    
    const safeUserId = this._sanitizeUserId(userId);
    if (session.userId !== safeUserId) {
      this._stats.accessDenied++;
      return { allowed: false, reason: '用户与会话不匹配' };
    }
    
    if (Date.now() - session.lastAccess > this.config.sessionTimeout) {
      this._stats.sessionsExpired++;
      return { allowed: false, reason: '会话已过期' };
    }
    
    session.lastAccess = Date.now();
    return { allowed: true, session };
  }

  getUserDataPath(userId) {
    if (!this.config.enabled) {
      return this._dataDir;
    }
    
    const safeUserId = this._sanitizeUserId(userId);
    let userSession = this._userSessions.get(safeUserId);
    
    if (!userSession) {
      userSession = this.createSession(safeUserId);
    }
    
    return userSession.dataPath;
  }

  validatePath(userId, requestedPath) {
    const safeUserId = this._sanitizeUserId(userId);
    const userPath = this.getUserDataPath(safeUserId);
    
    let normalizedRequested = path.resolve(requestedPath);
    let normalizedUser = path.resolve(userPath);
    
    normalizedRequested = normalizedRequested.replace(/\\/g, '/');
    normalizedUser = normalizedUser.replace(/\\/g, '/');
    
    if (this._containsPathTraversal(requestedPath)) {
      this._stats.pathTraversalsBlocked++;
      return {
        valid: false,
        reason: '检测到路径遍历攻击',
        blocked: true
      };
    }
    
    if (!normalizedRequested.startsWith(normalizedUser)) {
      if (this.config.strictMode) {
        this._stats.accessDenied++;
        return {
          valid: false,
          reason: '路径不在用户数据目录内',
          blocked: true
        };
      }
    }
    
    return {
      valid: true,
      safePath: normalizedRequested,
      userPath: normalizedUser
    };
  }

  _sanitizeUserId(userId) {
    if (!userId || typeof userId !== 'string') {
      return 'default';
    }
    
    let sanitized = userId
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 64);
    
    if (sanitized.length < 3) {
      sanitized = 'user_' + crypto.randomBytes(4).toString('hex');
    }
    
    return sanitized;
  }

  _generateSessionId(userId) {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `${userId}_${timestamp}_${random}`;
  }

  _containsPathTraversal(inputPath) {
    const patterns = [
      /\.\./,
      /\.\.\\/,
      /~\//,
      /\.\.%2f/i,
      /\.\.%5c/i,
      /%2e%2e/i,
      /\.\.%252f/i
    ];
    
    return patterns.some(p => p.test(inputPath));
  }

  _cleanupExpiredSessions() {
    const now = Date.now();
    const expired = [];
    
    for (const [sessionId, session] of this._sessions) {
      if (now - session.lastAccess > this.config.sessionTimeout) {
        expired.push(sessionId);
      }
    }
    
    for (const sessionId of expired) {
      this._sessions.delete(sessionId);
      this._stats.sessionsExpired++;
    }
    
    if (expired.length > 0) {
      console.log(`🧹 清理了 ${expired.length} 个过期会话`);
    }
  }

  getActiveSessions() {
    const sessions = [];
    for (const [id, session] of this._sessions) {
      sessions.push({
        id,
        userId: session.userId,
        createdAt: session.createdAt,
        lastAccess: session.lastAccess
      });
    }
    return sessions;
  }

  getStats() {
    return {
      ...this._stats,
      activeSessions: this._sessions.size,
      totalUsers: this._userSessions.size
    };
  }

  /**
   * 停止过期会话清理轮询（进程退出/关闭时调用）
   */
  stop() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  enable() {
    this.config.enabled = true;
  }

  disable() {
    this.config.enabled = false;
  }

  setStrictMode(enabled) {
    this.config.strictMode = enabled;
  }
}

module.exports = SessionIsolation;
