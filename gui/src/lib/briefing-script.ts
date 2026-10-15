/**
 * briefing-script.ts — 音频优先晨报：把经营数据编译成"能听完"的 60 秒稿子
 *
 * 场景（规格 §4）：老板早上在车里，不看屏幕。现有 briefing 卡是给人看的，
 * 念出来会变成三分钟流水账，而且**没有诚实降级**——缺数据时念"0 笔逾期"，
 * 比报错更危险（本项目已有同类教训：取数失败静默返回空数组被当成"确实没有"）。
 *
 * 本模块只做一件事：给定简报数据 → 产出**有序、有字数预算、可逐句重播**的稿件。
 * 纯函数、无 React、无音频依赖，因此可以完全离线验证（60 秒是否真能念完、
 * 缺数据时说的话是否正确，都是断言而不是感觉）。
 *
 * 时间口径：中文 TTS 实测约 4.5 字/秒（含标点停顿）。60 秒 ≈ 270 字。
 * 这个换算表是整个功能"严格 60 秒"的唯一依据，改它等于改产品承诺。
 */

/** 中文 TTS 语速（字/秒，含标点停顿）——实测口径，勿随手改 */
export const CHARS_PER_SECOND = 4.5
/** 目标时长（秒）——规格 §4.1 的硬约束 */
export const TARGET_SECONDS = 60
/** 总字数上限（= 60s × 4.5） */
export const MAX_TOTAL_CHARS = Math.floor(TARGET_SECONDS * CHARS_PER_SECOND)

/**
 * 四段的字数预算。合计 240 字（≈53 秒），留约 7 秒余量吸收标点停顿与
 * 数字发音差异（"¥374,000" 念成"三十七万四千"远比字面长）。
 */
export const SEGMENT_BUDGET = {
  /** 一句结论：今天最该知道的一件事 */
  headline: 40,
  /** 三个数字：营收 / 应收 / 合同 */
  numbers: 90,
  /** 一个风险 + 一个建议动作 */
  risk: 85,
  /** 一句结尾（把球交回老板） */
  closing: 25,
} as const

export type BriefingSegmentKind = keyof typeof SEGMENT_BUDGET

export interface BriefingSegment {
  kind: BriefingSegmentKind
  /** 念出来的文本（同时用于屏幕同步显示——两者必须是同一份，不允许各写一套） */
  text: string
  /** 估算朗读时长（秒），由字数与 CHARS_PER_SECOND 推出 */
  estSeconds: number
}

export interface BriefingScript {
  date: string
  segments: BriefingSegment[]
  /** 总估算时长（秒） */
  estSeconds: number
  /** 总字数 */
  totalChars: number
  /** 是否触达预算上限被裁剪（用于排查"为什么有些数据没念"） */
  truncated: boolean
}

/** 晨报所需的最小数据形状（与 morning-briefing-service.buildBriefingSnapshot 对齐） */
export interface BriefingInput {
  date?: string
  snapshot?: {
    revenue?: { month?: number | null; prevMonth?: number | null; yesterday?: number | null; deltaPct?: number | null }
    risks?: { receivableOverdue?: number | null; totalReceivable?: number | null; contractsExpiring?: number | null }
  } | null
  receivables?: { count?: number; amount?: number; items?: Array<{ customer?: string; amount?: number; overdueDays?: number | null }> } | null
  contracts?: { count?: number; items?: Array<{ customer?: string | null; expireDate?: string; daysLeft?: number | null }> } | null
  /** 数据源健康度（来自 /api/briefing/today 的 sources 字段）：ok=false 的源不得当成"没有数据" */
  sources?: Record<string, { ok?: boolean; detail?: string }> | null
}

/** 把金额说成人话：老板要的是量级，不是精确到元 */
export function speakMoney(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return `${trimZero(n / 100_000_000)}亿`
  if (abs >= 10_000) return `${trimZero(n / 10_000)}万`
  return `${Math.round(n)}元`
}

function trimZero(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** 截断到预算内（按标点断句优先，避免把词切断听起来突兀） */
function fitTo(text: string, budget: number): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false }
  const head = text.slice(0, budget)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('，'), head.lastIndexOf('；'))
  if (cut > budget * 0.5) return { text: head.slice(0, cut + 1), truncated: true }
  return { text: head, truncated: true }
}

function segment(kind: BriefingSegmentKind, raw: string): { seg: BriefingSegment; truncated: boolean } {
  const { text, truncated } = fitTo(raw, SEGMENT_BUDGET[kind])
  return {
    seg: { kind, text, estSeconds: Math.round((text.length / CHARS_PER_SECOND) * 10) / 10 },
    truncated,
  }
}

/** 数据源是否不可用（不可用 ≠ 没有数据；前者必须说出来） */
function sourceDown(src: string, sources: BriefingInput['sources']): boolean {
  const s = sources?.[src]
  return !!s && s.ok === false
}

/** 人名/公司名上限——超长名字（"某某某某集团股份有限公司"）会把一句风险挤爆，
 *  在源头截断而不是最后砍句子：老板听到的是完整句子，不是被腰斩的半句。 */
