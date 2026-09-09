const crypto = require('crypto');
const { EventEmitter } = require('events');

const EVENT_TYPES = {
  MESSAGE_INBOUND: 'message:inbound',
  MESSAGE_OUTBOUND: 'message:outbound',
  MESSAGE_FAILED: 'message:failed',
  CHANNEL_CONNECTED: 'channel:connected',
  CHANNEL_DISCONNECTED: 'channel:disconnected',
  CHANNEL_ERROR: 'channel:error',
  PROACTIVE_TRIGGER: 'proactive:trigger',
  PROACTIVE_SENT: 'proactive:sent',
  PROACTIVE_FAILED: 'proactive:failed',
  SCHEDULE_TRIGGER: 'schedule:trigger',
  CONDITION_TRIGGER: 'condition:trigger',
  USER_PRESENCE: 'user:presence',
  TYPING_START: 'typing:start',
  TYPING_END: 'typing:end',
  REACTION_ADDED: 'reaction:added',
  FILE_SHARED: 'file:shared',
  MENTION_RECEIVED: 'mention:received',
};

class ChannelEvent {
  constructor(type, payload, source = 'unknown') {
    this.id = `evt_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.type = type;
    this.payload = payload;
    this.source = source;
    this.timestamp = Date.now();
    this.processed = false;
    this.error = null;
  }
}

class ChannelEventBus extends EventEmitter {
  constructor(config = {}) {
    super();
    this._handlers = new Map();
    this._middleware = [];
    this._eventLog = [];
    this._maxLogSize = config.maxLogSize || 1000;
    this._channels = new Map();
    this._maxListeners = config.maxListeners || 50;
    this.setMaxListeners(this._maxListeners);
  }

  registerChannel(channelId, channelInstance) {
    this._channels.set(channelId, {
      instance: channelInstance,
      connected: false,
      lastActivity: Date.now(),
      stats: { inbound: 0, outbound: 0, errors: 0 },
    });

    this.emit('channel:registered', { channelId });
  }

  unregisterChannel(channelId) {
    this._channels.delete(channelId);
    this.emit('channel:unregistered', { channelId });
  }

  getChannel(channelId) {
    return this._channels.get(channelId)?.instance || null;
  }

  listChannels() {
    return [...this._channels.entries()].map(([id, ch]) => ({
      id,
      connected: ch.connected,
      lastActivity: ch.lastActivity,
      stats: { ...ch.stats },
    }));
  }

  use(middleware) {
    if (typeof middleware !== 'function') {
      throw new Error('Middleware must be a function');
    }
    this._middleware.push(middleware);
  }

  onEvent(eventType, handler, options = {}) {
    const priority = options.priority || 0;
    const handlerId = `h_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;

    if (!this._handlers.has(eventType)) {
      this._handlers.set(eventType, []);
    }

    this._handlers.get(eventType).push({
      id: handlerId,
      handler,
      priority,
      once: options.once || false,
    });

    this._handlers.get(eventType).sort((a, b) => b.priority - a.priority);

    return handlerId;
  }

