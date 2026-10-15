/**
 * business-scene.test.ts — 经营数据三维化映射回归（2026-09-30，P2）
 *
 * 本用例锁的是**业务语义**，不是渲染：
 *   · 账龄分桶边界正确（31 天应落 31-60 而不是 0-30）
 *   · 纵深随账龄递增（"越深越老"是这张图的全部意义）
 *   · 自发光/异常随"该看程度"递增（视线要被正确的东西吸走）
 *   · 集中度能识别"押注单一客户"
 *   · 空数据给空态原因，而不是画一个空场景
 */
import { describe, test, expect } from 'vitest'
import {
  AGING_BUCKETS,
  bucketOf,
  computeConcentration,
  buildBusinessScene,
  toFlatRows,
  sceneSummary,
  ALARM_SHARE,
  CONCENTRATION_ALARM,
  type AgingItem,
} from './business-scene'

const ITEMS: AgingItem[] = [
  { customer: '恒信物流', amount: 32000, overdueDays: 123 },   // 90+
  { customer: '华辰机械', amount: 128000, overdueDays: 45 },   // 31-60
  { customer: '蓝湾食品', amount: 86000, overdueDays: 102 },   // 90+
  { customer: '天成医疗', amount: 66000, overdueDays: 33 },    // 31-60
  { customer: '启明教育', amount: 42000, overdueDays: 77 },    // 61-90
  { customer: '云杉科技', amount: 19500, overdueDays: 20 },    // 0-30
]

describe('账龄分桶', () => {
  test('边界值落桶正确（31 天属于 31-60，不属于 0-30）', () => {
    expect(bucketOf(0)).toBe('0-30')
    expect(bucketOf(30)).toBe('0-30')
    expect(bucketOf(31)).toBe('31-60')
    expect(bucketOf(60)).toBe('31-60')
    expect(bucketOf(61)).toBe('61-90')
    expect(bucketOf(90)).toBe('61-90')
    expect(bucketOf(91)).toBe('90+')
    expect(bucketOf(999)).toBe('90+')
  })

  test('缺失/非法天数 → null（不猜成 0-30）', () => {
    expect(bucketOf(null)).toBeNull()
    expect(bucketOf(undefined)).toBeNull()
    expect(bucketOf(Number.NaN)).toBeNull()
  })

  test('负数（数据脏）也算 0-30，不产生负账龄段', () => {
    expect(bucketOf(-5)).toBe('0-30')
  })

  test('分桶定义深度递增（"越深越老"是这张图的意义）', () => {
    const depths = AGING_BUCKETS.map(b => b.depth)
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeGreaterThan(depths[i - 1])
  })
})

describe('场景构建', () => {
  test('默认按账龄段聚合（4 段 → 最多 4 个节点）', () => {
    const s = buildBusinessScene(ITEMS)
    expect(s.nodes.length).toBe(4)                    // 六笔分落四段
    expect(s.totalAmount).toBe(373500)
    expect(s.totalCount).toBe(6)
    expect(s.emptyReason).toBeNull()
  })

  test('纵深随账龄递增（z 是账龄轴）', () => {
    const s = buildBusinessScene(ITEMS)
    const zOf = (key: string) => s.nodes.find(n => n.key.startsWith(key))!.position.z
    expect(zOf('0-30')).toBeLessThan(zOf('31-60'))
    expect(zOf('31-60')).toBeLessThan(zOf('61-90'))
    expect(zOf('61-90')).toBeLessThan(zOf('90+'))
  })

  test('尺度归一化：最大段 scale=1，段金额按比例', () => {
    const s = buildBusinessScene(ITEMS)
    const max = Math.max(...s.nodes.map(n => n.amount))
    const maxNode = s.nodes.find(n => n.amount === max)!
    expect(maxNode.scale).toBeCloseTo(1, 5)
    for (const n of s.nodes) expect(n.scale).toBeCloseTo(n.amount / s.maxAmount, 5)
  })

  test('金额占比合计为 1（share 是可信的比例）', () => {
    const s = buildBusinessScene(ITEMS)
    const sum = s.nodes.reduce((a, n) => a + n.share, 0)
    expect(sum).toBeCloseTo(1, 5)
  })

  test('自发光随"该看程度"递增：占比越大越亮', () => {
    const s = buildBusinessScene(ITEMS)
    const small = s.nodes.reduce((a, b) => (a.amount < b.amount ? a : b))
    const big = s.nodes.reduce((a, b) => (a.amount > b.amount ? a : b))
    expect(big.glow).toBeGreaterThan(small.glow)
    for (const n of s.nodes) {
      expect(n.glow).toBeGreaterThanOrEqual(0)
      expect(n.glow).toBeLessThanOrEqual(1)
    }
  })

  test('90+ 段必定告警（最老一段最该被看见）', () => {
    const s = buildBusinessScene(ITEMS)
    const oldest = s.nodes.find(n => n.key.startsWith('90+'))!
    expect(oldest.alarm).toBe(true)
  })

  test('单段占比超阈值 → 告警（钱过度堆在一段账龄里）', () => {
    const s = buildBusinessScene([
      { customer: 'A', amount: 900000, overdueDays: 45 },
      { customer: 'B', amount: 100000, overdueDays: 20 },
    ])
    const big = s.nodes.reduce((a, b) => (a.amount > b.amount ? a : b))
    expect(big.share).toBeGreaterThan(ALARM_SHARE)
    expect(big.alarm).toBe(true)
  })

  test('perCustomer：按客户细分，标签带客户名', () => {
    const s = buildBusinessScene(ITEMS, { perCustomer: true })
    expect(s.nodes.length).toBe(6)
    const hx = s.nodes.find(n => n.label.includes('恒信物流'))!
    expect(hx.label).toContain('90 天以上')
    expect(hx.count).toBe(1)
  })

  test('同段多客户横向铺开且**居中**（一眼看集中度）', () => {
    const s = buildBusinessScene([
      { customer: 'A', amount: 100, overdueDays: 40 },
      { customer: 'B', amount: 100, overdueDays: 45 },
      { customer: 'C', amount: 100, overdueDays: 50 },
    ], { perCustomer: true })
    const xs = s.nodes.map(n => n.position.x).sort((a, b) => a - b)
    expect(xs).toHaveLength(3)
    // 居中：三点均值应为 0（间距 1.4 → -1.4 / 0 / +1.4）
    expect(xs.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 5)
  })

  test('单客户单段时 x 居中为 0', () => {
    const s = buildBusinessScene([{ customer: 'A', amount: 100, overdueDays: 45 }])
    expect(s.nodes[0].position.x).toBeCloseTo(0, 5)
  })
})

