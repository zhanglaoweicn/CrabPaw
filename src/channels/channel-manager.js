'use strict';

/**
 * channel-manager.js — 统一渠道管理器
 *
 * 管理所有外部渠道的启动/停止/状态：
 *   - wecom (existing)
 *   - lark webhook (existing)
 *   - lark WS real-time (new)
 *   - discord (new)
 *
 * 提供:
 *   - startAll() / stopAll()
 *   - 统一事件总线（'message' / 'command'）
 *   - 渠道状态查询
 */

const { EventEmitter } = require('events');

class ChannelManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this._channels = new Map();
    this._stats = {
      started: 0,
      errors: 0,
    };
  }

  /**
   * 注册一个渠道
   */
  register(name, channel) {
    this._channels.set(name, {
      name,
      channel,
      running: false,
      lastError: null,
    });

    // 桥接事件到统一总线
    const bridge = (eventName) => {
      channel.on(eventName, (...args) => {
        this.emit(eventName, { channel: name, args });
        this.emit(`${name}:${eventName}`, ...args);
      });
    };

    bridge('message');
    bridge('command');
    bridge('event');
    bridge('error');
    bridge('connected');
    bridge('disconnected');
    bridge('ready');
    bridge('message:sent');
    bridge('reconnect:scheduled');

    return this;
  }

  /**
   * 启动指定渠道
   */
  async startChannel(name) {
    const entry = this._channels.get(name);
    if (!entry) return { success: false, error: `渠道 ${name} 不存在` };
    if (entry.running) return { success: true, alreadyRunning: true };

    try {
      await entry.channel.start();
      entry.running = true;
      entry.lastError = null;
      this._stats.started++;
      this.emit('channel:started', { name });
      return { success: true };
    } catch (err) {
      entry.lastError = err.message;
      this._stats.errors++;
      this.emit('channel:error', { name, error: err.message });
      return { success: false, error: err.message };
    }
  }

  /**
   * 启动所有渠道
   */
  async startAll(filter = null) {
    const results = {};
    // eslint-disable-next-line no-unused-vars
    for (const [name, entry] of this._channels) {
      if (filter && !filter.includes(name)) continue;
      results[name] = await this.startChannel(name);
    }
    return results;
  }

  /**
   * 停止指定渠道
   */
  async stopChannel(name) {
    const entry = this._channels.get(name);
    if (!entry) return { success: false, error: `渠道 ${name} 不存在` };
    if (!entry.running) return { success: true, alreadyStopped: true };

    try {
      await entry.channel.stop();
      entry.running = false;
      this.emit('channel:stopped', { name });
      return { success: true };
    } catch (err) {
      entry.lastError = err.message;
      return { success: false, error: err.message };
    }
  }

  /**
   * 停止所有渠道
   */
  async stopAll() {
    const results = {};
    for (const name of this._channels.keys()) {
      results[name] = await this.stopChannel(name);
    }
    return results;
  }

  /**
   * 获取渠道状态
   */
  getStatus(name) {
    if (name) {
      const entry = this._channels.get(name);
      if (!entry) return null;
      return {
        name: entry.name,
        running: entry.running,
        lastError: entry.lastError,
        stats: entry.channel.getStats ? entry.channel.getStats() : null,
      };
    }
    const all = {};
    for (const [n, entry] of this._channels) {
      all[n] = {
        running: entry.running,
        lastError: entry.lastError,
        stats: entry.channel.getStats ? entry.channel.getStats() : null,
      };
    }
    return all;
  }

  /**
   * 列出已注册渠道
   */
  list() {
    return Array.from(this._channels.keys());
  }
}

let _instance = null;
function getChannelManager(config) {
  if (!_instance) _instance = new ChannelManager(config);
  return _instance;
}

module.exports = {
  ChannelManager,
  getChannelManager,
};