  offEvent(handlerId) {
    // eslint-disable-next-line no-unused-vars
    for (const [type, handlers] of this._handlers) {
      const idx = handlers.findIndex(h => h.id === handlerId);
      if (idx !== -1) {
        handlers.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  async dispatch(event) {
    if (!(event instanceof ChannelEvent)) {
      event = new ChannelEvent(event.type, event.payload, event.source);
    }

    this._logEvent(event);

    try {
      await this._runMiddleware(event);
    } catch (e) {
      event.error = e.message;
      this.emit('event:middleware_error', { eventId: event.id, error: e.message });
    }

    const handlers = this._handlers.get(event.type) || [];
    const results = [];

    for (let i = handlers.length - 1; i >= 0; i--) {
      const entry = handlers[i];
      try {
        const result = await entry.handler(event);
        results.push({ handlerId: entry.id, result });

        if (entry.once) {
          handlers.splice(i, 1);
        }
      } catch (e) {
        results.push({ handlerId: entry.id, error: e.message });
      }
    }

    this.emit(event.type, event);
    this.emit('event:dispatched', { eventId: event.id, type: event.type });

    event.processed = true;
    return results;
  }

  async emitInbound(channelId, message) {
    const channel = this._channels.get(channelId);
    if (channel) {
      channel.stats.inbound++;
      channel.lastActivity = Date.now();
    }

    return this.dispatch(new ChannelEvent(
      EVENT_TYPES.MESSAGE_INBOUND,
      { channelId, message },
      channelId
    ));
  }

  async emitOutbound(channelId, message) {
    const channel = this._channels.get(channelId);
    if (channel) {
      channel.stats.outbound++;
      channel.lastActivity = Date.now();
    }

    return this.dispatch(new ChannelEvent(
      EVENT_TYPES.MESSAGE_OUTBOUND,
      { channelId, message },
      channelId
    ));
  }

  async emitChannelConnected(channelId, metadata = {}) {
    const channel = this._channels.get(channelId);
    if (channel) channel.connected = true;

    return this.dispatch(new ChannelEvent(
      EVENT_TYPES.CHANNEL_CONNECTED,
      { channelId, metadata },
      channelId
    ));
  }

  async emitChannelDisconnected(channelId, reason = '') {
    const channel = this._channels.get(channelId);
    if (channel) channel.connected = false;

    return this.dispatch(new ChannelEvent(
      EVENT_TYPES.CHANNEL_DISCONNECTED,
      { channelId, reason },
      channelId
    ));
  }

  async _runMiddleware(event) {
    for (const middleware of this._middleware) {
      await middleware(event);
    }
  }

  _logEvent(event) {
    this._eventLog.push({
      id: event.id,
      type: event.type,
      source: event.source,
      timestamp: event.timestamp,
    });

    if (this._eventLog.length > this._maxLogSize) {
      this._eventLog = this._eventLog.slice(-this._maxLogSize);
    }
  }

  getEventLog(opts = {}) {
    const limit = opts.limit || 100;
    const type = opts.type;
    const source = opts.source;

    let log = this._eventLog;
    if (type) log = log.filter(e => e.type === type);
    if (source) log = log.filter(e => e.source === source);

    return log.slice(-limit);
  }

  getStats() {
    const stats = {
      channels: this._channels.size,
      handlerCount: 0,
      eventLogSize: this._eventLog.length,
    };

    for (const [, handlers] of this._handlers) {
      stats.handlerCount += handlers.length;
    }

    return stats;
  }
}

class ProactiveMessenger extends EventEmitter {
  constructor(config = {}) {
    super();
    this._eventBus = config.eventBus || null;
    this._store = config.store || null;
    this._model = config.model || null;
    this._schedules = new Map();
    this._conditions = new Map();
    this._timers = new Map();
    this._maxProactivePerHour = config.maxProactivePerHour || 5;
    this._sentCount = new Map();
    this._hourlyResetTimer = null;
  }

  setEventBus(bus) {
    this._eventBus = bus;
  }

  setStore(store) {
    this._store = store;
  }

  setModel(model) {
    this._model = model;
  }

  start() {
    this._hourlyResetTimer = setInterval(() => {
      this._sentCount.clear();
    }, 3600000);
    if (this._hourlyResetTimer.unref) this._hourlyResetTimer.unref();
  }

  stop() {
    if (this._hourlyResetTimer) {
      clearInterval(this._hourlyResetTimer);
      this._hourlyResetTimer = null;
    }
    // eslint-disable-next-line no-unused-vars
    for (const [id, timer] of this._timers) {
      clearInterval(timer);
    }
    this._timers.clear();
  }

  scheduleProactive(config) {
    const id = config.id || `sched_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;

    const schedule = {
      id,
      channelId: config.channelId,
      userId: config.userId,
      intervalMs: config.intervalMs || 3600000,
      message: config.message || null,
      messageGenerator: config.messageGenerator || null,
      condition: config.condition || null,
      enabled: config.enabled !== false,
      lastSent: 0,
      metadata: config.metadata || {},
    };

    this._schedules.set(id, schedule);

    if (schedule.enabled) {
      this._startScheduleTimer(schedule);
    }

    this.emit('proactive:scheduled', { id, channelId: config.channelId });
    return id;
  }

  unscheduleProactive(scheduleId) {
    const schedule = this._schedules.get(scheduleId);
    if (!schedule) return false;

    const timer = this._timers.get(scheduleId);
    if (timer) clearInterval(timer);

    this._schedules.delete(scheduleId);
    this._timers.delete(scheduleId);
    this.emit('proactive:unscheduled', { id: scheduleId });
    return true;
  }

  registerCondition(config) {
    const id = config.id || `cond_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`;

    const condition = {
      id,
      name: config.name || id,
      channelId: config.channelId,
      userId: config.userId,
      check: config.check,
      message: config.message || null,
      messageGenerator: config.messageGenerator || null,
      cooldownMs: config.cooldownMs || 3600000,
      lastTriggered: 0,
      enabled: config.enabled !== false,
      metadata: config.metadata || {},
    };

    this._conditions.set(id, condition);
    this.emit('condition:registered', { id, name: condition.name });
    return id;
  }

  unregisterCondition(conditionId) {
    this._conditions.delete(conditionId);
    this.emit('condition:unregistered', { id: conditionId });
    return true;
  }

  async checkConditions(context = {}) {
    const triggered = [];

    for (const [id, condition] of this._conditions) {
      if (!condition.enabled) continue;

      const now = Date.now();
      if (now - condition.lastTriggered < condition.cooldownMs) continue;

      try {
        const shouldTrigger = await condition.check(context);
        if (shouldTrigger) {
          condition.lastTriggered = now;
          triggered.push(condition);

          await this._sendProactive(condition, context);
        }
      } catch (e) {
        this.emit('condition:check_error', { id, error: e.message });
      }
    }

    return triggered;
  }

  async sendNow(channelId, userId, message, opts = {}) {
    const hourKey = `${channelId}:${userId}:${Math.floor(Date.now() / 3600000)}`;
    const sent = this._sentCount.get(hourKey) || 0;
    if (sent >= this._maxProactivePerHour) {
      this.emit('proactive:rate_limited', { channelId, userId });
      return { sent: false, reason: 'rate_limited' };
    }

    if (!this._eventBus) {
      return { sent: false, reason: 'no_event_bus' };
    }

    try {
      await this._eventBus.emitOutbound(channelId, {
        userId,
        content: message,
        proactive: true,
        metadata: opts.metadata || {},
      });

      this._sentCount.set(hourKey, sent + 1);

      this.emit('proactive:sent', { channelId, userId, messageLength: message.length });
      return { sent: true };
    } catch (e) {
      this.emit('proactive:failed', { channelId, userId, error: e.message });
      return { sent: false, reason: e.message };
    }
  }

  async _sendProactive(config, context = {}) {
    let message = config.message;

    if (config.messageGenerator) {
      try {
        message = await config.messageGenerator(context);
      } catch (e) {
        this.emit('proactive:generation_error', { id: config.id, error: e.message });
        return;
      }
    }

    if (!message) return;

    const result = await this.sendNow(
      config.channelId,
      config.userId,
      message,
      { metadata: config.metadata }
    );

    if (result.sent) {
      config.lastSent = Date.now();
    }
  }

  _startScheduleTimer(schedule) {
    const timer = setInterval(async () => {
      if (!schedule.enabled) return;

      try {
        await this._sendProactive(schedule);
      } catch { console.warn('[channel-event-bus] 定时主动消息发送失败'); }
    }, schedule.intervalMs);

    if (timer.unref) timer.unref();
    this._timers.set(schedule.id, timer);
  }

  getSchedules() {
    return [...this._schedules.values()].map(s => ({
      id: s.id,
      channelId: s.channelId,
      userId: s.userId,
      intervalMs: s.intervalMs,
      enabled: s.enabled,
      lastSent: s.lastSent,
    }));
  }

  getConditions() {
    return [...this._conditions.values()].map(c => ({
      id: c.id,
      name: c.name,
      channelId: c.channelId,
      enabled: c.enabled,
      lastTriggered: c.lastTriggered,
    }));
  }
}

let _busInstance = null;
let _proactiveInstance = null;

function getChannelEventBus(config) {
  if (!_busInstance) {
    _busInstance = new ChannelEventBus(config);
  }
  return _busInstance;
}

function getProactiveMessenger(config) {
  if (!_proactiveInstance) {
    _proactiveInstance = new ProactiveMessenger(config);
  }
  return _proactiveInstance;
}

module.exports = {
  ChannelEventBus,
  ChannelEvent,
  ProactiveMessenger,
  EVENT_TYPES,
  getChannelEventBus,
  getProactiveMessenger,
};
