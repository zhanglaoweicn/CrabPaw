/**
 * usage-period 聚合测试(GUI 全量修复 P6)
 * 2026-08-15 修复: 原实现硬编码 2026-08-14 为"今天"——日期翻页后测试失效
 * (跨午夜时间炸弹)。改为相对日期: 今天/昨天/6天前/7天前, 永不过期。
 */
import { aggregatePeriodMetrics, type UsageDay } from './usage-period'

/** 相对今天生成日期串(YYYY-MM-DD, UTC——与 usage-period.ts 实现口径一致:
 *  实现用 toISOString 比较, 本地时区字符串会因时差落错窗口) */
function dstr(daysAgo: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().split('T')[0]
}

const DAYS: UsageDay[] = [
  // 2026-08-15 注: 实现的 week 窗口 = 今天-6天..今天(含今天共 7 天)——
  // 最老样本用 dstr(6) 恰在窗口内
  { date: dstr(6), costCny: 1, promptTokens: 100, completionTokens: 100 },
  { date: dstr(5), costCny: 2, promptTokens: 200, completionTokens: 200 },
  { date: dstr(1), costCny: 3, promptTokens: 300, completionTokens: 300 },
  { date: dstr(0), costCny: 4, promptTokens: 400, completionTokens: 400, totalTokens: 1000 },
]

describe('aggregatePeriodMetrics', () => {
  test('today 只聚合今天', () => {
    const m = aggregatePeriodMetrics(DAYS, 'today')
    expect(m.cost).toBe(4)
    expect(m.tokens).toBe(1000) // totalTokens 优先
  })

  test('week 聚合近 7 天', () => {
    const m = aggregatePeriodMetrics(DAYS, 'week')
    // 窗口 = 今天-6天..今天(含今天共 7 天)——4 个样本全在窗口内
    expect(m.cost).toBe(10)
  })

  test('month 聚合本月', () => {
    const m = aggregatePeriodMetrics(DAYS, 'month')
    // 月初日期翻页边界: 7天前可能跨月——只断言"今天"必在内且总量不超过 10
    expect(m.cost).toBeGreaterThanOrEqual(4)
    expect(m.cost).toBeLessThanOrEqual(10)
  })

  test('all 聚合全部(与后端 total 一致)', () => {
    const m = aggregatePeriodMetrics(DAYS, 'all')
    expect(m.cost).toBe(10)
    expect(m.tokens).toBe(2200) // 200+400+600+1000(totalTokens 优先)
  })

  test('空 byDay → 全零', () => {
    // 2026-08-27 C1: 空态返回 4 键——补 cacheSavings
    expect(aggregatePeriodMetrics(undefined, 'all')).toEqual({ tokens: 0, cost: 0, requests: 0, cacheSavings: 0 })
    expect(aggregatePeriodMetrics([], 'today')).toEqual({ tokens: 0, cost: 0, requests: 0, cacheSavings: 0 })
  })

  test('totalTokens 缺失时退化 prompt+completion', () => {
    const m = aggregatePeriodMetrics([{ date: dstr(0), promptTokens: 50, completionTokens: 30 }], 'today')
    expect(m.tokens).toBe(80)
  })
})
