/**
 * VoiceDiagnostics — 语音诊断浮层
 *
 * 在开发模式下实时显示 TTS/ASR 的各项指标：
 * - TTS 首帧延迟 (TTFF)
 * - TTS 提供商/音色
 * - ASR 连接状态
 * - 重连计数
 * - 当前语音状态
 *
 * 按 Ctrl+Shift+D (Cmd+Shift+D) 切换显隐
 */

import { useState, useEffect, useRef } from 'react'
import { useVoiceState } from '../contexts/VoiceStateContext'

interface DiagData {
  ttsProvider: string
  ttsVoice: string
  ttsTTFF: number | null
  ttsSegmentsPlayed: number
  ttsState: string
  asrState: string
  asrReconnects: number
  sessionActive: boolean
  volume: number
  playbackId: number
}

export function VoiceDiagnostics() {
  const [visible, setVisible] = useState(false)
  const { state } = useVoiceState()
  const [diag, setDiag] = useState<DiagData>({
    ttsProvider: '-',
    ttsVoice: '-',
    ttsTTFF: null,
    ttsSegmentsPlayed: 0,
    ttsState: 'idle',
    asrState: 'idle',
    asrReconnects: 0,
    sessionActive: false,
    volume: 0,
    playbackId: 0,
  })

  // Ctrl+Shift+D 切换显隐
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        setVisible(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // 2026-08-07 fix(审查报告 P3 轻微项): interval 依赖此前为 [visible, state]——
  // state 每次更新(如 ttsVolume 60ms 一跳)都重建定时器;改为 ref 读最新 state,
  // 依赖仅 [visible]
  const stateRef = useRef(state)
  stateRef.current = state
  // 每秒采集一次诊断数据
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => {
      const s = stateRef.current
      setDiag({
        ttsProvider: s.ttsProvider || '-',
        ttsVoice: s.ttsVoice || '-',
        ttsTTFF: (window as any).__ttsFirstAudioStart
          ? (window as any).__ttsFirstAudioStart - (window as any).__ttsStreamStartTs
          : null,
        ttsSegmentsPlayed: s.ttsSpokenRef?.length || 0,
        ttsState: s.ttsActive ? 'playing' : 'idle',
        asrState: s.voiceSessionActive ? 'active' : 'idle',
        // 2026-08-01: 读取 useVoiceSession 暴露的重连计数（此前硬编码 0，诊断失效）
        asrReconnects: (window as any).__asrReconnects || 0,
        sessionActive: !!s.voiceSessionActive,
        volume: 0,
        playbackId: s.ttsPlaybackId || 0,
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [visible])

  if (!visible) return null

  const ttffColor = diag.ttsTTFF === null ? '#888'
    : diag.ttsTTFF < 800 ? '#4caf50'
    : diag.ttsTTFF < 2000 ? '#ff9800'
    : '#f44336'

  return (
    <div style={{
      position: 'fixed',
      top: 48,
      right: 12,
      zIndex: 99999,
      background: 'rgba(0,0,0,0.85)',
      color: '#fff',
      fontFamily: 'monospace',
      fontSize: 11,
      padding: '8px 12px',
      borderRadius: 8,
      minWidth: 240,
      backdropFilter: 'blur(8px)',
      border: '1px solid rgba(255,255,255,0.15)',
      pointerEvents: 'auto',
      userSelect: 'none',
    }}>
      <div style={{ marginBottom: 6, color: '#aaa', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
        🛠 Voice Diagnostics <span style={{ float: 'right', cursor: 'pointer' }} onClick={() => setVisible(false)}>✕</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>TTS State</td><td style={{ textAlign: 'right' }}>{diag.ttsState}</td></tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>Provider</td><td style={{ textAlign: 'right' }}>{diag.ttsProvider}</td></tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>Voice</td><td style={{ textAlign: 'right' }}>{diag.ttsVoice}</td></tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>TTFF</td>
            <td style={{ textAlign: 'right', color: ttffColor }}>
              {diag.ttsTTFF === null ? '—' : `${diag.ttsTTFF}ms`}
            </td>
          </tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>Spoken</td><td style={{ textAlign: 'right' }}>{diag.ttsSegmentsPlayed} chars</td></tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>Trimmed</td><td style={{ textAlign: 'right' }}>{(window as any).__ttsTrimTotal || 0} segs</td></tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>ASR State</td><td style={{ textAlign: 'right' }}>{diag.asrState}</td></tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>Session</td>
            <td style={{ textAlign: 'right', color: diag.sessionActive ? '#4caf50' : '#888' }}>
              {diag.sessionActive ? 'active' : 'inactive'}
            </td>
          </tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>Session ID</td>
            <td style={{ textAlign: 'right', fontSize: 9 }}>{(window as any).__voiceSessionId || '—'}</td>
          </tr>
          <tr><td style={{ padding: '2px 0', color: '#888' }}>Playback ID</td><td style={{ textAlign: 'right' }}>#{diag.playbackId}</td></tr>
        </tbody>
      </table>
    </div>
  )
}
