const EventEmitter = require('events')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')
// eslint-disable-next-line no-unused-vars
const { globalUserBehaviorSensor } = require('./user-behavior-sensor')
// eslint-disable-next-line no-unused-vars
const { globalBusinessContextSensor } = require('./business-context-sensor')

const INTENT_CATEGORIES = {
  information_seeking: {
    name: '信息查询',
    keywords: ['什么', '如何', '怎么', '为什么', '查询', '搜索', '了解', '看看', '查一下', 'what', 'how', 'why', 'search', 'find'],
    followUpIntents: ['data_analysis', 'report_generation', 'action_execution'],
    preloadHints: ['web_search', 'knowledge_base'],
  },
  task_execution: {
    name: '任务执行',
    keywords: ['帮我', '执行', '创建', '生成', '写', '做', '完成', '处理', 'help', 'create', 'generate', 'write', 'do', 'execute'],
    followUpIntents: ['result_review', 'task_refinement', 'report_generation'],
    preloadHints: ['skill_registry', 'tool_set'],
  },
  data_analysis: {
    name: '数据分析',
    keywords: ['分析', '统计', '对比', '趋势', '报表', '数据', '指标', 'analyze', 'statistics', 'compare', 'trend', 'data'],
    followUpIntents: ['report_generation', 'decision_support', 'visualization'],
    preloadHints: ['data_tools', 'chart_engine'],
  },
  communication: {
    name: '沟通协作',
    keywords: ['通知', '发送', '分享', '提醒', '告诉', '通知', 'send', 'notify', 'share', 'remind'],
    followUpIntents: ['schedule_management', 'document_creation'],
    preloadHints: ['channel_registry', 'contact_list'],
  },
  schedule_management: {
    name: '日程管理',
    keywords: ['日程', '会议', '安排', '预约', '时间', 'schedule', 'meeting', 'calendar', 'appointment'],
    followUpIntents: ['communication', 'task_execution'],
    preloadHints: ['calendar_api', 'task_manager'],
  },
  report_generation: {
    name: '报告生成',
    keywords: ['报告', '总结', '汇报', '文档', '周报', '月报', 'report', 'summary', 'document'],
    followUpIntents: ['communication', 'data_analysis'],
    preloadHints: ['doc_templates', 'data_sources'],
  },
  decision_support: {
    name: '决策支持',
    keywords: ['建议', '选择', '决策', '评估', '比较', '推荐', 'suggest', 'choose', 'decide', 'recommend'],
    followUpIntents: ['task_execution', 'information_seeking'],
    preloadHints: ['knowledge_base', 'historical_data'],
  },
  troubleshooting: {
    name: '问题排查',
    keywords: ['错误', '失败', '问题', '异常', '修复', '排查', 'error', 'fail', 'problem', 'fix', 'debug'],
    followUpIntents: ['task_execution', 'information_seeking'],
    preloadHints: ['diagnostic_tools', 'error_database'],
  },
}

const CONFIDENCE_THRESHOLD = 0.3
const PREDICTION_DECAY_MS = 300000
const MAX_INTENT_HISTORY = 200

class IntentPredictor extends EventEmitter {
  constructor() {
    super()
    this._intentHistory = []
    this._activePredictions = new Map()
    this._userIntentProfiles = new Map()
    this._patternCache = new Map()
  }

  predict(userId, currentMessage, context = {}) {
    const currentIntent = this._classifyIntent(currentMessage)
    const userProfile = this._getUserIntentProfile(userId)
    const sequentialPrediction = this._predictFromSequence(userId, currentIntent)
    const timePrediction = this._predictFromTimePattern(userId)
    const domainPrediction = this._predictFromDomain(context.domains || [])

    const predictions = this._mergePredictions([
      { source: 'current_message', weight: 0.4, intents: currentIntent },
      { source: 'sequential', weight: 0.3, intents: sequentialPrediction },
      { source: 'time_pattern', weight: 0.15, intents: timePrediction },
      { source: 'domain', weight: 0.15, intents: domainPrediction },
    ])

    this._updateIntentHistory(userId, currentIntent, context)
    this._updateUserProfile(userId, currentIntent, context)

    const topPrediction = predictions.length > 0 ? predictions[0] : null

    if (topPrediction && topPrediction.confidence >= CONFIDENCE_THRESHOLD) {
      this._activePredictions.set(userId, {
        prediction: topPrediction,
        timestamp: Date.now(),
        context,
      })

      globalSignalBus.emit({
        type: 'intent_predicted',
        source: 'intent_predictor',
        severity: SIGNAL_SEVERITY.INFO,
        detail: `预测用户 ${userId} 下一步意图: ${topPrediction.intent} (${(topPrediction.confidence * 100).toFixed(0)}%)`,
        metrics: {
          userId,
          intent: topPrediction.intent,
          confidence: topPrediction.confidence,
          preloadHints: topPrediction.preloadHints || [],
        },
      })
    }

    return {
      currentIntent,
      predictions,
      topPrediction,
      userProfile: this._summarizeProfile(userProfile),
    }
  }

