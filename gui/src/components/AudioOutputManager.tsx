/**
 * AudioOutputManager — 音频输出设备路由管理器
 *
 * 音频输出设备管理器。
 * 解决：TTS 输出到虚拟音频设备（VB-Cable、Voicemeeter、Steam Streaming 等）
 * 导致用户听不到声音的「静默失败」问题。
 *
 * 三层方案：
 * 1. 显式 sink 绑定：setSinkId() 路由到指定设备
 * 2. 自动规避虚拟设备：检测到默认设备是虚拟的，自动切换到最佳真实设备
 * 3. 横幅提示：无真实设备时显示提示
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'

// ─── 虚拟设备检测关键词 ───────────────────────────────
const VIRTUAL_KEYWORDS = [
  'steam streaming', 'nvidia virtual', 'nvidia broadcast',
  'vb-audio', 'vb audio', 'vb-cable', 'cable output', 'cable input',
  'voicemeeter', 'pico ', 'virtual', 'streaming',
  '虚拟', '串流',
]

function isVirtualOutputLabel(label: string): boolean {
  const lower = label.toLowerCase()
  return VIRTUAL_KEYWORDS.some(kw => lower.includes(kw))
}

/** 真实设备评分：耳机 > 扬声器 > 其他 > HDMI/Display */
function scoreRealDevice(label: string): number {
  const lower = label.toLowerCase()
  if (lower.includes('earphone') || lower.includes('headphone') || lower.includes('headset')
    || lower.includes('耳机') || lower.includes('耳麦')) return 30
  if (lower.includes('speaker') || lower.includes('扬声器') || lower.includes('音箱')) return 20
  if (lower.includes('hdmi') || lower.includes('display') || lower.includes('显示器')) return 5
  return 10
}

// ─── Props ──────────────────────────────────────────────
interface AudioOutputManagerProps {
  /** 当前正在使用的 audio 元素 */
  audioElement?: HTMLAudioElement | null
  /** 设备变化回调 */
  onDeviceChange?: (deviceId: string, label: string) => void
  /** 已固定的设备 ID */
  pinnedDeviceId?: string | null
  /** 固定设备回调 */
  onPinDevice?: (deviceId: string) => void
  /** AudioContext 实例（用于 applyContextSink） */
  /** TTS 播放结束回调 — 用于通知上层重置转录抑制等状态 */
  onPlaybackEnd?: () => void
  /** TTS 播放错误回调 */
  onPlaybackError?: (err: string) => void
}

