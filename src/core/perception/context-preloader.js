const EventEmitter = require('events')
const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')
// eslint-disable-next-line no-unused-vars
const { globalIntentPredictor, INTENT_CATEGORIES } = require('./intent-predictor')
// eslint-disable-next-line no-unused-vars
const { globalBusinessContextSensor, DOMAIN_KEYWORDS } = require('./business-context-sensor')

const PRELOAD_REGISTRY = {
  web_search: {
    name: '网络搜索',
    description: '预加载搜索引擎配置和缓存',
    loadFn: null,
    ttlMs: 600000,
  },
  knowledge_base: {
    name: '知识库',
    description: '预加载相关知识条目',
    loadFn: null,
    ttlMs: 1800000,
  },
  skill_registry: {
    name: '技能注册表',
    description: '预加载技能列表和元数据',
    loadFn: null,
    ttlMs: 3600000,
  },
  tool_set: {
    name: '工具集',
    description: '预加载工具定义和参数',
    loadFn: null,
    ttlMs: 3600000,
  },
  data_tools: {
    name: '数据分析工具',
    description: '预加载数据分析相关工具',
    loadFn: null,
    ttlMs: 1800000,
  },
  chart_engine: {
    name: '图表引擎',
    description: '预加载图表渲染配置',
    loadFn: null,
    ttlMs: 1800000,
  },
  channel_registry: {
    name: '通道注册表',
    description: '预加载通信通道配置',
    loadFn: null,
    ttlMs: 3600000,
  },
  contact_list: {
    name: '联系人列表',
    description: '预加载常用联系人',
    loadFn: null,
    ttlMs: 1800000,
  },
  calendar_api: {
    name: '日历API',
    description: '预加载日历接口配置',
    loadFn: null,
    ttlMs: 1800000,
  },
  task_manager: {
    name: '任务管理器',
    description: '预加载任务列表',
    loadFn: null,
    ttlMs: 1800000,
  },
  doc_templates: {
    name: '文档模板',
    description: '预加载文档模板库',
    loadFn: null,
    ttlMs: 3600000,
  },
  data_sources: {
    name: '数据源',
    description: '预加载数据源连接',
    loadFn: null,
    ttlMs: 1800000,
  },
  diagnostic_tools: {
    name: '诊断工具',
    description: '预加载诊断工具集',
    loadFn: null,
    ttlMs: 1800000,
  },
  error_database: {
    name: '错误数据库',
    description: '预加载常见错误解决方案',
    loadFn: null,
    ttlMs: 3600000,
  },
  domain_knowledge: {
    name: '领域知识',
    description: '预加载特定领域知识',
    loadFn: null,
    ttlMs: 1800000,
  },
}

const DOMAIN_PRELOAD_MAP = {
  finance: ['data_tools', 'chart_engine', 'data_sources', 'domain_knowledge'],
  hr: ['contact_list', 'doc_templates', 'task_manager', 'domain_knowledge'],
  legal: ['knowledge_base', 'doc_templates', 'domain_knowledge'],
  tech: ['diagnostic_tools', 'error_database', 'tool_set', 'domain_knowledge'],
  marketing: ['data_tools', 'chart_engine', 'channel_registry', 'domain_knowledge'],
  operations: ['task_manager', 'calendar_api', 'tool_set', 'domain_knowledge'],
}

const INTENT_RESOURCE_MAP = {
  search: ['web_search', 'knowledge_base'],
  analyze: ['data_tools', 'chart_engine'],
  create: ['doc_templates', 'skill_registry'],
  debug: ['diagnostic_tools', 'error_database'],
  schedule: ['calendar_api', 'task_manager'],
  communicate: ['contact_list', 'channel_registry'],
  manage: ['task_manager', 'tool_set'],
  learn: ['knowledge_base', 'domain_knowledge'],
}

class ContextPreloader extends EventEmitter {
  constructor() {
    super()
    this._cache = new Map()
    this._preloadStats = {
      totalPreloads: 0,
      cacheHits: 0,
      cacheMisses: 0,
      evictions: 0,
      proactivePreloads: 0,
      patternTriggers: 0,
    }
    this._running = false
    this._evictionIntervalId = null
    this._conversationPatterns = new Map()
    this._maxPatterns = 500
    this._patternWindow = 3
  }

  start() {
    if (this._running) return
    this._running = true
    this._evictionIntervalId = setInterval(() => this._evictExpired(), 120000)
    console.log('📦 上下文预加载器已启动')
  }

  stop() {
    if (!this._running) return
    this._running = false
    if (this._evictionIntervalId) {
      clearInterval(this._evictionIntervalId)
      this._evictionIntervalId = null
    }
    console.log('📦 上下文预加载器已停止')
  }

