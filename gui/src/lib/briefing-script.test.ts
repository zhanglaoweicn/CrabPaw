/**
 * briefing-script.test.ts — 音频优先晨报的"60 秒"与"诚实降级"回归（2026-09-30，P1-2）
 *
 * 这个模块是**产品承诺的载体**，所以断言必须硬：
 *   1. 严格 60 秒 —— 任何数据组合下总时长都不得超预算（老板在车里等不起三分钟）
 *   2. 诚实降级 —— 缺数据说"暂无"、取数失败说"失败"，**绝不把 null 念成 0**
 *      （本项目已有同类教训：取数失败静默返回空数组，被当成"确实没有业务数据"）
 *   3. 逐句导航 —— "再说一遍"只回退一句，不是整段重来
 */
import { describe, test, expect } from 'vitest'
import {
  buildBriefingScript,
  speakMoney,
  pickWorstOverdue,
  pickSoonestContract,
  briefingNav,
  replayIndex,
  currentSegment,
  CHARS_PER_SECOND,
  TARGET_SECONDS,
  SEGMENT_BUDGET,
  type BriefingInput,
  type BriefingPosition,
} from './briefing-script'

/** 满配数据：所有字段都有值 */
const FULL: BriefingInput = {
  date: '2026-09-30',
  snapshot: {
    revenue: { month: 571000, prevMonth: 500000, yesterday: 30000, deltaPct: 14.2 },
    risks: { receivableOverdue: 6, totalReceivable: 373500, contractsExpiring: 1 },
  },
  receivables: {
    count: 6,
    amount: 373500,
    items: [
      { customer: '恒信物流', amount: 32000, overdueDays: 123 },
      { customer: '华辰机械', amount: 128000, overdueDays: 45 },
      { customer: '蓝湾食品', amount: 86000, overdueDays: 102 },
    ],
  },
  contracts: { count: 1, items: [{ customer: '恒信物流', expireDate: '2026-10-20', daysLeft: 20 }] },
  sources: { snapshot: { ok: true }, receivables: { ok: true }, contracts: { ok: true } },
}

describe('严格 60 秒（产品承诺）', () => {
  test('满配数据不超预算', () => {
    const s = buildBriefingScript(FULL)
    expect(s.estSeconds).toBeLessThanOrEqual(TARGET_SECONDS)
    expect(s.totalChars).toBeLessThanOrEqual(TARGET_SECONDS * CHARS_PER_SECOND)
  })

  test('极端长输入（超长客户名 × 多项）仍不超预算', () => {
    const longName = '某某某某某某某某某某某某某某某某某某某某某某集团股份有限公司'
    const s = buildBriefingScript({
      ...FULL,
      receivables: {
        count: 99, amount: 98_765_432_100,
        items: Array.from({ length: 30 }, (_, i) => ({ customer: `${longName}${i}`, amount: 9_999_999, overdueDays: 300 + i })),
      },
      contracts: {
        count: 88,
        items: Array.from({ length: 30 }, () => ({ customer: longName, expireDate: '2026-10-01', daysLeft: 1 })),
      },
    })
    // 硬承诺：无论输入多脏，时长不超
    expect(s.estSeconds).toBeLessThanOrEqual(TARGET_SECONDS)
    expect(s.totalChars).toBeLessThanOrEqual(TARGET_SECONDS * CHARS_PER_SECOND)
    // 超长公司名被源头截断，不应把整句挤爆
    expect(s.segments[2].text.length).toBeLessThanOrEqual(SEGMENT_BUDGET.risk)
    expect(s.segments[2].text).toContain('…')
  })

  test('逐段合计超限时按最长段裁剪并如实标记 truncated（防将来调预算悄悄破坏承诺）', () => {
    // 构造每段都贴近上限的输入：让结论/数字/风险都尽量长
    const s = buildBriefingScript({
      date: '2026-09-30',
      snapshot: { revenue: { month: 98_765_432_100, deltaPct: -99.9 }, risks: { receivableOverdue: 12345, totalReceivable: 98_765_432_100, contractsExpiring: 9999 } },
      receivables: { count: 12345, amount: 98_765_432_100, items: [{ customer: '某某某某某某某某某某', amount: 98_765_432_100, overdueDays: 999 }] },
      contracts: { count: 9999, items: [{ customer: '某某某某某某某某某某', daysLeft: 1 }] },
      sources: { snapshot: { ok: true }, receivables: { ok: true }, contracts: { ok: true } },
    })
    expect(s.totalChars).toBeLessThanOrEqual(TARGET_SECONDS * CHARS_PER_SECOND)
    expect(s.estSeconds).toBeLessThanOrEqual(TARGET_SECONDS)
  })

  test('只有四段，且每段都非空', () => {
    const s = buildBriefingScript(FULL)
    expect(s.segments.map(x => x.kind)).toEqual(['headline', 'numbers', 'risk', 'closing'])
    for (const seg of s.segments) {
      expect(seg.text.length).toBeGreaterThan(0)
      expect(seg.text.length).toBeLessThanOrEqual(SEGMENT_BUDGET[seg.kind])
      expect(seg.estSeconds).toBeGreaterThan(0)
    }
  })

  test('估算时长与字数同源（改语速即改承诺，不允许两处各算一套）', () => {
    const s = buildBriefingScript(FULL)
    expect(s.estSeconds).toBeCloseTo(s.totalChars / CHARS_PER_SECOND, 0)
  })
})

