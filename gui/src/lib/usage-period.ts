/**
 * usage-period — 成本周期聚合纯函数(GUI 全量修复 P6)
 *
 * P1 根因: /api/usage?period=today/week 只裁剪图表 byDay, total 恒为全时段值 →
 * 切"今日"时"总 Token/总成本"卡显示全量数据(与图表矛盾)。
 * 修复: 汇总卡按 period 从 byDay 重新聚合。
 */

export type UsagePeriod = 'today' | 'week' | 'month' | 'all'

export interface UsageDay {
  date: string
  costCny?: number
  requests?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** 2026-08-26 C1: 缓存节省额(与 tokens/cost 同口径——period 裁剪时一并聚合) */
  cacheSavings?: number
}

export interface PeriodMetrics {
  tokens: number
  cost: number
  requests: number
  cacheSavings: number
}

export function aggregatePeriodMetrics(byDay: UsageDay[] | undefined, period: UsagePeriod): PeriodMetrics {
  const days = Array.isArray(byDay) ? byDay : []
  if (days.length === 0) return { tokens: 0, cost: 0, requests: 0, cacheSavings: 0 }

  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]
  const monthPrefix = todayStr.slice(0, 7)
  const weekStart = new Date(today.getTime() - 6 * 86400000).toISOString().split('T')[0]

  const filtered = days.filter((d) => {
    if (!d.date) return period === 'all'
    if (period === 'today') return d.date === todayStr
    if (period === 'week') return d.date >= weekStart
    if (period === 'month') return d.date.startsWith(monthPrefix)
    return true
  })

  return filtered.reduce<PeriodMetrics>((acc, d) => ({
    tokens: acc.tokens + (d.totalTokens || (d.promptTokens || 0) + (d.completionTokens || 0) || 0),
    cost: acc.cost + (d.costCny || 0),
    requests: acc.requests + (d.requests || 0),
    cacheSavings: acc.cacheSavings + (d.cacheSavings || 0),
  }), { tokens: 0, cost: 0, requests: 0, cacheSavings: 0 })
}
