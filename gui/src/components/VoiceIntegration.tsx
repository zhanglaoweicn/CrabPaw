/**
 * VoiceIntegration — 语音系统编排层（CrabPaw）
 *
 * 组装共享会话引擎（useVoiceSession）+ 两个模式策略：
 *   - useContinuousVoice（常开监听：自动断句发送 + barge-in 检测）
 *   - usePushToTalk（PTT 门控代理：按住空格 = 强制立即发一次）
 *
 * 解耦结构：
 *   useVoiceSession    共享机制 — 麦克风采集 + ASR 传输/转录 + 会话生命周期
 *   useContinuousVoice  常开策略 — 自动断句发送 + barge-in 打断检测（会话默认策略）
 *   usePushToTalk       PTT 策略 — 按住门控 + 松手立即发送（在常开策略之上叠加）
 *
 * 两模式共用同一个 voiceSession 会话，以保持「常开在跑时按空格 = 强制立即发一次」的叠加语义。
 * 改一个模式的策略只动对应文件，底层机制集中在 useVoiceSession。
 * P5.5: 空格 PTT 键盘监听在此注册（HUD 提示"空格=按住说话"的接线）。
 */

import { useCallback, useEffect, useRef } from 'react'
import { useVoiceSession } from '../hooks/useVoiceSession'
import { useWakeWord } from '../hooks/useWakeWord'
import { useContinuousVoice } from '../hooks/useContinuousVoice'
import { usePushToTalk } from '../hooks/usePushToTalk'
import { AudioOutputManager } from './AudioOutputManager'
import { useVoiceState } from '../contexts/VoiceStateContext'
import { interceptLocalVoiceCommand } from '../lib/voiceCommands'
import { useVoicePlayConsumer } from '../hooks/useVoicePlayConsumer'
import { applyDuckVolume } from '../lib/voice-engine-utils'
import { setTtsVolume } from '../lib/tts-state'
// P2(GUI 全量修复): 唤醒会话窗口内放行自动发送(修复"唤醒后说话永不发送 LLM" P0)
import { isWakeActive, shouldAutoSend } from '../lib/voice-auto-send'

// P5(GUI 全量修复 P1): 读取 Settings 麦克风选择(localStorage 'mic-device-id',
// 与 useVoiceSession 同一键)——usePushToTalk 需要同一设备
function readMicDeviceId(): string | undefined {
  try {
    const v = localStorage.getItem('mic-device-id')
    return v || undefined
  } catch (e) {
    console.warn('[Voice] 读麦克风设备失败:', (e as any)?.message || e)
    return undefined
  }
}

// ── readTTSVol: 从 AnalyserNode 读取实时 RMS 音量 ──
// v8: 当没有真实 analyser（不使用 createMediaElementSource）时，用模拟音量驱动球体
function readTTSVol(): number {
  const analyser = (window as any).__ttsAnalyser as AnalyserNode | undefined

  // v8: 如果标记了使用模拟音量（没有 createMediaElementSource），用正弦波模拟
  if ((window as any).__ttsUseSimulatedVolume && (window as any).__ttsActive) {
    // 模拟 TTS 播放时的音量：0.3~0.8 的正弦波 + 随机扰动
    return 0.45 + Math.sin(Date.now() / 180) * 0.25 + (Math.random() - 0.5) * 0.1
  }

  if (!analyser) return 0
  try {
    const dataArray = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(dataArray)
    let sum = 0
    for (const v of dataArray) {
      const centered = (v - 128) / 128
      sum += centered * centered
    }
    const rms = Math.sqrt(sum / dataArray.length)
    return Math.min(1, Math.max(0, rms * 3.2))
  } catch { console.warn('[Voice] readTTSVol 失败');
    return 0
  }
}

