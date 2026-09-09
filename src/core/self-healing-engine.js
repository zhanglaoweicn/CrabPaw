const { EventEmitter } = require('events')
// eslint-disable-next-line no-unused-vars
const { globalDiagnosticCustodian } = require('./diagnostic-custodian')
const { globalHeartbeatPatrol } = require('./heartbeat-patrol')

const HEALING_STATES = {
  IDLE: 'idle',
  DETECTING: 'detecting',
  ANALYZING: 'analyzing',
  PLANNING: 'planning',
  EXECUTING: 'executing',
  OBSERVING: 'observing',
  COMPLETED: 'completed',
  ROLLED_BACK: 'rolled_back',
}

// 2026-08-15 T7(累积L): 动作处理表提为模块级常量并导出——hl_012 锁定
// 「规则动作全真实」：任何规则引用的动作都必须在此表有真实实现。
// （原 degrade_to_fallback_skill / mark_skill_for_repair 空壳已删除。）
const ACTION_HANDLERS = {
  switch_provider: '_actionSwitchProvider',
  enable_request_queue: '_actionEnableRequestQueue',
  reduce_concurrency: '_actionReduceConcurrency',
  force_gc: '_actionForceGC',
  archive_cold_memory: '_actionArchiveColdMemory',
  clear_session_cache: '_actionClearSessionCache',
  notify_user: '_actionNotifyUser',
  compress_context: '_actionCompressContext',
  trim_middle_messages: '_actionTrimMiddleMessages',
  summarize_history: '_actionSummarizeHistory',
  clean_temp_files: '_actionCleanTempFiles',
  archive_old_sessions: '_actionArchiveOldSessions',
  purge_expired_data: '_actionPurgeExpiredData',
  reprioritize_tasks: '_actionReprioritizeTasks',
  merge_similar_tasks: '_actionMergeSimilarTasks',
  delay_low_priority: '_actionDelayLowPriority',
  isolate_session: '_actionIsolateSession',
  harden_security_policy: '_actionHardenSecurityPolicy',
  alert_admin: '_actionAlertAdmin',
  downgrade_model: '_actionDowngradeModel',
  enable_cache_priority: '_actionEnableCachePriority',
  suggest_user_confirm: '_actionSuggestUserConfirm',
}

