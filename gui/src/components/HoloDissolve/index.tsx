/**
 * HoloDissolve —— 全息消散沉降动画组件
 *
 * 从 sourceRect 区域采样光点粒子（high 400 / low 120），1.2s 内散开下坠并淡出。
 * canvas 2D 全视口覆盖，粒子初始位置在 sourceRect 内随机采样。
 *
 * 物理模型（每粒子独立）：
 *   - vx: 随机 ±60px/s（水平漂移）
 *   - vy: 起始 -30px/s（先微升），重力 +160px/s²（后加速下坠）
 *   - alpha: 0.9 → 0 线性衰减
 *   - 时长: 1.2s（rAF 驱动）
 *
 * Props:
 *   sourceRect: 粒子采样区域（null 时不渲染）
 *   onDone: 动画完成回调
 *   tint: 粒子颜色 [r, g, b]，默认 CrabPaw 品牌橙
 */

import { useEffect, useRef } from 'react'
import { getPerformanceMode } from '../../lib/performance-mode'

// ── 常量 ──────────────────────────────────────────
/** 根据性能模式返回粒子数：high 400 / low 120 */
function getParticleCount(): number {
  return getPerformanceMode() === 'low' ? 120 : 400
}
const DURATION_MS = 1200
const GRAVITY = 160       // px/s²
const VY0 = -30           // px/s 起始垂直速度（负 = 向上）
const VX_RANGE = 60       // px/s 水平速度范围 ±
const ALPHA_START = 0.9
// B7: tint 默认值常量化——旧实现默认参数 [249,115,22] 每次渲染都是新数组,
// effect deps 含 tint → sourceRect 非空期间父组件每次重渲染(如 audioLevel 更新)都
// 重启动画(startMs 重置),onDone 长期不触发,handleDissolveDone 卡住。
const DEFAULT_TINT: [number, number, number] = [249, 115, 22]

// ── 粒子接口 ──────────────────────────────────────
interface Particle {
  x0: number   // 初始 x（sourceRect 内随机）
  y0: number   // 初始 y
  vx: number   // 水平速度 px/s
}

// ── Props ─────────────────────────────────────────
export interface HoloDissolveProps {
  sourceRect: { x: number; y: number; w: number; h: number } | null
  onDone: () => void
  tint?: [number, number, number]
}

// ═══════════════════════════════════════════════════
// dissolveParams —— 纯函数（可测）
// 计算 sourceRect 中心点在归一化时间 t 处的粒子状态。
// 用于单元测试验证物理模型；组件内 400 粒子使用相同公式。
// ═══════════════════════════════════════════════════
export function dissolveParams(
  sourceRect: { x: number; y: number; w: number; h: number },
  t: number, // 0..1 归一化时间
): { x: number; y: number; alpha: number } {
  const cx = sourceRect.x + sourceRect.w / 2
  const cy = sourceRect.y + sourceRect.h / 2
  const elapsed = t * (DURATION_MS / 1000) // 秒

  // 水平：中心点无漂移（vx=0）
  const x = cx

  // 垂直：vy0 * t + 0.5 * g * t²
  const y = cy + VY0 * elapsed + 0.5 * GRAVITY * elapsed * elapsed

  // alpha：线性衰减 0.9 → 0
  const alpha = ALPHA_START * (1 - t)

  return { x, y, alpha }
}

// ═══════════════════════════════════════════════════
// HoloDissolve 组件
// ═══════════════════════════════════════════════════
export function HoloDissolve({ sourceRect, onDone, tint = DEFAULT_TINT }: HoloDissolveProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number>(0)
  const doneRef = useRef(false)

  useEffect(() => {
    if (!sourceRect) return

    // reduce-animations 设置项（localStorage）：全局跳过粒子消散动画，直接完成
    try {
      if (localStorage.getItem('reduce-animations') === 'true') {
        if (!doneRef.current) {
          doneRef.current = true
          onDone()
        }
        return
      }
    } catch (e) { console.error('[holo] reduce-animations 检查失败:', e) }

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // 画布尺寸匹配视口（按 devicePixelRatio 缩放，绘制使用 CSS 像素坐标）
    const dpr = window.devicePixelRatio || 1
    const resize = () => {
      canvas.width = window.innerWidth * dpr
      canvas.height = window.innerHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    // prefers-reduced-motion：跳过粒子动画，直接完成（内容瞬时消失，无消散动效）
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false) {
      if (!doneRef.current) {
        doneRef.current = true
        onDone()
      }
      return () => window.removeEventListener('resize', resize)
    }

    // 生成 400 粒子：初始位置在 sourceRect 内随机采样
    const particles: Particle[] = Array.from({ length: getParticleCount() }, () => ({
      x0: sourceRect.x + Math.random() * sourceRect.w,
      y0: sourceRect.y + Math.random() * sourceRect.h,
      vx: (Math.random() * 2 - 1) * VX_RANGE, // ±60 px/s
    }))

    const startMs = performance.now()
    doneRef.current = false

    // ── rAF 动画循环 ──
    const tick = () => {
      const elapsed = performance.now() - startMs
      const t = Math.min(elapsed / DURATION_MS, 1)

      // 清空画布（setTransform 后按 CSS 像素坐标清全视口）
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight)

      // 逐粒子绘制
      const [r, g, b] = tint
      const elapsedSec = t * (DURATION_MS / 1000)
      const alpha = ALPHA_START * (1 - t)

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]
        const px = p.x0 + p.vx * elapsedSec
        const py = p.y0 + VY0 * elapsedSec + 0.5 * GRAVITY * elapsedSec * elapsedSec
        const size = 2 + (1 - t) * 2 // 2→4px，随时间缩小

        ctx.globalAlpha = alpha
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.beginPath()
        // 光点光晕：两层（外层半透明大圆 + 内层实心小圆）
        ctx.arc(px, py, size * 2, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = alpha * 0.6
        ctx.beginPath()
        ctx.arc(px, py, size, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.globalAlpha = 1

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        // 动画完成
        if (!doneRef.current) {
          doneRef.current = true
          onDone()
        }
      }
    }

    // document.hidden 门控：隐藏时停 rAF，可见时恢复（rAF 虽会被浏览器暂停，显式取消更可控）
    let running = true
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current)
        running = false
      } else if (!running && !doneRef.current) {
        running = true
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVis)

    rafRef.current = requestAnimationFrame(tick)

    // ── 清理 ──
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [sourceRect, onDone, tint])

  if (!sourceRect) return null

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-topmost)',
        pointerEvents: 'none',
      }}
    />
  )
}