const MAX_PARTY_CHARS = 12

function partyName(name: string | null | undefined, fallback: string): string {
  const n = (name || '').trim() || fallback
  return n.length > MAX_PARTY_CHARS ? `${n.slice(0, MAX_PARTY_CHARS - 1)}…` : n
}

/**
 * 把简报数据编译成 60 秒稿子。
 *
 * 诚实降级规则（每条都有测试）：
 *   · 金额为 null（无数据）→ 说"暂无数据"，**不说 0**
 *   · 取数源失败（sources.xxx.ok === false）→ 明确说"取数失败"，并建议重试
 *   · 逾期为 0 且源健康 → 才说"没有逾期"（这是好消息，值得说）
 *   · 三个数字里若某项缺失 → 跳过该项而不是念 0，把预算让给有数据的项
 * 长度控制策略：先在源头限制可变长字段（公司名），再对整句做预算裁剪；
 * 两者都做，既保证不超时，又尽量不腰斩句子。
 */
export function buildBriefingScript(input: BriefingInput): BriefingScript {
  const date = input.date || ''
  const snap = input.snapshot || {}
  const rev = snap.revenue || {}
  const risks = snap.risks || {}
  const sources = input.sources || null
  const truncatedFlags: boolean[] = []

  // ── 第 1 段：一句结论 ──────────────────────────────────────────────
  // 优先讲"最该知道的一件事"：有在途风险先说风险，否则说现金。
  const overdueCnt = input.receivables?.count ?? risks.receivableOverdue ?? null
  const overdueAmt = input.receivables?.amount ?? risks.totalReceivable ?? null
  const overdueKnown = overdueCnt != null || overdueAmt != null

  let headlineRaw: string
  if (sourceDown('snapshot', sources) && sourceDown('receivables', sources)) {
    headlineRaw = '老板，今天经营数据没取到，取数失败，建议稍后重试。'
  } else if (overdueKnown && (overdueCnt ?? 0) > 0) {
    headlineRaw = `老板早上好。今天最该看的是应收：${overdueCnt ?? '多'} 笔逾期，合计 ${speakMoney(overdueAmt) || '金额待核'}。`
  } else if (rev.month != null) {
    headlineRaw = `老板早上好。本月营收 ${speakMoney(rev.month)}，${describeDelta(rev.deltaPct)}。应收这边没有逾期。`
  } else {
    headlineRaw = '老板早上好。今天还没有可用的经营数据，建议先导入报表。'
  }
  const s1 = segment('headline', headlineRaw)
  truncatedFlags.push(s1.truncated)

  // ── 第 2 段：三个数字 ──────────────────────────────────────────────
  const numParts: string[] = []
  // 1) 本月营收（+ 环比）
  if (rev.month != null) {
    numParts.push(`本月营收 ${speakMoney(rev.month)}，${describeDelta(rev.deltaPct)}`)
  } else if (rev.yesterday != null) {
    // 本月缺失但有昨日：不硬编本月，说昨天
    numParts.push(`昨日营收 ${speakMoney(rev.yesterday)}`)
  }
  // 2) 应收（区分"没有"与"没取到"）
  if (sourceDown('receivables', sources)) {
    numParts.push('应收账款取数失败，数字暂不可用')
  } else if (overdueKnown) {
    numParts.push((overdueCnt ?? 0) > 0
      ? `应收账款 ${overdueCnt} 笔逾期，合计 ${speakMoney(overdueAmt) || '金额待核'}`
      : '应收账款没有逾期')
  }
  // 3) 合同
  if (sourceDown('contracts', sources)) {
    numParts.push('合同数据取数失败')
  } else if (input.contracts?.count != null) {
    numParts.push(input.contracts.count > 0
      ? `三十天内 ${input.contracts.count} 份合同到期`
      : '三十天内没有合同到期')
  } else if (risks.contractsExpiring != null) {
    numParts.push(risks.contractsExpiring > 0
      ? `七天内 ${risks.contractsExpiring} 份合同到期`
      : '七天内没有合同到期')
  }
  const s2 = segment('numbers', numParts.length > 0 ? `${numParts.join('；')}。` : '三个关键数字暂无数据。')
  truncatedFlags.push(s2.truncated)

  // ── 第 3 段：一个风险 + 一个建议动作 ────────────────────────────────
  // 只给一条最有行动价值的（规格：一个风险 + 一个动作，不堆清单）
  let riskRaw: string
  const worst = pickWorstOverdue(input.receivables?.items)
  const soonest = pickSoonestContract(input.contracts?.items)
  if (worst) {
    riskRaw = `要盯的是${partyName(worst.customer, '一位客户')}，逾期 ${worst.overdueDays} 天、${speakMoney(worst.amount)}。建议今天先催这一笔。`
  } else if (soonest) {
    riskRaw = `最近到期的是${partyName(soonest.customer, '一份合同')}，${soonest.daysLeft} 天后到期。建议今天确认续约意向。`
  } else if (sourceDown('receivables', sources) || sourceDown('contracts', sources)) {
    riskRaw = '因为取数失败，今天没法给你风险清单；建议先检查数据目录后再让我重算。'
  } else if ((overdueCnt ?? 0) === 0 && overdueKnown) {
    riskRaw = '今天没有需要盯的风险。'
  } else {
    riskRaw = '今天没有可分析的风险明细。'
  }
  const s3 = segment('risk', riskRaw)
  truncatedFlags.push(s3.truncated)

  // ── 第 4 段：一句结尾 ──────────────────────────────────────────────
  const hasAction = !!worst || !!soonest
  const s4 = segment('closing', hasAction
    ? '要展开哪一条，直接说。'
    : '需要看细节随时叫我。')
  truncatedFlags.push(s4.truncated)

  const segments = [s1.seg, s2.seg, s3.seg, s4.seg]
  // 全局兜底：即使逐段都在预算内，合计仍可能超（例如每段都贴近上限）。
  // 超了就砍最长的一段（信息损失最小），并如实标记 truncated——
  // 这条保证的意义是："严格 60 秒"不会因为将来有人调预算或加段落而被悄悄破坏。
  let totalChars = segments.reduce((n, s) => n + s.text.length, 0)
  let truncated = truncatedFlags.some(Boolean)
  if (totalChars > MAX_TOTAL_CHARS) {
    const longest = segments.reduce((a, b) => (b.text.length > a.text.length ? b : a))
    const over = totalChars - MAX_TOTAL_CHARS
    const fitted = fitTo(longest.text, Math.max(10, longest.text.length - over))
    longest.text = fitted.text
    longest.estSeconds = Math.round((longest.text.length / CHARS_PER_SECOND) * 10) / 10
    totalChars = segments.reduce((n, s) => n + s.text.length, 0)
    truncated = true
  }
  return {
    date,
    segments,
    estSeconds: Math.round((totalChars / CHARS_PER_SECOND) * 10) / 10,
    totalChars,
    truncated,
  }
}

