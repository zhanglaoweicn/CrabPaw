const crypto = require('crypto');
const EventEmitter = require('events')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const REPLAY_TRIGGERS = {
  periodic: 'periodic',
  failure_pattern: 'failure_pattern',
  performance_degradation: 'performance_degradation',
  domain_shift: 'domain_shift',
  manual: 'manual',
}

const REPLAY_SESSION_STATES = {
  IDLE: 'idle',
  ANALYZING: 'analyzing',
  EXTRACTING: 'extracting',
  SYNTHESIZING: 'synthesizing',
  COMPLETED: 'completed',
  FAILED: 'failed',
}

class ExperienceReplayEngine extends EventEmitter {
  constructor(experienceStore) {
    super()
    this._store = experienceStore
    this._replayHistory = []
    this._learnedPatterns = new Map()
    this._failurePatterns = new Map()
    this._successPatterns = new Map()
    this._state = REPLAY_SESSION_STATES.IDLE
    this._maxHistorySize = 100
    this._maxPatterns = 200
    this._running = false
    this._intervalId = null
    /** @type {Array<{id: string, type: string, summary: string, success: boolean, timestamp: number, context?: object}>} */
    this._experiencePool = []
    /** @type {Set<string>} 经验去重 */
    this._experienceIds = new Set()
    /** @type {string[]} SignalBus subscription IDs for cleanup */
    this._subIds = []
  }

  start(intervalMs = 3600000) {
    if (this._running) return
    this._running = true

    // 周期性模式提取
    this._intervalId = setInterval(() => this._periodicReplay(), intervalMs)

    // 监听自愈完成事件 — 将 healing 记录作为经验保存
    const healingSubId = globalSignalBus.subscribe('self_healing_completed', (signal) => {
      this.recordExperience({
        type: 'self_healing',
        summary: signal.detail || '自愈完成',
        success: true,
        context: signal.metrics || {},
        source: 'self_healing_engine',
      })
    })
    this._subIds.push(healingSubId)

    // 监听进化触发事件 — 将进化记录作为经验保存
    const evolSubId = globalSignalBus.subscribe('evolution:triggered', (signal) => {
      this.recordExperience({
        type: 'evolution_triggered',
        summary: signal.detail || '进化触发',
        success: true,
        context: signal.metrics || {},
        source: signal.source || 'evolution_system',
      })
    })
    this._subIds.push(evolSubId)

    console.log('🧠 经验回放引擎已启动 (含 self-healing 和 evolution 事件监听)')
  }

  stop() {
    if (!this._running) return
    this._running = false

    // 清理 SignalBus 订阅
    for (const subId of this._subIds) {
      globalSignalBus.unsubscribe(subId)
    }
    this._subIds = []

    if (this._intervalId) {
      clearInterval(this._intervalId)
      this._intervalId = null
    }
    console.log('🧠 经验回放引擎已停止')
  }

  /**
   * 记录一条经验到经验池
   * 去重：相同 type + summary 在 60 秒内不重复记录
   * @param {object} entry - { type, summary, success, context, source }
   */
  recordExperience(entry) {
    const id = `${entry.type}_${Date.now()}`

    // 简单去重：5 分钟内同 type 的同摘要只记录一次
    const dedupKey = `${entry.type}:${(entry.summary || '').slice(0, 40)}`
    const dedupWindow = 5 * 60 * 1000
    const recentDup = this._experiencePool.find(e =>
      (e._dedupKey === dedupKey) && (Date.now() - e.timestamp < dedupWindow)
    )
    if (recentDup) {
      return // 去重跳过
    }

    const experience = {
      id,
      type: entry.type || 'unknown',
      summary: entry.summary || '',
      success: entry.success !== false,
      timestamp: entry.timestamp || Date.now(),
      source: entry.source || 'unknown',
      context: entry.context || {},
      _dedupKey: dedupKey,
    }

    this._experiencePool.push(experience)
    this._experienceIds.add(id)

    // 同步写入 ExperienceStore（如果存在）
    if (this._store && typeof this._store.addExperience === 'function') {
      try {
        this._store.addExperience({
          id,
          type: experience.type,
          outcome: experience.success ? 'success' : 'failure',
          createdAt: experience.timestamp,
          task: experience.summary,
          toolsUsed: experience.context.actions || [],
          source: experience.source,
        })
      } catch (e) {
        /* store 写入失败不影响内存池 */
        console.warn('[experience-replay.js] 空 catch 补日志:', e && e.message);
      }

    }

    // 限制内存池大小
    if (this._experiencePool.length > 500) {
      this._experiencePool = this._experiencePool.slice(-250)
    }

    console.log(`[ExperienceReplay] 记录经验: ${experience.type} - ${experience.summary.slice(0, 50)}`)
  }

