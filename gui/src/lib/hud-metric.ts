/**
 * hud-metric.ts — HUD 单数字常驻条的展示口径（2026-09-30，规格 §5）
 *
 * 场景：老板在会议中需要"瞄一眼"，不是"打开面板"。一条极薄的常驻条只承载
 * **一个数字 + 一个方向 + 一个风险点**；点击才展开完整卡。
 *
 * 本模块只做一件事：把取数结果与新鲜度**编译成一个可渲染的视图状态**。
 * 纯函数、无 React、无网络，因此"取数失败时到底显示什么"是断言而不是感觉。
 *
 * 为什么这条比看起来重要（规格 §5.2）：
 *   本项目已有教训——取数失败静默返回空数组，被当成"确实没有业务数据"。HUD 常驻在
 *   视野里，把"失败"显示成"0"会被持续当成事实，比一次性报错危险得多。
 *   因此四态必须**可被截图区分**：
 *     ok      正常数字 + 方向 + 新鲜度
 *     stale   数字仍在，但已过期/超阈值（数字旁带沙漏提示，不隐藏——旧数比无数有用）
 *     empty   确实没有数据（未导入）→ 明说"未导入"，不显示 0
 *     failed  取数失败 → 显示 `—` + 失败时间，**绝不显示 0**
 */

/** 常驻条展示的指标种类（可扩展；默认逾期应收） */
export type HudMetricKey = 'overdueReceivable' | 'receivableTotal' | 'monthRevenue' | 'contractsExpiring'

export const HUD_METRIC_LABELS: Record<HudMetricKey, string> = {
  overdueReceivable: '逾期应收',
  receivableTotal: '应收合计',
  monthRevenue: '本月营收',
  contractsExpiring: '临期合同',
}

/** 数据新鲜度阈值：超过即判定 stale（默认 24h） */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export type HudState = 'ok' | 'stale' | 'empty' | 'failed'

export interface HudView {
  state: HudState
  /** 指标名（如"逾期应收"） */
  label: string
  /**
   * 主数字的显示文本。
   * ok/stale → 数值文本（如 `37.4万`）；empty → `未导入`；failed → `—`
   */
  value: string
  /** 方向：与上期/上日的对比（`▲3笔` / `▼2笔` / null 表示无可比数据） */
  delta: string | null
  /** 风险点：最多一条，只在越过阈值时出现 */
  risk: string | null
  /** "多久前更新"——数据不新鲜却看起来正常，是比报错更危险的事 */
  freshness: string | null
  /** 失败/陈旧的说明（tooltip 与服务端 detail 用） */
  detail: string | null
  /** 是否可点击展开完整卡 */
  expandable: boolean
}

export interface HudInput {
  metric?: HudMetricKey
  /** 取数成功与否（sources.xxx.ok === false 即失败） */
  ok: boolean
  /** 失败原因（仅在 ok=false 时有意义） */
  errorDetail?: string | null
  /** 数值；null/undefined 表示无数据（≠ 0） */
  value?: number | null
  /** 上期值，用于算方向；无可比数据则不显示方向 */
  previous?: number | null
  /** 方向的单位（如"笔"/"份"）；无单位时按金额处理 */
  unit?: string | null
  /** 数据生成时刻（ms）；缺省则新鲜度未知 */
  generatedAt?: number | null
  /** 当前时刻（注入，便于测试） */
  now?: number
  /** 是否已导入过业务数据（未导入 → empty 而非 ok:0） */
  hasData?: boolean
  /** 风险点（调用方按阈值判断后传入；本模块只负责"最多一条"） */
  risk?: string | null
}

/** 金额说成人话（与晨报同口径，避免两处各写一套） */
export function formatHudMoney(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 100_000_000) return `${trim(n / 100_000_000)}亿`
  if (abs >= 10_000) return `${trim(n / 10_000)}万`
  return `${Math.round(n)}`
}

