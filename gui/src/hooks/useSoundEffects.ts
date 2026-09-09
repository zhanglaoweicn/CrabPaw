/**
 * useSoundEffects — Web Audio API 程序化音效系统
 *
 * 无需外部音频文件，用 OscillatorNode + GainNode 实时合成科技感音效。
 * 首次用户交互后懒加载 AudioContext（浏览器策略要求）。
 *
 * 音效类型：
 * - panel-open:   上升扫频 400→800Hz, 150ms, sine — 面板展开
 * - panel-close:  下降扫频 800→400Hz, 100ms, sine — 面板收起
 * - notification: 双音 880→1320Hz, 200ms — 通知提示
 * - button-click: 短促方波 1000Hz, 30ms — 按钮反馈
 * - voice-start:  柔和上升 300→500Hz, 200ms, triangle — 开始监听
 * - voice-end:    柔和下降 500→300Hz, 150ms, triangle — 停止监听
 * - error:        低频警告 220Hz, 300ms, sawtooth — 错误提示
 */

import { useEffect, useState, useCallback, useRef } from 'react'

export type SoundType =
  | 'panel-open'
  | 'panel-close'
  | 'notification'
  | 'button-click'
  | 'voice-start'
  | 'voice-end'
  | 'error'

// ─── 音效参数配置 ──────────────────────────────────────
interface SoundConfig {
  freqStart: number
  freqEnd: number
  duration: number  // ms
  type: OscillatorType
  gain: number      // 0-1
}

const SOUND_CONFIGS: Record<SoundType, SoundConfig> = {
  'panel-open':    { freqStart: 400, freqEnd: 800,  duration: 150, type: 'sine',     gain: 0.15 },
  'panel-close':   { freqStart: 800, freqEnd: 400,  duration: 100, type: 'sine',     gain: 0.12 },
  'notification':  { freqStart: 880, freqEnd: 1320, duration: 200, type: 'sine',     gain: 0.18 },
  'button-click':  { freqStart: 1000, freqEnd: 1000, duration: 30, type: 'square',   gain: 0.08 },
  'voice-start':   { freqStart: 300, freqEnd: 500,  duration: 200, type: 'triangle', gain: 0.10 },
  'voice-end':     { freqStart: 500, freqEnd: 300,  duration: 150, type: 'triangle', gain: 0.10 },
  'error':         { freqStart: 220, freqEnd: 180,  duration: 300, type: 'sawtooth', gain: 0.12 },
}

// ─── 全局单例（允许非 React 组件调用） ──────────────────
let _sharedCtx: AudioContext | null = null
let _enabled = true

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!_sharedCtx) {
    try {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext
      if (!Ctor) return null
      _sharedCtx = new Ctor()
    } catch (e) {
      console.warn('[SoundEffects] AudioContext init failed:', e)
      return null
    }
  }
  // 浏览器可能挂起 ctx（autoplay policy），尝试恢复
  if (_sharedCtx.state === 'suspended') {
    _sharedCtx.resume().catch(() => {})
  }
  return _sharedCtx
}

/** 程序化合成并播放一个音效 */
function synthesizeSound(ctx: AudioContext, config: SoundConfig): void {
  const now = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = config.type
  osc.frequency.setValueAtTime(config.freqStart, now)
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(config.freqEnd, 1), // exponentialRamp 不接受 0
    now + config.duration / 1000
  )

  // ADSR 包络：快速攻击 + 指数衰减
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(config.gain, now + 0.005) // 5ms attack
  gain.gain.exponentialRampToValueAtTime(0.001, now + config.duration / 1000)

  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(now)
  osc.stop(now + config.duration / 1000 + 0.02) // 多 20ms 释放尾部
}

// ─── 启动氛围段（无版权音乐时的合成 fallback，P5.5）— 低频 drone 渐强 + 高频星辉 ──

export function playBootAmbience(durationSec = 10): void {
  // 2026-08-31 修复: 开机氛围音此前不读 _enabled——Jarvis 音效开关关闭时
  // 启动仍响 10s 氛围音, 与总闸语义矛盾; 接入与 playSound 同门控。
  if (!_enabled) return
  const ctx = getAudioContext()
  if (!ctx) return
  const now = ctx.currentTime
  const t0 = now + 0.05
  const master = ctx.createGain()
  master.gain.setValueAtTime(0, t0)
  master.gain.linearRampToValueAtTime(0.12, t0 + durationSec * 0.5)
  master.gain.linearRampToValueAtTime(0.06, t0 + durationSec)
  master.connect(ctx.destination)

  // 低频 drone（40Hz + 55Hz 失谐 — 管风琴式呼吸）
  for (const f of [40, 55]) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(f, t0)
    o.frequency.linearRampToValueAtTime(f * 1.02, t0 + durationSec)
    o.connect(master)
    o.start(t0)
    o.stop(t0 + durationSec + 0.1)
  }
  // 星辉闪烁：高频短音随机出现
  const shimmer = ctx.createGain()
  shimmer.gain.setValueAtTime(0.02, t0)
  shimmer.connect(master)
  for (let i = 0; i < 5; i++) {
    const st = t0 + 0.6 + i * (durationSec / 5.5)
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(1200 + Math.random() * 900, st)
    shimmer.gain.setValueAtTime(0, st)
    shimmer.gain.linearRampToValueAtTime(0.05, st + 0.05)
    shimmer.gain.linearRampToValueAtTime(0, st + 0.35)
    o.connect(shimmer)
    o.start(st)
    o.stop(st + 0.4)
  }
}

/** 全局播放函数（可在任何地方调用，不限于 React 组件内） */
export function playSound(type: SoundType): void {
  if (!_enabled) return
  const ctx = getAudioContext()
  if (!ctx) return
  const config = SOUND_CONFIGS[type]
  if (!config) return
  try {
    synthesizeSound(ctx, config)
  } catch (e) {
    console.warn(`[SoundEffects] play("${type}") failed:`, e)
  }
}

/** 全局开关（可在 React 外调用） */
export function setSoundEnabled(v: boolean): void {
  _enabled = v
  try { localStorage.setItem('sound-effects-enabled', v ? '1' : '0') } catch (e: any) { console.warn('[SoundEffects] localStorage setItem failed:', e?.message || e) }
}

/** 读取 localStorage 初始值 */
function readInitialEnabled(): boolean {
  try {
    const v = localStorage.getItem('sound-effects-enabled')
    return v === null ? true : v === '1' // 默认开启
  } catch {
    return true
  }
}

// ─── React Hook ────────────────────────────────────────
export function useSoundEffects() {
  const [enabled, setEnabledState] = useState(readInitialEnabled)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  // 同步到全局
  useEffect(() => {
    _enabled = enabled
    try { localStorage.setItem('sound-effects-enabled', enabled ? '1' : '0') } catch (e: any) { console.warn('[SoundEffects] localStorage setItem failed:', e?.message || e) }
  }, [enabled])

  // 首次用户交互时初始化 AudioContext
  useEffect(() => {
    const init = () => { getAudioContext() }
    // pointerdown 比 click 更早触发
    window.addEventListener('pointerdown', init, { once: true })
    window.addEventListener('keydown', init, { once: true })
    return () => {
      window.removeEventListener('pointerdown', init)
      window.removeEventListener('keydown', init)
    }
  }, [])

  const play = useCallback((type: SoundType) => {
    if (!enabledRef.current) return
    playSound(type)
  }, [])

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v)
  }, [])

  const toggle = useCallback(() => {
    setEnabledState(v => !v)
  }, [])

  return { play, enabled, setEnabled, toggle }
}