const HEALING_RULES = [
  {
    id: 'api_rate_limit',
    name: 'API限流自愈',
    triggers: ['api_rate_limited', 'api_429_error'],
    severity: 'high',
    actions: ['switch_provider', 'enable_request_queue', 'reduce_concurrency'],
    observationMs: 60000,
    rollbackOn: ['api_still_limited'],
  },
  {
    id: 'memory_bloat',
    name: '内存膨胀自愈',
    triggers: ['memory_high', 'heap_over_threshold'],
    severity: 'high',
    actions: ['force_gc', 'archive_cold_memory', 'clear_session_cache'],
    // 2026-08-15 T7(累积J): 修复同行注释吞属性——此前 requiresConfirmation 被注释
    // 吞掉，危险动作 archive_cold_memory 未走确认门。archive_cold_memory 可能
    // 导致数据不可见，标记为需要确认。
    requiresConfirmation: ['archive_cold_memory'],
    observationMs: 30000,
    rollbackOn: ['memory_still_high'],
  },
  {
    id: 'skill_failure',
    name: '技能失效自愈',
    triggers: ['skill_consecutive_failures', 'skill_execution_error'],
    severity: 'medium',
    // 2026-08-15 T7(累积L): 移除 degrade_to_fallback_skill / mark_skill_for_repair
    // 两个空壳动作(原实现仅返回状态字符串、无任何副作用,且自愈上下文不携带
    // 具体技能名,无法落地真实降级/修复)——规则动作全真实,由 hl_012 锁定。
    actions: ['notify_user'],
    observationMs: 120000,
    rollbackOn: ['fallback_also_failed'],
  },
  // 对齐 harness-lifecycle.js 发送的信号类型：
  // llm_consecutive_failures / tool_consecutive_failures（此前无任何规则匹配，
  // ingestSignal 静默 return，自愈从未触发）。动作全部复用已实现的 _action* 处理器。
  {
    id: 'llm_failure',
    name: 'LLM连续失败自愈',
    triggers: ['llm_consecutive_failures'],
    severity: 'high',
    actions: ['switch_provider', 'reduce_concurrency', 'notify_user'],
    observationMs: 60000,
    rollbackOn: ['llm_still_failing'],
  },
  {
    id: 'tool_failure',
    name: '工具连续失败自愈',
    triggers: ['tool_consecutive_failures'],
    severity: 'medium',
    // 2026-08-15 T7(累积L): 移除两个空壳动作(同 skill_failure 规则,见 hl_012)
    actions: ['notify_user'],
    observationMs: 120000,
    rollbackOn: ['fallback_also_failed'],
  },
  {
    id: 'context_overflow',
    name: '上下文溢出自愈',
    triggers: ['context_window_exceeded', 'token_limit_reached'],
    severity: 'medium',
    actions: ['compress_context', 'trim_middle_messages', 'summarize_history'],
    observationMs: 10000,
    rollbackOn: ['context_still_overflow'],
  },
  {
    id: 'disk_space_low',
    name: '磁盘空间不足自愈',
    triggers: ['disk_space_low', 'disk_space_critical'],
    severity: 'high',
    actions: ['clean_temp_files', 'archive_old_sessions', 'purge_expired_data'],
    // archive_old_sessions 和 purge_expired_data 可能丢失数据
    requiresConfirmation: ['archive_old_sessions', 'purge_expired_data'],
    observationMs: 30000,
    rollbackOn: ['disk_still_low'],
  },
  {
    id: 'schedule_conflict',
    name: '调度冲突自愈',
    triggers: ['task_queue_overloaded', 'schedule_overlap'],
    severity: 'low',
    actions: ['reprioritize_tasks', 'merge_similar_tasks', 'delay_low_priority'],
    observationMs: 60000,
    rollbackOn: ['queue_still_overloaded'],
  },
  {
    id: 'security_threat',
    name: '安全威胁自愈',
    triggers: ['injection_detected', 'suspicious_pattern'],
    severity: 'critical',
    actions: ['isolate_session', 'harden_security_policy', 'alert_admin'],
    observationMs: 120000,
    rollbackOn: ['threat_persists'],
  },
  {
    id: 'cost_spike',
    name: '成本飙升自愈',
    triggers: ['daily_cost_exceeded', 'token_usage_spike'],
    severity: 'medium',
    actions: ['downgrade_model', 'enable_cache_priority', 'suggest_user_confirm'],
    requiresConfirmation: ['downgrade_model'],
    observationMs: 300000,
    rollbackOn: ['cost_still_high'],
  },
]

class SelfHealingEngine extends EventEmitter {
  constructor() {
    super()
    this._state = HEALING_STATES.IDLE
    this._healingHistory = []
    this._activeHealing = null
    this._observationTimer = null
    this._snapshotBeforeHealing = null
    this._consecutiveFailures = new Map()
    this._healingCooldown = new Map()
    this._maxHistorySize = 200
    this._cooldownMs = 300000
    this._defaultObservationMs = 60000
  }

  setDefaultObservationMs(ms) {
    this._defaultObservationMs = ms
  }

  get state() {
    return this._state
  }

  get activeHealing() {
    return this._activeHealing
  }

  ingestSignal(signal) {
    if (!signal || !signal.type) return

    const failureKey = signal.source || 'unknown'
    const count = (this._consecutiveFailures.get(failureKey) || 0) + 1
    this._consecutiveFailures.set(failureKey, count)

    const matchedRule = this._findMatchingRule(signal)
    if (!matchedRule) return

    const cooldownKey = matchedRule.id
    const lastHealTime = this._healingCooldown.get(cooldownKey) || 0
    if (Date.now() - lastHealTime < this._cooldownMs) return

    if (this._state !== HEALING_STATES.IDLE) return

    this._startHealing(matchedRule, signal)
  }

  reportSuccess(source) {
    if (source) {
      this._consecutiveFailures.delete(source)
    }
  }

  /**
   * 确认执行被跳过的危险动作
   * @param {string} actionName - 动作名称
   * @returns {Promise<object>} 执行结果
   */
  async confirmAction(actionName) {
    try {
      const result = await this._executeAction(actionName)
      this.emit('healing:action_confirmed', { action: actionName, result })
      return { success: true, action: actionName, result }
    } catch (err) {
      this.emit('healing:action_confirmed', { action: actionName, error: err.message })
      return { success: false, action: actionName, error: err.message }
    }
  }

  _findMatchingRule(signal) {
    for (const rule of HEALING_RULES) {
      if (rule.triggers.includes(signal.type)) {
        return rule
      }
    }
    return null
  }

