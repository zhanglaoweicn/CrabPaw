const crypto = require('crypto');
const { EventEmitter } = require('events');

const DATA_SOURCE_TYPES = {
  EMAIL: 'email',
  CALENDAR: 'calendar',
  MESSAGE: 'message',
  FILE: 'file',
  CONTACT: 'contact',
};

const SYNC_STATUS = {
  IDLE: 'idle',
  SYNCING: 'syncing',
  ERROR: 'error',
  PAUSED: 'paused',
};

class DataSourceAdapter extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.id = opts.id || `ds_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.name = opts.name || 'base';
    this.type = opts.type || DATA_SOURCE_TYPES.MESSAGE;
    this.platform = opts.platform || 'unknown';
    this.namespace = opts.namespace || 'global';
    this.config = opts.config || {};
    this._status = SYNC_STATUS.IDLE;
    this._syncInterval = opts.syncInterval || 300000;
    this._syncTimer = null;
    this._lastSyncAt = null;
    this._lastError = null;
    this._stats = {
      totalSyncs: 0,
      totalRecords: 0,
      totalErrors: 0,
      lastSyncDuration: 0,
    };
    this._memoryTree = opts.memoryTree || null;
    this._onData = opts.onData || null;
  }

  get status() {
    return this._status;
  }

  get isConfigured() {
    return false;
  }

  async connect() {
    throw new Error('connect 方法必须由子类实现');
  }

  async disconnect() {
    this.stopSync();
    this._status = SYNC_STATUS.IDLE;
    this.emit('disconnected');
  }

  // eslint-disable-next-line no-unused-vars
  async fetch(options = {}) {
    throw new Error('fetch 方法必须由子类实现');
  }

  normalize(_rawData) {
    throw new Error('normalize 方法必须由子类实现');
  }

  async sync(options = {}) {
    if (this._status === SYNC_STATUS.SYNCING) {
      return { skipped: true, reason: '同步进行中' };
    }

    this._status = SYNC_STATUS.SYNCING;
    this.emit('sync:start', { adapter: this.name, timestamp: Date.now() });

    const startTime = Date.now();

    try {
      const rawData = await this.fetch(options);
      const records = Array.isArray(rawData) ? rawData : [rawData];
      const normalized = records.map(r => this.normalize(r));

      let written = 0;
      for (const item of normalized) {
        if (this._memoryTree) {
          await this._memoryTree.appendLeaf(item.content, {
            tokenCount: this._estimateTokens(item.content),
            entities: item.entities || [],
            topics: item.topics || [],
            sourceType: this.type,
            sourcePlatform: this.platform,
            sourceId: item.id,
            timestamp: item.timestamp,
            metadata: item.metadata || {},
          });
          written++;
        }
        if (this._onData) {
          await this._onData(item);
          written++;
        }
      }

      const duration = Date.now() - startTime;
      this._lastSyncAt = Date.now();
      this._stats.totalSyncs++;
      this._stats.totalRecords += written;
      this._stats.lastSyncDuration = duration;
      this._status = SYNC_STATUS.IDLE;

      const result = {
        success: true,
        fetched: records.length,
        written,
        duration,
        adapter: this.name,
        timestamp: this._lastSyncAt,
      };

      this.emit('sync:complete', result);
      return result;
    } catch (e) {
      this._status = SYNC_STATUS.ERROR;
      this._lastError = e.message;
      this._stats.totalErrors++;

      const errorResult = {
        success: false,
        error: e.message,
        adapter: this.name,
        timestamp: Date.now(),
      };

      this.emit('sync:error', errorResult);
      return errorResult;
    }
  }

  startSync(interval) {
    if (interval) this._syncInterval = interval;

    this.stopSync();

    this.sync();

    this._syncTimer = setInterval(() => {
      this.sync();
    }, this._syncInterval);

    this.emit('sync:started', { interval: this._syncInterval });
  }

  stopSync() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
      this.emit('sync:stopped');
    }
  }

  getStats() {
    return {
      ...this._stats,
      status: this._status,
      lastSyncAt: this._lastSyncAt,
      lastError: this._lastError,
      adapter: this.name,
      platform: this.platform,
      type: this.type,
    };
  }

  bindMemoryTree(tree) {
    this._memoryTree = tree;
  }

  onData(callback) {
    this._onData = callback;
  }

  _estimateTokens(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
    const rest = text.length - cjk;
    return Math.ceil(cjk * 1.5 + rest * 0.25);
  }
}

module.exports = { DataSourceAdapter, DATA_SOURCE_TYPES, SYNC_STATUS };
