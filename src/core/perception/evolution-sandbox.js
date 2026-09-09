const crypto = require('crypto');
const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const { DATA_DIR } = require('../config')
const SANDBOX_STATE_DIR = path.join(DATA_DIR, 'perception')
const SANDBOX_STATE_FILE = path.join(SANDBOX_STATE_DIR, 'evolution-sandbox-state.json')

const EXPERIMENT_STATES = {
  DRAFT: 'draft',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
}

const EXPERIMENT_TYPES = {
  strategy_ab: { name: '策略A/B测试', description: '比较两种策略的效果差异' },
  parameter_tuning: { name: '参数调优', description: '测试不同参数组合的效果' },
  behavior_change: { name: '行为变更', description: '测试新的行为规则' },
  model_comparison: { name: '模型对比', description: '比较不同模型的效果' },
  cost_optimization: { name: '成本优化', description: '测试降本方案对质量的影响' },
}

class EvolutionExperiment {
  constructor(config) {
    this.id = config.id || `exp_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 6)}`
    this.name = config.name || '未命名实验'
    this.type = config.type || EXPERIMENT_TYPES.strategy_ab
    this.description = config.description || ''
    this.hypothesis = config.hypothesis || ''
    this.state = EXPERIMENT_STATES.DRAFT
    this.config = config
    this.controlGroup = { metrics: {}, sampleSize: 0 }
    this.experimentGroup = { metrics: {}, sampleSize: 0 }
    this.results = null
    this.createdAt = Date.now()
    this.startedAt = null
    this.completedAt = null
    this.duration = config.duration || 3600000
    this.minSampleSize = config.minSampleSize || 10
    this.confidenceThreshold = config.confidenceThreshold || 0.95
  }

  start() {
    if (this.state !== EXPERIMENT_STATES.DRAFT) return false
    this.state = EXPERIMENT_STATES.RUNNING
    this.startedAt = Date.now()
    return true
  }

  recordControl(metric, value) {
    if (!this.controlGroup.metrics[metric]) {
      this.controlGroup.metrics[metric] = { values: [], sum: 0, count: 0 }
    }
    const m = this.controlGroup.metrics[metric]
    m.values.push(value)
    m.sum += value
    m.count++
    this.controlGroup.sampleSize++
  }

  recordExperiment(metric, value) {
    if (!this.experimentGroup.metrics[metric]) {
      this.experimentGroup.metrics[metric] = { values: [], sum: 0, count: 0 }
    }
    const m = this.experimentGroup.metrics[metric]
    m.values.push(value)
    m.sum += value
    m.count++
    this.experimentGroup.sampleSize++
  }

  isReadyForAnalysis() {
    return this.experimentGroup.sampleSize >= this.minSampleSize &&
           this.controlGroup.sampleSize >= this.minSampleSize
  }

  isExpired() {
    if (!this.startedAt) return false
    return Date.now() - this.startedAt > this.duration
  }

  analyze() {
    if (!this.isReadyForAnalysis()) {
      return { ready: false, reason: '样本量不足' }
    }

    const comparisons = {}
    for (const metric of Object.keys(this.controlGroup.metrics)) {
      const control = this.controlGroup.metrics[metric]
      const experiment = this.experimentGroup.metrics[metric]
      if (!experiment) continue

      const controlMean = control.sum / control.count
      const experimentMean = experiment.sum / experiment.count
      const controlVariance = control.values.reduce((s, v) => s + Math.pow(v - controlMean, 2), 0) / control.count
      const experimentVariance = experiment.values.reduce((s, v) => s + Math.pow(v - experimentMean, 2), 0) / experiment.count

      const pooledStdErr = Math.sqrt(
        (controlVariance / control.count) + (experimentVariance / experiment.count)
      )

      const zScore = pooledStdErr > 0 ? (experimentMean - controlMean) / pooledStdErr : 0
      const pValue = this._approxPValue(Math.abs(zScore))
      const significant = pValue < (1 - this.confidenceThreshold)
      const improvement = controlMean !== 0 ? ((experimentMean - controlMean) / Math.abs(controlMean) * 100) : 0

      comparisons[metric] = {
        controlMean: controlMean.toFixed(4),
        experimentMean: experimentMean.toFixed(4),
        improvement: improvement.toFixed(2) + '%',
        zScore: zScore.toFixed(4),
        pValue: pValue.toFixed(4),
        significant,
        winner: improvement > 0 ? 'experiment' : improvement < 0 ? 'control' : 'tie',
      }
    }

    this.results = {
      ready: true,
      comparisons,
      overallWinner: this._determineOverallWinner(comparisons),
      analyzedAt: Date.now(),
    }

    return this.results
  }

