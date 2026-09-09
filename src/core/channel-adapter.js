/**
 * Channel Adapter — 多通道统一消息接口 (ECC 启发)
 *
 * 核心理念: 所有通道（飞书/CLI/Web/GUI/企微）的消息收发，
 * 通过统一接口对接到 ai.js，新增通道只需写一个适配器。
 *
 *   飞书消息 → LarkAdapter   → 统一消息 → ai.js → 统一回复 → LarkAdapter   → 飞书回复
 *   CLI 输入 → CLIAdapter    → 统一消息 → ai.js → 统一回复 → CLIAdapter    → 终端输出
 *   GUI 输入 → GUIAdapter    → 统一消息 → ai.js → 统一回复 → GUIAdapter    → SSE 推送
 *
 * 使用方式:
 *   const adapter = getChannelAdapter();
 *   adapter.register('lark', larkAdapter);
 *   const msg = await adapter.receive('lark', rawInput);
 *   const reply = await ai.chat(msg);
 *   await adapter.send('lark', reply);
 */

const { EventEmitter } = require('events');

// ============================================================
// 统一消息格式（ChannelMessage）
// ============================================================

/**
 * @typedef {Object} ChannelMessage
 * @property {string} channel — 'lark'|'cli'|'gui'|'wecom'|...
 * @property {string} userId — 发送者标识
 * @property {string} content — 消息文本内容
 * @property {Object} [meta] — 通道特有元数据（群聊ID、@提及等）
 * @property {number} timestamp — 接收时间
 */

/**
 * @typedef {Object} ChannelReply
 * @property {string} content — 回复文本
 * @property {Object} [meta] — 通道特有回复元数据（卡片、图片等）
 * @property {string} [larkCard] — 飞书卡片 JSON
 * @property {Array} [attachments] — 附件列表
 */

// ============================================================
// 通道适配器接口（Interface）
// ============================================================

/**
 * 通道适配器必须实现的方法:
 *
 *   parse(rawInput)  → ChannelMessage   // 解析通道原始输入 → 统一消息
 *   format(reply)    → channelOutput    // 格式化统一回复 → 通道输出
 *   send(reply, context) → void          // 发送回复（通道特有机制）
 */

// ============================================================
// ChannelAdapterRegistry
// ============================================================

