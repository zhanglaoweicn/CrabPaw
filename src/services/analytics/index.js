/**
 * Analytics Service
 * 
 * 事件日志和分析服务
 * 借鉴 Claude Code 的 analytics/index.ts 实现
 */

const { EventEmitter } = require('events');
const { appendFile, mkdir } = require('fs/promises');
const { join } = require('path');

class AnalyticsService extends EventEmitter {
  constructor() {
    super();
    this.eventQueue = [];
    this.sink = null;
    this.initialized = false;
    this.config = {
      enabled: true,
      sampleRate: 1.0,
      flushInterval: 5000,
      maxQueueSize: 100,
    };
    this.flushTimer = null;
    this.logPath = null;
  }

  async initialize(config = {}) {
    if (this.initialized) {
      return;
    }

    this.config = { ...this.config, ...config };
    
    if (this.config.logDir) {
      this.logPath = join(this.config.logDir, 'analytics.log');
      await mkdir(this.config.logDir, { recursive: true });
    }

    if (this.config.flushInterval > 0) {
      this.flushTimer = setInterval(() => {
        this.flush();
      }, this.config.flushInterval);
    }

    this.initialized = true;
    this.emit('initialized');
  }

  async shutdown() {
    if (!this.initialized) {
      return;
    }

    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
    this.initialized = false;
    this.emit('shutdown');
  }

  logEvent(eventName, metadata = {}) {
    if (!this.config.enabled) {
      return;
    }

    if (Math.random() > this.config.sampleRate) {
      return;
    }

    const event = {
      eventName,
      metadata,
      timestamp: Date.now(),
      sessionId: this.config.sessionId,
    };

    if (this.sink) {
      this.sink.logEvent(eventName, metadata);
    } else {
      this.eventQueue.push(event);
      if (this.eventQueue.length >= this.config.maxQueueSize) {
        this.flush();
      }
    }

    this.emit('event', event);
  }

  async logEventAsync(eventName, metadata = {}) {
    if (!this.config.enabled) {
      return;
    }

    if (this.sink) {
      await this.sink.logEventAsync(eventName, metadata);
    } else {
      this.logEvent(eventName, metadata);
    }
  }

  setSink(sink) {
    this.sink = sink;
    
    const queuedEvents = [...this.eventQueue];
    this.eventQueue = [];
    
    for (const event of queuedEvents) {
      this.sink.logEvent(event.eventName, event.metadata);
    }
  }

  async flush() {
    if (this.eventQueue.length === 0) {
      return;
    }

    const events = [...this.eventQueue];
    this.eventQueue = [];

    if (this.logPath) {
      const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
      await appendFile(this.logPath, lines, 'utf8');
    }

    this.emit('flush', { count: events.length });
  }

  getStats() {
    return {
      initialized: this.initialized,
      enabled: this.config.enabled,
      queueSize: this.eventQueue.length,
      hasSink: !!this.sink,
    };
  }
}

const analyticsService = new AnalyticsService();

module.exports = {
  AnalyticsService,
  analyticsService,
};