  async preloadForIntent(userId, intent, resources) {
    if (!resources || resources.length === 0) return []

    const results = []
    for (const resourceKey of resources) {
      const registry = PRELOAD_REGISTRY[resourceKey]
      if (!registry) continue

      const cacheKey = `${userId}:${resourceKey}`
      const cached = this._cache.get(cacheKey)

      if (cached && Date.now() - cached.loadedAt < registry.ttlMs) {
        this._preloadStats.cacheHits++
        results.push({
          resource: resourceKey,
          status: 'cached',
          age: Date.now() - cached.loadedAt,
        })
        continue
      }

      this._preloadStats.cacheMisses++
      this._preloadStats.totalPreloads++

      const entry = {
        resource: resourceKey,
        userId,
        loadedAt: Date.now(),
        expiresAt: Date.now() + registry.ttlMs,
        data: null,
        status: 'loaded',
      }

      if (registry.loadFn) {
        try {
          entry.data = await registry.loadFn(userId)
        } catch (e) {
          entry.status = 'error'
          entry.error = e.message
        }
      }

      this._cache.set(cacheKey, entry)
      results.push({
        resource: resourceKey,
        name: registry.name,
        status: entry.status,
      })

      globalSignalBus.emit({
        type: 'context_preloaded',
        source: 'context_preloader',
        severity: SIGNAL_SEVERITY.DEBUG,
        detail: `预加载资源: ${registry.name} (用户: ${userId})`,
        metrics: { userId, resource: resourceKey, status: entry.status },
      })
    }

    return results
  }

  async preloadForDomain(userId, domains) {
    if (!domains || domains.length === 0) return []

    const allResources = new Set()
    for (const domain of domains) {
      const domainName = domain.domain || domain
      const resources = DOMAIN_PRELOAD_MAP[domainName]
      if (resources) {
        for (const r of resources) allResources.add(r)
      }
    }

    if (allResources.size === 0) return []

    return this.preloadForIntent(userId, 'domain', [...allResources])
  }

  async preloadForPrediction(userId, prediction) {
    const actions = []

    if (prediction.topPrediction && prediction.topPrediction.preloadHints) {
      const result = await this.preloadForIntent(
        userId,
        prediction.topPrediction.intent,
        prediction.topPrediction.preloadHints,
      )
      actions.push({ type: 'intent_preload', result })
    }

    if (prediction.currentIntent) {
      for (const intent of prediction.currentIntent.slice(0, 2)) {
        if (intent.preloadHints && intent.preloadHints.length > 0) {
          const result = await this.preloadForIntent(userId, intent.intent, intent.preloadHints)
          actions.push({ type: 'current_intent_preload', intent: intent.intent, result })
        }
      }
    }

    return actions
  }