function trim(v: number): string {
  const r = Math.round(v * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

/** 新鲜度文案：尽量短（常驻条空间有限），且**不撒谎** */
export function formatFreshness(generatedAt: number | null | undefined, now: number): string | null {
  if (generatedAt == null || !Number.isFinite(generatedAt)) return null
  const age = Math.max(0, now - generatedAt)
  const min = Math.floor(age / 60_000)
  if (min < 1) return '刚刚更新'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/** 方向文案：绝对变化量优先（老板要看钱的绝对值，不是百分比） */
export function formatDelta(
  value: number | null | undefined,
  previous: number | null | undefined,
  unit: string | null | undefined,
  isMoney: boolean,
): string | null {
  if (value == null || previous == null) return null
  if (!Number.isFinite(value) || !Number.isFinite(previous)) return null
  const diff = value - previous
  if (diff === 0) return '持平'
  const arrow = diff > 0 ? '▲' : '▼'
  const mag = Math.abs(diff)
  const body = isMoney ? formatHudMoney(mag) : String(Math.round(mag))
  return `${arrow}${body}${unit || ''}`
}

/**
 * 编译常驻条视图状态。
 *
 * 判定顺序（顺序本身是设计决策）：
 *   1. 取数失败 → failed（即使有缓存数值也不能当 ok 显示——那会让人以为数据是新的）
 *   2. 未导入数据 → empty（明说"未导入"，不显示 0）
 *   3. 数值为 null → empty（"没有这个数"≠"这个数是 0"）
 *   4. 超过 STALE_AFTER_MS → stale（数字照显示 + 新鲜度提示；旧数比无数有用）
 *   5. 否则 ok
 */
export function buildHudView(input: HudInput): HudView {
  const metric = input.metric ?? 'overdueReceivable'
  const label = HUD_METRIC_LABELS[metric]
  const now = input.now ?? Date.now()
  const freshness = formatFreshness(input.generatedAt, now)
  const isMoney = metric === 'monthRevenue' || metric === 'receivableTotal'
  const risk = input.risk ? input.risk : null

  // 1) 取数失败：最优先，且绝不退化成数字
  if (!input.ok) {
    return {
      state: 'failed',
      label,
      value: '—',
      delta: null,
      risk: null,
      freshness,
      detail: input.errorDetail ? `取数失败：${input.errorDetail}` : '取数失败',
      expandable: true,
    }
  }

  // 2) 未导入业务数据
  if (input.hasData === false) {
    return {
      state: 'empty',
      label,
      value: '未导入',
      delta: null,
      risk: null,
      freshness,
      detail: '尚未导入经营数据',
      expandable: true,
    }
  }

  // 3) 该指标无数据（null ≠ 0）
  if (input.value == null || !Number.isFinite(input.value)) {
    return {
      state: 'empty',
      label,
      value: '无数据',
      delta: null,
      risk: null,
      freshness,
      detail: '该指标暂无数据',
      expandable: true,
    }
  }

  const isStale = input.generatedAt != null && now - input.generatedAt > STALE_AFTER_MS
  return {
    // 4) 陈旧：数字照显示（旧数比无数有用），但必须让老板看出来
    state: isStale ? 'stale' : 'ok',
    label,
    value: isMoney ? formatHudMoney(input.value) : String(Math.round(input.value)),
    delta: formatDelta(input.value, input.previous, input.unit, isMoney),
    risk,
    freshness,
    detail: isStale ? '数据已过期，建议刷新' : null,
    expandable: true,
  }
}

/** 常驻条是否应当"看起来正常"（用于决定是否加警示样式） */
export function isHudHealthy(view: HudView): boolean {
  return view.state === 'ok'
}

/**
 * 风险点筛选：最多一条，且只在越过阈值时才出现（常驻条不是清单）。
 * @returns 单条风险文案 或 null
 */
export function pickHudRisk(input: {
  overdueCount?: number | null
  overdueThreshold?: number
  contractsExpiring?: number | null
  contractsThreshold?: number
}): string | null {
  const { overdueCount, contractsExpiring } = input
  const oc = input.overdueThreshold ?? 1
  const cc = input.contractsThreshold ?? 1
  if (overdueCount != null && overdueCount >= oc) return `${overdueCount} 笔逾期`
  if (contractsExpiring != null && contractsExpiring >= cc) return `${contractsExpiring} 份合同临期`
  return null
}

/** 从 /api/briefing/today 的返回里提取 HUD 所需的输入（单一解释口径） */
export function hudInputFromBriefing(
  payload: {
    snapshot?: { revenue?: { month?: number | null; prevMonth?: number | null; generatedAt?: number | null }; risks?: { receivableOverdue?: number | null; totalReceivable?: number | null; contractsExpiring?: number | null }; generatedAt?: number | null } | null
    receivables?: { count?: number; amount?: number } | null
    contracts?: { count?: number } | null
    sources?: Record<string, { ok?: boolean; detail?: string }> | null
    generatedAt?: number | null
  } | null | undefined,
  metric: HudMetricKey,
  now?: number,
): HudInput {
  const p = payload || {}
  const sources = p.sources || null
  const risks = p.snapshot?.risks || {}
  const revenue = p.snapshot?.revenue || {}
  // 该指标依赖的数据源：失败要说失败，而不是显示 0
  const srcFor: Record<HudMetricKey, string> = {
    overdueReceivable: 'receivables',
    receivableTotal: 'receivables',
    monthRevenue: 'snapshot',
    contractsExpiring: 'contracts',
  }
  const srcName = srcFor[metric]
  const src = sources?.[srcName]
  const hasData = p.receivables != null || p.contracts != null || p.snapshot != null

  let value: number | null | undefined
  let previous: number | null | undefined
  let unit: string | null = null
  switch (metric) {
    case 'overdueReceivable':
      value = p.receivables?.count ?? risks.receivableOverdue ?? null
      unit = '笔'
      break
    case 'receivableTotal':
      value = p.receivables?.amount ?? risks.totalReceivable ?? null
      break
    case 'monthRevenue':
      value = revenue.month ?? null
      previous = revenue.prevMonth ?? null
      break
    case 'contractsExpiring':
      value = p.contracts?.count ?? risks.contractsExpiring ?? null
      unit = '份'
      break
  }

  return {
    metric,
    ok: src ? src.ok !== false : true,
    errorDetail: src?.detail ?? null,
    value,
    previous,
    unit,
    generatedAt: p.generatedAt ?? p.snapshot?.generatedAt ?? revenue.generatedAt ?? null,
    now,
    hasData,
    risk: pickHudRisk({
      overdueCount: p.receivables?.count ?? risks.receivableOverdue ?? null,
      contractsExpiring: p.contracts?.count ?? risks.contractsExpiring ?? null,
    }),
  }
}
