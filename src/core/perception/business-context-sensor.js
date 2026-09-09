const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const DOMAIN_KEYWORDS = {
  finance: ['财务', '报表', '预算', '成本', '营收', '利润', '税务', '审计', '融资', '投资', 'finance', 'budget', 'revenue'],
  hr: ['招聘', '员工', '薪资', '考勤', '绩效', '培训', '离职', '入职', 'hr', 'human resource'],
  legal: ['合同', '法律', '合规', '法规', '诉讼', '知识产权', '专利', 'legal', 'compliance', 'contract'],
  marketing: ['营销', '推广', '品牌', '广告', '流量', '转化', '用户增长', 'marketing', 'campaign', 'brand'],
  tech: ['代码', '开发', '部署', '架构', 'API', '数据库', '服务器', 'bug', 'tech', 'deploy', 'architecture'],
  operations: ['运营', '流程', '效率', '供应链', '物流', '库存', 'operations', 'supply chain'],
  product: ['产品', '需求', '功能', '用户体验', '原型', 'product', 'feature', 'requirement'],
  sales: ['销售', '客户', '订单', 'CRM', '线索', '成交', 'sales', 'customer', 'deal'],
  research: ['研究', '分析', '调研', '趋势', '报告', '数据', 'research', 'analysis', 'trend'],
  strategy: ['战略', '规划', '目标', '竞争', '市场', 'strategy', 'planning', 'competitive'],
}

class BusinessContextSensor {
  constructor() {
    this._contextHistory = []
    this._activeDomains = new Map()
    this._domainTransitionLog = []
    this._maxHistory = 2000
    this._interval = null
    this._running = false
    this._domainCooldownMs = 10 * 60 * 1000
  }

  start(intervalMs = 10 * 60 * 1000) {
    if (this._interval) return

    this._running = true
    this._interval = setInterval(() => this._analyze(), intervalMs)
    if (this._interval.unref) this._interval.unref()

    globalSignalBus.subscribe('user_topic_trend', (signal) => {
      this._processTopicSignal(signal)
    })

    globalSignalBus.subscribe('user_domain_focus', (signal) => {
      this._processDomainSignal(signal)
    })

    console.log('🏢 业务上下文感知器已启动')
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
    this._running = false
  }

  detectDomains(text) {
    if (!text) return []

    const lowerText = text.toLowerCase()
    const detected = []

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = 0
      for (const keyword of keywords) {
        if (lowerText.includes(keyword.toLowerCase())) {
          score++
        }
      }
      if (score > 0) {
        detected.push({ domain, score, confidence: Math.min(score / 3, 1) })
      }
    }

    return detected.sort((a, b) => b.score - a.score)
  }

  recordContext(userId, text) {
    const domains = this.detectDomains(text)
    const record = {
      userId,
      text: text.slice(0, 200),
      domains,
      timestamp: Date.now(),
    }

    this._contextHistory.push(record)
    if (this._contextHistory.length > this._maxHistory) {
      this._contextHistory = this._contextHistory.slice(-this._maxHistory / 2)
    }

    for (const d of domains) {
      const existing = this._activeDomains.get(d.domain)
      if (existing) {
        existing.score += d.score
        existing.lastSeen = Date.now()
        existing.occurrences++
      } else {
        this._activeDomains.set(d.domain, {
          domain: d.domain,
          score: d.score,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          occurrences: 1,
        })
      }
    }

    return domains
  }

  _processTopicSignal(signal) {
    if (!signal.metrics?.topic) return
    const topic = signal.metrics.topic
    const domains = this.detectDomains(topic)
    if (domains.length > 0) {
      this._emitDomainActivation(domains[0], signal.source)
    }
  }

  _processDomainSignal(signal) {
    if (!signal.metrics?.domain) return
    const domain = signal.metrics.domain
    if (DOMAIN_KEYWORDS[domain]) {
      this._emitDomainActivation({ domain, score: signal.metrics.count }, signal.source)
    }
  }

  _emitDomainActivation(domainInfo, source) {
    const active = this._activeDomains.get(domainInfo.domain)
    if (active && Date.now() - active.lastEmit < this._domainCooldownMs) return

    if (active) active.lastEmit = Date.now()

    globalSignalBus.emit({
      type: 'domain_activated',
      source: source || 'business_context',
      severity: SIGNAL_SEVERITY.INFO,
      detail: `业务领域激活: ${domainInfo.domain} (得分: ${domainInfo.score})`,
      metrics: { domain: domainInfo.domain, score: domainInfo.score },
    })
  }

  _analyze() {
    const now = Date.now()
    const recentThreshold = 30 * 60 * 1000
    const recentContexts = this._contextHistory.filter(c => now - c.timestamp < recentThreshold)

    if (recentContexts.length === 0) return

    const domainCounts = new Map()
    for (const ctx of recentContexts) {
      for (const d of ctx.domains) {
        domainCounts.set(d.domain, (domainCounts.get(d.domain) || 0) + 1)
      }
    }

    const sortedDomains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1])
    if (sortedDomains.length > 0) {
      const [topDomain, count] = sortedDomains[0]
      if (count >= 3) {
        this._emitDomainActivation({ domain: topDomain, score: count }, 'business_context_analysis')
      }
    }

    for (const [domain, info] of this._activeDomains) {
      if (now - info.lastSeen > 24 * 60 * 60 * 1000) {
        globalSignalBus.emit({
          type: 'domain_deactivated',
          source: 'business_context',
          severity: SIGNAL_SEVERITY.INFO,
          detail: `业务领域冷却: ${domain}`,
          metrics: { domain, lastSeen: info.lastSeen },
        })
        this._activeDomains.delete(domain)
      }
    }
  }

  getActiveDomains() {
    return [...this._activeDomains.entries()].map(([domain, info]) => ({
      domain,
      score: info.score,
      occurrences: info.occurrences,
      firstSeen: info.firstSeen,
      lastSeen: info.lastSeen,
    })).sort((a, b) => b.score - a.score)
  }

  getStatus() {
    return {
      running: this._running,
      activeDomains: this._activeDomains.size,
      totalContexts: this._contextHistory.length,
      domainList: [...this._activeDomains.keys()],
    }
  }
}

const globalBusinessContextSensor = new BusinessContextSensor()

module.exports = {
  BusinessContextSensor,
  globalBusinessContextSensor,
  DOMAIN_KEYWORDS,
}
