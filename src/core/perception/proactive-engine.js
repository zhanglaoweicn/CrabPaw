const { EventEmitter } = require('events')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')
const { globalSelfHealingEngine } = require('../self-healing-engine')
const { globalSystemHealthSensor } = require('./system-health-sensor')
const { globalUserBehaviorSensor } = require('./user-behavior-sensor')
const { globalBusinessContextSensor } = require('./business-context-sensor')
const { globalCostSensor } = require('./cost-sensor')

const PROACTIVE_RULES = [
  {
    id: 'auto_heal_on_critical',
    name: '严重信号自动自愈',
    triggerTypes: ['memory_high', 'api_rate_limited', 'disk_space_low', 'security_threat'],
    minSeverity: SIGNAL_SEVERITY.CRITICAL,
    action: 'heal',
    cooldownMs: 300000,
  },
  {
    id: 'auto_heal_on_warning_streak',
    name: '连续警告自动自愈',
    triggerTypes: ['api_429_error', 'api_latency_high', 'memory_high'],
    minSeverity: SIGNAL_SEVERITY.WARNING,
    action: 'heal',
    consecutiveThreshold: 3,
    cooldownMs: 600000,
  },
  {
    id: 'domain_preload',
    name: '领域预加载',
    triggerTypes: ['domain_activated'],
    minSeverity: SIGNAL_SEVERITY.INFO,
    action: 'preload_domain',
    cooldownMs: 600000,
  },
  {
    id: 'user_silence_checkin',
    name: '用户沉默关怀',
    triggerTypes: ['user_silence'],
    minSeverity: SIGNAL_SEVERITY.INFO,
    action: 'checkin',
    cooldownMs: 24 * 60 * 60 * 1000,
  },
  {
    id: 'cost_optimization',
    name: '成本优化',
    triggerTypes: ['daily_cost_warning', 'token_usage_spike'],
    minSeverity: SIGNAL_SEVERITY.WARNING,
    action: 'optimize_cost',
    cooldownMs: 3600000,
  },
]

class ProactiveEngine extends EventEmitter {
  constructor() {
    super()
    this._sensors = {
      systemHealth: globalSystemHealthSensor,
      userBehavior: globalUserBehaviorSensor,
      businessContext: globalBusinessContextSensor,
      cost: globalCostSensor,
    }
    this._signalCounts = new Map()
    this._lastActionTime = new Map()
    this._running = false
    this._subIds = []
    this._defaultCooldownMs = 300000
  }

  setDefaultCooldown(ms) {
    this._defaultCooldownMs = ms
  }

  start() {
    if (this._running) return

    this._running = true

    for (const rule of PROACTIVE_RULES) {
      for (const triggerType of rule.triggerTypes) {
        const subId = globalSignalBus.subscribe(triggerType, (signal) => {
          this._processSignal(rule, signal)
        }, { minSeverity: rule.minSeverity })
        this._subIds.push(subId)
      }
    }

    globalSelfHealingEngine.on('healing:completed', (data) => {
      this.emit('proactive:healed', data)
    })

    globalSelfHealingEngine.on('healing:rolled_back', (data) => {
      this.emit('proactive:rollback', data)
    })

    globalSelfHealingEngine.on('healing:notify', (data) => {
      this.emit('proactive:notify', data)
    })

    globalSelfHealingEngine.on('healing:suggest', (data) => {
      this.emit('proactive:suggest', data)
    })

    console.log('🎯 主动决策引擎已启动')
  }

  stop() {
    this._running = false
    for (const subId of this._subIds) {
      globalSignalBus.unsubscribe(subId)
    }
    this._subIds = []
  }

  _processSignal(rule, signal) {
    const countKey = `${rule.id}:${signal.type}`
    const count = (this._signalCounts.get(countKey) || 0) + 1
    this._signalCounts.set(countKey, count)

    const lastAction = this._lastActionTime.get(rule.id) || 0
    if (Date.now() - lastAction < rule.cooldownMs) return

    if (rule.consecutiveThreshold && count < rule.consecutiveThreshold) return

    this._signalCounts.set(countKey, 0)
    this._lastActionTime.set(rule.id, Date.now())

    this._executeAction(rule, signal)
  }

  async _executeAction(rule, signal) {
    this.emit('proactive:action', {
      ruleId: rule.id,
      ruleName: rule.name,
      action: rule.action,
      triggerSignal: signal,
    })

    switch (rule.action) {
      case 'heal':
        globalSelfHealingEngine.ingestSignal(signal)
        break

      case 'preload_domain':
        this._preloadDomain(signal)
        break

      case 'checkin':
        this._userCheckin(signal)
        break

      case 'optimize_cost':
        this._optimizeCost(signal)
        break

      default:
        console.warn(`未知主动动作: ${rule.action}`)
    }
  }

  _preloadDomain(signal) {
    const domain = signal.metrics?.domain
    if (!domain) return

    this.emit('proactive:domain_preload', {
      domain,
      detail: `预加载领域: ${domain}`,
    })

    console.log(`🏢 主动预加载领域: ${domain}`)
  }

  _userCheckin(signal) {
    const source = signal.source || ''
    const userId = source.replace('user:', '')

    this.emit('proactive:user_checkin', {
      userId,
      silenceDuration: signal.metrics?.silenceDurationMs,
    })

    console.log(`👋 用户沉默关怀: ${userId}`)
  }

  _optimizeCost(signal) {
    this.emit('proactive:cost_optimize', {
      type: signal.type,
      cost: signal.metrics?.cost,
      budget: signal.metrics?.budget,
    })

    console.log(`💰 主动成本优化: ${signal.type}`)
  }

  getFullStatus() {
    return {
      running: this._running,
      sensors: {
        systemHealth: globalSystemHealthSensor.getStatus(),
        userBehavior: globalUserBehaviorSensor.getStatus(),
        businessContext: globalBusinessContextSensor.getStatus(),
        cost: globalCostSensor.getStatus(),
      },
      selfHealing: globalSelfHealingEngine.getStatus(),
      signalBus: globalSignalBus.getSignalStats(),
    }
  }
}

const globalProactiveEngine = new ProactiveEngine()

module.exports = {
  ProactiveEngine,
  globalProactiveEngine,
  PROACTIVE_RULES,
}
