/**
 * business-scene.ts — 经营数据三维化的映射层（2026-09-30，P2）
 *
 * 目的（规格 §6.2）：老板问"钱卡在哪一段账龄"时，用**空间**回答比用表格快。
 * 映射约定：
 *   · 账龄 → 纵深轴（越深越老）
 *   · 金额 → 体积/高度
 *   · 异常 → 自发光强度（视线自然被亮的吸走）
 *   · 集中度 → 横向聚拢/散开（一眼看出是否押注单一客户）
 *
 * 本模块只做"业务量 → 空间与视觉参数"的纯映射，**不碰 three.js、不碰 DOM**：
 *   · 因此渲染器可以换（WebGL / Canvas / 未来导出视频）而不改业务口径
 *   · 因此"哪个柱子该发光""账龄怎么分桶"都是断言而不是感觉
 *
 * 一条硬约束（规格 §6.2 防止玩具化）：本视图**只在老板主动要看时出现**，
 * 且任何档位下都必须能拿到同样的信息（L0 用二维替代，靠的就是本模块产出的数据）。
 */

/** 账龄分桶（逾期天数；上界不含） */
export const AGING_BUCKETS = [
  { key: '0-30', label: '0-30 天', from: 0, to: 31, depth: 0.0 },
  { key: '31-60', label: '31-60 天', from: 31, to: 61, depth: 1.0 },
  { key: '61-90', label: '61-90 天', from: 61, to: 91, depth: 2.0 },
  { key: '90+', label: '90 天以上', from: 91, to: Infinity, depth: 3.0 },
] as const

export type AgingBucketKey = typeof AGING_BUCKETS[number]['key']

/** 一条逾期账目（来自 listOverdueReceivables / v_receivable） */
export interface AgingItem {
  customer: string
  amount: number
  overdueDays: number | null
}

/** 场景里的一个数据体（一根柱 / 一个节点） */
export interface SceneNode {
  key: string
  kind: 'aging'
  /** 显示名（账龄段或"客户 · 账龄段"） */
  label: string
  /** 金额（业务真值） */
  amount: number
  /** 该段的账目笔数 */
  count: number
  /** 空间位置（渲染器负责缩放到实际场景尺寸） */
  position: { x: number; y: number; z: number }
  /** 归一化尺度 0..1（金额/最大金额），渲染器据此定高度与体积 */
  scale: number
  /** 自发光强度 0..1（越高越"该看"） */
  glow: number
  /** 是否达到异常阈值（决定是否脉冲提示） */
  alarm: boolean
  /** 桶内占总额比例 0..1（用于文案"占 62%"） */
  share: number
}

/** 客户集中度（横向聚拢/散开的依据） */
export interface Concentration {
  /** 占比最高的客户 */
  topCustomer: string | null
  /** 其占比 0..1 */
  topShare: number
  /** 是否过度集中（默认 >50% 视为押注单一客户） */
  risky: boolean
}

export interface BusinessScene {
  nodes: SceneNode[]
  /** 金额轴最大值（渲染器归一化用；0 表示无数据） */
  maxAmount: number
  /** 总额 */
  totalAmount: number
  /** 账目总笔数 */
  totalCount: number
  concentration: Concentration
  /** 最老一段的账龄文案（结论：钱卡在哪一段） */
  worstLabel: string | null
  /** 空态原因（无数据时给文案，而不是画一个空场景） */
  emptyReason: string | null
}

/** 异常阈值：单段金额占比超过此值即视为需要关注（默认 40%） */
export const ALARM_SHARE = 0.4
/** 集中度预警阈值：单一客户占比超过此值视为押注（默认 50%） */
export const CONCENTRATION_ALARM = 0.5

/** 把逾期天数归入账龄桶 */
export function bucketOf(overdueDays: number | null | undefined): AgingBucketKey | null {
  if (overdueDays == null || !Number.isFinite(overdueDays)) return null
  const d = Math.max(0, Math.round(overdueDays))
  for (const b of AGING_BUCKETS) {
    if (d >= b.from && d < b.to) return b.key
  }
  return '90+'
}

/** 客户集中度：最大单一客户占比 */
export function computeConcentration(items: AgingItem[]): Concentration {
  const byCustomer = new Map<string, number>()
  let total = 0
  for (const it of items) {
    const amt = Number(it.amount) || 0
    if (amt <= 0) continue
    const name = it.customer || '未标注客户'
    byCustomer.set(name, (byCustomer.get(name) || 0) + amt)
    total += amt
  }
  if (total <= 0 || byCustomer.size === 0) {
    return { topCustomer: null, topShare: 0, risky: false }
  }
  let topCustomer = ''
  let topAmount = -1
  for (const [name, amt] of byCustomer) {
    if (amt > topAmount) { topAmount = amt; topCustomer = name }
  }
  const topShare = topAmount / total
  return { topCustomer, topShare, risky: topShare > CONCENTRATION_ALARM }
}

/**
 * 构建三维场景模型（纯函数）。
 *
 * 空间约定：
 *   z = 账龄段深度（0 最近 → 3 最老）
 *   x = 同段内客户横向铺开（体现集中度：客户越少越聚拢）
 *   y = 由渲染器按 scale 抬起（本模块给 0 基座，保持"地面"语义）
 *
 * @param items 逾期账目（每条带客户/金额/逾期天数）
 * @param opts.perCustomer 是否为每个客户单独出一根柱（默认 false：按段聚合，更易读）
 */