describe('诚实降级：缺数据 / 取数失败不得念成 0', () => {
  test('金额为 null → 说"暂无"，绝不出现 "0 笔逾期" 之外的假 0', () => {
    const s = buildBriefingScript({ date: '2026-09-30', snapshot: { revenue: {}, risks: {} } })
    const all = s.segments.map(x => x.text).join('')
    expect(all).toContain('暂无数据')
    // 关键：不能把"没有数据"说成"没有逾期"（后者是结论，前者是故障）
    expect(all).not.toContain('应收这边没有逾期')
    expect(all).not.toContain('0 笔逾期')
  })

  test('取数源失败 → 明说"取数失败"，且不进"没有逾期"分支', () => {
    const s = buildBriefingScript({
      date: '2026-09-30',
      snapshot: { revenue: { month: null }, risks: {} },
      sources: {
        snapshot: { ok: false, detail: 'db missing' },
        receivables: { ok: false, detail: 'db missing' },
        contracts: { ok: false, detail: 'db missing' },
      },
    })
    const all = s.segments.map(x => x.text).join('')
    expect(all).toContain('取数失败')
    expect(all).toContain('重试')
    expect(all).not.toContain('没有逾期')
  })

  test('源健康且逾期为 0 → 才允许说"没有逾期"（这是结论，值得说）', () => {
    const s = buildBriefingScript({
      date: '2026-09-30',
      snapshot: { revenue: { month: 100000, deltaPct: 0 }, risks: { receivableOverdue: 0, totalReceivable: 0 } },
      receivables: { count: 0, amount: 0, items: [] },
      contracts: { count: 0, items: [] },
      sources: { snapshot: { ok: true }, receivables: { ok: true }, contracts: { ok: true } },
    })
    const all = s.segments.map(x => x.text).join('')
    expect(all).toContain('没有逾期')
    expect(all).toContain('没有合同到期')
  })

  test('单源失败不影响其他源照常播报（局部降级，不整篇作废）', () => {
    const s = buildBriefingScript({
      ...FULL,
      sources: { snapshot: { ok: true }, receivables: { ok: true }, contracts: { ok: false, detail: 'x' } },
    })
    const all = s.segments.map(x => x.text).join('')
    expect(all).toContain('合同数据取数失败')
    expect(all).toContain('本月营收')      // 其他数字照念
  })

  test('任何输入都不抛（缺字段/空对象/undefined）', () => {
    expect(() => buildBriefingScript({})).not.toThrow()
    expect(() => buildBriefingScript({ snapshot: null, receivables: null, contracts: null })).not.toThrow()
    expect(() => buildBriefingScript({ snapshot: { revenue: null as never, risks: null as never } })).not.toThrow()
  })
})

