/**
 * AmbientGlow — 环境辉光层（VoiceShell 背景）
 *
 * 两层：
 *  1. CSS 径向渐变辉光（品牌 accent 色，呼吸式 opacity 动画）
 *  2. Canvas 粒子层（~60 个慢速漂浮光点，idle 自适应 24fps）
 *
 * 克制原则：辉光是"氛围"不是"焦点"，粒子透明度 0.04-0.18，运动缓慢。
 * prefers-reduced-motion 时跳过粒子动画，仅渲染静态渐变。
 */

import { useEffect, useRef } from 'react'
import { updateParticles, type TrailParticle } from './ambient-particles'

const ACCENT_RGB: Record<string, [number, number, number]> = {
  orange: [249, 115, 22],
  blue: [89, 168, 255],
  purple: [167, 139, 250],
  green: [74, 222, 128],
  pink: [244, 114, 182],
}

type Particle = TrailParticle

export function AmbientGlow({ intensity = 1, accent = 'orange', idle = false }: {
  intensity?: number
  accent?: 'orange' | 'blue' | 'purple' | 'green' | 'pink'
  idle?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rgb = ACCENT_RGB[accent] || ACCENT_RGB.orange
  const reduced = useRef(false)
  // B7: intensity 每帧读取（ref）——旧实现把它放 deps,模式切换(intensity 1↔1.4)
  // 整体重建粒子场(新随机位置) → 每次切换粒子"跳一下"。intensity 只影响 alpha,不必重建。
  const intensityRef = useRef(intensity)
  intensityRef.current = intensity
  const idleRef = useRef(idle)
  idleRef.current = idle
  // B7.1: raf + particles 提升为 ref,避免 idle 切换重建粒子场
  const rafRef = useRef(0)
  const particlesRef = useRef<Particle[]>([])
  const prevAccentRef = useRef(accent)
  // draw 回调缓存,供 idle→false 恢复时从外部重启 rAF
  const drawRef = useRef<((now: number) => void) | null>(null)

  useEffect(() => {
    reduced.current = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  }, [])

  useEffect(() => {
    const accentChanged = prevAccentRef.current !== accent
    prevAccentRef.current = accent

    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    let W = 0, H = 0
    let last = 0
    let particles: Particle[] = []

    const resize = () => {
      W = canvas.clientWidth
      H = canvas.clientHeight
      canvas.width = W * dpr
      canvas.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    // 仅在首次挂载或 accent 变化时重建粒子场，避免 idle 切换时粒子"跳一下"
    if (accentChanged || particlesRef.current.length === 0) {
      const COUNT = Math.min(60, Math.floor((W * H) / 36000))
      particles = []
      for (let i = 0; i < COUNT; i++) {
        const x = Math.random() * (W || 1920)
        const y = Math.random() * (H || 1080)
        particles.push({
          x,
          y,
          r: 0.6 + Math.random() * 1.6,
          vx: (Math.random() - 0.5) * 0.12,
          vy: (Math.random() - 0.5) * 0.09,
          alpha: 0.04 + Math.random() * 0.14,
          phase: Math.random() * Math.PI * 2,
          trail: [{ x, y }],
        })
      }
      particlesRef.current = particles
    } else {
      particles = particlesRef.current
    }

    // 帧间隔门控：粒子漂浮缓慢，idle 自适应 24fps（头部注释承诺，此前未实现）
    const FRAME_MS = 1000 / 24
    const renderFrame = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 0.016
      last = now
      particles = updateParticles(particles, dt * 1000, W, H)
      ctx.clearRect(0, 0, W, H)
      for (const p of particles) {
        p.phase += dt * 0.6
        if (p.x < -10) p.x = W + 10
        if (p.x > W + 10) p.x = -10
        if (p.y < -10) p.y = H + 10
        if (p.y > H + 10) p.y = -10
        const breathe = 0.6 + 0.4 * Math.sin(p.phase)
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(p.alpha * breathe * intensityRef.current).toFixed(3)})`
        ctx.fill()
      }
      // 拖尾：沿 trail 画衰减线段（克制 alpha ≤ 0.10）
      for (const p of particles) {
        const tr = p.trail
        if (!tr || tr.length < 2) continue
        ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.10 * p.alpha})`
        ctx.lineWidth = Math.max(0.5, p.r * 0.4)
        ctx.beginPath()
        ctx.moveTo(tr[0].x, tr[0].y)
        for (let i = 1; i < tr.length; i++) ctx.lineTo(tr[i].x, tr[i].y)
        ctx.stroke()
      }
    }
    const draw = (now: number) => {
      // idle 停帧守卫：父组件传入 idle 时不再调度下一帧（rAF 自然停止）
      if (idleRef.current) return
      // 帧间隔跳过：距上次绘制不足 1/24s 时直接排下一帧（降频 60fps → 24fps）
      if (now - last < FRAME_MS) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }
      renderFrame(now)
      rafRef.current = requestAnimationFrame(draw)
    }

    // 缓存 draw 供 idle→false 恢复时外部重启 rAF
    drawRef.current = draw

    // document.hidden 门控：隐藏时停 rAF，可见时恢复
    let visible = true
    const onVis = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current)
        visible = false
      } else if (!visible) {
        visible = true
        if (reduced.current || idleRef.current) {
          // 静态帧重绘（绕过帧间隔门控）
          last = 0
          renderFrame(0)
        } else {
          rafRef.current = requestAnimationFrame(draw)
        }
      }
    }
    document.addEventListener('visibilitychange', onVis)

    if (reduced.current || idle) {
      // 静态渐变由 CSS 提供，粒子层仅画一帧（绕过帧间隔门控）
      renderFrame(0)
    } else {
      rafRef.current = requestAnimationFrame(draw)
    }

    return () => {
      cancelAnimationFrame(rafRef.current)
      drawRef.current = null
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVis)
    }
    // B7: intensity 走 ref 每帧读取, particles 走 ref 避免 idle 切换重建
  }, [accent, idle])

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      {/* CSS 径向辉光（品牌 accent 呼吸） */}
      <div
        className="absolute inset-0 ambient-glow"
        style={{
          background: `radial-gradient(ellipse 55% 45% at 50% 52%, rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.10 * intensity}) 0%, rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.04 * intensity}) 45%, transparent 75%)`,
          animation: 'ambient-breathe 9s ease-in-out infinite',
        }}
      />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    </div>
  )
}
