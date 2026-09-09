/**
 * Harness Event System — 统一事件系统
 *
 * 为 CrabPaw 提供类型化的事件发布/订阅基础设施。
 * 设计参考 Harness OSS (Gitness) 的 Event[T] 泛型模式，适配 Node.js 生态。
 *
 * 核心理念:
 *   - 一个 EventBus 单例贯穿所有模块
 *   - category:type 两级路由 (如 "tool:call_start")
 *   - 非破坏性 — 与现有 EventEmitter 共存，逐步迁移
 *   - 支持 replay 用于调试/审计
 *
 * 事件目录:
 *   tool:call_start, tool:call_success, tool:call_failure, tool:contract_violation
 *   llm:call_start, llm:call_success, llm:call_failure, llm:token_usage
 *   session:start, session:end, session:compaction, session:anomaly
 *   evolution:feedback, evolution:triggered, evolution:completed, evolution:error
 *   system:health_check, system:config_change, system:error, system:shutdown
 */

const crypto = require('crypto');
const unifiedEventBus = require('./event-bus');

// ============================================================
// Event Categories & Types
// ============================================================

const EVENT_CATEGORIES = {
  TOOL: 'tool',
  LLM: 'llm',
  SESSION: 'session',
  EVOLUTION: 'evolution',
  SELF_HEALING: 'self_healing',
  SYSTEM: 'system',
};

const EVENT_TYPES = {
  // Tool events
  TOOL_CALL_START: 'call_start',
  TOOL_CALL_SUCCESS: 'call_success',
  TOOL_CALL_FAILURE: 'call_failure',
  TOOL_CONTRACT_VIOLATION: 'contract_violation',
  TOOL_BLOCKED: 'blocked',

  // LLM events
  LLM_CALL_START: 'call_start',
  LLM_CALL_SUCCESS: 'call_success',
  LLM_CALL_FAILURE: 'call_failure',
  LLM_TOKEN_USAGE: 'token_usage',

  // Session events
  SESSION_START: 'start',
  SESSION_END: 'end',
  SESSION_COMPACTION: 'compaction',
  SESSION_ANOMALY: 'anomaly',

  // Evolution events
  EVOLUTION_FEEDBACK: 'feedback',
  EVOLUTION_TRIGGERED: 'triggered',
  EVOLUTION_COMPLETED: 'completed',
  EVOLUTION_ERROR: 'error',

  // Self-healing events
  SELF_HEALING_COMPLETE: 'complete',

  // System events
  SYSTEM_HEALTH_CHECK: 'health_check',
  SYSTEM_CONFIG_CHANGE: 'config_change',
  SYSTEM_ERROR: 'error',
  SYSTEM_SHUTDOWN: 'shutdown',
};

// ============================================================
// HarnessEvent
// ============================================================

/**
 * @template T
 */
class HarnessEvent {
  /**
   * @param {string} category - 事件类别 (tool|llm|session|evolution|system)
   * @param {string} type - 事件类型 (call_start|call_success|...)
   * @param {T} payload - 事件载荷
   * @param {Object} [opts]
   * @param {string} [opts.traceId] - 追踪 ID，贯穿同一请求的所有事件
   * @param {string} [opts.sessionId] - 会话 ID
   */
  constructor(category, type, payload, opts = {}) {
    this.id = crypto.randomUUID();
    this.timestamp = Date.now();
    this.iso = new Date().toISOString();
    this.category = category;
    this.type = type;
    this.payload = payload;
    this.traceId = opts.traceId || null;
    this.sessionId = opts.sessionId || null;
  }

  /** 完整的事件路由键: "category:type" */
  get route() {
    return `${this.category}:${this.type}`;
  }

  /** 通配路由键: "category:*" */
  get categoryRoute() {
    return `${this.category}:*`;
  }

  /** 全局通配: "*" */
  static get WILDCARD() {
    return '*';
  }

  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      iso: this.iso,
      category: this.category,
      type: this.type,
      route: this.route,
      payload: this.payload,
      traceId: this.traceId,
      sessionId: this.sessionId,
    };
  }
}

