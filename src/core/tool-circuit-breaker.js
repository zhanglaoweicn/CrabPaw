/**
 * Circuit Breaker v2 - 增强版熔断器
 *
 * Inspired by: xai-circuit-breaker (Grok Build)
 * Enhancements:
 * - 滑动窗口统计 (Sliding Window) 替代简单计数
 * - Lock-free fast path for isOpen() (基于共享标志位)
 * - Half-open 探针超时回收 (abandoned probe reclaim)
 * - 支持窗口时间内的失败率判定，更精确的熔断触发
 *
 * 状态机：CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN
 */

const EventEmitter = require('events');

const STATE = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
};

const DEFAULT_OPTIONS = {
  failureThreshold: 3,        // 最小样本数 (窗口内)
  failureRateThreshold: 0.5,  // 失败率阈值 (窗口内)
  successThreshold: 2,        // 半开状态下连续成功N次恢复
  timeout: 30000,             // 单次调用超时(ms)
  resetDuration: 60000,       // 熔断持续时间(ms)，之后进入半开
  halfOpenMaxRequests: 1,     // 半开状态允许的最大探测请求数
  monitorInterval: 30000,     // 监控统计刷新间隔(ms)
  windowSizeMs: 10000,        // 滑动窗口大小 (ms)
  minSamples: 5,              // 窗口内最小样本数 (少于此数不触发)
  probeTimeoutMs: 10000,      // Half-open 探针超时 (超过此时间视为放弃)
};

/**
 * SlidingWindow - 滑动窗口统计
 * 在固定时间窗口内记录成功/失败次数，支持过期清理
 */
class SlidingWindow {
  constructor(windowSizeMs = 10000) {
    this.windowSizeMs = windowSizeMs;
    this.successes = [];
    this.failures = [];
  }

  record(success) {
    const now = Date.now();
    this._cleanup(now);
    if (success) this.successes.push(now);
    else this.failures.push(now);
  }

  _cleanup(now) {
    const cutoff = now - this.windowSizeMs;
    this.successes = this.successes.filter(t => t > cutoff);
    this.failures = this.failures.filter(t => t > cutoff);
  }

  getFailureRate() {
    const total = this.successes.length + this.failures.length;
    if (total === 0) return 0;
    return this.failures.length / total;
  }

  getCount() {
    return this.successes.length + this.failures.length;
  }

  reset() {
    this.successes = [];
    this.failures = [];
  }
}

class CircuitBreaker extends EventEmitter {
  constructor(name, options = {}) {
    super();
    this.name = name;
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._state = STATE.CLOSED;
    
    // 滑动窗口 (替代简单计数)
    this._window = new SlidingWindow(this._options.windowSizeMs);
    
    // 探针超时追踪 (防止 Half-open 卡死)
    this._probeClaimedAt = 0;
    this._halfOpenRequests = 0;
    
    this._lastFailureTime = 0;
    this._openedAt = 0;
    
    // 基础统计
    this._stats = {
      totalCalls: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      totalTimeouts: 0,
      totalRejected: 0,
      lastError: null,
      // 增强统计
      windowFailureRate: 0,
      windowSamples: 0,
      halfOpenProbes: 0,
      abandonedProbes: 0,
    };
  }

  get state() { return this._state; }

  /**
   * Lock-free fast path for isOpen()
   * 检查熔断状态 (先检查是否过期)
   */
  isOpen() {
    if (this._state === STATE.OPEN) {
      if (Date.now() - this._openedAt >= this._options.resetDuration) {
        this._transitionTo(STATE.HALF_OPEN);
        return false;
      }
      return true;
    }
    return false;
  }

  get isClosed() { return this._state === STATE.CLOSED; }
  get isHalfOpen() { return this._state === STATE.HALF_OPEN; }

  get stats() {
    return {
      ...this._stats,
      state: this._state,
      windowFailureRate: this._window.getFailureRate(),
      windowSamples: this._window.getCount(),
    };
  }

  /**
   * 通过熔断器执行函数 (增强版)
   * @param {Function} fn - 要执行的异步函数
   * @param {*} args - 传给 fn 的参数
   * @returns {Promise<*>} fn 的返回值
   */
  async execute(fn, ...args) {
    // Fast path: 检查熔断状态
    if (this._state === STATE.OPEN) {
      if (Date.now() - this._openedAt >= this._options.resetDuration) {
        this._transitionTo(STATE.HALF_OPEN);
      } else {
        this._stats.totalRejected++;
        this.emit('rejected', { name: this.name, state: this._state });
        const err = new Error(`熔断器 [${this.name}] 已开启，拒绝调用`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    // Half-open: 检查探针数 + 超时回收
    if (this._state === STATE.HALF_OPEN) {
      // 探针超时回收: 如果某个探针被占用太久，视为放弃
      if (this._probeClaimedAt > 0 && 
          Date.now() - this._probeClaimedAt > this._options.probeTimeoutMs) {
        this._stats.abandonedProbes++;
        this._halfOpenRequests = 0;
        this._probeClaimedAt = 0;
        this.emit('probe_abandoned', { name: this.name });
      }

      if (this._halfOpenRequests >= this._options.halfOpenMaxRequests) {
        this._stats.totalRejected++;
        const err = new Error(`熔断器 [${this.name}] 半开状态，探测请求数已满`);
        err.code = 'CIRCUIT_HALF_OPEN_FULL';
        throw err;
      }
      this._halfOpenRequests++;
      this._probeClaimedAt = Date.now();
      this._stats.halfOpenProbes++;
    }

    this._stats.totalCalls++;

    try {
      const result = await this._executeWithTimeout(fn, ...args);
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      throw error;
    }
  }

  async _executeWithTimeout(fn, ...args) {
    const timeout = this._options.timeout;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`工具调用超时 (${timeout}ms): ${this.name}`));
      }, timeout);

