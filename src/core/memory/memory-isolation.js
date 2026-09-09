const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
/**
 * Memory Isolation System
 * Merged from agent-isolation.js + user-isolation.js
 * Classes: ['AgentMemoryStore', 'GlobalMemoryStore', 'HybridMemoryManager', 'UserIsolationManager']
 */

const USER_NAMESPACE_PREFIX = 'user:';
const { NamespaceManager, GLOBAL_NAMESPACE } = require('./namespace-manager');
// 2026-08-31 Eval 隔离轮 Task 2：裸构造默认路径改走 config.DATA_DIR（原 CWD 相对
// './data/'+'.crabpaw' 式 CWD 相对硬编码绕过 CRABPAW_DATA_DIR 重定向；绝对路径与
// repo 根 CWD 下旧值同文件，生产行为不变）。
const { DATA_DIR } = require('../config');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');

// === From agent-isolation.js ===
class AgentMemoryStore extends EventEmitter {
  constructor(config = {}) {
    super();
    this.baseDir = config.baseDir || path.join(MEMORY_DIR, 'agents');
    this._cache = new Map();
  }

  async getMemory(agentName) {
    if (this._cache.has(agentName)) return this._cache.get(agentName);
    const filePath = path.join(this.baseDir, agentName, 'memory.json');
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this._cache.set(agentName, data);
      return data;
    } catch {
      const empty = { facts: [], entities: [], updatedAt: Date.now() };
      this._cache.set(agentName, empty);
      return empty;
    }
  }

  async updateMemory(agentName, updates) {
    const current = await this.getMemory(agentName);
    const merged = { ...current, ...updates, updatedAt: Date.now() };
    this._cache.set(agentName, merged);
    const dir = path.join(this.baseDir, agentName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(merged, null, 2));
    return merged;
  }

  async addFact(agentName, fact) {
    const memory = await this.getMemory(agentName);
    memory.facts = memory.facts || [];
    memory.facts.push(fact);
    await this.updateMemory(agentName, memory);
    return fact;
  }
}

class GlobalMemoryStore extends EventEmitter {
  constructor(config = {}) {
    super();
    this.memoryPath = config.memoryPath || path.join(MEMORY_DIR, 'memory.json');
    this._data = null;
  }

  async load() {
    try {
      this._data = JSON.parse(fs.readFileSync(this.memoryPath, 'utf-8'));
    } catch {
      this._data = { facts: [], entities: [], updatedAt: Date.now() };
    }
    return this._data;
  }

  async save(data) {
    this._data = data;
    const dir = path.dirname(this.memoryPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.memoryPath, JSON.stringify(data, null, 2));
  }

  async getMemory() {
    if (!this._data) await this.load();
    return this._data;
  }

  async updateMemory(updates) {
    if (!this._data) await this.load();
    this._data = { ...this._data, ...updates, updatedAt: Date.now() };
    await this.save(this._data);
    return this._data;
  }

  async addFact(fact) {
    if (!this._data) await this.load();
    this._data.facts = this._data.facts || [];
    this._data.facts.push(fact);
    await this.save(this._data);
    return fact;
  }
}

class HybridMemoryManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.agent = new AgentMemoryStore(config.agent || {});
    this.global = new GlobalMemoryStore(config.global || {});
  }

  async getMemory(agentName) {
    if (agentName) {
      return this.agent.getMemory(agentName);
    }
    return this.global.getMemory();
  }

  async updateMemory(agentName, updates) {
    if (agentName) {
      return this.agent.updateMemory(agentName, updates);
    }
    return this.global.updateMemory(updates);
  }

  async addFact(agentName, fact) {
    if (agentName) {
      return this.agent.addFact(agentName, fact);
    }
    return this.global.addFact(fact);
  }

  getStats() {
    return {
      agentCacheSize: this.agent._cache.size,
      globalLoaded: this.global._data !== null,
    };
  }
}

