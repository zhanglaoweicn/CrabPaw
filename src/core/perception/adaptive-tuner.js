const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const { DATA_DIR } = require('../config')
const TUNER_STATE_DIR = path.join(DATA_DIR, 'perception')
const TUNER_STATE_FILE = path.join(TUNER_STATE_DIR, 'adaptive-tuner-state.json')

const TUNABLE_PARAMS = {
  'health.checkIntervalMs': { min: 10000, max: 300000, default: 60000, step: 10000, description: '健康检查间隔' },
  'health.memoryWarningMB': { min: 100, max: 1000, default: 256, step: 32, description: '内存警告阈值(MB)' },
  'health.memoryCriticalMB': { min: 200, max: 2000, default: 512, step: 64, description: '内存危险阈值(MB)' },
  'health.apiErrorRateWarning': { min: 0.05, max: 0.5, default: 0.15, step: 0.05, description: 'API错误率警告阈值' },
  'cost.dailyBudget': { min: 1, max: 50, default: 5, step: 1, description: '日预算(USD)' },
  'cost.monthlyBudget': { min: 10, max: 500, default: 100, step: 10, description: '月预算(USD)' },
  'behavior.silenceThresholdMs': { min: 300000, max: 7200000, default: 1800000, step: 300000, description: '用户沉默阈值(ms)' },
  'behavior.burstThreshold': { min: 3, max: 20, default: 5, step: 1, description: '用户爆发活动阈值' },
  'signal.rateLimitMaxPerType': { min: 10, max: 200, default: 50, step: 10, description: '信号速率限制' },
  'signal.rateLimitWindowMs': { min: 1000, max: 60000, default: 10000, step: 5000, description: '信号速率窗口(ms)' },
  'proactive.cooldownMs': { min: 60000, max: 3600000, default: 300000, step: 60000, description: '主动行动冷却时间(ms)' },
  'healing.observationMs': { min: 30000, max: 300000, default: 60000, step: 30000, description: '自愈观察期(ms)' },
}

class AdaptiveTuner extends EventEmitter {
  constructor() {
    super()
    this._currentParams = new Map()
    this._adjustmentHistory = []
    this._feedbackBuffer = new Map()
    this._maxHistorySize = 200
    this._running = false
    this._componentRefs = {}

    for (const [key, spec] of Object.entries(TUNABLE_PARAMS)) {
      this._currentParams.set(key, spec.default)
    }

    // 从持久化存储恢复参数
    this._loadState()
  }

  bindComponents(components) {
    this._componentRefs = components || {}
  }

  start() {
    if (this._running) return
    this._running = true
    console.log('🎛️ 自适应参数调节器已启动')
  }

  stop() {
    if (!this._running) return
    this._running = false
    console.log('🎛️ 自适应参数调节器已停止')
  }

  adjustFromSignal(signal) {
    if (!signal || !signal.type) return null

    const adjustments = []

    switch (signal.type) {
      case 'memory_high':
        if (signal.severity === SIGNAL_SEVERITY.CRITICAL) {
          adjustments.push(this._adjustParam('health.checkIntervalMs', -20000, '内存危急, 加快检查频率'))
          adjustments.push(this._adjustParam('health.memoryWarningMB', -32, '降低内存警告阈值'))
        }
        break

      case 'api_rate_limited':
        adjustments.push(this._adjustParam('health.apiErrorRateWarning', -0.05, 'API限流, 降低错误率警告阈值'))
        adjustments.push(this._adjustParam('signal.rateLimitMaxPerType', -10, '降低信号速率避免加剧限流'))
        break

      case 'daily_cost_exceeded':
        adjustments.push(this._adjustParam('cost.dailyBudget', 0, '日成本超预算, 不自动调整预算'))
        adjustments.push(this._adjustParam('proactive.cooldownMs', 120000, '增加主动行动冷却减少消耗'))
        break

      case 'daily_cost_warning':
        adjustments.push(this._adjustParam('proactive.cooldownMs', 60000, '成本接近预算, 增加冷却时间'))
        break

      case 'user_silence':
        adjustments.push(this._adjustParam('behavior.silenceThresholdMs', 300000, '用户沉默, 增加沉默阈值'))
        break

      case 'user_burst':
        adjustments.push(this._adjustParam('behavior.burstThreshold', -1, '用户高频活动, 降低爆发阈值'))
        break
    }

    const applied = adjustments.filter(a => a !== null)
    if (applied.length > 0) {
      globalSignalBus.emit({
        type: 'params_adjusted',
        source: 'adaptive_tuner',
        severity: SIGNAL_SEVERITY.INFO,
        detail: `自适应调节: ${applied.map(a => a.paramKey).join(', ')}`,
        metrics: { adjustments: applied.length },
      })
    }

    return applied
  }

