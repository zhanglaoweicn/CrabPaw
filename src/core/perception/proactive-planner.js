const crypto = require('crypto');
const EventEmitter = require('events')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')
const { globalIntentPredictor } = require('./intent-predictor')
const { globalUserBehaviorSensor } = require('./user-behavior-sensor')
// eslint-disable-next-line no-unused-vars
const { globalBusinessContextSensor } = require('./business-context-sensor')

const PROACTIVE_ACTION_TYPES = {
  preload_context: {
    name: '上下文预加载',
    description: '根据预测意图提前加载相关资源',
    priority: 1,
  },
  suggest_action: {
    name: '行动建议',
    description: '向用户建议可能需要的下一步操作',
    priority: 2,
  },
  prepare_resource: {
    name: '资源准备',
    description: '提前准备工具、模板或数据',
    priority: 3,
  },
  notify_insight: {
    name: '洞察通知',
    description: '主动推送有价值的分析或发现',
    priority: 4,
  },
  auto_delegate: {
    name: '自动委派',
    description: '自动将任务分配给合适的子智能体',
    priority: 5,
  },
}

const PROACTIVE_RULES = [
  {
    id: 'long_silence_checkin',
    name: '长时间沉默问候',
    trigger: { silenceMinutes: 120, minInteractions: 3 },
    action: { type: 'suggest_action', template: 'checkin' },
    cooldownMs: 3600000,
    priority: 4,
  },
  {
    id: 'burst_activity_assist',
    name: '高频活动辅助',
    trigger: { burstDetected: true, minBurstCount: 5 },
    action: { type: 'suggest_action', template: 'burst_assist' },
    cooldownMs: 1800000,
    priority: 2,
  },
  {
    id: 'domain_deep_dive',
    name: '领域深潜准备',
    trigger: { domainConfidence: 0.7, consecutiveDomainMessages: 3 },
    action: { type: 'preload_context', template: 'domain_preload' },
    cooldownMs: 600000,
    priority: 1,
  },
  {
    id: 'cost_budget_alert',
    name: '成本预算提醒',
    trigger: { costRatio: 0.8 },
    action: { type: 'notify_insight', template: 'cost_alert' },
    cooldownMs: 3600000,
    priority: 2,
  },
  {
    id: 'repeated_intent_shortcut',
    name: '重复意图快捷',
    trigger: { sameIntentCount: 3, timeWindowMinutes: 30 },
    action: { type: 'suggest_action', template: 'intent_shortcut' },
    cooldownMs: 1800000,
    priority: 2,
  },
]

class ProactivePlanner extends EventEmitter {
  constructor() {
    super()
    this._actionHistory = []
    this._pendingActions = new Map()
    this._lastActionTime = new Map()
    this._ruleState = new Map()
    this._maxHistorySize = 200
    this._running = false
    this._intervalId = null
  }

  start(intervalMs = 60000) {
    if (this._running) return
    this._running = true
    this._intervalId = setInterval(() => this._evaluate(), intervalMs)
    console.log('🎯 主动行动规划器已启动')
  }

  stop() {
    if (!this._running) return
    this._running = false
    if (this._intervalId) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
    console.log('🎯 主动行动规划器已停止')
  }

  evaluateForUser(userId, message, context = {}) {
    const prediction = globalIntentPredictor.predict(userId, message, context)
    const actions = []

    if (prediction.topPrediction && prediction.topPrediction.confidence >= 0.4) {
      const preloadAction = this._createPreloadAction(userId, prediction.topPrediction)
      if (preloadAction) actions.push(preloadAction)

      const suggestAction = this._createSuggestAction(userId, prediction)
      if (suggestAction) actions.push(suggestAction)
    }

    for (const rule of PROACTIVE_RULES) {
      if (this._evaluateRule(rule, userId, context)) {
        const action = this._createRuleAction(rule, userId, context)
        if (action) actions.push(action)
      }
    }

    for (const action of actions) {
      this._recordAction(action)
      this.emit('action', action)

      globalSignalBus.emit({
        type: 'proactive_action',
        source: 'proactive_planner',
        severity: SIGNAL_SEVERITY.INFO,
        detail: `主动行动: ${action.name} (用户: ${userId})`,
        metrics: {
          userId,
          actionType: action.type,
          actionId: action.id,
          confidence: action.confidence,
        },
      })
    }

    return { prediction, actions }
  }

  _evaluate() {
    if (!this._running) return

    const now = Date.now()
    const hour = new Date().getHours()

    for (const rule of PROACTIVE_RULES) {
      if (rule.trigger.timeRange) {
        const [start, end] = rule.trigger.timeRange
        if (hour < start || hour >= end) continue
      }

      const lastTime = this._lastActionTime.get(rule.id) || 0
      if (now - lastTime < rule.cooldownMs) continue

      const userProfiles = globalUserBehaviorSensor.getAllUserProfiles()
      for (const [userId, profile] of userProfiles) {
        if (rule.trigger.minInteractions && profile.totalActivities < rule.trigger.minInteractions) continue

        if (rule.trigger.silenceMinutes) {
          const silenceDuration = now - profile.lastActivity
          if (silenceDuration < rule.trigger.silenceMinutes * 60000) continue
        }

        const action = this._createRuleAction(rule, userId, { hour })
        if (action) {
          this._recordAction(action)
          // 双 key 记录(rule.id 兼容旧查询 + rule.id:userId 供 evaluateForUser 命中)
          this._lastActionTime.set(rule.id, now)
          this._lastActionTime.set(`${rule.id}:${userId}`, now)
          this.emit('action', action)

          globalSignalBus.emit({
            type: 'proactive_action',
            source: 'proactive_planner',
            severity: SIGNAL_SEVERITY.INFO,
            detail: `定时主动行动: ${action.name} (用户: ${userId})`,
            metrics: { userId, actionType: action.type, actionId: action.id },
          })
        }
        break
      }
    }
  }

