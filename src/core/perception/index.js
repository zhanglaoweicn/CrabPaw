const { SignalBus, globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')
const { SystemHealthSensor, globalSystemHealthSensor } = require('./system-health-sensor')
const { UserBehaviorSensor, globalUserBehaviorSensor } = require('./user-behavior-sensor')
const { BusinessContextSensor, globalBusinessContextSensor, DOMAIN_KEYWORDS } = require('./business-context-sensor')
const { CostSensor, globalCostSensor, MODEL_COST_PER_1K } = require('./cost-sensor')
const { ProactiveEngine, globalProactiveEngine, PROACTIVE_RULES } = require('./proactive-engine')
const { IntentPredictor, globalIntentPredictor, INTENT_CATEGORIES } = require('./intent-predictor')
const { ProactivePlanner, globalProactivePlanner, PROACTIVE_ACTION_TYPES } = require('./proactive-planner')
const { ContextPreloader, globalContextPreloader, PRELOAD_REGISTRY, DOMAIN_PRELOAD_MAP } = require('./context-preloader')
const { ExperienceReplayEngine, initExperienceReplay, getGlobalExperienceReplay, REPLAY_TRIGGERS } = require('./experience-replay')
const { StrategyOptimizer, globalStrategyOptimizer, STRATEGY_DOMAINS, OPTIMIZATION_ACTIONS } = require('./strategy-optimizer')
const { AdaptiveTuner, globalAdaptiveTuner, TUNABLE_PARAMS } = require('./adaptive-tuner')
const { KnowledgeGraphEvolver, initKnowledgeGraphEvolver, getGlobalKnowledgeGraphEvolver, EVOLUTION_TYPES } = require('./knowledge-graph-evolver')
const { EvolutionExperiment, EvolutionSandbox, globalEvolutionSandbox, EXPERIMENT_STATES, EXPERIMENT_TYPES } = require('./evolution-sandbox')

function startPerceptionLayer(options = {}) {
  globalSystemHealthSensor.start(options.healthIntervalMs)
  globalUserBehaviorSensor.start(options.behaviorIntervalMs)
  globalBusinessContextSensor.start(options.contextIntervalMs)
  globalCostSensor.start(options.costIntervalMs)
  globalProactiveEngine.start()
  globalProactivePlanner.start(options.plannerIntervalMs)
  globalContextPreloader.start()
  globalStrategyOptimizer.start()
  globalAdaptiveTuner.start()

  globalAdaptiveTuner.bindComponents({
    systemHealthSensor: globalSystemHealthSensor,
    costSensor: globalCostSensor,
    signalBus: globalSignalBus,
    userBehaviorSensor: globalUserBehaviorSensor,
    proactiveEngine: globalProactiveEngine,
    selfHealingEngine: require('../self-healing-engine').globalSelfHealingEngine,
  })

  globalSignalBus.on('signal', (signal) => {
    if (signal.severity === SIGNAL_SEVERITY.CRITICAL || signal.severity === SIGNAL_SEVERITY.WARNING) {
      globalAdaptiveTuner.adjustFromSignal(signal)
    }
  })

  globalSignalBus.subscribe('experience_replay_completed', (_signal) => {
    const replay = getGlobalExperienceReplay()
    if (!replay) return
    const patterns = replay.getLearnedPatterns()
    const insights = patterns.map(p => {
      if (p.type.includes('failure')) {
        return { type: 'failure_insight', severity: p.severity || 'medium', pattern: p.type, message: p.recommendation, action: p.type === 'tool_failure_pattern' ? 'degrade_tool' : 'optimize_strategy' }
      }
      if (p.type.includes('success')) {
        return { type: 'success_insight', severity: 'info', pattern: p.type, message: p.recommendation, action: 'promote_approach' }
      }
      return { type: 'temporal_insight', severity: p.severity || 'low', pattern: p.type, message: p.recommendation, action: 'adjust_scheduling' }
    })
    const optimizations = globalStrategyOptimizer.optimizeFromInsights(insights)
    if (optimizations.length > 0) {
      console.log(`🔄 经验回放→策略优化: ${optimizations.length} 项优化已应用`)
    }
  })

  globalSignalBus.subscribe('strategy_optimized', (signal) => {
    const kgEvolver = getGlobalKnowledgeGraphEvolver()
    if (kgEvolver) {
      kgEvolver.recordEntityAccess('strategy_optimizer')
    }

    if (signal.metrics && signal.metrics.optimizationCount > 0) {
      try {
        const experiment = globalEvolutionSandbox.createExperiment({
          name: `策略优化验证: ${signal.detail || 'auto'}`,
          type: 'strategy_ab',
          hypothesis: '优化后的策略优于当前策略',
          duration: 3600000,
          minSampleSize: 20,
          confidenceThreshold: 0.9,
        })
        if (experiment) {
          globalEvolutionSandbox.startExperiment(experiment.id)
          console.log(`🧪 自动创建进化实验: ${experiment.id} - ${experiment.name}`)
        }
      } catch (err) {
        console.warn(`🧪 自动创建实验失败: ${err.message}`)
      }
    }
  })

  const experienceReplay = getGlobalExperienceReplay()
  if (experienceReplay) {
    experienceReplay.start(options.replayIntervalMs)
  }

  const kgEvolver = getGlobalKnowledgeGraphEvolver()
  if (kgEvolver) {
    kgEvolver.start(options.kgEvolverIntervalMs)
  }

  globalEvolutionSandbox.start()

  console.log('🌐 环境感知层已全面启动')
}

function stopPerceptionLayer() {
  globalSystemHealthSensor.stop()
  globalUserBehaviorSensor.stop()
  globalBusinessContextSensor.stop()
  globalCostSensor.stop()
  globalProactiveEngine.stop()
  globalProactivePlanner.stop()
  globalContextPreloader.stop()
  globalStrategyOptimizer.stop()
  globalAdaptiveTuner.stop()

  const experienceReplay = getGlobalExperienceReplay()
  if (experienceReplay) experienceReplay.stop()

  const kgEvolver = getGlobalKnowledgeGraphEvolver()
  if (kgEvolver) kgEvolver.stop()

  globalEvolutionSandbox.stop()

  console.log('🌐 环境感知层已停止')
}

module.exports = {
  SignalBus,
  globalSignalBus,
  SIGNAL_SEVERITY,
  SystemHealthSensor,
  globalSystemHealthSensor,
  UserBehaviorSensor,
  globalUserBehaviorSensor,
  BusinessContextSensor,
  globalBusinessContextSensor,
  DOMAIN_KEYWORDS,
  CostSensor,
  globalCostSensor,
  MODEL_COST_PER_1K,
  ProactiveEngine,
  globalProactiveEngine,
  PROACTIVE_RULES,
  IntentPredictor,
  globalIntentPredictor,
  INTENT_CATEGORIES,
  ProactivePlanner,
  globalProactivePlanner,
  PROACTIVE_ACTION_TYPES,
  ContextPreloader,
  globalContextPreloader,
  PRELOAD_REGISTRY,
  DOMAIN_PRELOAD_MAP,
  ExperienceReplayEngine,
  initExperienceReplay,
  getGlobalExperienceReplay,
  REPLAY_TRIGGERS,
  StrategyOptimizer,
  globalStrategyOptimizer,
  STRATEGY_DOMAINS,
  OPTIMIZATION_ACTIONS,
  AdaptiveTuner,
  globalAdaptiveTuner,
  TUNABLE_PARAMS,
  KnowledgeGraphEvolver,
  initKnowledgeGraphEvolver,
  getGlobalKnowledgeGraphEvolver,
  EVOLUTION_TYPES,
  EvolutionExperiment,
  EvolutionSandbox,
  globalEvolutionSandbox,
  EXPERIMENT_STATES,
  EXPERIMENT_TYPES,
  startPerceptionLayer,
  stopPerceptionLayer,
}