  /**
   * 获取一批需要重放的经验（优先失败的和近期成功的）
   * @param {number} count - 需要的数量
   * @returns {Array} 选中的经验
   */
  getReplayBatch(count = 10) {
    const failures = this._experiencePool.filter(e => !e.success)
    const recentSuccess = this._experiencePool
      .filter(e => e.success)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, Math.floor(count / 2))

    const selectedFailures = failures.slice(0, Math.max(1, count - recentSuccess.length))
    return [...selectedFailures, ...recentSuccess].slice(0, count)
  }

  /**
   * 简单模式提取 — 按 type 聚合成功率
   * @returns {Array<{type: string, total: number, successCount: number, successRate: number, lastTimestamp: number}>}
   */
  extractPatterns() {
    const groups = new Map()

    for (const exp of this._experiencePool) {
      if (!groups.has(exp.type)) {
        groups.set(exp.type, { type: exp.type, total: 0, successCount: 0, lastTimestamp: 0 })
      }
      const g = groups.get(exp.type)
      g.total++
      if (exp.success) g.successCount++
      if (exp.timestamp > g.lastTimestamp) g.lastTimestamp = exp.timestamp
    }

    const patterns = []
    for (const g of groups.values()) {
      patterns.push({
        type: g.type,
        total: g.total,
        successCount: g.successCount,
        successRate: g.total > 0 ? g.successCount / g.total : 0,
        lastTimestamp: g.lastTimestamp,
      })
    }

    return patterns.sort((a, b) => b.total - a.total)
  }

  async replay(trigger = REPLAY_TRIGGERS.manual, options = {}) {
    if (this._state !== REPLAY_SESSION_STATES.IDLE) {
      return { success: false, error: 'replay_already_in_progress' }
    }

    const session = {
      id: `replay_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`,
      trigger,
      startedAt: Date.now(),
      state: REPLAY_SESSION_STATES.ANALYZING,
      experiencesAnalyzed: 0,
      patternsExtracted: 0,
      insightsGenerated: [],
    }

    try {
      this._state = REPLAY_SESSION_STATES.ANALYZING
      let experiences = this._gatherExperiences(options)
      session.experiencesAnalyzed = experiences.length

      // getReplayBatch() 此前无任何调用者（死方法）：接入主循环——store/池子为空时
      // 用批选器兜底（优先失败经验 + 近期成功经验），保证回放闭环真正成立
      if (experiences.length === 0) {
        try {
          const batch = this.getReplayBatch(options.limit || 10)
          if (batch.length > 0) {
            experiences = batch.map(e => ({
              id: e.id,
              type: e.type,
              outcome: e.success ? "success" : "failure",
              task: e.summary,
              toolsUsed: e.context && e.context.actions ? e.context.actions : [],
              source: e.source,
              createdAt: e.timestamp,
            }))
            session.experiencesAnalyzed = experiences.length
          }
        } catch (e) {
          console.warn("[experience-replay.js] getReplayBatch 兜底失败:", e && e.message)
        }
      }

      if (experiences.length === 0) {
        session.state = REPLAY_SESSION_STATES.COMPLETED
        session.insightsGenerated = [{ type: 'no_data', message: '没有足够的经验数据' }]
        this._recordReplay(session)
        this._state = REPLAY_SESSION_STATES.IDLE
        return { success: true, session }
      }

      this._state = REPLAY_SESSION_STATES.EXTRACTING
      const failurePatterns = this._extractFailurePatterns(experiences)
      const successPatterns = this._extractSuccessPatterns(experiences)
      const temporalPatterns = this._extractTemporalPatterns(experiences)
      session.patternsExtracted = failurePatterns.length + successPatterns.length + temporalPatterns.length

      this._state = REPLAY_SESSION_STATES.SYNTHESIZING
      const insights = this._synthesizeInsights(failurePatterns, successPatterns, temporalPatterns)
      session.insightsGenerated = insights

      for (const pattern of failurePatterns) {
        this._failurePatterns.set(pattern.id, pattern)
      }
      for (const pattern of successPatterns) {
        this._successPatterns.set(pattern.id, pattern)
      }
      for (const pattern of [...failurePatterns, ...successPatterns, ...temporalPatterns]) {
        this._learnedPatterns.set(pattern.id, pattern)
        if (this._learnedPatterns.size > this._maxPatterns) {
          const oldest = this._learnedPatterns.keys().next().value
          this._learnedPatterns.delete(oldest)
        }
      }

      session.state = REPLAY_SESSION_STATES.COMPLETED
      this._state = REPLAY_SESSION_STATES.COMPLETED

      if (insights.length > 0) {
        globalSignalBus.emit({
          type: 'experience_replay_completed',
          source: 'experience_replay',
          severity: SIGNAL_SEVERITY.INFO,
          detail: `经验回放完成: 分析 ${session.experiencesAnalyzed} 条经验, 提取 ${session.patternsExtracted} 个模式, 生成 ${insights.length} 条洞察`,
          metrics: {
            sessionId: session.id,
            trigger,
            experiencesAnalyzed: session.experiencesAnalyzed,
            patternsExtracted: session.patternsExtracted,
            insightsCount: insights.length,
          },
        })
      }

      this._recordReplay(session)
      this._state = REPLAY_SESSION_STATES.IDLE
      return { success: true, session }
    } catch (err) {
      session.state = REPLAY_SESSION_STATES.FAILED
      session.error = err.message
      this._state = REPLAY_SESSION_STATES.IDLE
      this._recordReplay(session)
      return { success: false, error: err.message, session }
    }
  }

  _gatherExperiences(options = {}) {
    const all = []
    const limit = options.limit || 200
    const since = options.since || Date.now() - 7 * 86400000
    const seenIds = new Set()

    // 1. 主源：ExperienceStore 持久化经验（P0：此前 _experiences 字段不存在恒空）
    if (this._store && this._store._experiences) {
      for (const exp of this._store._experiences.values()) {
        if (exp.createdAt >= since) {
          all.push(exp)
          seenIds.add(exp.id)
        }
      }
    }

    // 2. 补充源：RAM 经验池（signal 订阅 self_healing/evolution 记入）。
    //    store 有数据时以 store 为主（按 id 去重），无数据时用池子兜底
    for (const exp of this._experiencePool) {
      if (exp.timestamp >= since && !seenIds.has(exp.id)) {
        all.push({
          id: exp.id,
          type: exp.type,
          outcome: exp.success ? "success" : "failure",
          task: exp.summary,
          approach: exp.approach || "",
          toolsUsed: exp.context && exp.context.actions ? exp.context.actions : [],
          source: exp.source,
          createdAt: exp.timestamp,
        })
        seenIds.add(exp.id)
      }
    }

    return all.slice(0, limit)
  }

  _extractFailurePatterns(experiences) {
    const failures = experiences.filter(e => e.outcome === 'failure' || e.outcome === 'error')
    if (failures.length === 0) return []

    const patterns = []
    const toolFailureCounts = new Map()
    const taskFailureCounts = new Map()

    for (const fail of failures) {
      for (const tool of (fail.toolsUsed || [])) {
        toolFailureCounts.set(tool, (toolFailureCounts.get(tool) || 0) + 1)
      }
      const taskKey = this._normalizeTask(fail.task)
      if (taskKey) {
        taskFailureCounts.set(taskKey, (taskFailureCounts.get(taskKey) || 0) + 1)
      }
    }

    for (const [tool, count] of toolFailureCounts) {
      if (count >= 2) {
        patterns.push({
          id: `fail_tool_${tool}_${Date.now()}`,
          type: 'tool_failure_pattern',
          tool,
          count,
          severity: count >= 5 ? 'high' : 'medium',
          recommendation: `工具 ${tool} 频繁失败(${count}次), 建议检查或降级`,
          createdAt: Date.now(),
        })
      }
    }

    for (const [task, count] of taskFailureCounts) {
      if (count >= 2) {
        patterns.push({
          id: `fail_task_${task.slice(0, 20)}_${Date.now()}`,
          type: 'task_failure_pattern',
          task: task,
          count,
          severity: count >= 4 ? 'high' : 'medium',
          recommendation: `任务类型 "${task}" 频繁失败(${count}次), 建议优化策略`,
          createdAt: Date.now(),
        })
      }
    }

    return patterns
  }

  _extractSuccessPatterns(experiences) {
    const successes = experiences.filter(e => e.outcome === 'success')
    if (successes.length === 0) return []

    const patterns = []
    const approachSuccess = new Map()
    const toolSuccessRate = new Map()
    const toolTotal = new Map()

    for (const succ of successes) {
      const approachKey = succ.approach || 'default'
      if (!approachSuccess.has(approachKey)) {
        approachSuccess.set(approachKey, { count: 0, totalTokens: 0, totalDuration: 0 })
      }
      const entry = approachSuccess.get(approachKey)
      entry.count++
      entry.totalTokens += succ.tokenCost || 0
      entry.totalDuration += succ.duration || 0

      for (const tool of (succ.toolsUsed || [])) {
        toolSuccessRate.set(tool, (toolSuccessRate.get(tool) || 0) + 1)
      }
    }

    for (const [tool, count] of toolSuccessRate) {
      toolTotal.set(tool, (toolTotal.get(tool) || 0) + count)
    }

    for (const [approach, data] of approachSuccess) {
      if (data.count >= 3) {
        const avgTokens = Math.round(data.totalTokens / data.count)
        const avgDuration = Math.round(data.totalDuration / data.count)
        patterns.push({
          id: `success_approach_${approach.slice(0, 20)}_${Date.now()}`,
          type: 'success_approach_pattern',
          approach,
          count: data.count,
          avgTokens,
          avgDurationMs: avgDuration,
          efficiency: avgTokens > 0 ? (data.count / avgTokens * 1000).toFixed(2) : 'N/A',
          recommendation: `策略 "${approach}" 成功率高(${data.count}次), 平均耗时 ${avgDuration}ms`,
          createdAt: Date.now(),
        })
      }
    }

    return patterns
  }

  _extractTemporalPatterns(experiences) {
    if (experiences.length < 5) return []

    const patterns = []
    const hourlyBuckets = new Map()

    for (const exp of experiences) {
      const hour = new Date(exp.createdAt).getHours()
      if (!hourlyBuckets.has(hour)) {
        hourlyBuckets.set(hour, { success: 0, failure: 0, total: 0 })
      }
      const bucket = hourlyBuckets.get(hour)
      bucket.total++
      if (exp.outcome === 'success') bucket.success++
      else if (exp.outcome === 'failure' || exp.outcome === 'error') bucket.failure++
    }

    for (const [hour, bucket] of hourlyBuckets) {
      if (bucket.total >= 3) {
        const successRate = bucket.success / bucket.total
        if (successRate < 0.5 && bucket.total >= 3) {
          patterns.push({
            id: `temporal_low_success_${hour}_${Date.now()}`,
            type: 'temporal_pattern',
            hour,
            successRate: successRate.toFixed(2),
            totalTasks: bucket.total,
            severity: 'low',
            recommendation: `${hour}:00 时段成功率较低(${(successRate * 100).toFixed(0)}%), 可能与模型负载有关`,
            createdAt: Date.now(),
          })
        }
      }
    }

    return patterns
  }

  _synthesizeInsights(failurePatterns, successPatterns, temporalPatterns) {
    const insights = []

    for (const p of failurePatterns) {
      insights.push({
        type: 'failure_insight',
        severity: p.severity,
        pattern: p.type,
        message: p.recommendation,
        action: p.type === 'tool_failure_pattern' ? 'degrade_tool' : 'optimize_strategy',
      })
    }

    for (const p of successPatterns) {
      insights.push({
        type: 'success_insight',
        severity: 'info',
        pattern: p.type,
        message: p.recommendation,
        action: 'promote_approach',
      })
    }

    for (const p of temporalPatterns) {
      insights.push({
        type: 'temporal_insight',
        severity: p.severity,
        pattern: p.type,
        message: p.recommendation,
        action: 'adjust_scheduling',
      })
    }

    return insights
  }

  _normalizeTask(task) {
    if (!task || typeof task !== 'string') return null
    return task.toLowerCase().replace(/\d+/g, 'N').slice(0, 80)
  }

  _recordReplay(session) {
    this._replayHistory.push(session)
    if (this._replayHistory.length > this._maxHistorySize) {
      this._replayHistory = this._replayHistory.slice(-this._maxHistorySize / 2)
    }
  }

  async _periodicReplay() {
    if (this._state !== REPLAY_SESSION_STATES.IDLE) return
    await this.replay(REPLAY_TRIGGERS.periodic)
  }

  getLearnedPatterns(type = null) {
    if (type === 'failure') return [...this._failurePatterns.values()]
    if (type === 'success') return [...this._successPatterns.values()]
    return [...this._learnedPatterns.values()]
  }

  getReplayHistory(limit = 20) {
    return this._replayHistory.slice(-limit)
  }

  getStatus() {
    return {
      running: this._running,
      state: this._state,
      totalReplays: this._replayHistory.length,
      learnedPatterns: this._learnedPatterns.size,
      failurePatterns: this._failurePatterns.size,
      successPatterns: this._successPatterns.size,
    }
  }
}

let globalExperienceReplay = null

function initExperienceReplay(experienceStore) {
  globalExperienceReplay = new ExperienceReplayEngine(experienceStore)
  return globalExperienceReplay
}

module.exports = {
  ExperienceReplayEngine,
  initExperienceReplay,
  getGlobalExperienceReplay: () => globalExperienceReplay,
  REPLAY_TRIGGERS,
  REPLAY_SESSION_STATES,
}