  _evaluateRule(rule, userId, _context) {
    const now = Date.now()

    // 2026-08-08 (冒烟修复): 此前 evaluateForUser(用户发消息)路径不检查 timeRange——
    // 晨间简报(7-9点)规则在任意时段发消息都会通过,导致对话框随机出现"早间播报"。
    // 与定时器 _evaluate() 保持一致的时间窗口校验。
    if (rule.trigger.timeRange) {
      const [start, end] = rule.trigger.timeRange
      const hour = new Date().getHours()
      if (hour < start || hour >= end) return false
    }

    // cooldown 查询兼容两种记录 key(_evaluate 记 rule.id,_evaluateRule 记 rule.id:userId)
    const lastTime = this._lastActionTime.get(`${rule.id}:${userId}`) || this._lastActionTime.get(rule.id) || 0
    if (now - lastTime < rule.cooldownMs) return false

    return true
  }

  _createPreloadAction(userId, prediction) {
    if (!prediction.preloadHints || prediction.preloadHints.length === 0) return null

    return {
      id: `preload_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      type: PROACTIVE_ACTION_TYPES.preload_context.name,
      name: `预加载: ${prediction.name}`,
      userId,
      intent: prediction.intent,
      confidence: prediction.confidence,
      resources: prediction.preloadHints,
      createdAt: Date.now(),
      status: 'pending',
    }
  }

  _createSuggestAction(userId, prediction) {
    if (!prediction.topPrediction) return null

    const suggestions = []
    if (prediction.predictions.length > 1) {
      for (let i = 1; i < Math.min(3, prediction.predictions.length); i++) {
        const p = prediction.predictions[i]
        suggestions.push({
          intent: p.intent,
          name: p.name,
          confidence: p.confidence,
        })
      }
    }

    if (suggestions.length === 0) return null

    return {
      id: `suggest_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      type: PROACTIVE_ACTION_TYPES.suggest_action.name,
      name: `建议下一步: ${suggestions.map(s => s.name).join(', ')}`,
      userId,
      suggestions,
      createdAt: Date.now(),
      status: 'pending',
    }
  }

  _createRuleAction(rule, userId, context) {
    return {
      id: `${rule.id}_${Date.now()}`,
      type: PROACTIVE_ACTION_TYPES[rule.action.type]?.name || rule.action.type,
      name: rule.name,
      userId,
      template: rule.action.template,
      ruleId: rule.id,
      context,
      createdAt: Date.now(),
      status: 'pending',
      confidence: 0.6,
    }
  }

  _recordAction(action) {
    this._actionHistory.push(action)
    if (this._actionHistory.length > this._maxHistorySize) {
      this._actionHistory = this._actionHistory.slice(-this._maxHistorySize / 2)
    }
  }

  markActionExecuted(actionId, result = {}) {
    const action = this._actionHistory.find(a => a.id === actionId)
    if (action) {
      action.status = 'executed'
      action.executedAt = Date.now()
      action.result = result
    }
  }

  markActionDismissed(actionId) {
    const action = this._actionHistory.find(a => a.id === actionId)
    if (action) {
      action.status = 'dismissed'
      action.dismissedAt = Date.now()
    }
  }

  getPendingActions(userId = null) {
    const pending = this._actionHistory.filter(a => a.status === 'pending')
    if (userId) return pending.filter(a => a.userId === userId)
    return pending
  }

  getActionHistory(limit = 50) {
    return this._actionHistory.slice(-limit)
  }

  getRules() {
    return PROACTIVE_RULES.map(r => ({
      id: r.id,
      name: r.name,
      actionType: r.action.type,
      template: r.action.template,
      cooldownMs: r.cooldownMs,
      priority: r.priority,
    }))
  }

  getStatus() {
    const pending = this._actionHistory.filter(a => a.status === 'pending').length
    const executed = this._actionHistory.filter(a => a.status === 'executed').length
    const dismissed = this._actionHistory.filter(a => a.status === 'dismissed').length

    return {
      running: this._running,
      totalActions: this._actionHistory.length,
      pending,
      executed,
      dismissed,
      rulesCount: PROACTIVE_RULES.length,
    }
  }
}

const globalProactivePlanner = new ProactivePlanner()

module.exports = {
  ProactivePlanner,
  globalProactivePlanner,
  PROACTIVE_ACTION_TYPES,
  PROACTIVE_RULES,
}