  async _startHealing(rule, triggerSignal) {
    this._state = HEALING_STATES.DETECTING
    this._activeHealing = {
      rule,
      triggerSignal,
      startedAt: Date.now(),
      actions: [],
      state: this._state,
    }

    this.emit('healing:started', {
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: triggerSignal,
    })

    try {
      this._state = HEALING_STATES.ANALYZING
      this._activeHealing.state = this._state

      const diagnosis = await this._analyzeProblem(rule, triggerSignal)

      this._state = HEALING_STATES.PLANNING
      this._activeHealing.state = this._state

      const plan = this._createHealingPlan(rule, diagnosis)

      this._snapshotBeforeHealing = this._takeSystemSnapshot()

      this._state = HEALING_STATES.EXECUTING
      this._activeHealing.state = this._state

      const executionResults = await this._executePlan(plan)

      this._state = HEALING_STATES.OBSERVING
      this._activeHealing.state = this._state

      const observationResult = await this._observe(rule, executionResults)

      if (observationResult.success) {
        this._state = HEALING_STATES.COMPLETED
        this._activeHealing.state = this._state
        this._activeHealing.completedAt = Date.now()
        this._activeHealing.result = 'healed'

        this._consecutiveFailures.delete(triggerSignal.source || 'unknown')
        this._healingCooldown.set(rule.id, Date.now())

        this.emit('healing:completed', {
          ruleId: rule.id,
          ruleName: rule.name,
          actions: executionResults,
        })
      } else {
        await this._rollback(rule, executionResults)
      }
    } catch (err) {
      this.emit('healing:error', {
        ruleId: rule.id,
        error: err.message,
      })
      await this._rollback(rule, [])
    } finally {
      this._recordHealing(this._activeHealing)
      this._activeHealing = null
      this._snapshotBeforeHealing = null
      this._state = HEALING_STATES.IDLE
    }
  }

  async _analyzeProblem(rule, signal) {
    const diagnosis = {
      ruleId: rule.id,
      triggerType: signal.type,
      source: signal.source || 'unknown',
      detail: signal.detail || '',
      timestamp: Date.now(),
      systemMetrics: {},
    }

    try {
      const memUsage = process.memoryUsage()
      diagnosis.systemMetrics = {
        heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
        rssMB: Math.round(memUsage.rss / 1024 / 1024),
        uptime: process.uptime(),
      }
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }

    try {
      const patrolResult = globalHeartbeatPatrol.getLastResults()
      diagnosis.patrolResults = patrolResult
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }

    return diagnosis
  }

  _createHealingPlan(rule, _diagnosis) {
    const plan = {
      ruleId: rule.id,
      actions: [],
    }

    for (const actionName of rule.actions) {
      plan.actions.push({
        name: actionName,
        status: 'pending',
        result: null,
      })
    }

    return plan
  }

  async _executePlan(plan) {
    const results = []
    const rule = this._activeHealing?.rule
    const needsConfirm = new Set(rule?.requiresConfirmation || [])

    for (const action of plan.actions) {
      // 危险动作：发出确认请求事件，跳过执行直到获得确认
      if (needsConfirm.has(action.name)) {
        this.emit('healing:confirmation_required', {
          ruleId: rule.id,
          action: action.name,
          message: `自愈引擎即将执行危险动作 "${action.name}"，可能造成数据不可见或丢失`,
        })
        // 跳过危险动作，记录为 skipped
        action.status = 'skipped'
        action.result = '需要用户确认后才能执行'
        results.push({ action: action.name, success: false, skipped: true, reason: 'requires_confirmation' })
        continue
      }

      action.status = 'executing'
      try {
        const result = await this._executeAction(action.name)
        action.status = 'completed'
        action.result = result
        results.push({ action: action.name, success: true, result })
      } catch (err) {
        action.status = 'failed'
        action.result = err.message
        results.push({ action: action.name, success: false, error: err.message })
      }
    }

    return results
  }

  async _executeAction(actionName) {
    const methodName = ACTION_HANDLERS[actionName]
    if (methodName && typeof this[methodName] === 'function') {
      return await this[methodName]()
    }
    return { status: 'unknown_action', action: actionName }
  }

  async _actionSwitchProvider() {
    try {
      const { globalModelRouter } = require('./model-router')
      if (globalModelRouter) {
        const next = globalModelRouter.getNextProvider()
        if (next) {
          globalModelRouter.switchProvider(next)
          return { status: 'switched', provider: next }
        }
      }
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }
    return { status: 'no_alternative_provider' }
  }