export function buildBusinessScene(
  items: AgingItem[],
  opts: { perCustomer?: boolean } = {},
): BusinessScene {
  const list = (items || []).filter((i) => i && (Number(i.amount) || 0) > 0)
  const totalAmount = list.reduce((s, i) => s + (Number(i.amount) || 0), 0)
  const concentration = computeConcentration(list)

  if (list.length === 0 || totalAmount <= 0) {
    return {
      nodes: [],
      maxAmount: 0,
      totalAmount: 0,
      totalCount: 0,
      concentration,
      worstLabel: null,
      emptyReason: '没有逾期账目——没有可看的结构',
    }
  }

  // 按桶聚合（perCustomer 时再按客户细分）
  type Agg = { bucket: AgingBucketKey; customer: string | null; amount: number; count: number; maxDays: number }
  const aggs = new Map<string, Agg>()
  for (const it of list) {
    const key = bucketOf(it.overdueDays)
    if (!key) continue
    const cust = opts.perCustomer ? (it.customer || '未标注客户') : null
    const id = `${key}|${cust ?? ''}`
    const cur = aggs.get(id) || { bucket: key, customer: cust, amount: 0, count: 0, maxDays: 0 }
    cur.amount += Number(it.amount) || 0
    cur.count += 1
    cur.maxDays = Math.max(cur.maxDays, Math.max(0, Math.round(it.overdueDays ?? 0)))
    aggs.set(id, cur)
  }

  const maxAmount = Math.max(...[...aggs.values()].map((a) => a.amount), 0)
  const nodes: SceneNode[] = []
  // 同段内客户横向铺开：计算各段条目数，用于居中
  const perBucketLane = new Map<AgingBucketKey, number>()

  for (const agg of aggs.values()) {
    const bucket = AGING_BUCKETS.find((b) => b.key === agg.bucket)!
    const lane = perBucketLane.get(agg.bucket) || 0
    perBucketLane.set(agg.bucket, lane + 1)
    const share = agg.amount / totalAmount
    const scale = maxAmount > 0 ? agg.amount / maxAmount : 0
    nodes.push({
      key: `${agg.bucket}|${agg.customer ?? ''}`,
      kind: 'aging',
      label: agg.customer ? `${agg.customer} · ${bucket.label}` : bucket.label,
      amount: agg.amount,
      count: agg.count,
      // x：同段内横向铺开（间距 1.4，居中偏移由 lane 决定，渲染器可再居中）
      position: { x: lane * 1.4, y: 0, z: bucket.depth },
      scale,
      // 自发光 = 金额占比为主、账龄为辅：越老越大越该看
      glow: Math.min(1, share * 2.5 + (bucket.depth / 3) * 0.35),
      alarm: share > ALARM_SHARE || bucket.depth >= 3,
      share,
    })
  }

  // 同段居中：把每段的 x 整体左移 (n-1)/2 * 间距
  const byBucket = new Map<AgingBucketKey, SceneNode[]>()
  for (const n of nodes) {
    const k = n.key.split('|')[0] as AgingBucketKey
    if (!byBucket.has(k)) byBucket.set(k, [])
    byBucket.get(k)!.push(n)
  }
  for (const [, arr] of byBucket) {
    const shift = ((arr.length - 1) / 2) * 1.4
    for (const n of arr) n.position.x -= shift
  }

  // 最老且有金额的一段 → 结论文案（"钱卡在哪"）
  const deepest = [...nodes].sort((a, b) => {
    const da = a.key.split('|')[0], db = b.key.split('|')[0]
    const za = AGING_BUCKETS.find((b) => b.key === da)!.depth
    const zb = AGING_BUCKETS.find((b) => b.key === db)!.depth
    return (zb - za) || (b.amount - a.amount)
  })[0]
  const worstBucket = deepest ? AGING_BUCKETS.find((b) => b.key === deepest.key.split('|')[0]) : null

  return {
    nodes,
    maxAmount,
    totalAmount,
    totalCount: list.length,
    concentration,
    worstLabel: worstBucket ? worstBucket.label : null,
    emptyReason: null,
  }
}

/** 二维替代视图（L0/低端档用同一份数据，不丢信息） */
export interface FlatSceneRow {
  label: string
  amount: number
  shareText: string
  alarm: boolean
}

export function toFlatRows(scene: BusinessScene): FlatSceneRow[] {
  return scene.nodes
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .map((n) => ({
      label: n.label,
      amount: n.amount,
      shareText: `${Math.round(n.share * 100)}%`,
      alarm: n.alarm,
    }))
}

/** 结论文案（给卡片标题/语音播报共用，避免两处各写一套） */
export function sceneSummary(scene: BusinessScene): string {
  if (scene.emptyReason) return scene.emptyReason
  const parts: string[] = []
  if (scene.worstLabel) parts.push(`最老一段是${scene.worstLabel}`)
  if (scene.concentration.topCustomer) {
    const pct = Math.round(scene.concentration.topShare * 100)
    parts.push(`${scene.concentration.topCustomer}占 ${pct}%`)
    if (scene.concentration.risky) parts.push('集中度偏高')
  }
  return parts.join('，') || '暂无结论'
}
