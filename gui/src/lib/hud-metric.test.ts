/**
 * hud-metric.test.ts — HUD 单数字常驻条的展示口径回归（2026-09-30，P1-3）
 *
 * 本用例的重心是**诚实降级**，而不是排版：
 *   常驻条待在视野里，把"取数失败"显示成"0"，会被持续当成事实——
 *   比一次性报错危险得多（本项目已有"取数失败静默返回空数组"的教训）。
 *   因此四态（ok / stale / empty / failed）必须可被区分，且**永不用 0 冒充失败**。
 */
import { describe, test, expect } from 'vitest'
import {
  buildHudView,
  formatHudMoney,
  formatFreshness,
  formatDelta,
  pickHudRisk,
  hudInputFromBriefing,
  isHudHealthy,
  STALE_AFTER_MS,
  type HudInput,
} from './hud-metric'

const NOW = 1_800_000_000_000 // 固定时刻，避免用例随真实时间漂移
const base: HudInput = {
  metric: 'overdueReceivable',
  ok: true,
  value: 6,
  previous: 3,
  unit: '笔',
  generatedAt: NOW - 60_000,
  now: NOW,
  hasData: true,
}

describe('四态判定（顺序即设计）', () => {
  test('正常 → ok，带数字/方向/新鲜度', () => {
    const v = buildHudView(base)
    expect(v.state).toBe('ok')
    expect(v.value).toBe('6')
    expect(v.delta).toBe('▲3笔')
    expect(v.freshness).toBe('1 分钟前')
    expect(isHudHealthy(v)).toBe(true)
  })

  test('【最关键】取数失败 → failed，显示 — 而不是 0', () => {
    const v = buildHudView({ ...base, ok: false, value: 0, errorDetail: 'business.db 不存在' })
    expect(v.state).toBe('failed')
    expect(v.value).toBe('—')
    expect(v.value).not.toBe('0')
    expect(v.detail).toContain('取数失败')
    expect(v.detail).toContain('business.db')
    expect(isHudHealthy(v)).toBe(false)
  })

  test('失败时即使带缓存数值也不当 ok 显示（否则会被当成新数据）', () => {
    const v = buildHudView({ ...base, ok: false, value: 373500 })
    expect(v.state).toBe('failed')
    expect(v.value).toBe('—')
  })

  test('未导入数据 → empty，明说"未导入"，不是 0', () => {
    const v = buildHudView({ ...base, hasData: false, value: 0, previous: 0 })
    expect(v.state).toBe('empty')
    expect(v.value).toBe('未导入')
    expect(v.detail).toContain('尚未导入')
  })

  test('该指标为 null → empty（"没有这个数" ≠ "这个数是 0"）', () => {
    expect(buildHudView({ ...base, value: null }).state).toBe('empty')
    expect(buildHudView({ ...base, value: undefined }).value).toBe('无数据')
  })

  test('值确实是 0 → ok（源健康、确实没有逾期，这是结论）', () => {
    const v = buildHudView({ ...base, value: 0, previous: 0 })
    expect(v.state).toBe('ok')
    expect(v.value).toBe('0')
    expect(v.delta).toBe('持平')
  })

  test('超过阈值 → stale：数字照显示 + 新鲜度提示（旧数比无数有用）', () => {
    const v = buildHudView({ ...base, generatedAt: NOW - STALE_AFTER_MS - 1 })
    expect(v.state).toBe('stale')
    expect(v.value).toBe('6')          // 不隐藏数字
    expect(v.detail).toContain('过期')
    expect(isHudHealthy(v)).toBe(false)
  })

  test('恰好等于阈值不算 stale（边界不抖动）', () => {
    expect(buildHudView({ ...base, generatedAt: NOW - STALE_AFTER_MS }).state).toBe('ok')
  })

  test('failed 优先于 stale/empty（失败是最需要被看见的状态）', () => {
    const v = buildHudView({ ...base, ok: false, hasData: false, value: null, generatedAt: NOW - STALE_AFTER_MS - 1 })
    expect(v.state).toBe('failed')
  })

  test('未知新鲜度 → 不编造"刚刚更新"', () => {
    const v = buildHudView({ ...base, generatedAt: null })
    expect(v.freshness).toBeNull()
    expect(v.state).toBe('ok')
  })
})