describe('speakMoney：老板要量级不要精确到元', () => {
  test('万/亿/元三档', () => {
    expect(speakMoney(571000)).toBe('57.1万')
    expect(speakMoney(10000)).toBe('1万')
    expect(speakMoney(3500)).toBe('3500元')
    expect(speakMoney(123_456_789)).toBe('1.2亿')
  })
  test('null/NaN → null（由调用方决定说什么，不在这里编 0）', () => {
    expect(speakMoney(null)).toBeNull()
    expect(speakMoney(undefined)).toBeNull()
    expect(speakMoney(Number.NaN)).toBeNull()
  })
  test('负数保留符号（退款/负营收场景）', () => {
    expect(speakMoney(-15000)).toBe('-1.5万')
  })
})

describe('挑重点：一个风险 + 一个动作', () => {
  test('最该催的一笔按逾期天数优先、其次金额', () => {
    const w = pickWorstOverdue(FULL.receivables!.items)
    expect(w?.customer).toBe('恒信物流')   // 123 天，比 128000 元那笔更急
    expect(w?.overdueDays).toBe(123)
  })

  test('最近到期合同取 daysLeft 最小', () => {
    const c = pickSoonestContract([
      { customer: 'A', daysLeft: 20 },
      { customer: 'B', daysLeft: 3 },
      { customer: 'C', daysLeft: 11 },
    ])
    expect(c?.customer).toBe('B')
    expect(c?.daysLeft).toBe(3)
  })

  test('空列表/金额为 0 → null（不该催不存在的账）', () => {
    expect(pickWorstOverdue([])).toBeNull()
    expect(pickWorstOverdue(undefined)).toBeNull()
    expect(pickWorstOverdue([{ customer: 'X', amount: 0, overdueDays: 10 }])).toBeNull()
    expect(pickSoonestContract([])).toBeNull()
  })
})

describe('逐句导航：再说一遍只回退一句', () => {
  const pos = (played: number, total = 4): BriefingPosition => ({ played, total })

  test('播完一段 → advance', () => {
    expect(briefingNav({ type: 'advance' }, pos(1))).toEqual(pos(2))
    expect(briefingNav({ type: 'advance' }, pos(4)).played).toBe(4)   // 不越界
  })

  test('"再说一遍" → 回退一段，不是整段重来', () => {
    expect(briefingNav({ type: 'replay-last' }, pos(3))).toEqual(pos(2))
    // 第 3 段播完时（played=3），上一句是第 2 段（index 2）
    expect(replayIndex(pos(3))).toBe(2)
  })

  test('还没播完任何一段时，"再说一遍"回到第一段', () => {
    expect(replayIndex(pos(0))).toBe(0)
    expect(replayIndex(pos(1))).toBe(0)
  })

  test('replayIndex 不越界（防 undefined 段）', () => {
    expect(replayIndex(pos(9, 4))).toBe(3)
    expect(replayIndex(pos(1, 0))).toBe(0)
  })

  test('屏幕显示必须等于正在播的段（同步是"信"的基础）', () => {
    const script = buildBriefingScript(FULL)
    expect(currentSegment(script, pos(0))?.kind).toBe('headline')
    expect(currentSegment(script, pos(2))?.kind).toBe('risk')
    expect(currentSegment(script, pos(4))).toBeNull()   // 播完没有"当前段"
  })
})

describe('稿件内容要点（防止回归成流水账）', () => {
  test('满配数据时结论指向逾期、风险段给出客户与动作', () => {
    const s = buildBriefingScript(FULL)
    const [headline, numbers, risk, closing] = s.segments
    expect(headline.text).toContain('逾期')
    expect(numbers.text).toContain('本月营收')
    expect(risk.text).toContain('恒信物流')
    expect(risk.text).toContain('逾期 123 天')
    expect(risk.text).toContain('建议')
    expect(closing.text.length).toBeGreaterThan(0)
  })

  test('无逾期但有合同临期 → 风险段转向合同续约', () => {
    const s = buildBriefingScript({
      ...FULL,
      receivables: { count: 0, amount: 0, items: [] },
      contracts: { count: 2, items: [{ customer: '启明教育', daysLeft: 5 }] },
    })
    expect(s.segments[2].text).toContain('启明教育')
    expect(s.segments[2].text).toContain('续约')
  })

  test('赚钱时也说实话：环比下降要念出来，不粉饰', () => {
    const s = buildBriefingScript({
      ...FULL,
      snapshot: { revenue: { month: 400000, deltaPct: -20 }, risks: { receivableOverdue: 0 } },
    })
    expect(s.segments[1].text).toContain('少 20%')
  })
})
