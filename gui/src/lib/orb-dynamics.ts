/**
 * orb-dynamics — 语音球动态响应纯函数（2026-09-23 球体动感增强轮）
 *
 * 背景（用户反馈「球听我说话/播报时波动太小，要像黑洞拉扯一样」）：
 *   旧实现里球的音量是"每次 prop 变化做一次 15% lerp"（VoiceOrb/index.tsx），
 *   而聆听期的音量信号是 1s 节流的慢信号 → 峰值永远到不了、台阶感明显。
 *   本模块把"响应曲线/包络/拉扯"抽成纯函数，逐帧积分，与渲染解耦。
 *
 * 三条曲线，各司其职：
 *   1. envStep      —— 非对称包络：快起（声音一进来立刻抬）+ 慢落（说完回弹），
 *                      用 1-exp(-dt/tau) 保证与帧率无关（掉帧不改变手感）
 *   2. perceptual   —— 感知曲线 v^0.7：中小音量抬起来（球对正常说话有反应），
 *                      0 仍映射到 0（守「安静=静态」的既有裁决）
 *   3. springStep   —— 二阶弹簧（欠阻尼）：拉扯带过冲与回弹，这是"被吸住"的手感来源
 *
 * 关键约束（不可破坏）：所有新动态都必须由音量门控——v=0 时包络/拉扯/潮汐全部归零，
 *   关闭态（idle 白球）与安静态（listening 绿静态）的观感必须与今天一致。
 */

/** 动态参数（单一事实源；调手感只动这里） */
export const ORB_DYN = {
  /** 包络上升时间常数（秒）——快起 */
  attackSec: 0.045,
  /** 包络下降时间常数（秒）——慢落 */
  releaseSec: 0.26,
  /** 感知曲线指数（<1 抬高中小音量） */
  curve: 0.7,
  /** 潮汐形变幅度（四极子径向形变，1 = 满幅） */
  tideGain: 0.16,
  /** 全局拉扯位移安全上限（|pull| 超过会顶到画布边缘） */
  pullMax: 0.18,
  /** 弹簧刚度（ω≈6.5 rad/s ≈ 1Hz 呼吸） */
  springK: 42,
  /** 弹簧阻尼（ζ≈0.58，欠阻尼→过冲约 10%，即"回弹"） */
  springDamp: 7.5,
  /** 快速能量通道的陈旧阈值（毫秒）——超时视为静音，防止"冻结在最后一声" */
  fastStaleMs: 300,
  /** 单点径向位移下限——防止极端音量下点穿过球心（视觉崩坏） */
  dFloor: 0.3,
  /**
   * 径向位移软饱和：膝点以下严格线性（说话音量的动态一点不损失），膝点以上平滑压缩。
   * 实测依据（2026-09-23）: 画布 250px、静止球半径约 97px → 只剩约 +29% 余量，
   * 而满音量下未饱和的位移把半径推到 158px（溢出画布 → 最外层点被静默裁掉）。
   */
  dispKnee: 0.18,
  dispMax: 0.3,
} as const

/** 各态的拉扯方向与力度：聆听=被吸（收缩），播报=顶出去（扩张），其余不拉扯 */
const PULL_GAIN: Record<string, number> = {
  listening: -0.14,
  speaking: 0.11,
}

/**
 * 非对称包络单步。dt 为秒；上升用 attackSec，下降用 releaseSec。
 * 指数形式（而非固定系数）保证 30fps 与 120fps 下手感一致。
 */
export function envStep(
  env: number,
  target: number,
  dt: number,
  attackSec: number = ORB_DYN.attackSec,
  releaseSec: number = ORB_DYN.releaseSec,
): number {
  if (!(dt > 0)) return env
  const tau = target > env ? attackSec : releaseSec
  if (!(tau > 0)) return target
  const k = 1 - Math.exp(-dt / tau)
  return env + (target - env) * k
}

/** 感知曲线：clamp(v,0,1)^curve。0→0、1→1，中小音量被抬高。 */
export function perceptual(v: number, curve: number = ORB_DYN.curve): number {
  const c = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0))
  return Math.pow(c, curve)
}

/**
 * 二阶弹簧单步（半隐式欧拉，阻尼恒定稳定）。
 * 返回新的位移与速度；target 突变时会产生过冲与回弹——"拉扯"的来源。
 */
export function springStep(
  value: number,
  vel: number,
  target: number,
  dt: number,
  k: number = ORB_DYN.springK,
  damp: number = ORB_DYN.springDamp,
): { value: number; vel: number } {
  if (!(dt > 0)) return { value, vel }
  const acc = (target - value) * k - vel * damp
  const nextVel = vel + acc * dt
  return { value: value + nextVel * dt, vel: nextVel }
}

/** 拉扯目标位移（负数=球收缩被吸，正数=球扩张顶出）。vEff 已过感知曲线。 */
export function pullTarget(mode: string, vEff: number): number {
  const gain = PULL_GAIN[mode] ?? 0
  const v = Math.max(0, Math.min(1, vEff))
  // 显式返回 +0：gain*v 在 v=0 时会得到 -0（IEEE 负零），门控语义是"归零"，
  // 不该输出一个带着方向的零（下游 Object.is 比较/序列化都会咬到）
  if (gain === 0 || v === 0) return 0
  return gain * v
}

/** 拉扯位移夹取：超出 pullMax 会顶出画布（球占画布 76%，安全余量约 +31%） */
export function clampPull(p: number, max: number = ORB_DYN.pullMax): number {
  if (!Number.isFinite(p)) return 0
  return Math.max(-max, Math.min(max, p))
}

/**
 * 潮汐权重（四极子球谐 3y²-1 归一化到 ±1）：y 为球面点的纵坐标(-1..1)。
 * 极点 +1、赤道 -0.5 —— 配合随时间反相的相位，即得"被引力拉长/挤扁"的形变
 * （对比单纯沿半径缩放，这才是黑洞潮汐的观感）。
 */
export function tideWeight(y: number): number {
  return (3 * y * y - 1) / 2
}

/** 快速能量通道是否新鲜（超时视为静音，避免球冻结在最后一次读数上） */
export function isFastFresh(nowMs: number, lastMs: number, staleMs: number = ORB_DYN.fastStaleMs): boolean {
  return lastMs > 0 && nowMs - lastMs < staleMs
}

/**
 * 径向位移 → 半径倍率（1 = 半径不变）。
 * 膝点以下严格线性（说话音量下的动态响应一点不损失），膝点以上平滑压缩到 ±dispMax，
 * 避免点云冲出画布被静默裁掉（实测满音量未饱和时会到 1.66×，而画布只有 +29% 余量）。
 * 膝点处一阶连续（斜率仍为 1），所以看不到折点。
 */
export function radialScale(
  rawDisp: number,
  dispMax: number = ORB_DYN.dispMax,
  knee: number = ORB_DYN.dispKnee,
): number {
  if (!Number.isFinite(rawDisp)) return 1
  if (!(dispMax > 0)) return 1 + rawDisp
  const k = Math.max(0, Math.min(knee, dispMax))
  const a = Math.abs(rawDisp)
  if (a <= k) return 1 + rawDisp
  const room = dispMax - k
  if (!(room > 0)) return 1 + (rawDisp < 0 ? -k : k)
  const shaped = k + room * (1 - Math.exp(-(a - k) / room))
  return 1 + (rawDisp < 0 ? -shaped : shaped)
}
