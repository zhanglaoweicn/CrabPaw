/**
 * Unified Event Bus — central event dispatch for the task system.
 * Replaces the three parallel notification paths (WebSocket, SSE, channels)
 * with a single bus that all subsystems can listen to.
 *
 * (自 2026-08-27 D7 B5 起为 src/core/events.js EventBus 内核的门面: 事件契约不变(名/载荷/时序),
 *  通道归一到 harness 事件内核。此前 EventEmitter 独立实例与 harness EventBus 双通道并存,
 *  插件/网页/任务监听方各自订阅两处时漏事件; 归一则所有订阅方同内核。)
 *
 * 路由规则:
 *   - "cat:type" 类名(≥2 段) → kernel.publish(cat, type, payload); 订阅方经核回调收到
 *     HarnessEvent, 门面解包 payload 直传(契约不变)。
 *   - "harness:*" 类名 → 仅本地分发(events.js publish 镜像的 harness: 前缀事件);
 *     不回发内核——防 publish→mirror→emit→publish 无限环。
 *   - 单段名 / 多参 emit → 本地 EventEmitter 兜底(多参仅单段名监听方可见; 路由名多参无监听方, 见 emit 注释)。
 *
 * Usage:
 *   const bus = require('./core/event-bus');
 *   bus.on('task:started', (payload) => { ... });
 *   bus.emit('task:started', { taskId, name, ... });
 */

'use strict';

const { EventEmitter } = require('events');

// 内核惰性获取——events.js 顶层 require 本文件, 若本文件顶层解构 getEventBus 会拿到
// 循环依赖的部分导出(undefined); 必须延迟到方法调用期(此时 events.js 必已完成求值)。
function getKernel() {
  return require('./events').getEventBus();
}

const EVENT_TYPES = {
  // Task lifecycle
  TASK_STARTED: 'task:started',
  TASK_PROGRESS: 'task:progress',
  TASK_SUCCEEDED: 'task:succeeded',
  TASK_FAILED: 'task:failed',
  TASK_CANCELLED: 'task:cancelled',
  TASK_TIMED_OUT: 'task:timed_out',
  TASK_RETRY: 'task:retry',

  // Flow lifecycle
  FLOW_STARTED: 'flow:started',
  FLOW_STEP_START: 'flow:step_start',
  FLOW_STEP_COMPLETE: 'flow:step_complete',
  FLOW_STEP_FAILED: 'flow:step_failed',
  FLOW_COMPLETED: 'flow:completed',
  FLOW_FAILED: 'flow:failed',
  FLOW_CANCELLED: 'flow:cancelled',

  // System
  SYSTEM_STARTUP: 'system:startup',
  SYSTEM_SHUTDOWN: 'system:shutdown',
  SYSTEM_ERROR: 'system:error',
  SCHEDULER_STARTED: 'system:scheduler_started',
  SCHEDULER_STOPPED: 'system:scheduler_stopped',
};

class UnifiedEventBusFacade {
  constructor() {
    // Audit trail: record all emitted events (capped) — 与旧实现同语义
    this._auditLog = [];
    this._auditMax = 1000;
    this._auditEnabled = true;

    // kernel 路径注册表: eventName → Map<handler, { unsub }>（双层键控, 供 off 按事件名精确退订内核）
    this._kernelRegs = new Map();
    // 本地分发表(harness: 前缀): eventName → Set<handler>
    this._local = new Map();
    // 全部 on() 注册计数(与旧 EventEmitter.listenerCount 同语义: 含 subscribe 路径)
    this._byName = new Map();
    // Subsystem health tracking: eventName → Set<subscriberId>（仅 subscribe() 路径登记, 旧语义）
    this._subscribers = new Map();
    // 单段名/多参 emit 兜底（旧 EventEmitter 语义）
    this._legacy = new EventEmitter();
    this._legacy.setMaxListeners(100);
  }

  _isLocal(eventName) {
    return typeof eventName === 'string' && eventName.startsWith('harness:');
  }

  /** "cat:type" → { category, type }; 单段名/非字符串 → null */
  _route(eventName) {
    if (typeof eventName !== 'string') return null;
    const i = eventName.indexOf(':');
    return i > 0 ? { category: eventName.slice(0, i), type: eventName.slice(i + 1) } : null;
  }

  _emitKernel(eventName, payload) {
    const r = this._route(eventName);
    if (!r) return undefined;
    return getKernel().publish(r.category, r.type, payload, { source: 'task-facade' });
  }

  emit(eventName, ...args) {
    if (this._auditEnabled) this._audit(eventName, args[0]);
    if (this._isLocal(eventName)) {
      // harness: 前缀 = events.js publish 的镜像事件: 仅本地分发, 不回发内核(防环)。
      const set = this._local.get(eventName);
      if (set) {
        for (const handler of [...set]) handler(args[0]);
      }
      return true;
    }
    if (args.length === 1 && this._route(eventName)) {
      return this._emitKernel(eventName, args[0]);
    }
    // 多参 emit 仅对非路由名走内部 EventEmitter 兼容; 路由名（含 : ）的多参 emit 监听方收不到尾参——当前零生产方使用（grep 证实）
    return this._legacy.emit(eventName, ...args);
  }

