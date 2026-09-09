const crypto = require('crypto');
const EventEmitter = require('events')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const STRATEGY_DOMAINS = {
  model_selection: {
    name: '模型选择策略',
    description: '根据任务类型和成本选择最优模型',
    adjustableParams: ['preferred_model', 'fallback_model', 'cost_threshold'],
  },
  context_management: {
    name: '上下文管理策略',
    description: '控制上下文窗口和压缩行为',
    adjustableParams: ['compression_threshold', 'max_context_tokens', 'summary_ratio'],
  },
  tool_selection: {
    name: '工具选择策略',
    description: '优化工具调用顺序和降级策略',
    adjustableParams: ['tool_priority', 'fallback_chain', 'retry_limit'],
  },
  response_style: {
    name: '响应风格策略',
    description: '调整回复的详细程度和格式',
    adjustableParams: ['verbosity', 'format_preference', 'proactive_suggestions'],
  },
  cost_control: {
    name: '成本控制策略',
    description: '平衡质量与成本',
    adjustableParams: ['daily_budget', 'model_tier', 'cache_priority'],
  },
}

const OPTIMIZATION_ACTIONS = {
  promote: { name: '提升', description: '提升某策略的优先级或权重' },
  demote: { name: '降级', description: '降低某策略的优先级或权重' },
  switch: { name: '切换', description: '切换到替代策略' },
  tune: { name: '微调', description: '微调策略参数' },
  add: { name: '新增', description: '添加新的策略规则' },
  remove: { name: '移除', description: '移除无效的策略规则' },
}

class StrategyOptimizer extends EventEmitter {
  constructor() {
    super()
    this._strategies = new Map()
    this._optimizationHistory = []
    this._performanceMetrics = new Map()
    this._abTests = new Map()
    this._maxHistorySize = 200
    this._running = false

    this._initDefaultStrategies()
  }

  _initDefaultStrategies() {
    this._strategies.set('model_selection', {
      domain: 'model_selection',
      rules: [
        { id: 'rule_simple_tasks', condition: 'token_estimate < 500', action: 'use_fast_model', priority: 1, successRate: 0.85, usageCount: 0 },
        { id: 'rule_complex_tasks', condition: 'token_estimate > 2000 OR requires_reasoning', action: 'use_reasoning_model', priority: 2, successRate: 0.78, usageCount: 0 },
        { id: 'rule_cost_sensitive', condition: 'daily_cost > budget * 0.8', action: 'downgrade_model', priority: 3, successRate: 0.7, usageCount: 0 },
      ],
    })

    this._strategies.set('context_management', {
      domain: 'context_management',
      rules: [
        { id: 'rule_compress_80', condition: 'context_usage > 0.8', action: 'compress_context', priority: 1, successRate: 0.9, usageCount: 0 },
        { id: 'rule_summarize_long', condition: 'message_count > 20', action: 'summarize_history', priority: 2, successRate: 0.82, usageCount: 0 },
        { id: 'rule_trim_middle', condition: 'context_usage > 0.9', action: 'trim_middle_messages', priority: 3, successRate: 0.75, usageCount: 0 },
      ],
    })

    this._strategies.set('tool_selection', {
      domain: 'tool_selection',
      rules: [
        { id: 'rule_file_tasks', condition: 'intent = file_operation', action: 'prioritize_file_tools', priority: 1, successRate: 0.88, usageCount: 0 },
        { id: 'rule_search_tasks', condition: 'intent = information_seeking', action: 'prioritize_search_tools', priority: 2, successRate: 0.85, usageCount: 0 },
        { id: 'rule_fallback', condition: 'tool_error_count >= 2', action: 'use_fallback_tool', priority: 3, successRate: 0.72, usageCount: 0 },
      ],
    })

    this._strategies.set('cost_control', {
      domain: 'cost_control',
      rules: [
        { id: 'rule_budget_warning', condition: 'daily_cost > budget * 0.7', action: 'enable_cache_priority', priority: 1, successRate: 0.8, usageCount: 0 },
        { id: 'rule_budget_critical', condition: 'daily_cost > budget * 0.9', action: 'force_cheapest_model', priority: 2, successRate: 0.65, usageCount: 0 },
      ],
    })
  }

  start() {
    if (this._running) return
    this._running = true
    console.log('⚙️ 策略优化器已启动')
  }

  stop() {
    if (!this._running) return
    this._running = false
    console.log('⚙️ 策略优化器已停止')
  }

  optimizeFromInsights(insights) {
    if (!insights || insights.length === 0) return []

    const optimizations = []

    for (const insight of insights) {
      const optimization = this._deriveOptimization(insight)
      if (optimization) {
        optimizations.push(optimization)
        this._applyOptimization(optimization)
      }
    }

    if (optimizations.length > 0) {
      globalSignalBus.emit({
        type: 'strategy_optimized',
        source: 'strategy_optimizer',
        severity: SIGNAL_SEVERITY.INFO,
        detail: `策略优化: 应用了 ${optimizations.length} 个优化`,
        metrics: { optimizationCount: optimizations.length },
      })
    }

    return optimizations
  }