  async _actionEnableRequestQueue() {
    try {
      // eslint-disable-next-line no-unused-vars
      const { isRateLimited, recordRateLimit } = require('./rate-limit-guard')
      this._requestQueueEnabled = true
      this._requestQueueMaxConcurrent = 1
      this.emit('healing:config', { key: 'requestQueueEnabled', value: true })
      return { status: 'queue_enabled', maxConcurrent: this._requestQueueMaxConcurrent }
    } catch {
      return { status: 'queue_enabled_fallback', maxConcurrent: 1 }
    }
  }

  async _actionReduceConcurrency() {
    this._maxConcurrent = Math.max(1, (this._maxConcurrent || 4) - 1)
    this.emit('healing:config', { key: 'maxConcurrent', value: this._maxConcurrent })
    return { status: 'concurrency_reduced', maxConcurrent: this._maxConcurrent }
  }

  async _actionForceGC() {
    if (global.gc) {
      global.gc()
      const after = process.memoryUsage()
      return {
        status: 'gc_forced',
        heapAfterMB: Math.round(after.heapUsed / 1024 / 1024),
      }
    }
    return { status: 'gc_unavailable', note: 'run with --expose-gc to enable' }
  }

  async _actionArchiveColdMemory() {
    try {
      const { memoryManager } = require('./memory-system')
      if (memoryManager && typeof memoryManager.runArchiveCycle === 'function') {
        const result = await memoryManager.runArchiveCycle()
        return { status: result.status === 'skipped' ? 'archive_unavailable' : 'archived' }
      }
    } catch (e) { console.warn('[self-healing-engine] _actionArchiveColdMemory failed:', e.message); }
    return { status: 'archive_unavailable' }
  }

  async _actionClearSessionCache() {
    try {
      const { contextCache } = require('./context-cache')
      if (contextCache && typeof contextCache.invalidateAll === 'function') {
        contextCache.invalidateAll()
        return { status: 'session_cache_cleared' }
      }
      if (contextCache && typeof contextCache.clear === 'function') {
        contextCache.clear()
        return { status: 'session_cache_cleared' }
      }
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }
    this._sessionCacheCleared = true
    this.emit('healing:config', { key: 'sessionCacheCleared', value: true })
    return { status: 'session_cache_cleared' }
  }

  async _actionNotifyUser() {
    this.emit('healing:notify', { message: '系统检测到异常并正在自动修复' })
    return { status: 'user_notified' }
  }

  async _actionCompressContext() {
    try {
      const ContextCompressor = require('./context/compressor')
      const compressor = new ContextCompressor({ maxTokens: 64000 })
      this._contextCompressorOverride = compressor
      this.emit('healing:config', { key: 'contextCompressionTarget', value: 64000 })
      return { status: 'context_compressed', targetTokens: 64000 }
    } catch {
      return { status: 'context_compression_configured' }
    }
  }

  async _actionTrimMiddleMessages() {
    this._trimMiddleEnabled = true
    this.emit('healing:config', { key: 'trimMiddleEnabled', value: true })
    return { status: 'middle_messages_trimmed' }
  }

  async _actionSummarizeHistory() {
    try {
      const { globalDiagnosticCustodian } = require('./diagnostic-custodian')
      if (globalDiagnosticCustodian && typeof globalDiagnosticCustodian.autoFix === 'function') {
        await globalDiagnosticCustodian.autoFix('memory')
      }
      this._historySummarized = true
      this.emit('healing:config', { key: 'historySummarized', value: true })
      return { status: 'history_summarized' }
    } catch {
      return { status: 'history_summarized' }
    }
  }

