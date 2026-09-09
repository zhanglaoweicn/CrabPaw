/**
 * Core Interfaces — 核心模块接口契约
 *
 * 为 CrabPaw 定义统一的模块接口规范：
 * - IEvolver: 进化器接口
 * - IStore: 存储接口
 * - ITracker: 追踪器接口
 * - IValidator: 验证器接口
 *
 * 所有实现必须遵循这些接口契约。
 */

/**
 * 进化器接口
 */
const IEvolver = {
  /**
   * 执行进化
   * @param {Object} context - 进化上下文
   * @returns {Promise<Object>} 进化结果
   */
  evolve: async (_context) => {},

  /**
   * 验证进化提案
   * @param {Object} proposal - 进化提案
   * @returns {Object} 验证结果 { valid: boolean, reason?: string }
   */
  validate: (_proposal) => { return { valid: true }; },

  /**
   * 获取进化器名称
   * @returns {string}
   */
  getName: () => { return 'base'; },
};

/**
 * 存储接口
 */
const IStore = {
  /**
   * 获取值
   * @param {string} key
   * @returns {Promise<any>}
   */
  get: async (_key) => {},

  /**
   * 设置值
   * @param {string} key
   * @param {any} value
   * @returns {Promise<boolean>}
   */
  // eslint-disable-next-line no-unused-vars
  set: async (_key, value) => { return true; },

  /**
   * 删除值
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  delete: async (_key) => { return true; },

  /**
   * 检查是否存在
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  has: async (_key) => { return false; },

  /**
   * 获取所有键
   * @returns {Promise<string[]>}
   */
  keys: async () => { return []; },
};

/**
 * 追踪器接口
 */
const ITracker = {
  /**
   * 记录事件
   * @param {string} name - 事件名称
   * @param {Object} data - 事件数据
   */
  // eslint-disable-next-line no-unused-vars
  record: (_name, data) => {},

  /**
   * 获取统计
   * @param {string} key - 统计键
   * @returns {Object}
   */
  getStats: (_key) => { return {}; },

  /**
   * 重置统计
   * @param {string} key
   */
  reset: (_key) => {},
};

/**
 * 验证器接口
 */
const IValidator = {
  /**
   * 验证输入
   * @param {any} input
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validate: (_input) => { return { valid: true, errors: [] }; },

  /**
   * 获取验证规则
   * @returns {Object}
   */
  getRules: () => { return {}; },
};

/**
 * 初始化器接口
 */
const IInitializable = {
  /**
   * 初始化
   * @param {Object} config
   * @returns {Promise<void>}
   */
  initialize: async (_config) => {},

  /**
   * 关闭
   * @returns {Promise<void>}
   */
  shutdown: async () => {},

  /**
   * 检查是否已初始化
   * @returns {boolean}
   */
  isInitialized: () => { return false; },
};

/**
 * 接口验证工具
 */
class InterfaceChecker {
  /**
   * 检查对象是否实现接口
   * @param {Object} obj - 要检查的对象
   * @param {Object} interfaceDef - 接口定义
   * @param {string} name - 接口名称
   * @returns {Object} { implements: boolean, missing: string[] }
   */
  static check(obj, interfaceDef, name = 'Interface') {
    const missing = [];

    for (const method of Object.keys(interfaceDef)) {
      if (typeof obj[method] !== 'function') {
        missing.push(method);
      }
    }

    return {
      implements: missing.length === 0,
      missing,
      message: missing.length === 0
        ? `${name} implemented correctly`
        : `${name} missing methods: ${missing.join(', ')}`,
    };
  }

  /**
   * 断言对象实现接口
   * @param {Object} obj
   * @param {Object} interfaceDef
   * @param {string} name
   * @throws {Error} 如果未实现
   */
  static assert(obj, interfaceDef, name = 'Interface') {
    const result = InterfaceChecker.check(obj, interfaceDef, name);
    if (!result.implements) {
      throw new Error(result.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Infrastructure Interfaces — Event Store
// ═══════════════════════════════════════════════════════════

/**
 * In-memory 事件存储
 * 参考 Harness OSS events/system.go + events/events.go 的 Event[T] 模式
 */
class InMemoryEventStore {
  constructor() {
    this._events = [];
    this._handlers = new Map();
    this._maxEvents = 1000;
  }

  async publish(category, type, payload) {
    const event = { id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: Date.now(), category, type, payload };
    this._events.push(event);
    if (this._events.length > this._maxEvents) this._events = this._events.slice(-this._maxEvents);

    const keys = new Set([`${category}:${type}`, `${category}:*`, '*']);
    for (const key of keys) {
      const handlers = this._handlers.get(key);
      if (handlers) { for (const h of handlers) { try { h(event); } catch (e) { console.warn('[InMemoryEventStore] handler error:', e.message); } } }
    }
  }

  async subscribe(category, type, handler) {
    const key = `${category}:${type}`;
    if (!this._handlers.has(key)) this._handlers.set(key, new Set());
    this._handlers.get(key).add(handler);
    return () => this._handlers.get(key)?.delete(handler);
  }

  replay(category, type) {
    const filtered = this._events.filter(e => {
      if (category && e.category !== category) return false;
      if (type && e.type !== type) return false;
      return true;
    });
    return filtered;
  }
}

/**
 * In-memory 锁实现（单进程场景）
 * 参考 Harness OSS lock/lock.go
 */
class InMemoryLockProvider {
  constructor() { this._locks = new Map(); }
  async acquire(key, ttl = 30000) {
    const start = Date.now();
    while (Date.now() - start < ttl) {
      if (!this._locks.has(key) || this._locks.get(key) < Date.now()) {
        this._locks.set(key, Date.now() + ttl);
        return () => this._locks.delete(key);
      }
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error(`Lock timeout: ${key}`);
  }
  async tryAcquire(key, ttl = 30000) {
    if (!this._locks.has(key) || this._locks.get(key) < Date.now()) {
      this._locks.set(key, Date.now() + ttl);
      return () => this._locks.delete(key);
    }
    return null;
  }
}

/**
 * 文件系统 Blob 存储
 * 参考 Harness OSS blob/ 接口
 */
class FileBlobStore {
  constructor(baseDir = './data/blobs') {
    const fs = require('fs');
    const path = require('path');
    this._fs = fs; this._path = path; this._baseDir = baseDir;
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  }
  _resolve(key) { return this._path.join(this._baseDir, key.replace(/[^a-zA-Z0-9_-]/g, '_')); }
  async put(key, data, metadata = {}) {
    this._fs.writeFileSync(this._resolve(key), JSON.stringify({ metadata, data: Buffer.from(data).toString('base64') }));
  }
  async get(key) {
    try { const parsed = JSON.parse(this._fs.readFileSync(this._resolve(key), 'utf-8')); return { data: Buffer.from(parsed.data, 'base64'), metadata: parsed.metadata || {} }; }
    catch { return null; }
  }
  async delete(key) { try { this._fs.unlinkSync(this._resolve(key)); return true; } catch { return false; } }
}

module.exports = {
  IEvolver,
  IStore,
  ITracker,
  IValidator,
  IInitializable,
  InterfaceChecker,
  // Infrastructure implementations
  InMemoryEventStore,
  InMemoryLockProvider,
  FileBlobStore,
};