      if (timer.unref) timer.unref();

      Promise.resolve()
        .then(() => fn(...args))
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  _onSuccess() {
    this._stats.totalSuccesses++;
    this._stats.lastError = null;
    this._window.record(true);

    if (this._state === STATE.HALF_OPEN) {
      // 成功恢复
      this._transitionTo(STATE.CLOSED);
    }
  }

  _onFailure(error) {
    this._stats.totalFailures++;
    this._stats.lastError = error.message;
    this._lastFailureTime = Date.now();
    this._window.record(false);

    if (error.message && error.message.includes('超时')) {
      this._stats.totalTimeouts++;
    }

    if (this._state === STATE.HALF_OPEN) {
      // 半开状态下任何失败立即回到 OPEN
      this._transitionTo(STATE.OPEN);
    } else if (this._state === STATE.CLOSED) {
      // 使用滑动窗口判定
      const sampleCount = this._window.getCount();
      const failureRate = this._window.getFailureRate();
      this._stats.windowFailureRate = failureRate;
      this._stats.windowSamples = sampleCount;

      // 需要最小样本数
      if (sampleCount >= this._options.minSamples) {
        // 满足失败数 AND 失败率 双重条件
        const recentFailures = this._window.failures.length;
        if (recentFailures >= this._options.failureThreshold && 
            failureRate >= this._options.failureRateThreshold) {
          this._transitionTo(STATE.OPEN);
        }
      }
    }

    // 清理探针状态
    this._probeClaimedAt = 0;

    this.emit('failure', { 
      name: this.name, 
      error: error.message, 
      failureRate: this._window.getFailureRate(),
      windowSamples: this._window.getCount(),
    });
  }

  _transitionTo(newState) {
    const oldState = this._state;
    this._state = newState;

    if (newState === STATE.OPEN) {
      this._openedAt = Date.now();
      this._halfOpenRequests = 0;
      this._probeClaimedAt = 0;
      this.emit('open', { name: this.name, previousState: oldState });
    } else if (newState === STATE.HALF_OPEN) {
      this._halfOpenRequests = 0;
      this._probeClaimedAt = 0;
      this.emit('halfOpen', { name: this.name, previousState: oldState });
    } else if (newState === STATE.CLOSED) {
      this._window.reset();
      this._halfOpenRequests = 0;
      this._probeClaimedAt = 0;
      this.emit('close', { name: this.name, previousState: oldState });
    }
  }

  reset() {
    this._transitionTo(STATE.CLOSED);
  }

  trip() {
    this._transitionTo(STATE.OPEN);
  }

  /**
   * 手动标记一个探针完成 (用于需要手动控制探针的场景)
   */
  completeProbe(success) {
    if (this._state !== STATE.HALF_OPEN) return;
    if (success) this._onSuccess();
    else this._onFailure(new Error('手动探针失败'));
  }
}

class CircuitBreakerRegistry extends EventEmitter {
  constructor() {
    super();
    this._breakers = new Map();
    this._defaultOptions = { ...DEFAULT_OPTIONS };
  }

  getBreaker(toolName, options = {}) {
    if (!this._breakers.has(toolName)) {
      const breaker = new CircuitBreaker(toolName, {
        ...this._defaultOptions,
        ...options,
      });
      this._breakers.set(toolName, breaker);

      breaker.on('open', (data) => this.emit('breaker:open', data));
      breaker.on('close', (data) => this.emit('breaker:close', data));
      breaker.on('rejected', (data) => this.emit('breaker:rejected', data));
      breaker.on('failure', (data) => this.emit('breaker:failure', data));
      breaker.on('probe_abandoned', (data) => this.emit('breaker:probe_abandoned', data));
    }
    return this._breakers.get(toolName);
  }

  async executeWithBreaker(toolName, fn, options = {}) {
    const breaker = this.getBreaker(toolName, options.breakerOptions);
    return breaker.execute(fn);
  }

  getStatus() {
    const status = {};
    for (const [name, breaker] of this._breakers) {
      status[name] = breaker.stats;
    }
    return status;
  }

  getAllBreakers() {
    return this._breakers.entries();
  }

  resetAll() {
    for (const breaker of this._breakers.values()) {
      breaker.reset();
    }
  }

  setDefaultOptions(options) {
    Object.assign(this._defaultOptions, options);
  }
}

let _registry = null;

function getCircuitBreakerRegistry() {
  if (!_registry) {
    _registry = new CircuitBreakerRegistry();
  }
  return _registry;
}

module.exports = {
  CircuitBreaker,
  CircuitBreakerRegistry,
  SlidingWindow,
  getCircuitBreakerRegistry,
  STATE,
  DEFAULT_OPTIONS,
};