export interface VoiceIntegrationProps {
  replyEnabled: boolean
  ttsPlaying: boolean
  sendMessage: (text: string) => void
  continuousMode?: boolean
  wakeWordEnabled?: boolean
  // 2026-08-01: ASR provider（aliyun/tencent/xunfei/volcengine），此前硬编码 volcengine
  asrProvider?: string
  onStateChange?: (state: { sessionActive: boolean }) => void
  /** P5.5: 全静默 — muted 时输入输出全关（PTT/连续对话/触摸均失效，会话停止） */
  muted?: boolean
  /** 2026-09-05 空格 PTT 体验修复: 静音态按空格=主动要说话 → 自动解除语音总开关
   *  (此前静音+无提示导致"开机空格没反应"的小白陷阱) */
  onUnmuteRequest?: () => void
  /** 专注模式（仅 PTT）：多人环境用 — 强制连续对话/唤醒词失效，只保留空格/触摸按住说话 */
  pttOnly?: boolean
}

export function VoiceIntegration({
  replyEnabled,
  ttsPlaying,
  sendMessage,
  continuousMode = false,
  wakeWordEnabled = false,
  asrProvider,
  onStateChange,
  muted = false,
  pttOnly = false,
  onUnmuteRequest,
}: VoiceIntegrationProps) {
  const { updateState } = useVoiceState()
  // 2026-08-07: 消费后端 voice_play SSE 事件（TextToSpeech 工具生成的音频文件），
  // 与流式 TTS 互斥（__ttsActive 守卫），组件卸载时自动清理 EventSource 与音频
  useVoicePlayConsumer()
  const sendMessageRef = useRef(sendMessage)
  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])

  // P2: 唤醒会话窗口 ref(wakeState 同步 effect 在 useWakeWord 之后)—getAutoSend
  // 在 wakeWord 创建前定义, 经 ref 读最新值, hooks 顺序安全
  const wakeActiveRef = useRef(false)

  // 专注模式门控：pttOnly 时连续对话与唤醒词全部失效（PTT 由 usePushToTalk 独立开麦）
  const effectiveContinuous = continuousMode && !pttOnly
  const effectiveWakeWord = wakeWordEnabled && !pttOnly

  // P2(GUI 全量修复 P0): 旧实现恒 effectiveContinuous——默认(唤醒词)模式下
  // scheduleAutoSend 首行 getAutoSend===false 直接 return → 唤醒后说话永不发送。
  // 现语义: 连续模式恒放行; 唤醒词模式仅在唤醒会话窗口内(wakeState 非 sleeping)放行。
  const getAutoSend = useCallback(
    () => shouldAutoSend({
      pttHolding: false,
      effectiveContinuous,
      effectiveWakeWord,
      wakeActive: wakeActiveRef.current,
    }),
    [effectiveContinuous, effectiveWakeWord]
  )
  const getSendMsg = useCallback(() => {
    const original = sendMessageRef.current
    return (text: string) => {
      if (interceptLocalVoiceCommand(text)) return
      original(text)
    }
  }, [])

  // ── Ref 桥接 ──
  const onFrameRef = useRef<(vol: number) => void>(() => {})
  const onTranscriptRef = useRef<(text: string) => void>(() => {})

  // ── 连续会话 ──
  const session = useVoiceSession({
    continuous: effectiveContinuous,
    asrProvider,
    onVolume: useCallback((vol: number) => {
      onFrameRef.current(vol)
    }, []),
    onInterim: useCallback((text: string) => {
      onTranscriptRef.current(text)
    }, []),
    onFinal: useCallback((text: string) => {
      // 本地命令即时拦截（关闭音乐面板等），不等 scheduleAutoSend 的 2s 静默延迟
      if (interceptLocalVoiceCommand(text)) return
      // 不直接 sendMessage — 由 scheduleAutoSend（静默后）或 pttEnd 统一发送
      onTranscriptRef.current(text) // 触发 scheduleAutoSend
    }, []),
    onStateChange: useCallback((s: string) => {
      const validStates: string[] = ['idle', 'listening', 'processing', 'speaking', 'error', 'recognizing', 'wake_listening', 'media_paused']
      updateState({
        voiceSessionState: (validStates.includes(s) ? s : null) as any,
        voiceSessionActive: s === 'listening' || s === 'processing' || s === 'recognizing',
      })
    }, [updateState]),
    // F4: 会话错误(含 AudioContext autoplay 被拦/麦克风失败)打日志——
    // 此前不接线则静默吞掉,用户"看起来在听实际聋"
    onError: useCallback((msg: string) => {
      console.error('[Voice] 语音会话错误:', msg)
      window.dispatchEvent(new CustomEvent('crabpaw:voice-error', { detail: { message: msg } }))
    }, []),
    getSendMessage: getSendMsg,
  })

  // ── Barge-in 回调 ──
  // 2026-08-08(音量忽大忽小修复): duck/unduck 同时实时应用到当前播放的 audio 元素
  // (applyDuckVolume 带回溯+平滑)——旧实现只置全局标记,下一句 new Audio() 才生效,
  // 句间 1.0↔0.15 硬跳变 → 忽大忽小
  const bargeinCallbacks = useRef({
    duckTTS: () => {
      updateState({ ttsDucked: true })
      applyDuckVolume((window as any).__ttsAudioElement || null, true)
      try { if (window.electronAPI?.voice?.setDuck) window.electronAPI.voice.setDuck(true).catch(() => {}) } catch (e) { console.warn('[Voice] setDuck error:', e) }
    },
    unduckTTS: () => {
      updateState({ ttsDucked: false })
      applyDuckVolume((window as any).__ttsAudioElement || null, false)
      try { if (window.electronAPI?.voice?.setDuck) window.electronAPI.voice.setDuck(false).catch(() => {}) } catch (e) { console.warn('[Voice] setDuck error:', e) }
    },
    stopTTS: async () => {
      try { if ((window as any).__voiceInterruptTTS) await (window as any).__voiceInterruptTTS(true) } catch (e) { console.warn('[Voice] interruptTTS error:', e) }
    },
    resumeTTSIfNoSpeech: () => {
      updateState({ ttsDucked: false })
      applyDuckVolume((window as any).__ttsAudioElement || null, false)
      try { if (window.electronAPI?.voice?.setDuck) window.electronAPI.voice.setDuck(false).catch(() => {}) } catch (e) { console.warn('[Voice] setDuck error:', e) }
      try { if ((window as any).__voiceResumeTTS) (window as any).__voiceResumeTTS() } catch (err: any) { console.warn('[Voice] resumeTTS 失败:', err?.message || err) }
      ;(window as any).__ttsResuming = true
      setTimeout(() => { (window as any).__ttsResuming = false }, 2000)
    },
  }).current

  // ── 常开策略（帧分类器 barge-in） ──
  const continuousPolicy = useContinuousVoice({
    suspendForTTS: session.suspendForTTS,
    resumeSession: session.resumeSession,
    pttHolding: session.pttHolding,
    startSession: session.startSession,
    getAutoSend,
    getSendMessage: getSendMsg,
    isSpeaking: ttsPlaying,
    duckTTS: bargeinCallbacks.duckTTS,
    unduckTTS: bargeinCallbacks.unduckTTS,
    stopTTS: bargeinCallbacks.stopTTS,
    resumeTTSIfNoSpeech: bargeinCallbacks.resumeTTSIfNoSpeech,
  })

  onFrameRef.current = continuousPolicy.onFrame
  onTranscriptRef.current = continuousPolicy.onTranscript

  // ── PTT 门控 ──（独立 PCM+ASR，释放 session mic 后采集）
  const ptt = usePushToTalk({
    onResult: (text: string) => {
      if (interceptLocalVoiceCommand(text)) return
      sendMessageRef.current(text)
    },
    onError: (err: string) => console.warn('[PTT] 识别错误:', err),
    // P5(GUI 全量修复 P1): 传 Settings 选中的麦克风——旧实现不传 micDeviceId,
    // PTT 恒用系统默认/自动选择, 与 useVoiceSession(读 localStorage 'mic-device-id')
    // 行为不一致——同一麦克风两种说话方式两个设备
    micDeviceId: readMicDeviceId(),
  })

  // ── 空格 PTT 键盘监听 ──（使用独立 PTT hook 的 start/stop/cancel）
  const pttStartRef = useRef(ptt.startRecording)
  const pttStopRef = useRef(ptt.stopRecording)
  const pttCancelRef = useRef(ptt.cancelRecording)
  // 2026-09-05 空格 PTT 体验修复: down 已成功开麦的标记——up 时据此无条件收麦
  // (静音自动解除后 mutedRef 时序不可靠, 防麦克风泄漏)
  const pttStartedRef = useRef(false)
  pttStartRef.current = ptt.startRecording
  pttStopRef.current = ptt.stopRecording
  pttCancelRef.current = ptt.cancelRecording
  // B3/H4: PTT 按住时需暂停常开会话(防同一句话双发)与打断 TTS(防录到回声)。
  // session 是每渲染新对象,键盘 effect 依赖 [] 用 ref 保最新。
  const sessionRef = useRef(session)
  sessionRef.current = session
  // P5.5 全静默: muted 守卫（A 语义 — 静音时 PTT/触摸/连续对话全部失效）
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  useEffect(() => {
    // 2026-09-03 修复(台风卡后空格失效): 输入框回复完成后会自动聚焦,焦点在空
    // 输入框时 isEditable 豁免把空格 PTT 全吞掉(用户视角"按空格没反应",实为
    // 输入框静默吃掉一个空格)。语音优先语义: 输入框**为空**且非 IME 合成中 →
    // 空格仍走 PTT; 有内容/合成中 → 让给打字。(IME 合成中输入框必有组合文本,
    // 空值检查已覆盖,无需额外 composition 事件跟踪)
    const editableEl = (t: EventTarget | null): HTMLElement | null => {
      const el = t as HTMLElement | null
      if (!el) return null
      return (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) ? el : null
    }
    // 空输入框 → 允许 PTT 接管
    const pttAllowedInEditable = (el: HTMLElement) => {
      return !(el as HTMLInputElement).value
    }
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      // 2026-09-03 诊断(空格 PTT 失效排查): bail 时必留日志——此前 isEditable/muted
      // 静默 return,现场零痕迹无法定位(台风卡摊开后空格失效问题的排查切口)
      const ed = editableEl(e.target)
      if (ed && !pttAllowedInEditable(ed)) {
        console.log('[Voice] PTT 忽略 Space: 焦点在输入框且有内容/合成中')
        return
      }
      e.preventDefault()
      if (mutedRef.current) {
        // 2026-09-05 修复: 静音态按空格=主动要说话 → 自动解除语音总开关并继续 PTT
        // (此前静默 return 且无任何提示——"开机空格没反应"的小白陷阱)
        console.log('[Voice] PTT: 已静音——自动解除语音总开关并开始 PTT')
        mutedRef.current = false
        try { onUnmuteRequest?.() } catch (err: any) { console.warn('[Voice] 解除静音失败(仍继续 PTT):', err?.message || err) }
      }
      pttStartedRef.current = true
      // B3/H4: 空格 PTT 与常开会话是独立双管线(独立 getUserMedia+WS)。
      // 按住时先暂停常开会话采集——否则常开会话 auto-send 的 pttHolding 守卫
      // 读 session.pttHolding 恒 false,会在静默 800ms 后自动发送同句话,
      // PTT 松手 onResult 再发一次 → 指令双发。
      try {
        if ((window as any).__ttsActive && typeof (window as any).__voiceInterruptTTS === 'function') {
          ;(window as any).__voiceInterruptTTS(true)
        }
      } catch (err: any) { console.warn('[Voice] PTT 打断 TTS 失败:', err?.message || err) }
      // 2026-08-07(三方抢占修复): 弃用 suspendForTTS(它保留 session mic 流 +
      // 恢复 KWS probe)——改调 releaseMicForPtt:挂起 ASR + 停 session 采集 +
      // 暂停 KWS probe,让 usePushToTalk 的 getUserMedia 独占麦克风。
      // 2026-09-03 修复(面板打开后只录到部分声音): releaseMicForPtt 现在返回
      // probe 暂停的 ack(F7 机制)——await 确认 probe 停流后再开 PTT 麦,
      // 消除"开麦时 probe 收尾中"的抢麦哑流竞态;异常/超时兜底照常开麦。
      try {
        const released = sessionRef.current.releaseMicForPtt()
        if (released && typeof released.then === 'function') {
          released.catch(() => false).then(() => pttStartRef.current())
          return
        }
      } catch (err: any) { console.warn('[Voice] releaseMicForPtt 异常(直接开麦):', err?.message || err) }
      pttStartRef.current()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      // 与 down 同口径: 空输入框放行(按住期间说过话), 有内容/合成中让给打字
      // 2026-09-05: down 已成功开麦时无条件收麦(静音自动解除后 mutedRef 时序不可靠)
      const started = pttStartedRef.current
      const ed = editableEl(e.target)
      if (!started && ed && !pttAllowedInEditable(ed)) return
      e.preventDefault()
      if (!started && mutedRef.current) return
      pttStartedRef.current = false
      // 2026-08-07(三方抢占修复): 松手顺序——先释放 PTT 自己的麦克风
      // (stopRecording 同步 cleanup),再重建 session 采集,避免 restore 的
      // getUserMedia 与 PTT 采集并发占麦;最后重连 ASR WS
      pttStopRef.current()
      sessionRef.current.restoreMicAfterPtt()
      sessionRef.current.resumeSession()
    }
    // 失焦兜底：按住空格时切窗口（keyup 丢失）→ 取消录音 + 恢复会话，不误发
    const onBlur = () => {
      pttCancelRef.current()
      sessionRef.current.restoreMicAfterPtt()
      sessionRef.current.resumeSession()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // ── 唤醒词 ──
  // 2026-08-07(双唤醒词并发占麦修复): Electron 环境(KWS probe 常驻占麦)与
  // Web Speech 检测(useWakeWord 内部独占麦克风)并存会并发占麦。Electron 下
  // 不启动 Web Speech 检测(wakeWordEnabled 恒 false)——hooks 规则禁止条件
  // 调用,以"启用开关"等效实现"跳过";KWS 命中仍经 __voiceWakeHit → onHit
  // 走同一状态机,打断/会话启动语义不变。
  const kwsAvailable = typeof window !== 'undefined' && !!window.electronAPI?.wake
  const wakeWord = useWakeWord({
    onWake: () => {
      // B3: 全静默守卫——muted 已为 true 时唤醒命中不得启动会话（muted effect 只会在
      // muted 翻转时停会话;若 muted 持续 true 而唤醒命中则会话无人停）。
      if (mutedRef.current) {
        console.log('[Voice] Muted: 唤醒命中忽略')
        return
      }
      // 2026-08-01: 唤醒命中时若 TTS 正在播放 → 立即打断。
      // 此前唤醒只启动麦克风，TTS 继续播放造成双声冲突 + ASR 录到 TTS 回声。
      try {
        if ((window as any).__ttsActive && typeof (window as any).__voiceInterruptTTS === 'function') {
          ;(window as any).__voiceInterruptTTS(true)
        }
      } catch (err: any) { console.warn('[Voice] 唤醒打断 TTS 失败:', err?.message || err) }
      // 2026-08-07: 防御性 .catch——startSession 内部已消化 rejection
      session.startSession().catch(err => console.error('[Voice] 唤醒启动会话失败:', err))
    },
    onDismiss: () => {
      // 2026-08-15 修复: 连续模式(live)下 60s KWS 空闲退场不得拆会话——
      // 常开会话此前每 60s 被拆毁重建(volc 握手窗口丢语音), 是"初次语音
      // 费劲/每分钟后说话丢字"的根因。连续模式会话常开, 收球语义不适用。
      if (effectiveContinuousRef.current) return
      session.stopSession()
      continuousPolicy.onSessionStop()
    },
    wakeWordEnabled: effectiveWakeWord && !kwsAvailable,
  })

  // P2: 唤醒会话窗口同步——wakeState 非 sleeping/dismissing 且唤醒词模式生效时
  // 放行自动发送(60s 空闲退场/手动 dismiss 后自动关闭, 不会误发未唤醒杂音——
  // 会话只由 onWake 启动, 未唤醒时无 session 无转写)
  useEffect(() => {
    wakeActiveRef.current = isWakeActive(wakeWord.wakeState) && effectiveWakeWord
  }, [wakeWord.wakeState, effectiveWakeWord])

  // ── 2026-08-15: 语音能量打断(barge-in)——TTS 播放窗口内说任何话即打断 ──
  // 主进程 probe 能量检测(回声基线 + 占空比)命中 → 打断 TTS + 启动会话,
  // 与唤醒词 onWake 同链: 用户后半句直接进 ASR。muted 全静默时忽略。
  useEffect(() => {
    const wakeApi = (window as any).electronAPI?.wake
    if (!wakeApi || typeof wakeApi.onSpeechBargein !== 'function') return
    const un = wakeApi.onSpeechBargein(() => {
      console.log('[Voice] 语音能量打断触发')
      try {
        if ((window as any).__ttsActive && typeof (window as any).__voiceInterruptTTS === 'function') {
          ;(window as any).__voiceInterruptTTS(true)
        }
      } catch (err: any) { console.warn('[Voice] 打断 TTS 失败:', err?.message || err) }
      if (mutedRef.current) return
      try {
        sessionRef.current.startSession().catch((e: any) => console.error('[Voice] 打断后启动会话失败:', e))
      } catch (err: any) { console.error('[Voice] 打断后启动会话异常:', err) }
    })
    return () => { try { un() } catch (e) { console.warn('[Voice] 移除订阅回调失败:', e) } }
  }, [])

  // ── 连续模式自动启动（P5.5 全静默: muted 时不启动 + 静音时停止已跑会话） ──
  useEffect(() => {
    if (muted) {
      if (session.isActive) {
        console.log('[Voice] Muted: stopping session')
        session.stopSession()
        continuousPolicy.onSessionStop()
      }
      return
    }
    if (effectiveContinuous && !session.isActive) {
      console.log('[Voice] Continuous mode: auto-starting session')
      // 2026-08-07: 延迟 800ms 重启——stopSession（voice_retire 等）后常开模式
      // 自动恢复。根因: effect 原依赖不含 session.isActive,会话停后(active=false)
      // effect 不重跑 → 常开会话永不重启 → 后续说话无法识别(问题2"识别不稳定")。
      // 800ms 防与停止流程竞态; suspendForTTS 不改 isActive,不会误触发。
      const t = setTimeout(() => {
        // 补 .catch——startSession 的 Promise 此前无 rejection 处理
        // (getAuthenticatedWsUrl 失败路径曾抛 rejection → 未处理警告,审查报告 P2)
        session.startSession().then(ok => {
          if (ok) continuousPolicy.onResume(false)
        }).catch(err => console.error('[Voice] 自动启动会话失败:', err))
      }, 800)
      return () => clearTimeout(t)
    } else if (!effectiveContinuous && session.isActive) {
      console.log('[Voice] Continuous mode disabled: stopping session')
      session.stopSession()
      continuousPolicy.onSessionStop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveContinuous, muted, session.isActive])

  // ── TTS 播放 → 暂停 mic+ASR ──
  const prevTtsPlayingRef = useRef(ttsPlaying)
  useEffect(() => {
    if (prevTtsPlayingRef.current === ttsPlaying) return
    prevTtsPlayingRef.current = ttsPlaying

    // B3/H3: __ttsResuming 只挡"重复 suspend"（TTS 恢复中不必再挂起），
    // 不再吞掉"TTS 结束恢复会话"——旧实现整体 return,若 __ttsResuming 恰为 true
    // (barge-in 恢复窗口)则 resumeSession 被跳过 → 会话卡在 bargeinBuffering=true。
    if (ttsPlaying && session.isActive) {
      if ((window as any).__ttsResuming) return
      session.suspendForTTS()
      continuousPolicy.onSuspendForTTS()
    } else if (!ttsPlaying && session.isActive && !ptt.isRecording) {
      // 2026-08-13 审查 P1: PTT 按住期间 TTS 结束(空格打断 TTS → ttsPlaying 翻转)
      // 不 resume——否则 session 重建采集与 PTT 的 getUserMedia 并发抢麦(Windows
      // 独占模式),且会话 ASR 同时转写 PTT 语音 → 与 PTT 松手 onResult 双发。
      // 恢复交给 PTT 松手链路(restoreMicAfterPtt + resumeSession)。
      session.clearTranscriptSuppress()
      session.resumeSession()
      continuousPolicy.onResume(false)
      wakeWord.resumeListening()
    }
  }, [ttsPlaying, session.isActive, continuousPolicy, wakeWord, ptt.isRecording])

  // ── 周期读取 TTS 实时音量驱动球体跳动 ──
  // 用 setInterval(~60ms ≈ 16fps) 读取，只在音量有变化时才 updateState，
  // 避免 rAF 每帧都触发 React 重渲染导致 70ms+ 卡顿
  const lastTTSVolRef = useRef(0)
  const lastEmittedVolRef = useRef(0)
  const lastEmittedVolTsRef = useRef(0)
  useEffect(() => {
    const volTick = setInterval(() => {
      if ((window as any).__ttsActive) {
        const raw = readTTSVol()
        // lerp 平滑，避免球体跳动过于剧烈
        lastTTSVolRef.current = lastTTSVolRef.current * 0.65 + raw * 0.35
        // 2026-08-07(整树重渲染修复): 阈值之外再加 >150ms 降频——updateState 每次
        // dispatch 新 state 对象 → 所有 useVoiceState 消费方重渲染;旧实现阈值 0.02
        // 在正弦模拟音量下几乎每 60ms 都超阈值 → ~16次/s 重渲染(审查报告 P2)。
        // 150ms 门控降到 ~6次/s,球体动画 16fps 足够
        const now = Date.now()
        if (now - lastEmittedVolTsRef.current > 150
          && Math.abs(lastTTSVolRef.current - lastEmittedVolRef.current) > 0.02) {
          lastEmittedVolTsRef.current = now
          lastEmittedVolRef.current = lastTTSVolRef.current
          // P5(GUI 全量修复 P1): 旧实现 updateState 全树广播(~6次/秒 React 重渲染,
          // 唯一消费者是音乐卡假音量条)。改走 tts-state pub-sub 订阅通道。
          setTtsVolume(lastEmittedVolRef.current)
        }
      } else if (lastTTSVolRef.current > 0.001) {
        lastTTSVolRef.current = 0
        lastEmittedVolRef.current = 0
        lastEmittedVolTsRef.current = 0
        setTtsVolume(0)
      }
    }, 60) // ~16fps，足够驱动球体动画
    return () => clearInterval(volTick)
  }, [])

  // ── 承重墙接口 ──
  // 统一暴露到一个对象上，减少碎片化的 window 全局变量
  // B3: 依赖收敛为 [sessionState, onStateChange]（均为稳定值）——旧实现依赖
  // continuousPolicy/wakeWord/ptt.startRecording 等每渲染新引用,导致 effect 每次
  // 渲染执行 + onStateChange 被 ~16次/秒调用(ttsVolume 60ms 更新)→ VoiceShell
  // handleStateChange→resetIdle 每次重置 → KWS 60s 空闲退场永不触发。
  // 内部统一经 refs 读取最新实例;onStateChange 仅在活跃翻转时调用。
  const continuousPolicyRef = useRef(continuousPolicy)
  continuousPolicyRef.current = continuousPolicy
  const wakeWordRef = useRef(wakeWord)
  wakeWordRef.current = wakeWord
  const effectiveContinuousRef = useRef(effectiveContinuous)
  effectiveContinuousRef.current = effectiveContinuous
  const prevActiveRef = useRef(false)
  const sessionState = session.state
  useEffect(() => {
    const w = window as any
    const s = sessionRef.current
    const cp = continuousPolicyRef.current
    const wk = wakeWordRef.current
    const ec = effectiveContinuousRef.current
    const pttStart = pttStartRef.current
    const pttStop = pttStopRef.current

    // 承重墙：crabpawVoice 接口
    w.crabpawVoice = {
      isActive: () => s.isActive,
      suspendForMedia: () => { s.suspendForMedia(); s.setMediaActive(true) },
      suspendForTTS: () => s.suspendForTTS(),
      resumeAfterMedia: () => {
        cp.clearNoSpeechTimer()
        if (s.mediaActive) {
          s.resumeAfterMedia()
          s.setMediaActive(false)
        }
      },
      stop: () => { s.stopSession(); cp.onSessionStop() },
      pttStart,
      pttEnd: pttStop,
    }
    w.__ptt = {
      // 全静默: 触摸 PTT 同样受 muted 守卫
      startRecording: () => { if (!mutedRef.current) pttStart() },
      stopRecording: () => { if (!mutedRef.current) pttStop() },
      isRecording: ptt.isRecording,
      isProcessing: s.state === 'recognizing' || s.state === 'processing',
      error: null,
    }

    // 兼容旧接口（渐进式迁移，保留旧的 __xxx 变量一段时间）
    w.__voiceSessionToggle = () => {
      if (s.isActive) { s.stopSession(); cp.onSessionStop() }
      else { s.startSession().catch(e => console.warn('[Voice] 会话切换启动失败:', e)) }
    }
    w.__voiceSessionSuspend = () => {
      if (s.isActive) {
        s.suspendForTTS()
        cp.onSuspendForTTS()
      }
    }
    w.__voiceSessionResume = () => {
      if (s.isActive) {
        s.resumeSession()
        cp.onResume(false)
        wk.resumeListening()
      }
    }
    w.__voiceSessionActive = s.isActive
    w.__voiceSessionSendCurrent = () => { s.sendCurrentText() }
    w.__voiceSessionResumeAfterTTS = () => {
      if (ec && !s.isActive) {
        s.startSession().catch(e => console.warn('[Voice] TTS 后恢复会话失败:', e))
      } else if (ec && s.isActive) {
        s.resumeSession()
      }
    }
    w.__voiceSuppressTranscripts = (ms: number) => {
      s.suppressTranscripts(ms)
    }
    w.__voiceClearTranscriptSuppress = () => {
      s.clearTranscriptSuppress()
    }
    // SSE 事件桥接
    w.__voiceWakeHit = () => wk.onHit()
    w.__voiceWakeRequestDismiss = () => wk.requestDismiss()
    w.__voiceWakeNoteTranscript = () => wk.noteTranscript()
    w.__voiceWakeMarkActive = () => wk.markActiveExternal?.()
    w.__voiceWakeOnResponse = () => wk.onResponse?.()
    w.__voiceWakeResetCounter = () => wk.resetRestartCounter()

    // B3: 活跃翻转时才通知调用方(避免 16次/秒调用重置 KWS 空闲定时器)
    const active = s.isActive
    if (active !== prevActiveRef.current) {
      prevActiveRef.current = active
      onStateChange?.({ sessionActive: active })
    }
  }, [sessionState, onStateChange])

  // 2026-08-01: 修复 "Rendered more hooks"——条件 return 此前位于 hooks 中间
  // （首次 render replyEnabled=false 时提前返回，跳过 handleDeviceChange 等
  // useCallback；配置加载后不再返回 → hooks 数量跳增崩溃）。
  // 条件渲染已移至组件末尾（所有 hooks 之后），hooks 数量恒定。

  const pinnedDeviceId = (window as any).__audioOutputDeviceId as string | undefined || null

  const handleDeviceChange = useCallback((deviceId: string, label: string) => {
    ;(window as any).__audioOutputDeviceId = deviceId
    console.log('[Voice] 音频输出设备变更:', deviceId, label)
  }, [])

  const handlePinDevice = useCallback((deviceId: string) => {
    try { localStorage.setItem('crabpaw_audio_output_device', deviceId) } catch (err: any) { console.warn('[Voice] localStorage 写入失败:', err?.message || err) }
    console.log('[Voice] 固定音频输出设备:', deviceId)
  }, [])

  const handlePlaybackEnd = useCallback(() => {
    session.clearTranscriptSuppress()
  }, [session])

  const handlePlaybackError = useCallback((err: string) => {
    console.warn('[Voice] TTS 播放错误:', err)
    session.clearTranscriptSuppress()
  }, [session])

  // ── 不渲染任何 UI 元素（状态动画由右侧边栏 VoicePanel 负责） ──
  // 条件渲染在全部 hooks 之后：hooks 数量恒定，避免 Rendered more hooks
  // pttOnly 时保持渲染：专注模式只保留 PTT（键盘监听在此组件内）
  if (!replyEnabled && !wakeWordEnabled && !continuousMode && !pttOnly) return null

  return (
    <AudioOutputManager
      audioElement={(window as any).__ttsAudioElement || null}
      pinnedDeviceId={pinnedDeviceId}
      onDeviceChange={handleDeviceChange}
      onPinDevice={handlePinDevice}
      onPlaybackEnd={handlePlaybackEnd}
      onPlaybackError={handlePlaybackError}
    />
  )
}
