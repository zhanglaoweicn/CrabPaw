/**
 * VoiceStateContext — 语音状态上下文
 * 
 * 统一管理所有语音相关状态，替代window全局变量。
 * 提供向后兼容：同时更新window全局变量。
 */

import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react'
import { subscribeTtsState, setTtsDucked } from '../lib/tts-state'

interface VoiceState {
  // TTS 状态
  ttsActive: boolean
  ttsProvider: string
  ttsVoice: string
  ttsTTFF: number | null
  ttsPlaybackId: number
  ttsSpokenRef: string
  ttsDucked: boolean
  ttsInterruptedSpoken: string
  ttsInterruptedAt: number
  ttsCurrentSegment: string

  // ASR 状态
  voiceSessionActive: boolean
  voiceSessionState: 'idle' | 'listening' | 'processing' | 'speaking' | 'recognizing' | 'error' | 'media_paused' | 'wake_listening' | null

  // 音频输出
  audioOutputDeviceId: string
}

type VoiceAction = { type: 'UPDATE'; payload: Partial<VoiceState> }

const initialState: VoiceState = {
  ttsActive: false,
  ttsProvider: '-',
  ttsVoice: '-',
  ttsTTFF: null,
  ttsPlaybackId: 0,
  ttsSpokenRef: '',
  ttsDucked: false,
  ttsInterruptedSpoken: '',
  ttsInterruptedAt: 0,
  ttsCurrentSegment: '',
  voiceSessionActive: false,
  voiceSessionState: null,
  audioOutputDeviceId: '',
}

function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case 'UPDATE':
      return { ...state, ...action.payload }
    default:
      return state
  }
}

interface VoiceStateContextType {
  state: VoiceState
  updateState: (updates: Partial<VoiceState>) => void
}

const VoiceStateContext = createContext<VoiceStateContextType | null>(null)

export function VoiceStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(voiceReducer, initialState)

  const updateState = useCallback((updates: Partial<VoiceState>) => {
    dispatch({ type: 'UPDATE', payload: updates })
  }, [])

  // 向后兼容：同步到 window 全局变量
  // 2026-08-12: window.__tts* 由 tts-state 单一写入模块镜像（见下方订阅），此处不再直写
  const prevStateRef = useRef(initialState)
  useEffect(() => {
    const w = window as any
    const prev = prevStateRef.current
    // 仅同步变化的 key，避免每 60ms 音量更新触发 12 个属性的全量重写
    if (state.ttsProvider !== prev.ttsProvider) w.__ttsProvider = state.ttsProvider
    if (state.ttsVoice !== prev.ttsVoice) w.__ttsVoice = state.ttsVoice
    // P5(GUI 全量修复 P1): 删除 __ttsFirstAudioStart 覆盖写——旧实现用"当前时刻"
    // Date.now() 覆盖 useVoiceReply 实测的首音频时刻(语义错误的双写者); 该键由
    // useVoiceReply:950 单一写入(实测首帧时机)
    if (state.ttsPlaybackId !== prev.ttsPlaybackId) w.__ttsPlaybackId = state.ttsPlaybackId
    if (state.ttsSpokenRef !== prev.ttsSpokenRef) w.__ttsSpokenRef = state.ttsSpokenRef
    if (state.ttsDucked !== prev.ttsDucked) setTtsDucked(state.ttsDucked)
    if (state.ttsInterruptedSpoken !== prev.ttsInterruptedSpoken) w.__ttsInterruptedSpoken = state.ttsInterruptedSpoken
    if (state.ttsInterruptedAt !== prev.ttsInterruptedAt) w.__ttsInterruptedAt = state.ttsInterruptedAt
    if (state.ttsCurrentSegment !== prev.ttsCurrentSegment) w.__ttsCurrentSegment = state.ttsCurrentSegment
    // P5(GUI 全量修复 P1): __ttsVolume 改由 tts-state 订阅镜像(下方)——
    // 不再从 React state 高频镜像(旧实现 60ms 音量更新触发全量 state diff)
    // 2026-08-05: __voiceSessionActive 改为单向（仅 VoiceIntegration 写入），
    // 对齐 __ttsActive 先例——避免 React 状态滞后覆盖真实 session 状态。
    if (state.voiceSessionState !== prev.voiceSessionState) w.__voiceSessionState = state.voiceSessionState
    if (state.audioOutputDeviceId !== prev.audioOutputDeviceId) w.__audioOutputDeviceId = state.audioOutputDeviceId
    prevStateRef.current = state
  }, [state])

  // 2026-08-12: 订阅 tts-state 单一写入模块 → 镜像到 window.__ (只读)
  // P5(GUI 全量修复 P1): 同时回写 context state.ttsActive——旧实现只镜像 window,
  // state.ttsActive 无任何写入方(死字段)→ flow.ttsPlaying 只剩 isSpeaking 兜底,
  // VoiceDiagnostics 播放中恒显示 idle
  useEffect(() => {
    return subscribeTtsState((s) => {
      const w = window as any
      w.__ttsActive = s.active
      w.__ttsOwner = s.owner
      w.__ttsAudioElement = s.audioElement
      w.__ttsAbortController = s.aborted
      w.__ttsDucked = s.ducked
      w.__ttsVolume = s.volume
      dispatch({ type: 'UPDATE', payload: { ttsActive: s.active } })
    })
  }, [])

  // 提供 imperative 访问（兼容旧代码中直接读取 window.__voiceStateContext）
  useEffect(() => {
    const w = window as any
    w.__voiceStateContext = { getState: () => state, updateState }
    return () => { delete w.__voiceStateContext }
  }, [state, updateState])

  return (
    <VoiceStateContext.Provider value={{ state, updateState }}>
      {children}
    </VoiceStateContext.Provider>
  )
}

export function useVoiceState() {
  const context = useContext(VoiceStateContext)
  if (!context) {
    throw new Error('useVoiceState must be used within a VoiceStateProvider')
  }
  return context
}

// 便捷hooks
export function useTTSState() {
  const { state } = useVoiceState()
  return {
    isActive: state.ttsActive,
    provider: state.ttsProvider,
    voice: state.ttsVoice,
    ttff: state.ttsTTFF,
    playbackId: state.ttsPlaybackId,
    spokenText: state.ttsSpokenRef,
    isDucked: state.ttsDucked,
    interruptedSpoken: state.ttsInterruptedSpoken,
    interruptedAt: state.ttsInterruptedAt,
    currentSegment: state.ttsCurrentSegment,
  }
}

export function useASRState() {
  const { state } = useVoiceState()
  return {
    isActive: state.voiceSessionActive,
    sessionState: state.voiceSessionState,
  }
}
