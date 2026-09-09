/**
 * useWakeWord — 唤醒词检测 + 连续对话生命周期
 *
 * 唤醒词检测 Hook — 浏览器语音识别编排
 *   唤醒命中 → 启动麦克风 → 监听 → 识别到语音 → 发送给 AI
 *   → AI 回复(TTS) → 自动回到监听(连续对话) → 或退出
 *
 * 三种退出条件：
 *   1. 用户要求退下 → voice_retire SSE 事件
 *   2. 任务完成 → 同上
 *   3. 60s 空闲无语音 → 自动退场
 *
 * 退场策略：等当前 TTS 播放完毕再关闭（防止切断告别语）
 *
 * 注意：不创建 SSE 连接（复用父组件的 useSse），通过外部传入事件通知。
 */

import { useEffect, useRef, useCallback, useState } from 'react'

declare global {
  interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number
    readonly results: SpeechRecognitionResultList
  }
  interface SpeechRecognitionErrorEvent extends Event {
    readonly error: string
  }
  interface SpeechRecognition extends EventTarget {
    lang: string
    continuous: boolean
    interimResults: boolean
    onresult: ((event: SpeechRecognitionEvent) => void) | null
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
    onend: (() => void) | null
    start(): void
    stop(): void
    abort(): void
  }
}

const IDLE_DISMISS_MS = 60000
const ORB_EXIT_MS = 320
const FALLBACK_WAKE_WORDS = ['你好']

/**
 * 2026-08-01: 唤醒词动态化——从智能体配置名称生成。
 * 用户改名称后唤醒词自动跟随（此前硬编码 ['小白龙','小龙女',...] 与配置重复维护）。
 */
async function fetchAgentName(): Promise<string | null> {
  try {
    if (window.electronAPI?.config?.assistant?.get) {
      const cfg = await window.electronAPI.config.assistant.get()
      if (cfg?.name && typeof cfg.name === 'string') return cfg.name.trim()
    }
  } catch (err: any) { console.warn('[WakeWord] electronAPI 获取智能体名称失败:', err?.message || err) }
  try {
    const { apiGet, extractApiData } = await import('../lib/api')
    const res = await apiGet<{ agent?: { name?: string } }>('/config')
    const data = extractApiData(res)
    if (data?.agent?.name) return String(data.agent.name).trim()
  } catch (err: any) { console.warn('[WakeWord] API 获取智能体名称失败:', err?.message || err) }
  return null
}

/**
 * 从智能体名称构建唤醒词列表：
 * - 名称 ≥2 字符且非纯英文（Web Speech zh-CN 对中文识别更可靠）
 * - 主词 + '嘿'前缀 + 'hi'前缀
 * - 兜底通用词 '你好'
 */
function buildWakeWords(agentName: string | null): string[] {
  const words: string[] = []
  const name = (agentName || '').trim()
  if (name && name.length >= 2 && !/^[a-zA-Z\s]+$/.test(name)) {
    words.push(name, `嘿${name}`, `hi ${name}`)
  }
  words.push(...FALLBACK_WAKE_WORDS)
  return [...new Set(words)]
}

export type WakeState = 'sleeping' | 'waking' | 'listening' | 'recognizing' | 'processing' | 'speaking' | 'dismissing'

interface UseWakeWordOptions {
  onWake?: () => void
  onDismiss?: () => void
  onStateChange?: (state: WakeState) => void
  wakeWordEnabled?: boolean
}

