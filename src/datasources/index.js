const { EventEmitter } = require('events');
// eslint-disable-next-line no-unused-vars -- require 解构的 DATA_SOURCE_TYPES 暂未使用（保留 base-adapter 导出对齐）
const { DATA_SOURCE_TYPES, SYNC_STATUS } = require('./base-adapter');
const { QQMailDataSource } = require('./qqmail-adapter');
const { WeComMessageDataSource } = require('./wecom-message-adapter');
const { LarkMessageDataSource } = require('./lark-message-adapter');
const { WeComCalendarDataSource } = require('./wecom-calendar-adapter');
const { LarkCalendarDataSource } = require('./lark-calendar-adapter');

const BUILTIN_ADAPTERS = {
  'qqmail': QQMailDataSource,
  'wecom-message': WeComMessageDataSource,
  'lark-message': LarkMessageDataSource,
  'wecom-calendar': WeComCalendarDataSource,
  'lark-calendar': LarkCalendarDataSource,
};

class DataSourceRegistry extends EventEmitter {
  constructor() {
    super();
    this._adapters = new Map();
    this._adapterConfigs = new Map();
    this._syncTimers = new Map();
  }

  register(name, AdapterClass, config = {}) {
    if (this._adapters.has(name)) {
      throw new Error(`数据源 "${name}" 已注册`);
    }

    const adapter = new AdapterClass({
      ...config,
      id: name,
    });

    adapter.on('sync:complete', (result) => {
      this.emit('sync:complete', { ...result, source: name });
    });

    adapter.on('sync:error', (error) => {
      this.emit('sync:error', { ...error, source: name });
    });

    adapter.on('message', (msg) => {
      this.emit('data', { source: name, data: msg });
    });

    adapter.on('calendar:event', (evt) => {
      this.emit('data', { source: name, data: evt });
    });

    this._adapters.set(name, adapter);
    this._adapterConfigs.set(name, config);

    this.emit('registered', { name, type: adapter.type, platform: adapter.platform });

    return adapter;
  }

  unregister(name) {
    const adapter = this._adapters.get(name);
    if (!adapter) return false;

    adapter.stopSync();
    adapter.removeAllListeners();

    this._adapters.delete(name);
    this._adapterConfigs.delete(name);

    const timer = this._syncTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this._syncTimers.delete(name);
    }

    this.emit('unregistered', { name });
    return true;
  }

  get(name) {
    return this._adapters.get(name) || null;
  }

  has(name) {
    return this._adapters.has(name);
  }

  list() {
    const result = [];
    for (const [name, adapter] of this._adapters) {
      result.push({
        name,
        type: adapter.type,
        platform: adapter.platform,
        isConfigured: adapter.isConfigured,
        status: adapter.status,
        stats: adapter.getStats(),
      });
    }
    return result;
  }

  listByType(type) {
    return this.list().filter(a => a.type === type);
  }

  listByPlatform(platform) {
    return this.list().filter(a => a.platform === platform);
  }

  async syncAll(options = {}) {
    const results = [];

    for (const [name, adapter] of this._adapters) {
      if (adapter.isConfigured) {
        try {
          const result = await adapter.sync(options[name] || {});
          results.push({ name, ...result });
        } catch (e) {
          results.push({ name, success: false, error: e.message });
        }
      } else {
        results.push({ name, skipped: true, reason: '未配置' });
      }
    }

    this.emit('sync:all', { results, timestamp: Date.now() });
    return results;
  }

  startAllSync(intervals = {}) {
    for (const [name, adapter] of this._adapters) {
      if (adapter.isConfigured) {
        const interval = intervals[name] || undefined;
        adapter.startSync(interval);
      }
    }
    this.emit('sync:all-started');
  }

  stopAllSync() {
    // eslint-disable-next-line no-unused-vars -- 数组解构的 name 未使用（遍历仅需 adapter）
    for (const [name, adapter] of this._adapters) {
      adapter.stopSync();
    }
    this.emit('sync:all-stopped');
  }

  bindMemoryTree(name, tree) {
    const adapter = this._adapters.get(name);
    if (adapter) {
      adapter.bindMemoryTree(tree);
      return true;
    }
    return false;
  }

  bindAllMemoryTree(tree) {
    for (const [, adapter] of this._adapters) {
      adapter.bindMemoryTree(tree);
    }
  }

  onData(callback) {
    for (const [, adapter] of this._adapters) {
      adapter.onData(callback);
    }
  }

  getStats() {
    const stats = {};
    for (const [name, adapter] of this._adapters) {
      stats[name] = adapter.getStats();
    }
    return stats;
  }

  getOverallStats() {
    let totalSyncs = 0;
    let totalRecords = 0;
    let totalErrors = 0;
    let configured = 0;
    let active = 0;

    for (const [, adapter] of this._adapters) {
      const s = adapter.getStats();
      totalSyncs += s.totalSyncs;
      totalRecords += s.totalRecords;
      totalErrors += s.totalErrors;
      if (adapter.isConfigured) configured++;
      if (adapter.status === SYNC_STATUS.SYNCING) active++;
    }

    return {
      totalAdapters: this._adapters.size,
      configured,
      active,
      totalSyncs,
      totalRecords,
      totalErrors,
    };
  }

  static getBuiltinAdapters() {
    return { ...BUILTIN_ADAPTERS };
  }

  static createFromConfig(configObj) {
    const registry = new DataSourceRegistry();

    const datasources = configObj.datasources || configObj.dataSources || {};

    if (datasources.qqmail) {
      registry.register('qqmail', QQMailDataSource, datasources.qqmail);
    }
    if (datasources['wecom-message']) {
      registry.register('wecom-message', WeComMessageDataSource, datasources['wecom-message']);
    }
    if (datasources['lark-message']) {
      registry.register('lark-message', LarkMessageDataSource, datasources['lark-message']);
    }
    if (datasources['wecom-calendar']) {
      registry.register('wecom-calendar', WeComCalendarDataSource, datasources['wecom-calendar']);
    }
    if (datasources['lark-calendar']) {
      registry.register('lark-calendar', LarkCalendarDataSource, datasources['lark-calendar']);
    }

    return registry;
  }
}

module.exports = { DataSourceRegistry, BUILTIN_ADAPTERS };