  _adjustParam(paramKey, delta, reason) {
    const spec = TUNABLE_PARAMS[paramKey]
    if (!spec) return null

    const current = this._currentParams.get(paramKey) || spec.default
    let newValue = current + delta

    if (spec.step) {
      newValue = Math.round(newValue / spec.step) * spec.step
    }

    newValue = Math.max(spec.min, Math.min(spec.max, newValue))

    if (newValue === current) return null

    this._currentParams.set(paramKey, newValue)

    const record = {
      paramKey,
      oldValue: current,
      newValue,
      delta: newValue - current,
      reason,
      timestamp: Date.now(),
    }

    this._adjustmentHistory.push(record)
    if (this._adjustmentHistory.length > this._maxHistorySize) {
      this._adjustmentHistory = this._adjustmentHistory.slice(-this._maxHistorySize / 2)
    }

    this._applyParamToComponent(paramKey, newValue)
    this._saveState()

    return record
  }

  _applyParamToComponent(paramKey, value) {
    try {
      switch (paramKey) {
        case 'health.checkIntervalMs':
          if (this._componentRefs.systemHealthSensor) {
            this._componentRefs.systemHealthSensor.stop()
            this._componentRefs.systemHealthSensor.start(value)
          }
          break

        case 'health.memoryWarningMB':
          if (this._componentRefs.systemHealthSensor) {
            this._componentRefs.systemHealthSensor.setMemoryWarningThreshold(value)
          }
          break

        case 'health.memoryCriticalMB':
          if (this._componentRefs.systemHealthSensor) {
            this._componentRefs.systemHealthSensor.setMemoryCriticalThreshold(value)
          }
          break

        case 'health.apiErrorRateWarning':
          if (this._componentRefs.systemHealthSensor) {
            this._componentRefs.systemHealthSensor.setApiErrorRateWarning(value)
          }
          break

        case 'cost.dailyBudget':
        case 'cost.monthlyBudget':
          if (this._componentRefs.costSensor) {
            this._componentRefs.costSensor.setBudget(
              this._currentParams.get('cost.dailyBudget'),
              this._currentParams.get('cost.monthlyBudget')
            )
          }
          break

        case 'signal.rateLimitMaxPerType':
          if (this._componentRefs.signalBus) {
            this._componentRefs.signalBus.setRateLimitMaxPerType(value)
          }
          break

        case 'signal.rateLimitWindowMs':
          if (this._componentRefs.signalBus) {
            this._componentRefs.signalBus.setRateLimitWindowMs(value)
          }
          break

        case 'behavior.silenceThresholdMs':
          if (this._componentRefs.userBehaviorSensor) {
            this._componentRefs.userBehaviorSensor.setSilenceThreshold(value)
          }
          break

        case 'behavior.burstThreshold':
          if (this._componentRefs.userBehaviorSensor) {
            this._componentRefs.userBehaviorSensor.setBurstThreshold(value)
          }
          break

        case 'proactive.cooldownMs':
          if (this._componentRefs.proactiveEngine) {
            this._componentRefs.proactiveEngine.setDefaultCooldown(value)
          }
          break

        case 'healing.observationMs':
          if (this._componentRefs.selfHealingEngine) {
            this._componentRefs.selfHealingEngine.setDefaultObservationMs(value)
          }
          break
      }
    } catch (err) {
      console.warn(`🎛️ 参数回写失败 [${paramKey}]: ${err.message}`)
    }
  }

  recordFeedback(paramKey, feedback) {
    if (!this._feedbackBuffer.has(paramKey)) {
      this._feedbackBuffer.set(paramKey, [])
    }
    const buffer = this._feedbackBuffer.get(paramKey)
    buffer.push({ feedback, timestamp: Date.now() })
    if (buffer.length > 50) buffer.shift()

    // 反馈闭环：连续负面反馈触发自动回滚
    this._checkFeedbackLoop(paramKey)
  }