  _deriveOptimization(insight) {
    switch (insight.type) {
      case 'failure_insight':
        if (insight.action === 'degrade_tool') {
          return {
            id: `opt_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
            domain: 'tool_selection',
            action: OPTIMIZATION_ACTIONS.demote,
            targetRule: `rule_${insight.pattern}`,
            reason: insight.message,
            confidence: insight.severity === 'high' ? 0.9 : 0.6,
            adjustment: { successRateDelta: -0.1 },
            createdAt: Date.now(),
          }
        }
        if (insight.action === 'optimize_strategy') {
          return {
            id: `opt_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
            domain: 'model_selection',
            action: OPTIMIZATION_ACTIONS.tune,
            targetRule: 'rule_complex_tasks',
            reason: insight.message,
            confidence: 0.5,
            adjustment: { priorityDelta: 1 },
            createdAt: Date.now(),
          }
        }
        break

      case 'success_insight':
        if (insight.action === 'promote_approach') {
          return {
            id: `opt_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
            domain: insight.pattern.includes('tool') ? 'tool_selection' : 'model_selection',
            action: OPTIMIZATION_ACTIONS.promote,
            targetRule: insight.pattern,
            reason: insight.message,
            confidence: 0.7,
            adjustment: { successRateDelta: 0.05, priorityDelta: -1 },
            createdAt: Date.now(),
          }
        }
        break

      case 'temporal_insight':
        if (insight.action === 'adjust_scheduling') {
          return {
            id: `opt_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
            domain: 'cost_control',
            action: OPTIMIZATION_ACTIONS.tune,
            targetRule: 'rule_budget_warning',
            reason: insight.message,
            confidence: 0.4,
            adjustment: { thresholdDelta: -0.1 },
            createdAt: Date.now(),
          }
        }
        break
    }

    return null
  }

  _applyOptimization(optimization) {
    const strategy = this._strategies.get(optimization.domain)
    if (!strategy) return

    const rule = strategy.rules.find(r => r.id === optimization.targetRule)
    if (!rule) return

    if (optimization.adjustment.successRateDelta) {
      rule.successRate = Math.max(0, Math.min(1, rule.successRate + optimization.adjustment.successRateDelta))
    }
    if (optimization.adjustment.priorityDelta) {
      rule.priority = Math.max(1, rule.priority + optimization.adjustment.priorityDelta)
    }

    rule.usageCount = (rule.usageCount || 0) + 1

    this._optimizationHistory.push({
      ...optimization,
      appliedAt: Date.now(),
      targetRuleState: { ...rule },
    })

    if (this._optimizationHistory.length > this._maxHistorySize) {
      this._optimizationHistory = this._optimizationHistory.slice(-this._maxHistorySize / 2)
    }
  }

  recordRuleExecution(domain, ruleId, success) {
    const strategy = this._strategies.get(domain)
    if (!strategy) return

    const rule = strategy.rules.find(r => r.id === ruleId)
    if (!rule) return

    rule.usageCount = (rule.usageCount || 0) + 1

    const alpha = 0.1
    const target = success ? 1 : 0
    rule.successRate = rule.successRate * (1 - alpha) + target * alpha

    const metricKey = `${domain}:${ruleId}`
    if (!this._performanceMetrics.has(metricKey)) {
      this._performanceMetrics.set(metricKey, { executions: 0, successes: 0 })
    }
    const metric = this._performanceMetrics.get(metricKey)
    metric.executions++
    if (success) metric.successes++
  }

  // eslint-disable-next-line no-unused-vars -- 函数签名参数 context 未用（不改签名）
  getBestRule(domain, context = {}) {
    const strategy = this._strategies.get(domain)
    if (!strategy) return null

    const sorted = [...strategy.rules].sort((a, b) => {
      const scoreA = a.successRate * 0.7 + (1 / a.priority) * 0.3
      const scoreB = b.successRate * 0.7 + (1 / b.priority) * 0.3
      return scoreB - scoreA
    })

    return sorted[0] || null
  }

  getStrategy(domain) {
    return this._strategies.get(domain) || null
  }

  getAllStrategies() {
    const result = {}
    for (const [domain, strategy] of this._strategies) {
      result[domain] = {
        domain,
        name: STRATEGY_DOMAINS[domain]?.name || domain,
        rulesCount: strategy.rules.length,
        rules: strategy.rules.map(r => ({
          id: r.id,
          condition: r.condition,
          action: r.action,
          priority: r.priority,
          successRate: r.successRate?.toFixed(2),
          usageCount: r.usageCount || 0,
        })),
      }
    }
    return result
  }

  getOptimizationHistory(limit = 20) {
    return this._optimizationHistory.slice(-limit)
  }

  getStatus() {
    let totalRules = 0
    let totalUsage = 0
    for (const strategy of this._strategies.values()) {
      totalRules += strategy.rules.length
      for (const rule of strategy.rules) {
        totalUsage += rule.usageCount || 0
      }
    }

    return {
      running: this._running,
      domainsCount: this._strategies.size,
      totalRules,
      totalUsage,
      totalOptimizations: this._optimizationHistory.length,
      activeABTests: this._abTests.size,
    }
  }
}

const globalStrategyOptimizer = new StrategyOptimizer()

module.exports = {
  StrategyOptimizer,
  globalStrategyOptimizer,
  STRATEGY_DOMAINS,
  OPTIMIZATION_ACTIONS,
}