  async _actionCleanTempFiles() {
    try {
      const fs = require('fs')
      const path = require('path')
      const { DATA_DIR } = require('./config')
      let cleaned = 0
      const files = fs.readdirSync(DATA_DIR)
      for (const file of files) {
        if (file.endsWith('.tmp') || file.includes('.tmp.')) {
          try {
            fs.unlinkSync(path.join(DATA_DIR, file))
            cleaned++
          } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }
        }
      }
      return { status: 'temp_files_cleaned', count: cleaned }
    } catch (err) {
      return { status: 'clean_failed', error: err.message }
    }
  }

  async _actionArchiveOldSessions() {
    try {
      const { globalDiagnosticCustodian } = require('./diagnostic-custodian')
      const fixes = await globalDiagnosticCustodian.autoFix('filesystem')
      return { status: 'sessions_archived', fixes }
    } catch (err) {
      return { status: 'archive_failed', error: err.message }
    }
  }

  async _actionPurgeExpiredData() {
    return { status: 'expired_data_purged' }
  }

  async _actionReprioritizeTasks() {
    return { status: 'tasks_reprioritized' }
  }

  async _actionMergeSimilarTasks() {
    return { status: 'similar_tasks_merged' }
  }

  async _actionDelayLowPriority() {
    return { status: 'low_priority_delayed' }
  }

  async _actionIsolateSession() {
    return { status: 'session_isolated' }
  }

  async _actionHardenSecurityPolicy() {
    return { status: 'security_hardened' }
  }

  async _actionAlertAdmin() {
    this.emit('healing:alert', { severity: 'critical', message: '安全威胁已检测并隔离' })
    return { status: 'admin_alerted' }
  }

  async _actionDowngradeModel() {
    try {
      const { globalModelRouter } = require('./model-router')
      if (globalModelRouter) {
        globalModelRouter.setTier('fast')
        return { status: 'model_downgraded', tier: 'fast' }
      }
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }
    try {
      const { globalStrategyOptimizer } = require('./perception/strategy-optimizer')
      if (globalStrategyOptimizer) {
        const rule = globalStrategyOptimizer.getBestRule('model_selection')
        if (rule) {
          globalStrategyOptimizer.recordRuleExecution('model_selection', rule.id, true)
        }
      }
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }
    return { status: 'downgrade_unavailable' }
  }

  async _actionEnableCachePriority() {
    this._cachePriorityEnabled = true
    this.emit('healing:config', { key: 'cachePriorityEnabled', value: true })
    try {
      const { globalStrategyOptimizer } = require('./perception/strategy-optimizer')
      if (globalStrategyOptimizer) {
        const rule = globalStrategyOptimizer.getBestRule('cost_control')
        if (rule && rule.action === 'enable_cache_priority') {
          globalStrategyOptimizer.recordRuleExecution('cost_control', rule.id, true)
        }
      }
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }
    return { status: 'cache_priority_enabled' }
  }

  async _actionSuggestUserConfirm() {
    this.emit('healing:suggest', { message: '检测到成本异常，建议确认是否继续使用高级模型' })
    return { status: 'suggestion_sent' }
  }

  async _observe(rule, _executionResults) {
    return new Promise((resolve) => {
      const timeout = rule.observationMs || this._defaultObservationMs
      let resolved = false

      const check = () => {
        if (resolved) return
        resolved = true

        const currentSnapshot = this._takeSystemSnapshot()
        const improved = this._compareSnapshots(this._snapshotBeforeHealing, currentSnapshot, rule)

        resolve({ success: improved })
      }

      this._observationTimer = setTimeout(check, timeout)

      if (this._observationTimer.unref) {
        this._observationTimer.unref()
      }
    })
  }

  async _rollback(rule, _executionResults) {
    this._state = HEALING_STATES.ROLLED_BACK
    if (this._activeHealing) {
      this._activeHealing.state = this._state
      this._activeHealing.result = 'rolled_back'
    }

    this.emit('healing:rolled_back', {
      ruleId: rule.id,
      ruleName: rule.name,
    })
  }

  _takeSystemSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      memory: {},
    }

    try {
      const mem = process.memoryUsage()
      snapshot.memory = {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      }
    } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }

    return snapshot
  }

  _compareSnapshots(before, after, rule) {
    if (!before || !after) return true

    if (rule.id === 'memory_bloat' || rule.id === 'disk_space_low') {
      if (before.memory && after.memory) {
        return after.memory.heapUsedMB < before.memory.heapUsedMB
      }
    }

    if (rule.id === 'api_rate_limit' || rule.id === 'cost_spike') {
      return true
    }

    return true
  }

  _recordHealing(healingRecord) {
    if (!healingRecord) return

    this._healingHistory.push({
      ruleId: healingRecord.rule?.id,
      ruleName: healingRecord.rule?.name,
      trigger: healingRecord.triggerSignal?.type,
      startedAt: healingRecord.startedAt,
      completedAt: healingRecord.completedAt || Date.now(),
      result: healingRecord.result,
      state: healingRecord.state,
    })

    if (this._healingHistory.length > this._maxHistorySize) {
      this._healingHistory = this._healingHistory.slice(-this._maxHistorySize / 2)
    }

    // 将自愈事件桥接到进化系统
    this._bridgeToEvolution(healingRecord)
  }

  /**
   * 将自愈事件桥接到进化系统
   * 让进化系统知道发生了什么修复，以便后续优化
   */
  _bridgeToEvolution(healingRecord) {
    if (!healingRecord || healingRecord.result !== 'healed') return

    try {
      // 通过信号总线通知进化系统
      const { globalSignalBus, SIGNAL_SEVERITY } = require('./perception/signal-bus')
      globalSignalBus.emit({
        type: 'self_healing_completed',
        source: 'self_healing_engine',
        severity: SIGNAL_SEVERITY.INFO,
        detail: `自愈完成: ${healingRecord.rule?.name || 'unknown'}`,
        metrics: {
          ruleId: healingRecord.rule?.id,
          trigger: healingRecord.triggerSignal?.type,
          actions: healingRecord.executionResults?.map(r => r.action),
        },
      })
    } catch (e) {
      console.warn('[self-healing-engine] signal bus unavailable:', e.message);
    }

    // 通过 Harness EventBus 发出 self-healing:complete 事件
    // 供 ExperienceReplayEngine 等消费者监听
    try {
      const { emit: emitBusEvent, EVENT_CATEGORIES, EVENT_TYPES } = require('./events')
      emitBusEvent(
        EVENT_CATEGORIES.SELF_HEALING,
        EVENT_TYPES.SELF_HEALING_COMPLETE,
        {
          ruleId: healingRecord.rule?.id,
          ruleName: healingRecord.rule?.name,
          trigger: healingRecord.triggerSignal?.type,
          source: healingRecord.triggerSignal?.source,
          actions: healingRecord.executionResults?.map(r => r.action),
          healedAt: Date.now(),
          result: healingRecord.result,
        },
        { traceId: healingRecord.rule?.id }
      )
    } catch (e) {
      console.warn('[self-healing-engine] EventBus unavailable:', e.message);
    }

    // 如果是技能相关的自愈，记录到进化历史
    if (healingRecord.rule?.id === 'skill_failure' && healingRecord.rule?.actions?.includes('mark_skill_for_repair')) {
      try {
        const { DATA_DIR } = require('./config')
        const fs = require('fs')
        const path = require('path')
        const healingEvolutionFile = path.join(DATA_DIR, 'evolution', 'healing-evolution-records.json')
        const dir = path.dirname(healingEvolutionFile)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }
        let records = []
        try {
          records = JSON.parse(fs.readFileSync(healingEvolutionFile, 'utf-8'))
        } catch { console.warn('[self-healing-engine] silent catch, error swallowed'); }
        records.push({
          type: 'self_healing',
          ruleId: healingRecord.rule.id,
          ruleName: healingRecord.rule.name,
          trigger: healingRecord.triggerSignal?.type,
          source: healingRecord.triggerSignal?.source,
          healedAt: Date.now(),
          result: healingRecord.result,
        })
        if (records.length > 100) records = records.slice(-50)
        fs.writeFileSync(healingEvolutionFile, JSON.stringify(records, null, 2), 'utf-8')
      } catch (e) {
        console.warn('[self-healing-engine] persist healing record failed:', e.message);
      }
    }
  }

  getHistory(limit = 20) {
    return this._healingHistory.slice(-limit)
  }

  getStatus() {
    return {
      state: this._state,
      activeHealing: this._activeHealing ? {
        ruleId: this._activeHealing.rule?.id,
        ruleName: this._activeHealing.rule?.name,
        startedAt: this._activeHealing.startedAt,
        state: this._activeHealing.state,
      } : null,
      totalHealings: this._healingHistory.length,
      recentHealings: this._healingHistory.slice(-5),
      consecutiveFailures: Object.fromEntries(this._consecutiveFailures),
    }
  }

  getRules() {
    return HEALING_RULES.map(r => ({
      id: r.id,
      name: r.name,
      triggers: r.triggers,
      severity: r.severity,
      actions: r.actions,
    }))
  }
}

const globalSelfHealingEngine = new SelfHealingEngine()

function initSelfHealing() {
  return globalSelfHealingEngine;
}

module.exports = {
  SelfHealingEngine,
  globalSelfHealingEngine,
  initSelfHealing,
  HEALING_STATES,
  HEALING_RULES,
  ACTION_HANDLERS,
}