  on(eventName, handler) {
    if (typeof handler !== 'function') throw new TypeError('listener must be a function');
    if (!this._byName.has(eventName)) this._byName.set(eventName, new Set());
    this._byName.get(eventName).add(handler);
    if (this._isLocal(eventName)) {
      if (!this._local.has(eventName)) this._local.set(eventName, new Set());
      this._local.get(eventName).add(handler);
    } else if (this._route(eventName)) {
      let regs = this._kernelRegs.get(eventName);
      if (!regs) {
        regs = new Map();
        this._kernelRegs.set(eventName, regs);
      }
      // 同 handler 同事件重复注册: 先退旧内核订阅(保持内核 Set 去重语义), 再注册新
      const prev = regs.get(handler);
      if (prev) {
        try { prev.unsub(); } catch (e) { console.warn('[event-bus] 内核退订失败:', e.message); }
      }
      const wrapped = (event) => handler(event.payload);
      const unsub = getKernel().subscribe(eventName, wrapped);
      regs.set(handler, { unsub });
    } else {
      this._legacy.on(eventName, handler);
    }
    return () => this.off(eventName, handler);
  }

  prependListener(eventName, handler) {
    this.on(eventName, handler);
  }

  removeListener(eventName, handler) {
    this.off(eventName, handler);
  }

  off(eventName, handler) {
    // 双层键控: 仅退订 eventName 下该 handler 的内核订阅, 不误退同 handler 其他事件的订阅
    const regs = this._kernelRegs.get(eventName);
    if (regs) {
      const rec = regs.get(handler);
      if (rec) {
        try { rec.unsub(); } catch (e) { console.warn('[event-bus] 内核退订失败:', e.message); }
        regs.delete(handler);
        if (regs.size === 0) this._kernelRegs.delete(eventName);
      }
    }
    const set = this._local.get(eventName);
    if (set) set.delete(handler);
    this._legacy.removeListener(eventName, handler);
    const byName = this._byName.get(eventName);
    if (byName) {
      byName.delete(handler);
      if (byName.size === 0) this._byName.delete(eventName);
    }
  }

  // --- Subscriber Tracking ---

  subscribe(subscriberId, eventName, handler) {
    this.on(eventName, handler);
    if (!this._subscribers.has(eventName)) {
      this._subscribers.set(eventName, new Set());
    }
    this._subscribers.get(eventName).add(subscriberId);
    return () => this.unsubscribe(subscriberId, eventName, handler);
  }

  unsubscribe(subscriberId, eventName, handler) {
    this.off(eventName, handler);
    const subs = this._subscribers.get(eventName);
    if (subs) subs.delete(subscriberId);
  }

  getSubscriberCount(eventName) {
    const byName = this._byName.get(eventName);
    return byName ? byName.size : 0;
  }

  // B14 fix: 提供公共方法判断是否有订阅者，避免外部读取 _subscribers 私有属性
  hasSubscribers(eventName) {
    return this._subscribers.has(eventName) && this._subscribers.get(eventName).size > 0;
  }

  getSubscribers() {
    const result = {};
    for (const [event, subs] of this._subscribers) {
      result[event] = Array.from(subs);
    }
    return result;
  }

  // --- Standardized Events ---

  /** Emit a task lifecycle event with consistent shape */
  taskLifecycle(eventType, taskId, metadata = {}) {
    const eventName = `task:${eventType}`;
    this.emit(eventName, {
      taskId,
      timestamp: Date.now(),
      ...metadata,
    });
  }

  /** Emit a flow lifecycle event */
  flowLifecycle(eventType, flowId, metadata = {}) {
    const eventName = `flow:${eventType}`;
    this.emit(eventName, {
      flowId,
      timestamp: Date.now(),
      ...metadata,
    });
  }

  /** Emit a system event */
  systemEvent(eventType, metadata = {}) {
    const eventName = `system:${eventType}`;
    this.emit(eventName, {
      timestamp: Date.now(),
      ...metadata,
    });
  }

  // --- Audit Trail ---

  _audit(eventName, payload) {
    if (!this._auditEnabled) return;
    const entry = {
      event: eventName,
      timestamp: Date.now(),
      payload: this._sanitizeForAudit(payload),
    };
    this._auditLog.push(entry);
    if (this._auditLog.length > this._auditMax) {
      this._auditLog = this._auditLog.slice(-this._auditMax);
    }
  }

  _sanitizeForAudit(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    // Keep only safe keys; strip large result data
    const safe = {};
    const safeKeys = ['taskId', 'flowId', 'status', 'name', 'cron', 'action', 'error', 'duration', 'triggeredBy'];
    for (const key of safeKeys) {
      if (payload[key] !== undefined) safe[key] = payload[key];
    }
    return safe;
  }

  getAuditLog(limit = 100, eventName = null) {
    let log = this._auditLog;
    if (eventName) log = log.filter(e => e.event === eventName);
    return log.slice(-limit);
  }

  clearAuditLog() {
    this._auditLog = [];
  }

  enableAudit(enabled = true) {
    this._auditEnabled = enabled;
  }

  // --- Statistics ---

  getStats() {
    const eventCounts = {};
    for (const entry of this._auditLog) {
      eventCounts[entry.event] = (eventCounts[entry.event] || 0) + 1;
    }
    return {
      totalEvents: this._auditLog.length,
      eventCounts,
      subscriberCounts: this.getSubscribers(),
      auditEnabled: this._auditEnabled,
    };
  }
}

// Singleton
const unifiedEventBus = new UnifiedEventBusFacade();

module.exports = unifiedEventBus;
module.exports.UnifiedEventBus = UnifiedEventBusFacade;
module.exports.EVENT_TYPES = EVENT_TYPES;