  _approxPValue(z) {
    if (z > 3) return 0.001
    if (z > 2.5) return 0.01
    if (z > 2) return 0.05
    if (z > 1.5) return 0.13
    if (z > 1) return 0.32
    if (z > 0.5) return 0.62
    return 0.85
  }

  _determineOverallWinner(comparisons) {
    let expWins = 0
    let ctrlWins = 0
    for (const comp of Object.values(comparisons)) {
      if (comp.significant) {
        if (comp.winner === 'experiment') expWins++
        else if (comp.winner === 'control') ctrlWins++
      }
    }
    if (expWins > ctrlWins) return 'experiment'
    if (ctrlWins > expWins) return 'control'
    return 'inconclusive'
  }

  complete() {
    this.state = EXPERIMENT_STATES.COMPLETED
    this.completedAt = Date.now()
  }

  cancel() {
    this.state = EXPERIMENT_STATES.CANCELLED
    this.completedAt = Date.now()
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      description: this.description,
      hypothesis: this.hypothesis,
      state: this.state,
      controlGroup: {
        sampleSize: this.controlGroup.sampleSize,
        metrics: Object.fromEntries(
          Object.entries(this.controlGroup.metrics).map(([k, v]) => [k, { mean: (v.sum / v.count).toFixed(4), count: v.count }])
        ),
      },
      experimentGroup: {
        sampleSize: this.experimentGroup.sampleSize,
        metrics: Object.fromEntries(
          Object.entries(this.experimentGroup.metrics).map(([k, v]) => [k, { mean: (v.sum / v.count).toFixed(4), count: v.count }])
        ),
      },
      results: this.results,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      duration: this.duration,
    }
  }
}

class EvolutionSandbox extends EventEmitter {
  constructor() {
    super()
    this._experiments = new Map()
    this._completedExperiments = []
    this._maxCompletedSize = 50
    this._running = false
    this._checkIntervalId = null
    this._stats = {
      totalCreated: 0,
      totalCompleted: 0,
      totalCancelled: 0,
    }

    // 从持久化存储恢复已完成实验
    this._loadState()
  }

  start() {
    if (this._running) return
    this._running = true
    this._checkIntervalId = setInterval(() => this._checkExperiments(), 60000)
    console.log('🧪 进化实验场已启动')
  }

  stop() {
    if (!this._running) return
    this._running = false
    if (this._checkIntervalId) {
      clearInterval(this._checkIntervalId)
      this._checkIntervalId = null
    }
    console.log('🧪 进化实验场已停止')
  }

  createExperiment(config) {
    const experiment = new EvolutionExperiment(config)
    this._experiments.set(experiment.id, experiment)
    this._stats.totalCreated++

    this.emit('experiment_created', { id: experiment.id, name: experiment.name, type: experiment.type })

    return experiment
  }

  startExperiment(experimentId) {
    const experiment = this._experiments.get(experimentId)
    if (!experiment) return { success: false, error: 'experiment_not_found' }
    if (experiment.state !== EXPERIMENT_STATES.DRAFT) {
      return { success: false, error: 'experiment_not_in_draft' }
    }

    experiment.start()
    this.emit('experiment_started', { id: experiment.id })

    globalSignalBus.emit({
      type: 'evolution_experiment_started',
      source: 'evolution_sandbox',
      severity: SIGNAL_SEVERITY.INFO,
      detail: `进化实验已启动: ${experiment.name}`,
      metrics: { experimentId: experiment.id, type: experiment.type },
    })

    return { success: true, experimentId }
  }