// ============================================================
// EventBus
// ============================================================

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} route → handlers */
    this._handlers = new Map();
    /** @type {HarnessEvent[]} 最近事件（用于 replay） */
    this._recentEvents = [];
    this._maxRecent = 1000;
    this._started = false;
  }

  /**
   * 发布事件
   * @template T
   * @param {string} category
   * @param {string} type
   * @param {T} payload
   * @param {Object} [opts]
   */
  publish(category, type, payload, opts = {}) {
    const event = new HarnessEvent(category, type, payload, opts);

    // 存储用于 replay
    this._recentEvents.push(event);
    if (this._recentEvents.length > this._maxRecent) {
      this._recentEvents = this._recentEvents.slice(-Math.floor(this._maxRecent / 2));
    }

    // 分发到匹配的 handler
    const routes = [event.route, event.categoryRoute, HarnessEvent.WILDCARD];
    for (const route of routes) {
      const handlers = this._handlers.get(route);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(event);
          } catch (e) {
            console.warn(`[EventBus] handler error for ${route}:`, e.message);
          }
        }
      }
    }

    // ── 双总线统一 (2026-08-15 P2-7) ──
    // EventBus 定位为 UnifiedEventBus(event-bus.js)之上的类型化发布器:
    // 本地 route 分发保留(wildcard 语义 UnifiedEventBus 无法表达,evals eb_003/004 锁定),
    // 同时将类型化事件镜像到统一总线(harness: 命名空间,避免与 task:/flow:/system:
    // 既有名字冲突),使跨系统监听方(面板/场景/技能等)能从单一总线观察 Harness 事件。
    try {
      unifiedEventBus.emit(`harness:${event.category}:${event.type}`, event.toJSON());
    } catch (e) {
      console.warn('[EventBus] 统一总线镜像发布失败:', e?.message || e);
    }

    return event;
  }

  /**
   * 订阅事件
   * @param {string} route - "category:type" | "category:*" | "*"
   * @param {Function} handler - (event: HarnessEvent) => void
   * @returns {Function} 取消订阅函数
   */
  subscribe(route, handler) {
    if (!this._handlers.has(route)) {
      this._handlers.set(route, new Set());
    }
    this._handlers.get(route).add(handler);

    // 返回取消订阅函数
    return () => {
      const handlers = this._handlers.get(route);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this._handlers.delete(route);
        }
      }
    };
  }

  /**
   * 带来源标记的订阅 — 插件系统使用
   * 可通过 unsubscribeBySource(source) 批量取消
   * @param {string} source - 来源标识 (如 'plugin:voice')
   * @param {string} route - 事件路由 (如 'tool:call_start')
   * @param {Function} handler
   * @returns {Function} unsubscribe
   */
  subscribeWithSource(source, route, handler) {
    if (!this._sourceHandlers) this._sourceHandlers = new Map();
    if (!this._sourceHandlers.has(source)) this._sourceHandlers.set(source, []);
    this._sourceHandlers.get(source).push({ route, handler });
    return this.subscribe(route, handler);
  }

  /**
   * 按来源取消所有订阅
   */
  unsubscribeBySource(source) {
    if (!this._sourceHandlers) return;
    const handlers = this._sourceHandlers.get(source);
    if (!handlers) return;
    for (const { route, handler } of handlers) {
      const routeHandlers = this._handlers.get(route);
      if (routeHandlers) routeHandlers.delete(handler);
    }
    this._sourceHandlers.delete(source);
  }

  /**
   * 回放最近事件（用于调试/审计）
   * @param {Object} [filter]
   * @param {string} [filter.category]
   * @param {string} [filter.type]
   * @param {number} [filter.since] - 时间戳
   * @param {number} [filter.limit=100]
   * @returns {HarnessEvent[]}
   */
  replay(filter = {}) {
    let events = this._recentEvents;

    if (filter.category) {
      events = events.filter(e => e.category === filter.category);
    }
    if (filter.type) {
      events = events.filter(e => e.type === filter.type);
    }
    if (filter.since) {
      events = events.filter(e => e.timestamp >= filter.since);
    }

    const limit = filter.limit || 100;
    return events.slice(-limit);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const categoryCounts = {};
    for (const event of this._recentEvents) {
      categoryCounts[event.category] = (categoryCounts[event.category] || 0) + 1;
    }
    return {
      totalEvents: this._recentEvents.length,
      handlerCount: [...this._handlers.values()].reduce((s, h) => s + h.size, 0),
      routeCount: this._handlers.size,
      categoryCounts,
    };
  }

  /**
   * 清空事件历史（保留 handler 注册）
   */
  clearHistory() {
    this._recentEvents = [];
  }

  /**
   * 重置整个 EventBus
   */
  reset() {
    this._handlers.clear();
    this._recentEvents = [];
  }
}

// ============================================================
// 全局单例
// ============================================================

let _bus = null;

// 2026-08-15 T7(累积B): 暴露真实单例引用——unified-memory 等模块此前读
// EventBus.global(恒 undefined),记忆 reconciliation 订阅从未激活。
// getter 惰性返回 getEventBus() 单例,首次访问即创建并共享。
Object.defineProperty(EventBus, 'global', {
  get() { return getEventBus(); },
  configurable: true,
});

/**
 * 获取全局 EventBus 单例
 * @returns {EventBus}
 */
function getEventBus() {
  if (!_bus) {
    _bus = new EventBus();
  }
  return _bus;
}

/**
 * 便捷发布函数
 * @template T
 */
function emit(category, type, payload, opts) {
  return getEventBus().publish(category, type, payload, opts);
}

/**
 * 便捷订阅函数
 */
function on(route, handler) {
  return getEventBus().subscribe(route, handler);
}

module.exports = {
  // 核心类
  HarnessEvent,
  EventBus,

  // 枚举
  EVENT_CATEGORIES,
  EVENT_TYPES,

  // 单例
  getEventBus,

  // 便捷函数
  emit,
  on,

};
