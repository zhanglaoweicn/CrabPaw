/**
 * VoiceOrb — 语音感知球体（CrabPaw Fibonacci 点云）
 *
 * 五种状态（P5.5 形态级差异化）：
 *   idle      — 静态白球（2026-08-24: 语音总开关关闭态——完全静止，无呼吸无摆动）
 *   listening — 语音开启态绿球：安静=绿色静态，人声（volume>0）=绿色动态波动
 *   thinking  — 品牌橙，扫描环旋转（LLM 处理中）
 *   speaking  — 科技蓝，能量脉冲，音量驱动
 *   muted     — 银白珍珠（保留配置；2026-08-24 起 UI 映射关闭态到 idle，不再直接使用）
 */

import { useEffect, useRef } from 'react'
import { playSound } from '../../hooks/useSoundEffects'

// ─── Fibonacci 球面采样 ──────────────────────────────────
function fibSphere(n: number, r: number) {
  const pts: number[][] = []
  const phi = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = phi * i
    pts.push([Math.cos(theta) * radius * r, y * r, Math.sin(theta) * radius * r])
  }
  return pts
}

// ─── 正弦噪声 ────────────────────────────────────────────
function sn(x: number, y: number, z: number, t: number) {
  return (
    Math.sin(x * 3.7 + t * 0.8) * 0.5 +
    Math.sin(y * 5.1 - t * 0.6) * 0.3 +
    Math.sin(z * 4.3 + t * 0.7) * 0.35 +
    Math.sin((x + y + z) * 2.1 + t * 1.1) * 0.25
  )
}

// ─── 状态配置：颜色 (暗→亮) + 动画参数 ──────────────────

export type OrbFxType = 'ripple' | 'scanring' | 'pulse'

export interface OrbFx {
  type: OrbFxType
  /** ripple: 环扩散速率; scanring: 光弧旋转速率; pulse: 发光强度系数 */
  speed?: number
  count?: number
  glow?: number
}

interface ModeConfig {
  r: [number, number, number]  // [dark, mid, bright]
  g: [number, number, number]
  b: [number, number, number]
  baseAmp: number    // 基础噪声幅度
  volAmp: number     // 音量放大系数
  baseSpd: number    // 基础时间速度
  volSpd: number     // 音量加速系数
  rotSpd: number     // Y轴旋转速度
  noiseGain: number  // 噪声位移强度倍率
  dotAlphaMin: number // 点透明度范围
  dotAlphaMax: number
  fx?: OrbFx        // P5.5: 状态专属特效（ripple 涟漪 / scanring 扫描环 / pulse 能量脉冲）
}

export const MODE_CFG: Record<string, ModeConfig> = {
  idle: {
    // 2026-08-24(用户反馈): 关闭态=静态白色球体——完全静止(呼吸/微摆/旋转全零),
    // 关闭语音(ASR/TTS 全停)时球如定格的珍珠; 图元呼吸仅靠 alpha 深度渐变体现
    r: [225, 235, 245],
    g: [228, 238, 248],
    b: [235, 245, 252],
    baseAmp: 0,
    volAmp: 0,
    baseSpd: 0,
    volSpd: 0,
    rotSpd: 0,
    noiseGain: 0,
    dotAlphaMin: 0.18,
    dotAlphaMax: 0.42,
  },
  muted: {
    // 静音态 — 银白珍珠质感（P5.5 用户反馈: 不旋转不闪烁，仅保留缓慢呼吸波动）
    r: [130, 175, 225],
    g: [135, 180, 230],
    b: [145, 190, 240],
    baseAmp: 0.02,
    volAmp: 0,
    baseSpd: 0.25,
    volSpd: 0,
    rotSpd: 0,
    noiseGain: 0,
    dotAlphaMin: 0.30,
    dotAlphaMax: 0.50,
  },
  listening: {
    // 2026-08-24(用户反馈): 绿态语义统一——语音开启态恒绿:
    //   安静(volume≈0) → 绿色静态球; 有人声(volume>0) → 绿色动态波动
    // 幅度完全由音量驱动(volAmp 0.7), 基础幅度压到 0.02 + 不自转保证静态
    r: [74, 210, 120],
    g: [110, 235, 160],
    b: [90, 200, 135],
    baseAmp: 0.02,
    volAmp: 0.7,
    baseSpd: 1.0,
    volSpd: 2.4,
    rotSpd: 0,
    noiseGain: 1.2,
    dotAlphaMin: 0.12,
    dotAlphaMax: 0.85,
  },
  thinking: {
    // 思考中 — 品牌橙扫描环（P5.5）：LLM 处理时球外橙色光弧旋转
    r: [249, 115, 22],
    g: [140, 70, 30],
    b: [40, 25, 60],
    baseAmp: 0.045,
    volAmp: 0,
    baseSpd: 0.9,
    volSpd: 0,
    rotSpd: 0.5,
    noiseGain: 1.0,
    dotAlphaMin: 0.10,
    dotAlphaMax: 0.70,
    fx: { type: 'scanring', speed: 1.6, glow: 0.5 },
  },
  speaking: {
    // 2026-08-14(用户反馈确认): 播放声音 = 科技蓝（语义保持, 无需改动）
    r: [20, 50, 80],
    g: [40, 100, 180],
    b: [120, 200, 255],
    baseAmp: 0.07,
    volAmp: 0.9,
    baseSpd: 1.3,
    volSpd: 3.5,
    rotSpd: 1.3,
    noiseGain: 1.5,
    dotAlphaMin: 0.15,
    dotAlphaMax: 0.92,
    fx: { type: 'pulse', glow: 1.0 },
  },
}