// ─── 组件 ──────────────────────────────────────────────
export function AudioOutputManager({
  audioElement, onDeviceChange, pinnedDeviceId,
  // P2-3: "切换"按钮已改为系统设置引导，不再固定设备——保留 prop 兼容 VoiceIntegration 传参
  onPinDevice: _onPinDevice, onPlaybackEnd, onPlaybackError,
}: AudioOutputManagerProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [degraded, setDegraded] = useState(false)
  const [suggestedDevice, setSuggestedDevice] = useState<{ id: string; label: string } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 枚举音频输出设备 ──
  const enumerateDevices = useCallback(async () => {
    try {
      // V21 fix: 先获取麦克风权限，使 enumerateDevices 返回完整设备标签
      let permissionGranted = false
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true })
        tempStream.getTracks().forEach(t => t.stop())
        permissionGranted = true
      } catch (e) { console.warn('[AudioOutput] getUserMedia permission denied or unavailable:', e) }
      // 需要先 getUserMedia 才能触发 devicechange
      const all = await navigator.mediaDevices.enumerateDevices()
      const audioOutputs = all.filter(d => d.kind === 'audiooutput')
      setDevices(audioOutputs)

      // V21 fix: 权限被拒绝时设备标签为空，虚拟设备检测不可用，标记降级
      if (!permissionGranted && audioOutputs.length > 0 && !audioOutputs[0].label) {
        setDegraded(true)
        console.warn('[AudioOutput] 麦克风权限未授予，设备标签为空，虚拟设备检测不可用')
      }
    } catch (e) { console.warn('[AudioOutput] enumerateDevices failed:', e) }
  }, [])

  // ── 解析最佳输出设备 ──
  const resolveSink = useCallback(() => {
    if (devices.length === 0) return

    // 1. 已固定设备
    if (pinnedDeviceId) {
      const pinned = devices.find(d => d.deviceId === pinnedDeviceId)
      if (pinned) {
        applySink(pinned.deviceId)
        setDegraded(false)
        setSuggestedDevice(null)
        return
      }
      // 固定设备丢失 → 降级
      setDegraded(true)
    }

    // 2. 自动模式
    const defaultDev = devices.find(d => d.deviceId === 'default' || d.deviceId === '')
    const isDefaultVirtual = defaultDev && isVirtualOutputLabel(defaultDev.label)

    if (!isDefaultVirtual) {
      // 默认设备正常
      setDegraded(false)
      setSuggestedDevice(null)
      return
    }

    // 3. 默认是虚拟设备 → 找到最佳真实设备
    const realDevices = devices.filter(d => !isVirtualOutputLabel(d.label) && d.deviceId !== 'default')
    realDevices.sort((a, b) => scoreRealDevice(b.label) - scoreRealDevice(a.label))

    if (realDevices.length > 0) {
      const best = realDevices[0]
      applySink(best.deviceId)
      setDegraded(true)
      setSuggestedDevice({ id: best.deviceId, label: best.label })
    } else {
      // 无真实设备
      setDegraded(true)
      setSuggestedDevice(null)
    }
  }, [devices, pinnedDeviceId])

  // ── 应用 sink ──
  const applySink = useCallback((deviceId: string) => {
    // ⚠️ v8 fix: 不再对 audioElement 调用 setSinkId！
    // createMediaElementSource 已移除，<audio> 使用原生播放（useVoiceReply 恒走系统
    // 默认输出）。此处仅把选择记录到全局变量（P2-3: 用户切换输出需走系统声音设置）。
    ;(window as any).__audioOutputDeviceId = deviceId
    onDeviceChange?.(deviceId, devices.find(d => d.deviceId === deviceId)?.label || '')
  }, [devices, onDeviceChange])

  // ── 初始化 ──
  // 2026-08-07: 删除 ambient-noise 死代码——原设计为"环境噪声监测 + 音量自适应"
  // (见已删除的 src/lib/ambient-noise.ts 头注释),但 startNoiseMonitor 无调用者
  // (单界面下麦克风归 KWS 唤醒进程),此处 stopMonitor 恒为空操作;播放音量自适应
  // 一并移除(useVoiceReply 侧改常量 1),避免误导后人以为有监测在跑(审查报告 P2)
  useEffect(() => {
    enumerateDevices()

    const handler = () => {
      clearTimeout(bannerTimerRef.current!)
      bannerTimerRef.current = setTimeout(enumerateDevices, 250)
    }
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handler)
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current)
    }
  }, [enumerateDevices])

  // ── V7 fix: 监听 audioElement 的播放结束/错误事件 ──
  useEffect(() => {
    if (!audioElement) return
    const handleEnded = () => onPlaybackEnd?.()
    const handleError = () => onPlaybackError?.(audioElement.error?.message || 'TTS audio playback error')
    audioElement.addEventListener('ended', handleEnded)
    audioElement.addEventListener('error', handleError)
    return () => {
      audioElement.removeEventListener('ended', handleEnded)
      audioElement.removeEventListener('error', handleError)
    }
  }, [audioElement, onPlaybackEnd, onPlaybackError])

  // ── 设备列表变化时重新解析 ──
  useEffect(() => {
    if (devices.length > 0) resolveSink()
  }, [devices, resolveSink])

  // ── 清理 ──
  useEffect(() => {
    return () => { if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current) }
  }, [])

  // ── 横幅渲染 ──
  if (!degraded || dismissed || !suggestedDevice) return null

  return createPortal(
    <div
      style={{
        position: 'fixed',
        bottom: '80px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 2147483000,
        padding: '12px 20px',
        borderRadius: '12px',
        backgroundColor: 'var(--panel, rgba(24,24,36,0.95))',
        backdropFilter: 'blur(16px)',
        border: '1px solid var(--warm, #e0a64d)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        fontSize: '13px',
        color: 'var(--ink, #e0e0e0)',
      }}
    >
      <span>⚠️ 音频可能输出到了虚拟设备，建议切换到 </span>
      <strong>{suggestedDevice.label}</strong>
      <button
        onClick={() => {
          // P2-3: 此前"切换"只存 deviceId 到全局变量（setSinkId 已按 v8 决策移除，
          // <audio> 恒走系统默认输出），实际不生效。改为 toast 引导用户走系统设置。
          try { toast.info('请在系统声音设置中切换输出设备') } catch (err) { console.error('[AudioOutput] 切换提示失败:', err) }
        }}
        style={{
          padding: '6px 14px',
          borderRadius: '8px',
          border: '1px solid var(--warm, #e0a64d)',
          backgroundColor: 'transparent',
          color: 'var(--warm, #e0a64d)',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: 600,
        }}
      >
        切换
      </button>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--dim, #888)',
          cursor: 'pointer',
          fontSize: '16px',
          padding: '0 4px',
        }}
        title="关闭"
      >
        ✕
      </button>
    </div>,
    document.body,
  )
}

export default AudioOutputManager
