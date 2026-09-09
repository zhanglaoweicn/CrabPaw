const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const CHECK_INTERVAL_MS = 30000
const MEMORY_THRESHOLD_WARNING_MB = 256
const MEMORY_THRESHOLD_CRITICAL_MB = 512
const API_ERROR_RATE_WARNING = 0.15
const API_ERROR_RATE_CRITICAL = 0.3
const API_LATENCY_WARNING_MS = 10000
const API_LATENCY_CRITICAL_MS = 30000

class SystemHealthSensor {
  constructor() {
    this._interval = null
    this._memoryWarningMB = MEMORY_THRESHOLD_WARNING_MB
    this._memoryCriticalMB = MEMORY_THRESHOLD_CRITICAL_MB
    this._apiErrorRateWarning = API_ERROR_RATE_WARNING
    this._apiCallStats = {
      total: 0,
      errors: 0,
      totalLatencyMs: 0,
      lastErrorTime: null,
      lastErrorType: null,
    }
    this._lastCheck = null
    this._running = false
  }

  start(intervalMs = CHECK_INTERVAL_MS) {
    if (this._interval) return

    this._running = true
    this._check()

    this._interval = setInterval(() => this._check(), intervalMs)
    if (this._interval.unref) this._interval.unref()

    console.log('🏥 系统健康感知器已启动')
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
    this._running = false
  }

  recordApiCall(result) {
    this._apiCallStats.total++
    if (result.error) {
      this._apiCallStats.errors++
      this._apiCallStats.lastErrorTime = Date.now()
      this._apiCallStats.lastErrorType = result.errorType || 'unknown'
    }
    if (result.latencyMs) {
      this._apiCallStats.totalLatencyMs += result.latencyMs
    }
  }

  _check() {
    this._lastCheck = Date.now()
    this._checkMemory()
    this._checkApiHealth()
    this._checkProcessHealth()
  }

  _checkMemory() {
    const usage = process.memoryUsage()
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024)
    const rssMB = Math.round(usage.rss / 1024 / 1024)

    if (heapUsedMB > this._memoryCriticalMB) {
      globalSignalBus.emit({
        type: 'memory_high',
        source: 'system_health',
        severity: SIGNAL_SEVERITY.CRITICAL,
        detail: `内存严重过高: Heap ${heapUsedMB}MB, RSS ${rssMB}MB`,
        metrics: { heapUsedMB, rssMB },
      })
    } else if (heapUsedMB > this._memoryWarningMB) {
      globalSignalBus.emit({
        type: 'memory_high',
        source: 'system_health',
        severity: SIGNAL_SEVERITY.WARNING,
        detail: `内存偏高: Heap ${heapUsedMB}MB, RSS ${rssMB}MB`,
        metrics: { heapUsedMB, rssMB },
      })
    }
  }

  _checkApiHealth() {
    const stats = this._apiCallStats
    if (stats.total < 5) return

    const errorRate = stats.errors / stats.total
    const avgLatencyMs = stats.total > 0 ? stats.totalLatencyMs / stats.total : 0

    if (errorRate > API_ERROR_RATE_CRITICAL) {
      globalSignalBus.emit({
        type: 'api_rate_limited',
        source: 'system_health',
        severity: SIGNAL_SEVERITY.CRITICAL,
        detail: `API错误率过高: ${(errorRate * 100).toFixed(1)}%, 最近错误: ${stats.lastErrorType}`,
        metrics: { errorRate, totalCalls: stats.total, errors: stats.errors },
      })
    } else if (errorRate > this._apiErrorRateWarning) {
      globalSignalBus.emit({
        type: 'api_429_error',
        source: 'system_health',
        severity: SIGNAL_SEVERITY.WARNING,
        detail: `API错误率偏高: ${(errorRate * 100).toFixed(1)}%`,
        metrics: { errorRate, totalCalls: stats.total },
      })
    }

    if (avgLatencyMs > API_LATENCY_CRITICAL_MS) {
      globalSignalBus.emit({
        type: 'api_latency_high',
        source: 'system_health',
        severity: SIGNAL_SEVERITY.CRITICAL,
        detail: `API延迟过高: ${avgLatencyMs.toFixed(0)}ms`,
        metrics: { avgLatencyMs },
      })
    } else if (avgLatencyMs > API_LATENCY_WARNING_MS) {
      globalSignalBus.emit({
        type: 'api_latency_high',
        source: 'system_health',
        severity: SIGNAL_SEVERITY.WARNING,
        detail: `API延迟偏高: ${avgLatencyMs.toFixed(0)}ms`,
        metrics: { avgLatencyMs },
      })
    }

    if (stats.total > 20) {
      this._apiCallStats.total = Math.floor(stats.total / 2)
      this._apiCallStats.errors = Math.floor(stats.errors / 2)
      this._apiCallStats.totalLatencyMs = Math.floor(stats.totalLatencyMs / 2)
    }
  }

  _checkProcessHealth() {
    const uptime = process.uptime()
    const cpuUsage = process.cpuUsage()

    if (cpuUsage.user > 10000000) {
      globalSignalBus.emit({
        type: 'cpu_high',
        source: 'system_health',
        severity: SIGNAL_SEVERITY.WARNING,
        detail: `CPU使用时间较高: user ${Math.round(cpuUsage.user / 1000000)}s`,
        metrics: { cpuUser: cpuUsage.user, cpuSystem: cpuUsage.system, uptime },
      })
    }
  }

  setMemoryWarningThreshold(mb) {
    this._memoryWarningMB = mb
  }

  setMemoryCriticalThreshold(mb) {
    this._memoryCriticalMB = mb
  }

  setApiErrorRateWarning(rate) {
    this._apiErrorRateWarning = rate
  }

  getStatus() {
    const usage = process.memoryUsage()
    return {
      running: this._running,
      lastCheck: this._lastCheck,
      memory: {
        heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
        rssMB: Math.round(usage.rss / 1024 / 1024),
      },
      api: {
        totalCalls: this._apiCallStats.total,
        errors: this._apiCallStats.errors,
        errorRate: this._apiCallStats.total > 0
          ? (this._apiCallStats.errors / this._apiCallStats.total).toFixed(3)
          : '0',
        avgLatencyMs: this._apiCallStats.total > 0
          ? Math.round(this._apiCallStats.totalLatencyMs / this._apiCallStats.total)
          : 0,
      },
    }
  }
}

const globalSystemHealthSensor = new SystemHealthSensor()

module.exports = {
  SystemHealthSensor,
  globalSystemHealthSensor,
}
