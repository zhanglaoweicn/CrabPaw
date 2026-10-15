/**
 * motion-tier.ts — 动效保真阶梯（Motion Fidelity Ladder）
 *
 * 背景（2026-09-30 深度检查）：UI 有 98 处 `backdrop-filter`、340 个 `@keyframes`、
 * 154 处 `transition`，却**没有任何降级机制**，也不响应 `prefers-reduced-motion`。
 * 而本产品跑在"买 U 盘、不装环境"的形态上——用户插的往往就是集显/机械盘的老机器。
 * 同时项目已有前车之鉴：`ShellFloatCard/styles.css:4` 记录过"大面积 backdrop-filter
 * 与视频/地图合成层死锁 → 黑屏"（MediaStage 事故）。
 *
 * 因此把"炫度"做成**可调三档**，而不是一刀切：
 *   L0 精简 — 无障碍偏好 / 设备评分低 / 用户手动：去模糊、去装饰性动画、零转场
 *   L1 标准 — 默认：单层玻璃、仅关键反馈
 *   L2 全效 — 独显/高分屏且实测帧率达标：保留全部层次
 *
 * 判定顺序（前者优先）：
 *   1) 用户在设置里显式选择（localStorage）——信任来自可控
 *   2) 系统 `prefers-reduced-motion: reduce` → L0（这是无障碍，不是优化）
 *   3) 启动后实测 FPS 采样 + 硬件线索 → L0/L1/L2
 *
 * 所有视觉差异由 CSS 令牌承担（`[data-motion="L0|L1|L2"]` 覆盖 `:root`），
 * 本模块只负责**决定并写属性**，不直接改样式——便于单测与排查。
 */

export type MotionTier = 'L0' | 'L1' | 'L2'
/** 'auto' = 按设备与系统偏好自动；其余为手动锁定 */
export type MotionMode = MotionTier | 'auto'

const STORAGE_KEY = 'crabpaw_motion_mode'
const SAMPLE_MS = 1200
/** 低于此帧率判为吃力 → L0 */
const FPS_LOW = 45
/** 达到此帧率才允许全效 → L2 */
const FPS_HIGH = 56

export function readMotionMode(): MotionMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'L0' || v === 'L1' || v === 'L2' || v === 'auto') return v
  } catch { /* localStorage 不可用（隐私模式等）→ 走自动 */ }
  return 'auto'
}

export function saveMotionMode(mode: MotionMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, mode)
  } catch { /* 存不下就只影响下次启动的默认值，不阻断当前会话 */ }
}

/** 系统是否要求减少动态效果 */
function systemPrefersReduced(): boolean {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch { return false }
}

/**
 * 采样真实帧率。用 rAF 计时而非"猜硬件"——U 盘 + 集显的组合无法从型号推断。
 * 返回 null 表示无法采样（无 rAF / 页面不可见），由调用方回落保守档位。
 */
export function sampleFps(durationMs = SAMPLE_MS): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function' || typeof performance === 'undefined') { resolve(null); return }
    let frames = 0
    let start = 0
    let done = false
    const finish = (fps: number | null) => { if (!done) { done = true; resolve(fps) } }
    const tick = (t: number) => {
      if (done) return
      if (!start) { start = t; frames = 0; requestAnimationFrame(tick); return }
      frames++
      const elapsed = t - start
      if (elapsed >= durationMs) {
        const fps = frames > 0 ? (frames * 1000) / elapsed : null
        finish(fps == null ? null : Math.round(fps))
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    // 兜底：页面被切到后台时 rAF 会暂停，避免永久挂起
    setTimeout(() => finish(null), durationMs + 500)
  })
}

/** 由实测帧率与硬件线索决定档位（纯函数，便于单测） */
export function decideTier(fps: number | null, hardwareConcurrency: number | undefined): MotionTier {
  if (fps == null) return 'L1'                       // 采不到 → 保守但不残废
  if (fps < FPS_LOW) return 'L0'
  if (fps >= FPS_HIGH && (hardwareConcurrency ?? 4) >= 4) return 'L2'
  return 'L1'
}

/** 应用档位到文档根（CSS 令牌据此切换） */
export function applyTier(tier: MotionTier): void {
  try {
    const el = document.documentElement
    el.setAttribute('data-motion', tier)
    // 供非 CSS 消费方（如需要按档位决定是否挂载重组件）读取
    ;(window as unknown as { __crabpawMotionTier?: MotionTier }).__crabpawMotionTier = tier
  } catch { /* 极端情况下 DOM 不可用，忽略 */ }
}

export function currentTier(): MotionTier {
  try {
    const v = document.documentElement.getAttribute('data-motion')
    if (v === 'L0' || v === 'L1' || v === 'L2') return v
  } catch { /* ignore */ }
  return 'L1'
}

/**
 * 解析并应用档位。
 * @param opts.probe 是否做 FPS 采样（测试/首帧关键路径可传 false，直接用保守 L1）
 * @returns 最终生效档位
 */
export async function resolveAndApplyMotionTier(opts: { probe?: boolean } = {}): Promise<MotionTier> {
  const mode = readMotionMode()
  if (mode !== 'auto') { applyTier(mode); return mode }
  if (systemPrefersReduced()) { applyTier('L0'); return 'L0' }
  const fps = opts.probe === false ? null : await sampleFps()
  const tier = decideTier(fps, typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined)
  applyTier(tier)
  return tier
}

/**
 * 监听系统"减少动态效果"变化并即时生效（用户在使用中改系统设置也应立刻响应）。
 * 手动锁定档位时不覆盖用户选择。
 * @returns 取消监听的函数
 */
export function watchSystemMotionPreference(): () => void {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => {
      if (readMotionMode() !== 'auto') return   // 用户显式选择优先
      applyTier(mq.matches ? 'L0' : currentTier() === 'L0' ? 'L1' : currentTier())
    }
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    return () => {}
  } catch { return () => {} }
}
