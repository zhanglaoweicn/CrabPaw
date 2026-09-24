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
// 2026-09-23 动感增强（用户反馈「波动太小，要像黑洞拉扯」）: 包络/弹簧/潮汐抽成纯函数，
// 逐帧积分（替代旧的"每次 prop 变化只走 15%"），单测见 lib/orb-dynamics.test.ts
import {
  ORB_DYN,
  clampPull,
  envStep,
  isFastFresh,
  perceptual,
  pullTarget,
  radialScale,
  springStep,
  tideWeight,
} from '../../lib/orb-dynamics'

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
    // 2026-09-24 会客厅轮: 暗端降饱和加暖（249,140,40 → 214,132,60）——满饱和橙在
    // 长时间思考时看着像"卡住的警示灯"，降一档更像"在运转"
    r: [214, 132, 48],
    g: [132, 70, 32],
    b: [60, 30, 62],
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
    // 2026-09-24 会客厅轮: 亮端向青白提亮（80,180,255 → 150,220,255）——"在说"与
    // "在听"（绿）原本明度太接近，1–2m 外或投屏时只看颜色分不清是在听还是在说
    r: [20, 60, 150],
    g: [40, 120, 220],
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
  waiting: {
    // 2026-09-24 会客厅轮(P5 用户拍板): 「待批准」——唯一需要老板出手的状态，此前
    // 只出现在对话卡注意带里，球本身毫无提示。琥珀慢脉冲（ripple 涟漪，该特效早已
    // 实现但没有任何状态使用过）：余光就能察觉"有东西在等我"。
    r: [255, 170, 70],
    g: [150, 110, 50],
    b: [40, 60, 90],
    baseAmp: 0.035,
    volAmp: 0,
    baseSpd: 0.45,
    volSpd: 0,
    rotSpd: 0,
    noiseGain: 0.9,
    dotAlphaMin: 0.14,
    dotAlphaMax: 0.78,
    fx: { type: 'ripple', speed: 0.45, count: 2 },
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
  mode: 'idle' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'muted'  // P5.5: +thinking; 2026-09-24: +waiting(待批准)
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
  /** prop 音量目标（0-1）——平滑已交给逐帧包络（envStep），本 ref 只存目标值 */
  const volRef = useRef(0)
  /** 2026-09-23: 能量包络（0-1，快起慢落）——所有音量驱动效果的唯一输入 */
  const envRef = useRef(0)
  /** 2026-09-23: 快速能量通道读数 + 到达时刻（聆听期每帧 RMS / 播报期 TTS 音量） */
  const fastVolRef = useRef(0)
  const fastAtRef = useRef(0)
  /** 2026-09-23: 全局拉扯位移与其速度（二阶弹簧：过冲回弹 = "被吸住"手感） */
  const pullRef = useRef(0)
  const pullVelRef = useRef(0)
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
  // 2026-09-23: 潮汐形变权重按点预计算（四极子 3y²-1）——逐帧每点只多一次乘加，
  // 不引入逐点三角函数（4400 点每帧一次 sin 已是既有的最大开销）
  const outerTide = useRef<Float32Array>(new Float32Array(0))
  const innerTide = useRef<Float32Array>(new Float32Array(0))
  if (outerPts.current.length === 0) {
    outerPts.current = fibSphere(3200, 1.0)
    innerPts.current = fibSphere(1200, 0.88)
    outerTide.current = Float32Array.from(outerPts.current, p => tideWeight(p[1]))
    innerTide.current = Float32Array.from(innerPts.current, p => tideWeight(p[1]))
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

  // 音量目标（prop）——平滑改由逐帧包络承担（见 draw() 内 envStep）
  useEffect(() => {
    volRef.current = Math.max(0, Math.min(1, volume))
  }, [volume])

  // 2026-09-23 快速能量通道: crabpaw:voice-energy-fast（聆听期每帧 RMS ~8Hz；播报期
  // TTS 音量 60ms 级）。直写 ref，不触发 React 重渲染——球的 60fps 动画不该驮着整树
  // setState（旧实现走 VoiceShell state，1s 一跳，这是"波动小"的第二根因）。
  useEffect(() => {
    const onFast = (e: Event) => {
      const raw = (e as CustomEvent<number | { level?: number }>).detail
      const lvl = typeof raw === 'number' ? raw : Number(raw?.level)
      if (!Number.isFinite(lvl)) return
      fastVolRef.current = Math.max(0, Math.min(1, lvl))
      fastAtRef.current = performance.now()
    }
    window.addEventListener('crabpaw:voice-energy-fast', onFast)
    return () => window.removeEventListener('crabpaw:voice-energy-fast', onFast)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    let W = 0, H = 0, cx = 0, cy = 0, scale = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const w = rect.width * dpr, h = rect.height * dpr
      // 2026-09-23 实测修复: 零尺寸不得写进位图。父容器 display:none / 尚未布局时
      // rect=0，写进去就是 0×0 位图；而 ResizeObserver 只报"尺寸变化"，此后父容器
      // 尺寸不再变化就再也不会触发 → 球永久空白（本机最大化窗口后当场复现；且把本轮
      // 全部改动回退后仍然空白 → 是既有缺陷，不是本轮引入）。返回 false = 尚未就绪。
      if (!(w > 0) || !(h > 0)) return false
      W = w; H = h
      canvas.width = W; canvas.height = H
      cx = W / 2; cy = H / 2
      scale = Math.min(W, H) * 0.38
      return true
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

      // 位图尚未就绪（挂载时零尺寸 / 被上面的守卫拦下）→ 每帧重试，直到拿到真实尺寸。
      // "空白球"的兜底自愈: 不再依赖 ResizeObserver 恰好再报一次尺寸变化。
      if (W === 0 || H === 0) {
        if (!resize()) {
          rafRef.current = requestAnimationFrame(draw)
          return
        }
      }

      const cfg = cfgRef.current

      // ── 2026-09-23 动感增强: 逐帧能量积分（替代旧的"每次 prop 变化只走 15%"）──
      // 旧实现的两个问题: ①聆听期能量信号 1s 一跳, 每次只补 15% 的差距 → 峰值
      // 永远到不了, 球看起来几乎不动; ②播报期 prop 恒 0(球根本收不到 TTS 音量)。
      // 现在: 目标取 max(慢态 prop, 快速通道) + 逐帧包络, 峰值真实可达。
      const nowMs = performance.now()
      const fastFresh = isFastFresh(nowMs, fastAtRef.current)
      const volTarget = Math.max(volRef.current, fastFresh ? fastVolRef.current : 0)
      // 非对称包络: 声音一进来立刻抬(45ms), 说完缓慢回落(260ms) → 有"呼吸"不僵硬
      envRef.current = envStep(envRef.current, volTarget, dt)
      // 感知曲线: 中小音量抬起来(正常说话就看得见波动), 0 仍映射到 0(安静=静态)
      const vEff = perceptual(envRef.current)
      // 拉扯/潮汐只在"音量驱动型"状态生效(volAmp>0)——关闭态(idle 白球)与思考态
      // 零响应, 保住「关闭=定格的珍珠」这条既有裁决
      const dynOn = cfg.volAmp > 0
      // 关闭态(无基础幅度/无旋转/无音量驱动)= 完全静止: 把三个 lerp 直接归零。
      // 旧实现的渐近尾巴会让"定格"的白球残留约 0.14px 的逐帧漂移（实测），
      // 与「关闭 = 定格的珍珠」这条既有裁决不符。
      const hardStatic = !dynOn && cfg.baseAmp === 0 && cfg.rotSpd === 0
      if (hardStatic) {
        lerpAmp.current = 0
        lerpSpd.current = 0
        lerpRot.current = 0
      }
      // 全局拉扯(二阶弹簧): 聆听=被吸进去(收缩), 播报=顶出来(扩张), 过冲即"回弹"。
      // 非音量驱动型状态直接归零(而不是让它慢慢衰减)——关闭态必须逐帧定格,
      // 不能出现"静音后白球还在缓动一秒"的余波
      if (dynOn) {
        const pullSpring = springStep(pullRef.current, pullVelRef.current, pullTarget(mode, vEff), dt)
        pullRef.current = clampPull(pullSpring.value)
        pullVelRef.current = pullSpring.vel
      } else {
        pullRef.current = 0
        pullVelRef.current = 0
      }
      // 潮汐形变相位: 每帧一次正弦, 逐点只做一次乘加(见 projectPts 的 tideD)
      const tidePhase = dynOn ? Math.sin(tRef.current * 1.7) * ORB_DYN.tideGain * vEff : 0

      // 各参数平滑过渡到目标值（时间常数同前, 手感不变; amp 一路加快——
      // 旧的 dt*6(τ≈167ms) 会把 45ms 的包络攻击重新拖慢, 手感又变钝）
      const tAmp = cfg.baseAmp + envRef.current * cfg.volAmp
      const tSpd = cfg.baseSpd + envRef.current * cfg.volSpd
      const tRot = cfg.rotSpd

      lerpAmp.current += (tAmp - lerpAmp.current) * Math.min(dt * 14, 1)
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

      // 投影所有点（全局拉扯作用于投影尺寸: 球整体收缩/扩张 + 过冲回弹）
      const isSpectrum = isSpectrumRef.current
      const sProj = scale * (1 + (dynOn ? pullRef.current : 0))
      const projected: Array<{ sx: number; sy: number; z: number; depth: number; dotR: number; colorD: number }> = []
      // tideSign: 外壳与内壳反相（外壳被拉长时内壳被挤扁）——两层视差给出"引力井"的纵深
      const projectPts = (pts: number[][], baseR: number, tide: Float32Array, tideSign: number) => {
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]
          // 潮汐形变: 沿半径的四极子形变（极点↔赤道交替拉长/挤扁）——"被引力拉扯"的观感
          const tideD = tidePhase ? tide[i] * tidePhase * tideSign : 0
          // 软饱和后的半径倍率（dFloor: 极端参数下点也不得穿过球心）
          const d = Math.max(
            ORB_DYN.dFloor,
            radialScale(sn(p[0], p[1], p[2], tRef.current) * amp * cfg.noiseGain + tideD),
          )
          const cosY = Math.cos(rotYRef.current), sinY = Math.sin(rotYRef.current)
          const rx2 = p[0] * d * cosY - p[2] * d * sinY
          const rz = p[0] * d * sinY + p[2] * d * cosY
          const ry2 = p[1] * d
          const cosX = Math.cos(rx), sinX = Math.sin(rx)
          const ry3 = ry2 * cosX - rz * sinX
          const rz3 = ry2 * sinX + rz * cosX
          let sx = cx + rx2 * sProj
          let sy = cy - ry3 * sProj
          // P7 频谱喷流位移：有音量时点云沿 y 轴随正弦分裂为粒子流
          if (isSpectrum && vEff > 0.05) {
            sy += Math.sin(i * 0.3 + tRef.current) * vEff * sProj * 0.5
          }
          const depth = (rz3 + 1.5) / 3.0
          // P7 频谱色相偏移：深度 + 音量驱动三通道近似 hue shift
          const colorD = isSpectrum ? Math.max(0, Math.min(1, depth + vEff * 0.3)) : depth
          const dotR = baseR + depth * 0.8 + amp * 2
          projected.push({ sx, sy, z: rz3, depth, dotR, colorD })
        }
      }
      projectPts(outerPts.current, 0.6, outerTide.current, 1)
      projectPts(innerPts.current, 0.4, innerTide.current, -0.6)

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
          // 2026-09-23: 改用包络（不再读 prop 音量）——播报期球的 volume prop 恒为 0，
          // 旧写法导致光晕强度恒定，球"在说话却毫无起伏"
          const glow = (fx.glow || 1) * (0.5 + envRef.current * 1.2)
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