describe('数字与方向的口径', () => {
  test('金额量级化（老板要量级不要精确到元）', () => {
    expect(formatHudMoney(373500)).toBe('37.4万')
    expect(formatHudMoney(10000)).toBe('1万')
    expect(formatHudMoney(3500)).toBe('3500')
    expect(formatHudMoney(123_456_789)).toBe('1.2亿')
  })

  test('方向用绝对变化量 + 单位（不是百分比）', () => {
    expect(formatDelta(6, 3, '笔', false)).toBe('▲3笔')
    expect(formatDelta(3, 6, '笔', false)).toBe('▼3笔')
    expect(formatDelta(373500, 300000, null, true)).toBe('▲7.4万')
    expect(formatDelta(5, 5, '笔', false)).toBe('持平')
  })

  test('无可比数据 → 不显示方向（不编个 0% 出来）', () => {
    expect(formatDelta(6, null, '笔', false)).toBeNull()
    expect(formatDelta(null, 3, '笔', false)).toBeNull()
    expect(buildHudView({ ...base, previous: null }).delta).toBeNull()
  })

  test('新鲜度文案随跨度变化，且不出现负数', () => {
    expect(formatFreshness(NOW - 30_000, NOW)).toBe('刚刚更新')
    expect(formatFreshness(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(formatFreshness(NOW - 3 * 3600_000, NOW)).toBe('3 小时前')
    expect(formatFreshness(NOW - 2 * 86400_000, NOW)).toBe('2 天前')
    expect(formatFreshness(NOW + 60_000, NOW)).toBe('刚刚更新')   // 时钟回拨也不显示负数
    expect(formatFreshness(null, NOW)).toBeNull()
  })
})

describe('风险点：最多一条', () => {
  test('逾期优先于合同（先讲钱的去向）', () => {
    expect(pickHudRisk({ overdueCount: 6, contractsExpiring: 2 })).toBe('6 笔逾期')
  })
  test('无逾期但有临期合同 → 报合同', () => {
    expect(pickHudRisk({ overdueCount: 0, contractsExpiring: 2 })).toBe('2 份合同临期')
  })
  test('都没越过阈值 → null（常驻条不是清单）', () => {
    expect(pickHudRisk({ overdueCount: 0, contractsExpiring: 0 })).toBeNull()
    expect(pickHudRisk({})).toBeNull()
  })
  test('阈值可调：设为 5 时 3 笔不报', () => {
    expect(pickHudRisk({ overdueCount: 3, overdueThreshold: 5 })).toBeNull()
    expect(pickHudRisk({ overdueCount: 5, overdueThreshold: 5 })).toBe('5 笔逾期')
  })
})

describe('从 /api/briefing/today 提取（单一解释口径）', () => {
  const payload = {
    generatedAt: NOW - 60_000,
    snapshot: { revenue: { month: 571000, prevMonth: 500000 }, risks: { receivableOverdue: 6, totalReceivable: 373500, contractsExpiring: 1 } },
    receivables: { count: 6, amount: 373500 },
    contracts: { count: 1 },
    sources: { snapshot: { ok: true }, receivables: { ok: true }, contracts: { ok: true } },
  }

  test('逾期应收（默认指标）：无上期数据则不给方向（不编 0%）', () => {
    const v = buildHudView(hudInputFromBriefing(payload, 'overdueReceivable', NOW))
    expect(v.state).toBe('ok')
    expect(v.label).toBe('逾期应收')
    expect(v.value).toBe('6')
    // briefing 载荷里没有"上期逾期笔数"，因此不该显示方向——
    // 显示"▲6笔"会让人以为比上次多了 6 笔（实际是首次展示）
    expect(v.delta).toBeNull()
  })

  test('本月营收带环比方向', () => {
    const v = buildHudView(hudInputFromBriefing(payload, 'monthRevenue', NOW))
    expect(v.value).toBe('57.1万')
    expect(v.delta).toBe('▲7.1万')
  })

  test('源失败 → failed（HUD 不进"0 笔"陷阱）', () => {
    const bad = { ...payload, sources: { ...payload.sources, receivables: { ok: false, detail: 'db missing' } } }
    const v = buildHudView(hudInputFromBriefing(bad, 'overdueReceivable', NOW))
    expect(v.state).toBe('failed')
    expect(v.value).toBe('—')
    expect(v.detail).toContain('db missing')
  })

  test('payload 为空/undefined 不抛（首帧尚无数据）', () => {
    expect(() => buildHudView(hudInputFromBriefing(null, 'overdueReceivable', NOW))).not.toThrow()
    expect(() => buildHudView(hudInputFromBriefing(undefined, 'monthRevenue', NOW))).not.toThrow()
  })

  test('风险点从同一份 payload 取（不两处各算一套）', () => {
    const v = buildHudView(hudInputFromBriefing(payload, 'overdueReceivable', NOW))
    expect(v.risk).toBe('6 笔逾期')
  })
})

describe('展示文本不会被误读', () => {
  test('failed/empty 的 value 都不是纯数字（截图可辨认）', () => {
    expect(buildHudView({ ...base, ok: false }).value).toMatch(/[^0-9.]/)
    expect(buildHudView({ ...base, hasData: false }).value).toMatch(/[^0-9.]/)
    expect(buildHudView({ ...base, value: null }).value).toMatch(/[^0-9.]/)
  })

  test('ok 时 value 是纯数字文本（便于等宽对齐）', () => {
    expect(buildHudView(base).value).toMatch(/^[0-9.]+$/)
  })
})