  /**
   * 反馈闭环检测
   * 如果最近 3 次反馈中有 2 次以上为负面（negative），自动回滚该参数到默认值
   */
  _checkFeedbackLoop(paramKey) {
    const buffer = this._feedbackBuffer.get(paramKey)
    if (!buffer || buffer.length < 3) return

    const recent = buffer.slice(-3)
    const negativeCount = recent.filter(
      entry => entry.feedback === 'negative' || entry.feedback === 'degraded'
    ).length

    if (negativeCount >= 2) {
      const spec = TUNABLE_PARAMS[paramKey]
      if (!spec) return

      const oldValue = this._currentParams.get(paramKey)
      if (oldValue === spec.default) return // 已经是默认值，无需回滚

      console.warn(
        `[AdaptiveTuner] 反馈闭环触发回滚: ${paramKey} ${oldValue} → ${spec.default} ` +
        `(最近${recent.length}次反馈中${negativeCount}次负面)`
      )

      this._currentParams.set(paramKey, spec.default)
      this._applyParamToComponent(paramKey, spec.default)

      this._adjustmentHistory.push({
        paramKey,
        oldValue,
        newValue: spec.default,
        delta: spec.default - oldValue,
        reason: 'feedback_loop_rollback',
        timestamp: Date.now(),
      })

      this._saveState()

      // 发出回滚信号
      globalSignalBus.emit({
        type: 'params_adjusted',
        source: 'adaptive_tuner_feedback_loop',
        severity: SIGNAL_SEVERITY.WARNING,
        detail: `反馈闭环回滚: ${paramKey} → 默认值`,
        metrics: { paramKey, oldValue, newValue: spec.default },
      })
    }
  }

  getParam(paramKey) {
    return this._currentParams.get(paramKey)
  }

  setParam(paramKey, value) {
    const spec = TUNABLE_PARAMS[paramKey]
    if (!spec) return { success: false, error: 'unknown_param' }

    const clampedValue = Math.max(spec.min, Math.min(spec.max, value))
    const oldValue = this._currentParams.get(paramKey)
    this._currentParams.set(paramKey, clampedValue)

    this._adjustmentHistory.push({
      paramKey,
      oldValue,
      newValue: clampedValue,
      delta: clampedValue - oldValue,
      reason: 'manual',
      timestamp: Date.now(),
    })

    this._applyParamToComponent(paramKey, clampedValue)

    return { success: true, paramKey, oldValue, newValue: clampedValue }
  }

  resetParam(paramKey) {
    const spec = TUNABLE_PARAMS[paramKey]
    if (!spec) return { success: false, error: 'unknown_param' }

    const oldValue = this._currentParams.get(paramKey)
    this._currentParams.set(paramKey, spec.default)

    return { success: true, paramKey, oldValue, newValue: spec.default }
  }

  resetAll() {
    for (const [key, spec] of Object.entries(TUNABLE_PARAMS)) {
      this._currentParams.set(key, spec.default)
    }
    return { success: true, resetCount: Object.keys(TUNABLE_PARAMS).length }
  }

  getAllParams() {
    const result = {}
    for (const [key, spec] of Object.entries(TUNABLE_PARAMS)) {
      result[key] = {
        current: this._currentParams.get(key),
        default: spec.default,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        description: spec.description,
        isModified: this._currentParams.get(key) !== spec.default,
      }
    }
    return result
  }

  getAdjustmentHistory(limit = 30) {
    return this._adjustmentHistory.slice(-limit)
  }

  getStatus() {
    let modifiedCount = 0
    for (const [key, spec] of Object.entries(TUNABLE_PARAMS)) {
      if (this._currentParams.get(key) !== spec.default) modifiedCount++
    }

    return {
      running: this._running,
      totalParams: Object.keys(TUNABLE_PARAMS).length,
      modifiedParams: modifiedCount,
      totalAdjustments: this._adjustmentHistory.length,
    }
  }

  // ========== 持久化 ==========

  _loadState() {
    try {
      if (!fs.existsSync(TUNER_STATE_FILE)) return
      const data = JSON.parse(fs.readFileSync(TUNER_STATE_FILE, 'utf-8'))
      if (data.params) {
        for (const [key, value] of Object.entries(data.params)) {
          const spec = TUNABLE_PARAMS[key]
          if (spec) {
            // 验证范围
            const clamped = Math.max(spec.min, Math.min(spec.max, value))
            this._currentParams.set(key, clamped)
          }
        }
      }
      if (data.adjustmentHistory && Array.isArray(data.adjustmentHistory)) {
        this._adjustmentHistory = data.adjustmentHistory.slice(-this._maxHistorySize)
      }
    } catch (e) {
      console.warn('[adaptive-tuner] load state failed:', e.message);
    }
  }

  _saveState() {
    try {
      if (!fs.existsSync(TUNER_STATE_DIR)) {
        fs.mkdirSync(TUNER_STATE_DIR, { recursive: true })
      }
      const params = {}
      for (const [key, value] of this._currentParams) {
        params[key] = value
      }
      const data = {
        params,
        savedAt: Date.now(),
        adjustmentHistory: this._adjustmentHistory.slice(-50), // 只保留最近50条
      }
      fs.writeFileSync(TUNER_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[adaptive-tuner] save state failed:', e.message);
    }
  }
}

const globalAdaptiveTuner = new AdaptiveTuner()

module.exports = {
  AdaptiveTuner,
  globalAdaptiveTuner,
  TUNABLE_PARAMS,
}