// ─── P7 Task 1: 场景语义色 tint 混合纯函数 ─────────────────
/** 将 base 色向 tint 色按 weight (0~1) 混合，返回新的 RGB 三元组 */
export function mixColor(
  base: [number, number, number],
  tint: [number, number, number],
  weight: number,
): [number, number, number] {
  const w = Math.max(0, Math.min(1, weight))
  return [
    Math.round(base[0] + (tint[0] - base[0]) * w),
    Math.round(base[1] + (tint[1] - base[1]) * w),
    Math.round(base[2] + (tint[2] - base[2]) * w),
  ]
}

// ─── P7 Task 1: 音乐频谱分裂形态配置 ────────────────────────
/** 频谱形态：暖橙→玫红渐变、高旋转速度、强音量响应 */
export const SPECTRUM_CFG: ModeConfig = {
  r: [255, 210, 160],
  g: [120, 95, 70],
  b: [40, 55, 90],
  baseAmp: 0.08,
  volAmp: 1.5,
  baseSpd: 1.2,
  volSpd: 2.0,
  rotSpd: 2.0,
  noiseGain: 1.3,
  dotAlphaMin: 0.10,
  dotAlphaMax: 0.88,
}

// ─── P7 Task 1: FX 颜色常量（可混合形式，无 tint 时行为与现状一致） ──
const FX_SCANRING_RGB: [number, number, number] = [249, 115, 22]  // 扫描环橙色
const FX_PULSE_RGB: [number, number, number] = [80, 160, 255]     // 脉冲蓝色

/** 将 ModeConfig 的 rgb 三阶色按权重应用 tint，返回新的 ModeConfig */
function applyTint(
  cfg: ModeConfig,
  tint: [number, number, number],
  weight: number,
): ModeConfig {
  const dark = mixColor([cfg.r[0], cfg.g[0], cfg.b[0]], tint, weight)
  const mid = mixColor([cfg.r[1], cfg.g[1], cfg.b[1]], tint, weight)
  const bright = mixColor([cfg.r[2], cfg.g[2], cfg.b[2]], tint, weight)
  return {
    ...cfg,
    r: [dark[0], mid[0], bright[0]],
    g: [dark[1], mid[1], bright[1]],
    b: [dark[2], mid[2], bright[2]],
  }
}

// ─── 组件 ─────────────────────────────────────────────────

interface VoiceOrbProps {
  mode: 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted'  // P5.5: +thinking
  volume?: number  // 0~0.5
  size?: number
  /** P7: 场景语义色 (RGB 0-255)，注入后点云 + fx 颜色均向该色偏移 */
  tint?: [number, number, number]
  /** P7: standard = 5 态 Fibonacci 球体；spectrum = 频谱分裂粒子流 */
  variant?: 'standard' | 'spectrum'
}