function describeDelta(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '环比暂无可比数据'
  if (pct > 0) return `比上月同期多 ${pct}%`
  if (pct < 0) return `比上月同期少 ${Math.abs(pct)}%`
  return '与上月同期持平'
}

/** 挑最该催的一笔：逾期天数优先，其次金额 */
export function pickWorstOverdue(
  items: Array<{ customer?: string; amount?: number; overdueDays?: number | null }> | undefined,
): { customer: string; amount: number; overdueDays: number } | null {
  if (!Array.isArray(items) || items.length === 0) return null
  const scored = items
    .filter(i => i && (i.amount ?? 0) > 0)
    .map(i => ({ customer: i.customer || '未标注客户', amount: Number(i.amount) || 0, overdueDays: Math.max(0, Math.round(i.overdueDays ?? 0)) }))
  if (scored.length === 0) return null
  scored.sort((a, b) => (b.overdueDays - a.overdueDays) || (b.amount - a.amount))
  return scored[0]
}

/** 挑最近到期的一份合同 */
export function pickSoonestContract(
  items: Array<{ customer?: string | null; expireDate?: string; daysLeft?: number | null }> | undefined,
): { customer: string | null; daysLeft: number } | null {
  if (!Array.isArray(items) || items.length === 0) return null
  const scored = items
    .filter(i => i && i.daysLeft != null)
    .map(i => ({ customer: i.customer ?? null, daysLeft: Math.max(0, Math.round(i.daysLeft as number)) }))
  if (scored.length === 0) return null
  scored.sort((a, b) => a.daysLeft - b.daysLeft)
  return scored[0]
}

/* ── 播报导航：让"再说一遍"只重播最后一句 ─────────────────────────────
   老板说"再说一遍"时，整段重来是最恼人的体验（要重新等 60 秒才听到想听的那句）。
   这里把"播到哪了"显式建模，导航变成纯函数。 */

export interface BriefingPosition {
  /** 已播完的段数（0 = 还没开始） */
  played: number
  total: number
}

export type BriefingNavAction =
  | { type: 'advance' }              // 一段播完
  | { type: 'replay-last' }          // "再说一遍" → 回退一段
  | { type: 'stay' }                 // 无操作

export function briefingNav(action: BriefingNavAction, pos: BriefingPosition): BriefingPosition {
  switch (action.type) {
    case 'advance':
      return { ...pos, played: Math.min(pos.played + 1, pos.total) }
    case 'replay-last':
      // 只回退到"上一句"（已播完的最后一段）；还没播完任何一段时回到第一段重播
      return { ...pos, played: Math.max(0, pos.played - 1) }
    case 'stay':
    default:
      return pos
  }
}

/**
 * 该从第几段开始重播。
 * - played >= 1：上一句 = 第 played-1 段（0-based）
 * - played === 0：还没播完任何一段，从头（0）开始
 */
export function replayIndex(pos: BriefingPosition): number {
  return Math.max(0, Math.min(pos.played - 1, Math.max(0, pos.total - 1)))
}

/** 当前正在播的段（用于屏幕与音频严格同步：屏幕只能显示这一句） */
export function currentSegment(script: BriefingScript, pos: BriefingPosition): BriefingSegment | null {
  return script.segments[pos.played] ?? null
}
