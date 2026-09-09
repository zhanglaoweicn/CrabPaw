const { globalSignalBus, SIGNAL_SEVERITY } = require('./signal-bus')

const DEFAULT_DAILY_BUDGET_USD = 5.0
const DEFAULT_MONTHLY_BUDGET_USD = 100.0

const COST_WARNING_THRESHOLD = 0.8

const MODEL_COST_PER_1K = {
  'deepseek-chat': { input: 0.0014, output: 0.0028 },
  'deepseek-reasoner': { input: 0.004, output: 0.016 },
  'qwen-plus': { input: 0.002, output: 0.006 },
  'qwen-turbo': { input: 0.0005, output: 0.001 },
  'qwen-max': { input: 0.01, output: 0.03 },
  'glm-4': { input: 0.015, output: 0.015 },
  'glm-4-flash': { input: 0.0001, output: 0.0001 },
  'doubao-pro-32k': { input: 0.0005, output: 0.001 },
  'doubao-pro-128k': { input: 0.005, output: 0.009 },
  'moonshot-v1-8k': { input: 0.012, output: 0.012 },
  'moonshot-v1-32k': { input: 0.024, output: 0.024 },
}

class CostSensor {
  constructor() {
    this._dailyUsage = new Map()
    this._monthlyUsage = new Map()
    this._sessionUsage = new Map()
    this._interval = null
    this._running = false
    this._dailyBudget = DEFAULT_DAILY_BUDGET_USD
    this._monthlyBudget = DEFAULT_MONTHLY_BUDGET_USD
  }

  start(intervalMs = 5 * 60 * 1000) {
    if (this._interval) return

    this._running = true
    this._interval = setInterval(() => this._analyze(), intervalMs)
    if (this._interval.unref) this._interval.unref()

    console.log('💰 成本感知器已启动')
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
    this._running = false
  }

  setBudget(daily, monthly) {
    if (daily) this._dailyBudget = daily
    if (monthly) this._monthlyBudget = monthly
  }

  recordTokenUsage(sessionId, model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
    const costPer1k = MODEL_COST_PER_1K[model] || { input: 0.002, output: 0.006 }
    const inputCost = (inputTokens / 1000) * costPer1k.input
    const outputCost = (outputTokens / 1000) * costPer1k.output
    const cacheReadCost = (cacheReadTokens / 1000) * (costPer1k.input * 0.1)
    const cacheWriteCost = (cacheWriteTokens / 1000) * (costPer1k.input * 0.5)
    const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost

    const today = new Date().toISOString().slice(0, 10)
    const month = today.slice(0, 7)

    const daily = this._dailyUsage.get(today) || {
      cost: 0, inputTokens: 0, outputTokens: 0, modelBreakdown: new Map(),
    }
    daily.cost += totalCost
    daily.inputTokens += inputTokens
    daily.outputTokens += outputTokens
    const modelCost = daily.modelBreakdown.get(model) || { cost: 0, calls: 0 }
    modelCost.cost += totalCost
    modelCost.calls++
    daily.modelBreakdown.set(model, modelCost)
    this._dailyUsage.set(today, daily)

    const monthly = this._monthlyUsage.get(month) || { cost: 0, inputTokens: 0, outputTokens: 0 }
    monthly.cost += totalCost
    monthly.inputTokens += inputTokens
    monthly.outputTokens += outputTokens
    this._monthlyUsage.set(month, monthly)

    const session = this._sessionUsage.get(sessionId) || { cost: 0, inputTokens: 0, outputTokens: 0, model }
    session.cost += totalCost
    session.inputTokens += inputTokens
    session.outputTokens += outputTokens
    this._sessionUsage.set(sessionId, session)

    return { totalCost, inputCost, outputCost, cacheReadCost, cacheWriteCost }
  }

  _analyze() {
    const today = new Date().toISOString().slice(0, 10)
    const month = today.slice(0, 7)

    const dailyUsage = this._dailyUsage.get(today)
    if (dailyUsage) {
      if (dailyUsage.cost > this._dailyBudget) {
        globalSignalBus.emit({
          type: 'daily_cost_exceeded',
          source: 'cost_sensor',
          severity: SIGNAL_SEVERITY.CRITICAL,
          detail: `日成本超预算: $${dailyUsage.cost.toFixed(4)} / $${this._dailyBudget}`,
          metrics: { cost: dailyUsage.cost, budget: this._dailyBudget, usageRatio: dailyUsage.cost / this._dailyBudget },
        })
      } else if (dailyUsage.cost > this._dailyBudget * COST_WARNING_THRESHOLD) {
        globalSignalBus.emit({
          type: 'daily_cost_warning',
          source: 'cost_sensor',
          severity: SIGNAL_SEVERITY.WARNING,
          detail: `日成本接近预算: $${dailyUsage.cost.toFixed(4)} / $${this._dailyBudget}`,
          metrics: { cost: dailyUsage.cost, budget: this._dailyBudget, usageRatio: dailyUsage.cost / this._dailyBudget },
        })
      }

      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
      const dayOfMonth = new Date().getDate()
      const projectedDaily = dailyUsage.cost
      const projectedMonthly = projectedDaily * daysInMonth
      if (projectedMonthly > this._monthlyBudget * 1.5) {
        globalSignalBus.emit({
          type: 'token_usage_spike',
          source: 'cost_sensor',
          severity: SIGNAL_SEVERITY.WARNING,
          detail: `月成本预测超标: 预计 $${projectedMonthly.toFixed(2)} (预算 $${this._monthlyBudget})`,
          metrics: { projectedMonthly, budget: this._monthlyBudget, dayOfMonth, daysInMonth },
        })
      }
    }

    const oldDays = [...this._dailyUsage.keys()].filter(d => d < today && this._dailyUsage.size > 30)
    for (const d of oldDays) this._dailyUsage.delete(d)

    const oldMonths = [...this._monthlyUsage.keys()].filter(m => m < month && this._monthlyUsage.size > 12)
    for (const m of oldMonths) this._monthlyUsage.delete(m)
  }

  getDailyUsage(date = null) {
    const day = date || new Date().toISOString().slice(0, 10)
    const usage = this._dailyUsage.get(day)
    if (!usage) return { cost: 0, inputTokens: 0, outputTokens: 0, modelBreakdown: {} }

    return {
      cost: usage.cost,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      modelBreakdown: Object.fromEntries(usage.modelBreakdown),
    }
  }

  getMonthlyUsage(month = null) {
    const m = month || new Date().toISOString().slice(0, 7)
    return this._monthlyUsage.get(m) || { cost: 0, inputTokens: 0, outputTokens: 0 }
  }

  getStatus() {
    const today = new Date().toISOString().slice(0, 10)
    const daily = this._dailyUsage.get(today)
    return {
      running: this._running,
      dailyBudget: this._dailyBudget,
      monthlyBudget: this._monthlyBudget,
      todayCost: daily?.cost || 0,
      todayInputTokens: daily?.inputTokens || 0,
      todayOutputTokens: daily?.outputTokens || 0,
      activeSessions: this._sessionUsage.size,
    }
  }
}

const globalCostSensor = new CostSensor()

module.exports = {
  CostSensor,
  globalCostSensor,
  MODEL_COST_PER_1K,
}