export function useWakeWord(options: UseWakeWordOptions = {}) {
  const { wakeWordEnabled = false } = options

  // ── 用 ref 保存回调，避免依赖变化触发 effect 重建 ──
  const optsRef = useRef(options)
  optsRef.current = options

  const [wakeState, setWakeState] = useState<WakeState>('sleeping')

  // 2026-08-01: 动态唤醒词列表（ref 供检测循环即时读取，支持配置热更新）
  const wakeWordsRef = useRef<string[]>(buildWakeWords(null))
  const refreshWakeWords = useCallback(async () => {
    try {
      const name = await fetchAgentName()
      wakeWordsRef.current = buildWakeWords(name)
      console.log('[WakeWord] 唤醒词:', wakeWordsRef.current.join(' / '))
    } catch (err: any) { console.warn('[WakeWord] refreshWakeWords 失败:', err?.message || err) }
  }, [])

  const stateRef = useRef<WakeState>('sleeping')
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTokenRef = useRef(0)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  // 2026-08-07: 唤醒命中后 300ms 延迟进入 'listening' 的定时器——此前未入 ref,
  // 停用/卸载后仍可能触发(泄漏 + 卸载后 setState);统一入 ref 清除
  const wakeDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // P2 修复: 防止 stopWakeDetection 后 Web Speech onend 异步回调绕过守卫重启——
  // stop 时置位,onend 回调检查后不 start;start 时复位
  const stoppedRef = useRef(false)
  const wakeRestartCountRef = useRef(0)
  const wakeRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 连续对话状态 ──
  const lastActiveTsRef = useRef(0)
  const retirePendingRef = useRef(false)
  const retireArmedRef = useRef(false)
  const retireArmedTsRef = useRef(0)

  const updateState = useCallback((s: WakeState) => {
    stateRef.current = s
    setWakeState(s)
    optsRef.current.onStateChange?.(s)
  }, [])

  const markActive = useCallback(() => {
    lastActiveTsRef.current = Date.now()
  }, [])

  // ── 退场 ──
  const dismiss = useCallback(() => {
    if (stateRef.current === 'sleeping' || stateRef.current === 'dismissing') return
    const token = ++dismissTokenRef.current
    updateState('dismissing')
    retirePendingRef.current = false
    retireArmedRef.current = false
    optsRef.current.onDismiss?.()
    setTimeout(() => {
      if (token !== dismissTokenRef.current) return
      updateState('sleeping')
    }, ORB_EXIT_MS)
  }, [updateState])

  // ── 60s 空闲退场 ──
  const resetIdleTimer = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    markActive()
    const token = ++dismissTokenRef.current
    dismissTimerRef.current = setInterval(() => {
      if (dismissTokenRef.current !== token) return
      if (stateRef.current === 'sleeping' || stateRef.current === 'dismissing') return
      if (stateRef.current === 'listening' || stateRef.current === 'recognizing') {
        if (Date.now() - lastActiveTsRef.current >= IDLE_DISMISS_MS) {
          console.log('[WakeWord] 60s 空闲，自动退场')
          dismiss()
        }
      }
    }, 2000)
  }, [markActive, dismiss])

  // ── 唤醒命中 ──
  const onHit = useCallback(() => {
    if (stateRef.current === 'dismissing') {
      console.log('[WakeWord] 正在退场中，忽略唤醒')
      return
    }
    if (stateRef.current !== 'sleeping') {
      // 2026-08-03: TTS 播放中（会话 active）命中 → 除保持活跃外也触发 onWake
      // （打断 TTS + 接管会话）——此前只 markActive，唤醒词无法打断播报
      // （空格 PTT 有效因是独立打断路径）
      markActive()
      try { optsRef.current.onWake?.() } catch (e) { console.warn('[WakeWord] 非休眠命中 onWake 失败:', e) }
      return
    }
    console.log('[WakeWord] 唤醒命中')
    dismissTokenRef.current++
    retirePendingRef.current = false
    retireArmedRef.current = false
    updateState('waking')
    // 2026-08-07: 定时器句柄入 ref——stopWakeDetection/卸载时清除,
    // 避免停用后延迟回调仍触发 onWake(泄漏 + 卸载后 setState)
    // 2026-08-15 S10a: 延迟 300→50ms——KWS 检测层已有 1.5s 去抖, 此处再防抖
    // 纯属唤醒响应损失(用户喊完等 300ms 才开麦); 50ms 保留 waking 态一个
    // 渲染帧, 消除大部分固定延迟
    if (wakeDelayTimerRef.current) clearTimeout(wakeDelayTimerRef.current)
    wakeDelayTimerRef.current = setTimeout(() => {
      wakeDelayTimerRef.current = null
      if (stateRef.current === 'waking') {
        updateState('listening')
        optsRef.current.onWake?.()
        resetIdleTimer()
      }
    }, 50)
  }, [updateState, resetIdleTimer, markActive])

  // ── 通过外部事件更新活跃 ──
  const markActiveExternal = useCallback(() => {
    if (stateRef.current === 'sleeping' || stateRef.current === 'dismissing') return
    markActive()
  }, [markActive])

  const noteTranscript = useCallback(() => {
    if (stateRef.current === 'sleeping' || stateRef.current === 'dismissing') return
    markActive()
    retirePendingRef.current = false
    retireArmedRef.current = false
  }, [markActive])

  const requestDismiss = useCallback(() => {
    if (stateRef.current === 'sleeping' || stateRef.current === 'dismissing') return
    retirePendingRef.current = true
    markActive()
  }, [markActive])

  const onResponse = useCallback(() => {
    markActive()
    if (retirePendingRef.current) {
      retireArmedRef.current = true
      retireArmedTsRef.current = Date.now()
    }
  }, [markActive])

  // ── 连续对话回复完成后自动回到监听 ──
  const resumeListening = useCallback(() => {
    if (stateRef.current === 'sleeping' || stateRef.current === 'dismissing') return
    if (retireArmedRef.current && Date.now() - retireArmedTsRef.current > 600) {
      console.log('[WakeWord] 武装退场执行')
      dismiss()
      return
    }
    updateState('listening')
    markActive()
  }, [markActive, dismiss, updateState])

  // ── Web Speech API 唤醒词检测 ──
  // 用 ref 存 onHit，避免 effect 依赖变化
  const onHitRef = useRef(onHit)
  onHitRef.current = onHit

  const startWakeDetection = useCallback(() => {
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
      console.warn('[WakeWord] 浏览器不支持 Web Speech API')
      return
    }
    stoppedRef.current = false
    // 2026-08-01: 每次启动检测时刷新唤醒词（智能体名称可能已变更）
    refreshWakeWords()

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = ''
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript
        }
      }
      const text = finalTranscript.trim()
      if (!text) return
      // 2026-08-01: 动态唤醒词（ref 读取，热更新即时生效）
      for (const word of wakeWordsRef.current) {
        if (text.includes(word)) {
          console.log('[WakeWord] 检测到唤醒词:', word)
          // V23 fix: 成功检测唤醒词时重置重连计数器，避免因之前重试累积导致永久静默
          wakeRestartCountRef.current = 0
          recognition.stop()
          onHitRef.current()
          return
        }
      }
    }

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // no-speech 是正常行为（麦克风开着但没人说话），静默忽略
      if (event.error === 'no-speech') return
      if (event.error === 'aborted') return
      if (event.error === 'network') {
		        // V23 fix: 成功识别时重置计数器 — 网络错误减轻但不完全清零
		        wakeRestartCountRef.current = Math.max(0, wakeRestartCountRef.current - 2)
		        return
      }
      console.warn('[WakeWord] 语音识别错误:', event.error)
    }

    recognition.onend = () => {
      // P2 修复: stoppedRef 显式标记停止意图——防止 stopWakeDetection 后
      // Web Speech onend 异步回调绕过守卫重启 recognition。
      // 同时检查 sleeping 态(组件卸载/停用时 updateState('sleeping') 设置)。
      if (stoppedRef.current) return
      if (stateRef.current === 'sleeping') return
      if (!optsRef.current.wakeWordEnabled) return
      if (stateRef.current === 'dismissing' || stateRef.current === 'waking') return
      wakeRestartCountRef.current++
      // V11 fix: 超过 20 次后降低重试频率，并在 60s 冷却期后重置计数器允许恢复
      if (wakeRestartCountRef.current > 20) {
        const delay = 30000
        if (wakeRestartTimerRef.current) clearTimeout(wakeRestartTimerRef.current)
        wakeRestartTimerRef.current = setTimeout(() => {
          // 冷却期后重置计数器，允许后续正常重试
          if (wakeRestartCountRef.current > 20) {
            console.log('[WakeWord] 冷却期结束，重置重连计数器')
            wakeRestartCountRef.current = 0
          }
          try { recognition.start() } catch (err: any) { console.warn('[WakeWord] recognition.start 失败(冷却期后):', err?.message || err) }
        }, delay)
        return
      }
      if (wakeRestartTimerRef.current) clearTimeout(wakeRestartTimerRef.current)
      wakeRestartTimerRef.current = setTimeout(() => {
        try { recognition.start() } catch (err: any) { console.warn('[WakeWord] recognition.start 失败(重试):', err?.message || err) }
      }, 2000)
    }

    recognitionRef.current = recognition
    wakeRestartCountRef.current = 0

    try {
      recognition.start()
      console.log('[WakeWord] 唤醒词检测已启动')
    } catch (e) {
      console.error('[WakeWord] 启动失败:', e)
    }
  }, [])

  const stopWakeDetection = useCallback(() => {
    stoppedRef.current = true
    if (wakeRestartTimerRef.current) clearTimeout(wakeRestartTimerRef.current)
    if (wakeDelayTimerRef.current) { clearTimeout(wakeDelayTimerRef.current); wakeDelayTimerRef.current = null }
    // 2026-08-14 审计: 60s 空闲检测的 2s interval 此前从不清理——停用/卸载后仍空转
    // (token 守卫使其不再 dismiss,但句柄泄漏);停用/卸载时一并清除
    if (dismissTimerRef.current) { clearInterval(dismissTimerRef.current); dismissTimerRef.current = null }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch (err: any) { console.warn('[WakeWord] recognition.stop 失败:', err?.message || err) }
      recognitionRef.current = null
    }
  }, [])

  /** V11 fix: 重置唤醒词重连计数器 — ASR WS 重连后调用，避免陈旧计数器阻止唤醒检测 */
  const resetRestartCounter = useCallback(() => {
    wakeRestartCountRef.current = 0
    if (wakeRestartTimerRef.current) {
      clearTimeout(wakeRestartTimerRef.current)
      wakeRestartTimerRef.current = null
    }
  }, [])

  // ── 唤醒词检测启停（仅依赖 wakeWordEnabled） ──
  // 初始化为 false 确保首次 mount 时正确触发 startWakeDetection
  const prevWakeEnabledRef = useRef(false)
  useEffect(() => {
    const wasEnabled = prevWakeEnabledRef.current
    const nowEnabled = wakeWordEnabled
    prevWakeEnabledRef.current = nowEnabled

    if (nowEnabled && !wasEnabled) {
      // 从关闭→开启
      startWakeDetection()
    } else if (!nowEnabled && wasEnabled) {
      // 从开启→关闭
      stopWakeDetection()
      updateState('sleeping')
    }

    return () => {
      // 注意：组件卸载时清理
      stopWakeDetection()
    }
    // 注意: 故意省略 startWakeDetection/stopWakeDetection 依赖
    // 这些函数只在 enabled 切换时调用，不需要追踪其内部的引用变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeWordEnabled, updateState])

  return {
    wakeState,
    onHit,
    dismiss,
    requestDismiss,
    resumeListening,
    noteTranscript,
    markActive,
    markActiveExternal,
    onResponse,
    /** V11 fix: 重置唤醒词重连计数器 */
    resetRestartCounter,
  }
}