  _classifyIntent(message) {
    if (!message || typeof message !== 'string') return []

    const lowerMessage = message.toLowerCase()
    const scores = []

    for (const [intentId, category] of Object.entries(INTENT_CATEGORIES)) {
      let score = 0
      let matchedKeywords = []

      for (const keyword of category.keywords) {
        if (lowerMessage.includes(keyword.toLowerCase())) {
          score += 1
          matchedKeywords.push(keyword)
        }
      }

      if (score > 0) {
        const confidence = Math.min(score / 3, 1)
        scores.push({
          intent: intentId,
          name: category.name,
          confidence,
          matchedKeywords,
          preloadHints: category.preloadHints,
          followUpIntents: category.followUpIntents,
        })
      }
    }

    return scores.sort((a, b) => b.confidence - a.confidence)
  }

  _predictFromSequence(userId, currentIntent) {
    const recentHistory = this._intentHistory
      .filter(h => h.userId === userId)
      .slice(-10)

    if (recentHistory.length < 2) return []

    const transitions = new Map()
    for (let i = 1; i < recentHistory.length; i++) {
      const prev = recentHistory[i - 1].topIntent
      const curr = recentHistory[i].topIntent
      if (prev && curr) {
        const key = `${prev}->?`
        const existing = transitions.get(key) || new Map()
        existing.set(curr, (existing.get(curr) || 0) + 1)
        transitions.set(key, existing)
      }
    }

    const predictions = []
    if (currentIntent.length > 0) {
      const currentTop = currentIntent[0].intent
      const key = `${currentTop}->?`
      const nextIntents = transitions.get(key)

      if (nextIntents) {
        const total = [...nextIntents.values()].reduce((s, c) => s + c, 0)
        for (const [nextIntent, count] of nextIntents) {
          const category = INTENT_CATEGORIES[nextIntent]
          if (category) {
            predictions.push({
              intent: nextIntent,
              name: category.name,
              confidence: count / total,
              preloadHints: category.preloadHints,
              source: 'sequential',
            })
          }
        }
      }
    }

    if (currentIntent.length > 0) {
      const category = INTENT_CATEGORIES[currentIntent[0].intent]
      if (category && category.followUpIntents) {
        for (const followUp of category.followUpIntents) {
          if (!predictions.find(p => p.intent === followUp)) {
            const followUpCategory = INTENT_CATEGORIES[followUp]
            if (followUpCategory) {
              predictions.push({
                intent: followUp,
                name: followUpCategory.name,
                confidence: 0.3,
                preloadHints: followUpCategory.preloadHints,
                source: 'followup_heuristic',
              })
            }
          }
        }
      }
    }

    return predictions.sort((a, b) => b.confidence - a.confidence)
  }

  _predictFromTimePattern(userId) {
    const profile = this._getUserIntentProfile(userId)
    if (!profile || profile.timePatterns.size === 0) return []

    const now = new Date()
    const hour = now.getHours()
    const dayOfWeek = now.getDay()

    const timeKey = `${dayOfWeek}-${hour}`
    const intentCounts = profile.timePatterns.get(timeKey)

    if (!intentCounts) return []

    const total = [...intentCounts.values()].reduce((s, c) => s + c, 0)
    const predictions = []

    for (const [intent, count] of intentCounts) {
      const category = INTENT_CATEGORIES[intent]
      if (category && count / total > 0.2) {
        predictions.push({
          intent,
          name: category.name,
          confidence: count / total,
          preloadHints: category.preloadHints,
          source: 'time_pattern',
        })
      }
    }

    return predictions.sort((a, b) => b.confidence - a.confidence)
  }