class ChannelAdapterRegistry extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Object>} channelName → adapter */
    this._adapters = new Map();
    /** @type {Map<string, Object>} channelName → stats */
    this._stats = new Map();
  }

  /**
   * 注册通道适配器
   * @param {string} channel — 通道名称
   * @param {Object} adapter — 适配器实例
   * @param {Function} adapter.parse — (rawInput) => ChannelMessage
   * @param {Function} adapter.format — (reply) => channel-specific output
   * @param {Function} [adapter.send] — (reply, context) => void
   * @param {Function} [adapter.onReceive] — (callback) => void — 被动监听模式
   */
  register(channel, adapter) {
    if (this._adapters.has(channel)) {
      console.warn(`[ChannelAdapter] 通道 '${channel}' 已注册，覆盖`);
    }
    this._adapters.set(channel, adapter);
    this._stats.set(channel, { received: 0, sent: 0, errors: 0 });

    // 如果适配器支持被动监听（如飞书事件回调），注册监听
    if (typeof adapter.onReceive === 'function') {
      adapter.onReceive((rawInput) => {
        this._onRawInput(channel, rawInput);
      });
    }

    this.emit('channel:registered', { channel });
    console.log(`[ChannelAdapter] 通道已注册: ${channel}`);
  }

  /**
   * 处理通道原始输入 → 统一消息格式
   * @param {string} channel
   * @param {*} rawInput
   * @returns {ChannelMessage|null}
   */
  parseInput(channel, rawInput) {
    const adapter = this._adapters.get(channel);
    if (!adapter) {
      console.warn(`[ChannelAdapter] 未注册的通道: ${channel}`);
      return null;
    }

    try {
      const msg = adapter.parse(rawInput);
      if (msg) {
        const stats = this._stats.get(channel);
        if (stats) stats.received++;
        msg.channel = channel;
        msg.timestamp = msg.timestamp || Date.now();
        this.emit('message:received', msg);
      }
      return msg;
    } catch (e) {
      const stats = this._stats.get(channel);
      if (stats) stats.errors++;
      console.error(`[ChannelAdapter] ${channel} 解析失败:`, e.message);
      return null;
    }
  }

  /**
   * 格式化统一回复 → 通道特定输出
   * @param {string} channel
   * @param {ChannelReply} reply
   * @returns {*}
   */
  formatReply(channel, reply) {
    const adapter = this._adapters.get(channel);
    if (!adapter || !adapter.format) return reply.content;
    try {
      return adapter.format(reply);
    } catch (e) {
      console.error(`[ChannelAdapter] ${channel} 格式化失败:`, e.message);
      return reply.content;
    }
  }

  /**
   * 发送回复（如果通道支持主动发送）
   * @param {string} channel
   * @param {ChannelReply} reply
   * @param {Object} [context]
   */
  async sendReply(channel, reply, context = {}) {
    const adapter = this._adapters.get(channel);
    if (!adapter) {
      console.warn(`[ChannelAdapter] 未注册的通道: ${channel}`);
      return false;
    }

    try {
      if (typeof adapter.send === 'function') {
        await adapter.send(reply, context);
      }
      const stats = this._stats.get(channel);
      if (stats) stats.sent++;
      this.emit('reply:sent', { channel, reply });
      return true;
    } catch (e) {
      const stats = this._stats.get(channel);
      if (stats) stats.errors++;
      console.error(`[ChannelAdapter] ${channel} 发送失败:`, e.message);
      return false;
    }
  }

  /**
   * 获取通道统计
   */
  getStats(channel = null) {
    if (channel) return this._stats.get(channel) || null;
    const all = {};
    for (const [ch, stats] of this._stats) {
      all[ch] = { ...stats };
    }
    return all;
  }

  /**
   * 列出已注册通道
   */
  listChannels() {
    return [...this._adapters.keys()];
  }

  // ── 跨通道身份映射 (Hermes-Agent 启发) ──────────────────
  // 微信的"张三"和飞书的"zhangsan@company.com"可能是同一个人

  /** @type {Map<string, string>} channelUserId → canonicalId */
  _identityMap = new Map();

  /**
   * 注册跨通道身份映射
   * @param {string} canonicalId — 规范身份 ID（如 email 或统一用户 ID）
   * @param {Object} channelIds — { wechat: 'senderName', lark: 'openId', ... }
   */
  linkIdentity(canonicalId, channelIds = {}) {
    for (const [channel, uid] of Object.entries(channelIds)) {
      this._identityMap.set(`${channel}:${uid}`, canonicalId);
    }
    this.emit('identity:linked', { canonicalId, channelIds });
  }

  /**
   * 解析用户身份到规范 ID
   * @param {string} channel — 通道名
   * @param {string} rawUserId — 通道内的原始用户标识
   * @returns {string} 规范 ID（如果无映射则返回原始值）
   */
  resolveIdentity(channel, rawUserId) {
    const key = `${channel}:${rawUserId}`;
    return this._identityMap.get(key) || rawUserId;
  }

  /**
   * 获取某个规范身份的所有通道标识
   * @param {string} canonicalId
   * @returns {Object} { wechat: '...', lark: '...', ... }
   */
  getChannelIdentities(canonicalId) {
    const result = {};
    for (const [key, cid] of this._identityMap) {
      if (cid === canonicalId) {
        const [ch, uid] = key.split(':');
        result[ch] = uid;
      }
    }
    return result;
  }

  getIdentityStats() {
    return { identityLinks: this._identityMap.size };
  }
}

// ============================================================
// 单例
// ============================================================

let _registry = null;

function getChannelAdapter() {
  if (!_registry) {
    _registry = new ChannelAdapterRegistry();
  }
  return _registry;
}

module.exports = {
  ChannelAdapterRegistry,
  getChannelAdapter,
};