describe('集中度：是否押注单一客户', () => {
  test('单一客户超阈值 → risky', () => {
    const c = computeConcentration([
      { customer: '华辰机械', amount: 800000, overdueDays: 40 },
      { customer: '其他', amount: 200000, overdueDays: 10 },
    ])
    expect(c.topCustomer).toBe('华辰机械')
    expect(c.topShare).toBeCloseTo(0.8, 5)
    expect(c.risky).toBe(true)
    expect(c.topShare).toBeGreaterThan(CONCENTRATION_ALARM)
  })

  test('分散 → 不 risky', () => {
    const c = computeConcentration(ITEMS)
    expect(c.risky).toBe(false)
    expect(c.topShare).toBeLessThan(CONCENTRATION_ALARM)
  })

  test('同一客户多笔合并计算（不会被拆散而低估集中度）', () => {
    const c = computeConcentration([
      { customer: '华辰机械', amount: 300000, overdueDays: 40 },
      { customer: '华辰机械', amount: 300000, overdueDays: 80 },
      { customer: '其他', amount: 400000, overdueDays: 10 },
    ])
    expect(c.topCustomer).toBe('华辰机械')
    expect(c.topShare).toBeCloseTo(0.6, 5)
  })

  test('空输入 → 不算 risky（没有数据不是风险）', () => {
    const c = computeConcentration([])
    expect(c.topCustomer).toBeNull()
    expect(c.risky).toBe(false)
  })
})

describe('空态与二维替代', () => {
  test('无账目 → 给空态原因，而不是空场景', () => {
    const s = buildBusinessScene([])
    expect(s.nodes).toEqual([])
    expect(s.emptyReason).toBeTruthy()
    expect(sceneSummary(s)).toBe(s.emptyReason)
  })

  test('金额为 0/负数的脏数据被忽略（不画 0 高柱）', () => {
    const s = buildBusinessScene([
      { customer: 'A', amount: 0, overdueDays: 40 },
      { customer: 'B', amount: -100, overdueDays: 40 },
      { customer: 'C', amount: 500, overdueDays: 40 },
    ])
    expect(s.nodes).toHaveLength(1)
    expect(s.totalAmount).toBe(500)
  })

  test('二维替代行：按金额降序、带占比、保留告警位（L0 不丢信息）', () => {
    const s = buildBusinessScene([
      { customer: 'A', amount: 900000, overdueDays: 45 },
      { customer: 'B', amount: 100000, overdueDays: 20 },
    ])
    const rows = toFlatRows(s)
    expect(rows[0].amount).toBeGreaterThanOrEqual(rows[1].amount)
    expect(rows[0].shareText).toBe('90%')
    expect(rows[0].alarm).toBe(true)
    expect(rows[1].alarm).toBe(false)
  })

  test('二维替代的行数与三维节点数一致（同源，不丢项）', () => {
    const s = buildBusinessScene(ITEMS, { perCustomer: true })
    expect(toFlatRows(s)).toHaveLength(s.nodes.length)
  })
})

describe('结论文案（卡片与语音共用一份）', () => {
  test('含最老账龄段与集中客户占比', () => {
    const s = buildBusinessScene(ITEMS)
    const text = sceneSummary(s)
    expect(text).toContain('90 天以上')
    expect(text).toContain('华辰机械')
    expect(text).toContain('%')
  })

  test('高度集中时明说"集中度偏高"（不粉饰）', () => {
    const s = buildBusinessScene([
      { customer: '华辰机械', amount: 900000, overdueDays: 45 },
      { customer: 'B', amount: 100000, overdueDays: 20 },
    ])
    expect(sceneSummary(s)).toContain('集中度偏高')
  })

  test('空态直接返回原因', () => {
    expect(sceneSummary(buildBusinessScene([]))).toContain('没有逾期账目')
  })
})