  recordMetric(experimentId, group, metric, value) {
    const experiment = this._experiments.get(experimentId)
    if (!experiment) return { success: false, error: 'experiment_not_found' }
    if (experiment.state !== EXPERIMENT_STATES.RUNNING) {
      return { success: false, error: 'experiment_not_running' }
    }

    if (group === 'control') {
      experiment.recordControl(metric, value)
    } else if (group === 'experiment') {
      experiment.recordExperiment(metric, value)
    } else {
      return { success: false, error: 'invalid_group' }
    }

    return { success: true }
  }

  analyzeExperiment(experimentId) {
    const experiment = this._experiments.get(experimentId)
    if (!experiment) return { success: false, error: 'experiment_not_found' }

    const results = experiment.analyze()
    return { success: true, results }
  }

  completeExperiment(experimentId) {
    const experiment = this._experiments.get(experimentId)
    if (!experiment) return { success: false, error: 'experiment_not_found' }

    const results = experiment.analyze()
    experiment.complete()
    this._stats.totalCompleted++

    this._completedExperiments.push(experiment.toJSON())
    if (this._completedExperiments.length > this._maxCompletedSize) {
      this._completedExperiments = this._completedExperiments.slice(-this._maxCompletedSize / 2)
    }

    this._experiments.delete(experimentId)
    this._saveState()

    this.emit('experiment_completed', { id: experimentId, results })

    globalSignalBus.emit({
      type: 'evolution_experiment_completed',
      source: 'evolution_sandbox',
      severity: SIGNAL_SEVERITY.INFO,
      detail: `进化实验完成: ${experiment.name}, 结果: ${results.overallWinner || 'inconclusive'}`,
      metrics: { experimentId, winner: results.overallWinner },
    })

    return { success: true, results }
  }

  cancelExperiment(experimentId) {
    const experiment = this._experiments.get(experimentId)
    if (!experiment) return { success: false, error: 'experiment_not_found' }

    experiment.cancel()
    this._stats.totalCancelled++
    this._experiments.delete(experimentId)

    return { success: true }
  }

  _checkExperiments() {
    for (const [id, experiment] of this._experiments) {
      if (experiment.state === EXPERIMENT_STATES.RUNNING) {
        if (experiment.isExpired()) {
          const results = experiment.analyze()
          experiment.complete()
          this._stats.totalCompleted++
          this._completedExperiments.push(experiment.toJSON())
          this._experiments.delete(id)

          this.emit('experiment_auto_completed', { id, results })
        }
      }
    }
  }

  getExperiment(experimentId) {
    return this._experiments.get(experimentId) || null
  }

  getActiveExperiments() {
    return [...this._experiments.values()].map(e => e.toJSON())
  }

  getCompletedExperiments(limit = 20) {
    return this._completedExperiments.slice(-limit)
  }

  getStatus() {
    return {
      running: this._running,
      activeExperiments: this._experiments.size,
      completedExperiments: this._completedExperiments.length,
      stats: this._stats,
    }
  }

  // ========== 持久化 ==========

  _loadState() {
    try {
      if (!fs.existsSync(SANDBOX_STATE_FILE)) return
      const data = JSON.parse(fs.readFileSync(SANDBOX_STATE_FILE, 'utf-8'))
      if (data.completedExperiments && Array.isArray(data.completedExperiments)) {
        this._completedExperiments = data.completedExperiments.slice(-this._maxCompletedSize)
      }
      if (data.stats) {
        this._stats = { ...this._stats, ...data.stats }
      }
    } catch (e) {
      console.warn('[evolution-sandbox] load state failed:', e.message);
    }
  }

  _saveState() {
    try {
      if (!fs.existsSync(SANDBOX_STATE_DIR)) {
        fs.mkdirSync(SANDBOX_STATE_DIR, { recursive: true })
      }
      const data = {
        completedExperiments: this._completedExperiments,
        stats: this._stats,
        savedAt: Date.now(),
      }
      fs.writeFileSync(SANDBOX_STATE_FILE, JSON.stringify(data, null, 2), 'utf-8')
    } catch (e) {
      console.warn('[evolution-sandbox] save state failed:', e.message);
    }
  }
}

const globalEvolutionSandbox = new EvolutionSandbox()

module.exports = {
  EvolutionExperiment,
  EvolutionSandbox,
  globalEvolutionSandbox,
  EXPERIMENT_STATES,
  EXPERIMENT_TYPES,
}