// === From user-isolation.js ===
class UserIsolationManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this._namespaceManager = config.namespaceManager || new NamespaceManager();
    this._users = new Map();
    this._sessionBindings = new Map();
    this._maxUsersPerCheck = config.maxUsersPerCheck || 100;
  }

  registerUser(userId, opts = {}) {
    if (this._users.has(userId)) return this._users.get(userId);

    const userNamespace = `${USER_NAMESPACE_PREFIX}${userId}`;

    this._namespaceManager.create(userNamespace, {
      priority: 10,
      description: `用户 ${userId} 的隔离空间`,
      isolation: 'strict',
      inheritFrom: [GLOBAL_NAMESPACE],
    });

    const userData = {
      userId,
      namespace: userNamespace,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      sessionCount: 0,
      memoryCount: 0,
      channels: opts.channels || [],
      preferences: opts.preferences || {},
    };

    this._users.set(userId, userData);
    this.emit('user:registered', { userId, namespace: userNamespace });

    return userData;
  }

  bindSession(sessionId, userId) {
    const userData = this._users.get(userId);
    if (!userData) {
      this.registerUser(userId);
    }

    this._sessionBindings.set(sessionId, userId);
    const user = this._users.get(userId);
    user.sessionCount++;
    user.lastActiveAt = Date.now();

    this.emit('session:bound', { sessionId, userId });
  }

  unbindSession(sessionId) {
    const userId = this._sessionBindings.get(sessionId);
    if (userId) {
      this._sessionBindings.delete(sessionId);
      const user = this._users.get(userId);
      if (user) user.sessionCount = Math.max(0, user.sessionCount - 1);
      this.emit('session:unbound', { sessionId, userId });
    }
  }

  resolveNamespace(sessionIdOrUserId) {
    const userId = this._sessionBindings.get(sessionIdOrUserId) || sessionIdOrUserId;
    const userData = this._users.get(userId);
    if (userData) return userData.namespace;

    if (userId && !this._users.has(userId)) {
      const registered = this.registerUser(userId);
      return registered.namespace;
    }

    return GLOBAL_NAMESPACE;
  }

  getUser(userId) {
    return this._users.get(userId) || null;
  }

  getUserBySession(sessionId) {
    const userId = this._sessionBindings.get(sessionId);
    return userId ? this._users.get(userId) : null;
  }

  checkAccess(userId, targetNamespace, operation) {
    const userData = this._users.get(userId);
    if (!userData) return { allowed: false, reason: '用户未注册' };

    if (targetNamespace === GLOBAL_NAMESPACE) {
      return { allowed: operation === 'read', reason: operation === 'read' ? '全局命名空间可读' : '全局命名空间不可写' };
    }

    if (targetNamespace === userData.namespace) {
      return { allowed: true, reason: '用户自有命名空间' };
    }

    if (targetNamespace.startsWith(USER_NAMESPACE_PREFIX)) {
      return { allowed: false, reason: '不能访问其他用户的命名空间' };
    }

    const ns = this._namespaceManager._namespaces.get(targetNamespace);
    if (ns) {
      const isolation = ns.isolation || {};
      if (operation === 'read' && isolation.crossRead) {
        return { allowed: true, reason: '命名空间允许跨读' };
      }
      if (operation === 'write' && isolation.crossWrite) {
        return { allowed: true, reason: '命名空间允许跨写' };
      }
    }

    return { allowed: false, reason: '无权限' };
  }

  listUsers() {
    return [...this._users.values()];
  }

  getActiveUsers(sinceMs = 3600000) {
    const cutoff = Date.now() - sinceMs;
    return [...this._users.values()].filter(u => u.lastActiveAt >= cutoff);
  }

  getStats() {
    let totalSessions = 0;
    for (const user of this._users.values()) {
      totalSessions += user.sessionCount;
    }

    return {
      totalUsers: this._users.size,
      activeSessions: this._sessionBindings.size,
      totalSessions,
      namespaces: this._users.size + 1,
    };
  }

  cleanupStaleUsers(maxInactiveMs = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxInactiveMs;
    const removed = [];

    for (const [userId, userData] of this._users) {
      if (userData.lastActiveAt < cutoff && userData.sessionCount === 0) {
        this._users.delete(userId);
        removed.push(userId);
      }
    }

    if (removed.length > 0) {
      this.emit('users:cleaned', { count: removed.length });
    }

    return removed;
  }
}

let _instance = null;

function _getUserIsolationManager(config) {
  if (!_instance) {
    _instance = new UserIsolationManager(config);
  }
  return _instance;
}

module.exports = {
  AgentMemoryStore,
  GlobalMemoryStore,
  HybridMemoryManager,
  UserIsolationManager,
};