  getCachedResource(userId, resourceKey) {
    const cacheKey = `${userId}:${resourceKey}`
    const entry = this._cache.get(cacheKey)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(cacheKey)
      return null
    }
    return entry
  }

  invalidateCache(userId, resourceKey = null) {
    if (resourceKey) {
      this._cache.delete(`${userId}:${resourceKey}`)
    } else {
      for (const key of this._cache.keys()) {
        if (key.startsWith(`${userId}:`)) {
          this._cache.delete(key)
        }
      }
    }
  }

  _evictExpired() {
    const now = Date.now()
    let evicted = 0
    for (const [key, entry] of this._cache) {
      if (now > entry.expiresAt) {
        this._cache.delete(key)
        evicted++
      }
    }
    if (evicted > 0) {
      this._preloadStats.evictions += evicted
    }
  }

  getCacheStats() {
    let totalSize = 0
    let expiredSize = 0
    const now = Date.now()
    const byResource = new Map()

    for (const [, entry] of this._cache) {
      totalSize++
      if (now > entry.expiresAt) expiredSize++
      const count = byResource.get(entry.resource) || 0
      byResource.set(entry.resource, count + 1)
    }

    return {
      totalEntries: totalSize,
      expiredEntries: expiredSize,
      byResource: Object.fromEntries(byResource),
    }
  }

  getStatus() {
    return {
      running: this._running,
      stats: { ...this._preloadStats },
      cache: this.getCacheStats(),
      registeredResources: Object.keys(PRELOAD_REGISTRY).length,
    }
  }

  getRegistry() {
    return Object.entries(PRELOAD_REGISTRY).map(([key, reg]) => ({
      key,
      name: reg.name,
      description: reg.description,
      ttlMs: reg.ttlMs,
      hasLoader: reg.loadFn !== null,
    }))
  }

  recordConversationEvent(userId, event) {
    const patternKey = `${userId}:events`
    let events = this._conversationPatterns.get(patternKey)
    if (!events) {
      events = []
      this._conversationPatterns.set(patternKey, events)
    }
    events.push({
      type: event.type || 'unknown',
      intent: event.intent || null,
      resource: event.resource || null,
      timestamp: Date.now(),
    })
    if (events.length > 50) {
      events.splice(0, events.length - 50)
    }
    if (this._conversationPatterns.size > this._maxPatterns) {
      const oldest = this._conversationPatterns.keys().next().value
      this._conversationPatterns.delete(oldest)
    }
  }

  analyzeAndPreload(userId) {
    const patternKey = `${userId}:events`
    const events = this._conversationPatterns.get(patternKey)
    if (!events || events.length < this._patternWindow) return []

    const recent = events.slice(-this._patternWindow)
    const predictedResources = this._predictFromPattern(recent)
    if (predictedResources.length === 0) return []

    this._preloadStats.patternTriggers++
    const results = this.preloadForIntent(userId, 'proactive_pattern', predictedResources)
    this._preloadStats.proactivePreloads += predictedResources.length

    this.emit('proactive_preload', {
      userId,
      pattern: recent.map(e => e.type),
      predictedResources,
    })

    return results
  }

  _predictFromPattern(recentEvents) {
    const resourceScores = new Map()

    for (const event of recentEvents) {
      if (event.type === 'tool_call' && event.resource) {
        const related = this._getRelatedResources(event.resource)
        for (const r of related) {
          resourceScores.set(r, (resourceScores.get(r) || 0) + 2)
        }
      }
      if (event.type === 'intent_detected' && event.intent) {
        const intentResources = INTENT_RESOURCE_MAP[event.intent]
        if (intentResources) {
          for (const r of intentResources) {
            resourceScores.set(r, (resourceScores.get(r) || 0) + 1)
          }
        }
      }
    }

    const sorted = [...resourceScores.entries()].sort((a, b) => b[1] - a[1])
    return sorted.slice(0, 3).map(([r]) => r)
  }

  _getRelatedResources(resource) {
    const RELATIONSHIP_MAP = {
      web_search: ['knowledge_base'],
      knowledge_base: ['web_search', 'domain_knowledge'],
      data_tools: ['chart_engine', 'data_sources'],
      chart_engine: ['data_tools', 'data_sources'],
      data_sources: ['data_tools', 'chart_engine'],
      task_manager: ['calendar_api', 'contact_list'],
      calendar_api: ['task_manager', 'contact_list'],
      contact_list: ['calendar_api', 'channel_registry'],
      doc_templates: ['knowledge_base'],
      diagnostic_tools: ['error_database', 'tool_set'],
      error_database: ['diagnostic_tools'],
      skill_registry: ['tool_set'],
      tool_set: ['skill_registry', 'diagnostic_tools'],
      channel_registry: ['contact_list'],
      domain_knowledge: ['knowledge_base'],
    }
    return RELATIONSHIP_MAP[resource] || []
  }

  async onUserMessage(userId, messageText) {
    this.recordConversationEvent(userId, { type: 'user_message' })

    const detectedResources = this._detectResourcesFromText(messageText)
    if (detectedResources.length > 0) {
      this.recordConversationEvent(userId, { type: 'intent_detected', intent: 'detected', resource: detectedResources[0] })
      await this.preloadForIntent(userId, 'text_detected', detectedResources)
    }

    return this.analyzeAndPreload(userId)
  }

  _detectResourcesFromText(text) {
    if (!text) return []
    const lower = text.toLowerCase()
    const detected = []

    const TEXT_PATTERNS = [
      { pattern: /搜索|查询|search|query|find|lookup/i, resources: ['web_search', 'knowledge_base'] },
      { pattern: /数据|图表|分析|data|chart|analyz|report/i, resources: ['data_tools', 'chart_engine'] },
      { pattern: /任务|待办|task|todo|schedule/i, resources: ['task_manager', 'calendar_api'] },
      { pattern: /文档|模板|document|template|write|draft/i, resources: ['doc_templates', 'knowledge_base'] },
      { pattern: /错误|调试|error|debug|fix|diagnos/i, resources: ['diagnostic_tools', 'error_database'] },
      { pattern: /技能|工具|skill|tool|plugin/i, resources: ['skill_registry', 'tool_set'] },
      { pattern: /联系|邮件|contact|email|message/i, resources: ['contact_list', 'channel_registry'] },
      { pattern: /日历|会议|calendar|meeting|appointment/i, resources: ['calendar_api', 'task_manager'] },
    ]

    for (const { pattern, resources } of TEXT_PATTERNS) {
      if (pattern.test(lower)) {
        for (const r of resources) {
          if (!detected.includes(r)) detected.push(r)
        }
      }
    }

    return detected.slice(0, 4)
  }
}

const globalContextPreloader = new ContextPreloader()

module.exports = {
  ContextPreloader,
  globalContextPreloader,
  PRELOAD_REGISTRY,
  DOMAIN_PRELOAD_MAP,
}