  _predictFromDomain(domains) {
    if (!domains || domains.length === 0) return []

    const domainIntentMap = {
      finance: ['data_analysis', 'report_generation', 'decision_support'],
      hr: ['task_execution', 'communication', 'report_generation'],
      legal: ['information_seeking', 'report_generation', 'decision_support'],
      tech: ['troubleshooting', 'task_execution', 'information_seeking'],
      marketing: ['data_analysis', 'report_generation', 'communication'],
      operations: ['task_execution', 'schedule_management', 'troubleshooting'],
    }

    const predictions = []
    for (const domain of domains) {
      const domainName = domain.domain || domain
      const mappedIntents = domainIntentMap[domainName]
      if (mappedIntents) {
        const domainConfidence = domain.confidence || 0.5
        for (let i = 0; i < mappedIntents.length; i++) {
          const intentId = mappedIntents[i]
          const category = INTENT_CATEGORIES[intentId]
          if (category) {
            predictions.push({
              intent: intentId,
              name: category.name,
              confidence: domainConfidence * (1 - i * 0.2),
              preloadHints: category.preloadHints,
              source: 'domain_inference',
            })
          }
        }
      }
    }

    return predictions.sort((a, b) => b.confidence - a.confidence)
  }

  _mergePredictions(sources) {
    const intentScores = new Map()

    for (const { weight, intents } of sources) {
      if (!intents || intents.length === 0) continue
      for (const intent of intents) {
        const existing = intentScores.get(intent.intent) || {
          intent: intent.intent,
          name: intent.name,
          confidence: 0,
          preloadHints: intent.preloadHints || [],
          sources: [],
        }
        existing.confidence += intent.confidence * weight
        existing.sources.push(intent.source || 'unknown')
        intentScores.set(intent.intent, existing)
      }
    }

    return [...intentScores.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
  }

  _updateIntentHistory(userId, currentIntent, context) {
    const topIntent = currentIntent.length > 0 ? currentIntent[0].intent : null
    this._intentHistory.push({
      userId,
      topIntent,
      timestamp: Date.now(),
      context: context || {},
    })

    if (this._intentHistory.length > MAX_INTENT_HISTORY) {
      this._intentHistory = this._intentHistory.slice(-MAX_INTENT_HISTORY / 2)
    }
  }

  _updateUserProfile(userId, currentIntent, _context) {
    let profile = this._userIntentProfiles.get(userId)
    if (!profile) {
      profile = {
        intentCounts: new Map(),
        timePatterns: new Map(),
        lastUpdate: Date.now(),
      }
      this._userIntentProfiles.set(userId, profile)
    }

    if (currentIntent.length > 0) {
      const topIntent = currentIntent[0].intent
      profile.intentCounts.set(topIntent, (profile.intentCounts.get(topIntent) || 0) + 1)

      const now = new Date()
      const timeKey = `${now.getDay()}-${now.getHours()}`
      const timeMap = profile.timePatterns.get(timeKey) || new Map()
      timeMap.set(topIntent, (timeMap.get(topIntent) || 0) + 1)
      profile.timePatterns.set(timeKey, timeMap)
    }

    profile.lastUpdate = Date.now()
  }

  _getUserIntentProfile(userId) {
    return this._userIntentProfiles.get(userId) || null
  }

  _summarizeProfile(profile) {
    if (!profile) return { totalIntents: 0, topIntents: [], timePatterns: 0 }
    const topIntents = [...profile.intentCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([intent, count]) => ({ intent, count }))
    return {
      totalIntents: [...profile.intentCounts.values()].reduce((s, c) => s + c, 0),
      topIntents,
      timePatterns: profile.timePatterns.size,
    }
  }

  getActivePrediction(userId) {
    const entry = this._activePredictions.get(userId)
    if (!entry) return null
    if (Date.now() - entry.timestamp > PREDICTION_DECAY_MS) {
      this._activePredictions.delete(userId)
      return null
    }
    return entry
  }

  getIntentCategories() {
    return Object.entries(INTENT_CATEGORIES).map(([id, cat]) => ({
      id,
      name: cat.name,
      keywordCount: cat.keywords.length,
      followUpIntents: cat.followUpIntents,
      preloadHints: cat.preloadHints,
    }))
  }

  getStatus() {
    return {
      historySize: this._intentHistory.length,
      activePredictions: this._activePredictions.size,
      userProfileCount: this._userIntentProfiles.size,
      categories: Object.keys(INTENT_CATEGORIES).length,
    }
  }
}

const globalIntentPredictor = new IntentPredictor()

module.exports = {
  IntentPredictor,
  globalIntentPredictor,
  INTENT_CATEGORIES,
}