export function VoiceOrb({ mode, volume = 0, size = 140, tint, variant = 'standard' }: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const cfgRef = useRef(MODE_CFG.idle)
  const volRef = useRef(0)
  const lerpAmp = useRef(0.04)
  const lerpSpd = useRef(0.6)
  const lerpRot = useRef(0.5)
  const tRef = useRef(0)
  const rotYRef = useRef(0)
  // P7: 频谱形态 & tint 引用（绘图循环内消费）
  const isSpectrumRef = useRef(false)
  const tintRef = useRef<[number, number, number] | undefined>(undefined)
  const fxScanringRef = useRef<[number, number, number]>(FX_SCANRING_RGB)
  const fxPulseRef = useRef<[number, number, number]>(FX_PULSE_RGB)

  // 预计算球面点
  const outerPts = useRef<number[][]>([])
  const innerPts = useRef<number[][]>([])
  if (outerPts.current.length === 0) {
    outerPts.current = fibSphere(3200, 1.0)
    innerPts.current = fibSphere(1200, 0.88)
  }

  // 模式 / 场景语义色 / 频谱形态 切换：更新目标配置 + 触发音效
  const prevModeRef = useRef(mode)
  useEffect(() => {
    const isSpectrum = variant === 'spectrum'
    isSpectrumRef.current = isSpectrum
    const base = isSpectrum ? SPECTRUM_CFG : (MODE_CFG[mode] || MODE_CFG.idle)
    if (tint) {
      tintRef.current = tint
      // thinking/speaking/spectrum 用 0.6（场景色主导），idle/listening 用 0.3（柔和）
      const weight = (mode === 'thinking' || mode === 'speaking' || isSpectrum) ? 0.6 : 0.3
      cfgRef.current = applyTint(base, tint, weight)
      // fx 颜色也随 tint 派生
      fxScanringRef.current = mixColor(FX_SCANRING_RGB, tint, weight)
      fxPulseRef.current = mixColor(FX_PULSE_RGB, tint, weight)
    } else {
      tintRef.current = undefined
      cfgRef.current = base
      fxScanringRef.current = FX_SCANRING_RGB
      fxPulseRef.current = FX_PULSE_RGB
    }
    const prev = prevModeRef.current
    if (prev !== mode) {
      if (mode === 'listening') playSound('voice-start')
      else if (prev === 'listening' || prev === 'speaking') playSound('voice-end')
    }
    prevModeRef.current = mode
  }, [mode, variant, tint])

  // 音量平滑
  useEffect(() => {
    volRef.current += (volume - volRef.current) * 0.15
  }, [volume])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    let W = 0, H = 0, cx = 0, cy = 0, scale = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      W = rect.width * dpr; H = rect.height * dpr
      canvas.width = W; canvas.height = H
      cx = W / 2; cy = H / 2
      scale = Math.min(W, H) * 0.38
    }
    resize()

    // 2026-08-31 修复(模式切换后语音球空白): 球在 display:none 父容器中挂载(极简态
    // 侧栏隐藏)时 getBoundingClientRect=0 → 位图 0×0; resize 仅在 mode/size 变化时
    // 运行, 切回高级后 CSS 盒 200 但位图仍 0 → 空白球(刷新才恢复)。用 ResizeObserver
    // 感知容器尺寸变化(含 0→200)并重建位图。
    let resizeObserver: ResizeObserver | null = null
    try {
      resizeObserver = new ResizeObserver(() => { resize() })
      resizeObserver.observe(canvas.parentElement || canvas)
    } catch { /* 环境不支持 RO: 维持原行为 */ }

    let lastTs = 0
    const draw = (now: number) => {
      const dt = lastTs ? Math.min((now - lastTs) / 1000, 0.1) : 0.016
      lastTs = now

      const cfg = cfgRef.current
      const v = volRef.current

      // 各参数平滑过渡到目标值
      const tAmp = cfg.baseAmp + v * cfg.volAmp
      const tSpd = cfg.baseSpd + v * cfg.volSpd
      const tRot = cfg.rotSpd

      lerpAmp.current += (tAmp - lerpAmp.current) * Math.min(dt * 6, 1)
      lerpSpd.current += (tSpd - lerpSpd.current) * Math.min(dt * 5, 1)
      lerpRot.current += (tRot - lerpRot.current) * Math.min(dt * 4, 1)

      const amp = lerpAmp.current
      const spd = lerpSpd.current

      // 时间推进
      tRef.current += dt * spd * 2.5

      // Y 轴旋转
      rotYRef.current += dt * lerpRot.current
      // 2026-08-24: 静止态(无噪声幅度+无旋转——idle 白/绿静态)取消 rx 微摆,
      // 否则 0.06 rad 摇摆使「静态球」仍轻微晃动; 其余态保留原有视觉呼吸
      const rxSwing = (cfg.baseAmp === 0 && cfg.rotSpd === 0) ? 0 : Math.sin(tRef.current * 0.15) * 0.06
      const rx = 0.22 + rxSwing

      ctx.clearRect(0, 0, W, H)

      // 投影所有点
      const isSpectrum = isSpectrumRef.current
      const projected: Array<{ sx: number; sy: number; z: number; depth: number; dotR: number; colorD: number }> = []
      const projectPts = (pts: number[][], baseR: number) => {
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]
          const d = 1.0 + sn(p[0], p[1], p[2], tRef.current) * amp * cfg.noiseGain
          const cosY = Math.cos(rotYRef.current), sinY = Math.sin(rotYRef.current)
          const rx2 = p[0] * d * cosY - p[2] * d * sinY
          const rz = p[0] * d * sinY + p[2] * d * cosY
          const ry2 = p[1] * d
          const cosX = Math.cos(rx), sinX = Math.sin(rx)
          const ry3 = ry2 * cosX - rz * sinX
          const rz3 = ry2 * sinX + rz * cosX
          let sx = cx + rx2 * scale
          let sy = cy - ry3 * scale
          // P7 频谱喷流位移：有音量时点云沿 y 轴随正弦分裂为粒子流
          if (isSpectrum && v > 0.05) {
            sy += Math.sin(i * 0.3 + tRef.current) * v * scale * 0.5
          }
          const depth = (rz3 + 1.5) / 3.0
          // P7 频谱色相偏移：深度 + 音量驱动三通道近似 hue shift
          const colorD = isSpectrum ? Math.max(0, Math.min(1, depth + v * 0.3)) : depth
          const dotR = baseR + depth * 0.8 + amp * 2
          projected.push({ sx, sy, z: rz3, depth, dotR, colorD })
        }
      }
      projectPts(outerPts.current, 0.6)
      projectPts(innerPts.current, 0.4)

      // 按 Z 排序（远处先画）
      projected.sort((a, b) => a.z - b.z)

      // 逐点绘制 — 深度从暗色渐变到亮色（频谱时 colorD 含音量 hue shift）
      for (const pt of projected) {
        const d = Math.max(0, Math.min(1, pt.colorD))
        const r = Math.round(cfg.r[0] + (cfg.r[2] - cfg.r[0]) * d)
        const g = Math.round(cfg.g[0] + (cfg.g[2] - cfg.g[0]) * d)
        const b = Math.round(cfg.b[0] + (cfg.b[2] - cfg.b[0]) * d)
        const alpha = (cfg.dotAlphaMin + d * (cfg.dotAlphaMax - cfg.dotAlphaMin)).toFixed(2)
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`
        ctx.beginPath()
        ctx.arc(pt.sx, pt.sy, pt.dotR * dpr, 0, Math.PI * 2)
        ctx.fill()
      }

      // P5.5: 状态特效叠加层（涟漪/扫描环/能量脉冲）
      // P7: fx 颜色通过 fxScanringRef / fxPulseRef 派生（无 tint 时与原色一致）
      const fx = cfg.fx
      if (fx) {
        if (fx.type === 'ripple') {
          const n = fx.count || 2
          for (let i = 0; i < n; i++) {
            const ph = ((tRef.current * (fx.speed || 1)) + i / n) % 1
            const rr = scale * 0.62 + ph * scale * 0.75
            const alpha = 0.5 * (1 - ph)
            const [rrr, rg, rb] = fxScanringRef.current
            ctx.strokeStyle = `rgba(${rrr},${rg},${rb},${alpha})`
            ctx.lineWidth = 2.2 * dpr
            ctx.beginPath()
            ctx.arc(cx, cy, rr, 0, Math.PI * 2)
            ctx.stroke()
          }
        } else if (fx.type === 'scanring') {
          const ang = tRef.current * (fx.speed || 1.6)
          const rr = scale * 1.12
          const [sr, sg, sb] = fxScanringRef.current
          const grad = ctx.createLinearGradient(cx - rr, cy, cx + rr, cy)
          grad.addColorStop(0, `rgba(${sr},${sg},${sb},0)`)
          grad.addColorStop(0.5, `rgba(${sr},${sg},${sb},0.85)`)
          grad.addColorStop(1, `rgba(${sr},${sg},${sb},0)`)
          ctx.strokeStyle = grad
          ctx.lineWidth = 3 * dpr
          ctx.beginPath()
          ctx.arc(cx, cy, rr, ang, ang + Math.PI * 1.25)
          ctx.stroke()
        } else if (fx.type === 'pulse') {
          const glow = (fx.glow || 1) * (0.5 + volRef.current * 1.2)
          const [pr, pg, pb] = fxPulseRef.current
          const grad = ctx.createRadialGradient(cx, cy, scale * 0.4, cx, cy, scale * 1.1)
          grad.addColorStop(0, `rgba(${pr},${pg},${pb},${0.10 * glow})`)
          grad.addColorStop(1, `rgba(${pr},${pg},${pb},0)`)
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(cx, cy, scale * 1.1, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(rafRef.current); resizeObserver?.disconnect() }
  }, [mode, size])

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        width: size,
        height: size,
        cursor: 'pointer',
        borderRadius: '50%',
      }}
    />
  )
}
