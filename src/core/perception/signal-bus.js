const crypto = require('crypto');
const { EventEmitter } = require('events')

const SIGNAL_SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
}

class SignalBus extends EventEmitter {
  constructor() {
    super()
    this._signals = []
    this._subscribers = new Map()
    this._maxSignals = 1000
    this._rateLimits = new Map()
    this._rateLimitWindowMs = 60000
    this._rateLimitMaxPerType = 30
    this._metricsPipeline = null // MetricsPipeline 注入
  }

  /**
   * 注入 MetricsPipeline，自动采集 metric 类型信号
   */
  setMetricsPipeline(pipeline) {
    this._metricsPipeline = pipeline
  }

  emit(signal) {
    if (!signal || !signal.type) return false

    signal.timestamp = signal.timestamp || Date.now()
    signal.severity = signal.severity || SIGNAL_SEVERITY.INFO

    const rateKey = signal.type
    const now = Date.now()
    const rateInfo = this._rateLimits.get(rateKey) || { count: 0, windowStart: now }

    if (now - rateInfo.windowStart > this._rateLimitWindowMs) {
      rateInfo.count = 0
      rateInfo.windowStart = now
    }

    rateInfo.count++
    this._rateLimits.set(rateKey, rateInfo)

    if (rateInfo.count > this._rateLimitMaxPerType) {
      return false
    }

    this._signals.push(signal)
    if (this._signals.length > this._maxSignals) {
      this._signals = this._signals.slice(-this._maxSignals / 2)
    }

    super.emit('signal', signal)
    super.emit(signal.type, signal)

    if (signal.source) {
      super.emit(`${signal.type}:${signal.source}`, signal)
    }

    // 自动路由 metric 类型信号到 MetricsPipeline
    if (signal.type === 'metric' && this._metricsPipeline) {
      try {
        this._metricsPipeline.record(
          signal.name || signal.metricName || 'unknown',
          signal.value ?? signal.metricValue ?? 0,
          signal.tags || signal.metricTags || {}
        )
      } catch (e) { console.warn('[signal-bus] failed to record metric:', e.message); }
    }

    return true
  }

  subscribe(signalType, handler, options = {}) {
    const subId = `${signalType}_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`

    const wrappedHandler = (signal) => {
      if (options.minSeverity) {
        const severityOrder = [SIGNAL_SEVERITY.INFO, SIGNAL_SEVERITY.WARNING, SIGNAL_SEVERITY.CRITICAL]
        const signalIdx = severityOrder.indexOf(signal.severity)
        const minIdx = severityOrder.indexOf(options.minSeverity)
        if (signalIdx < minIdx) return
      }

      try {
        handler(signal)
      } catch (err) {
        console.error(`SignalBus subscriber error [${subId}]:`, err.message)
      }
    }

    this.on(signalType, wrappedHandler)
    this._subscribers.set(subId, { signalType, handler: wrappedHandler, originalHandler: handler })

    return subId
  }

  unsubscribe(subId) {
    const sub = this._subscribers.get(subId)
    if (sub) {
      this.removeListener(sub.signalType, sub.handler)
      this._subscribers.delete(subId)
    }
  }

  getRecentSignals(type = null, limit = 50) {
    let signals = this._signals
    if (type) {
      signals = signals.filter(s => s.type === type)
    }
    return signals.slice(-limit)
  }

  getSignalStats() {
    const stats = {
      total: this._signals.length,
      byType: {},
      bySeverity: {},
      bySource: {},
    }

    for (const signal of this._signals) {
      stats.byType[signal.type] = (stats.byType[signal.type] || 0) + 1
      stats.bySeverity[signal.severity] = (stats.bySeverity[signal.severity] || 0) + 1
      if (signal.source) {
        stats.bySource[signal.source] = (stats.bySource[signal.source] || 0) + 1
      }
    }

    return stats
  }

  setRateLimitMaxPerType(max) {
    this._rateLimitMaxPerType = max
  }

  setRateLimitWindowMs(windowMs) {
    this._rateLimitWindowMs = windowMs
  }

  clear() {
    this._signals = []
    this._rateLimits.clear()
  }
}

const globalSignalBus = new SignalBus()

module.exports = {
  SignalBus,
  globalSignalBus,
  SIGNAL_SEVERITY,
}
