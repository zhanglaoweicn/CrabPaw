/**
 * useContinuousVoice — 连续语音自动发送 + Barge-in 检测
 *
 * 连续对话语音模式 Hook。
 * 在 useVoiceSession 之上提供：
 * - 静默 2s 后自动发送（仅文本变化重置计时器，非音量）
 * - 两级 Duck Barge-in 检测（duck → 判真）
 * - 误报恢复（快速沉默 500ms 检测）
 * - 打断换话题优化：barge-in 后立即重置回音底噪 + 清空自动发送定时器
 */

import { useRef, useCallback, useEffect } from 'react'

// ─── 常量 ───────────────────────────────────────────────
const BARGEIN_THRESHOLD = 0.09
const ECHO_MARGIN_VOL = 0.025     // 从 0.04 降低，对标参考实现的 0.025，更灵敏
const ECHO_HARD_VOL = 0.16
const DUCK_FRAMES = 3
const SUSTAIN_FRAMES = 10
const DECAY_FRAMES = 6
const NOISE_DECAY_FRAMES = 3       // 噪声 duck 快速恢复（2-3 帧）
const DUCK_TIMEOUT_MS = 1500
const FAST_SILENT_FRAMES = 7
const NO_SPEECH_RECOVERY_MS = 3500
const WARMUP_MS = 200             // 缩短预热期，减少字头丢失，PTT 模式无预热期所以识别更准
const SILENCE_SEND_MS = 800       // 对标 PTT 的 800ms 等尾时间，原 1.5s 过长导致尾部切断感

// 帧级 ZCR 特征常量
const ZCR_SPEECH_MIN = 0.02
const ZCR_SPEECH_MAX = 0.25
const ZCR_NOISE_HIGH = 0.30
const ZCR_NOISE_LOW = 0.01
const ZCR_CONSISTENCY_WINDOW = 5

export type BargeInClassification = 'silence' | 'noise' | 'speech'

/** 从 PCM Int16 帧计算过零率 (ZCR) */
function computeZCR(frame: Int16Array): number {
  if (frame.length < 2) return 0
  let crossings = 0
  for (let i = 1; i < frame.length; i++) {
    if ((frame[i] >= 0 && frame[i - 1] < 0) || (frame[i] < 0 && frame[i - 1] >= 0)) {
      crossings++
    }
  }
  return crossings / frame.length
}

/** 判断近期 ZCR 是否稳定（低方差 = 信号一致性） */
function isZcrConsistent(zcrHistory: number[]): boolean {
  if (zcrHistory.length < ZCR_CONSISTENCY_WINDOW) return false
  const recent = zcrHistory.slice(-ZCR_CONSISTENCY_WINDOW)
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length
  const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recent.length
  return variance < 0.002
}

/** 多特征帧分类器：结合音量、ZCR、一致性判断 */
function classifyFrame(
  vol: number,
  zcr: number,
  isConsistent: boolean,
  threshold: number,
  hardVol: number,
): BargeInClassification {
  if (vol < threshold) return 'silence'
  if (zcr >= ZCR_SPEECH_MIN && zcr <= ZCR_SPEECH_MAX && vol > threshold && isConsistent) return 'speech'
  if (zcr > ZCR_NOISE_HIGH || zcr < ZCR_NOISE_LOW) return 'noise'
  return vol > hardVol ? 'speech' : 'noise'
}

export interface ContinuousVoiceOptions {
  suspendForTTS: () => void
  resumeSession: (fromBargein?: boolean) => void
  pttHolding: boolean
  startSession: () => Promise<boolean>
  getAutoSend?: () => boolean
  getSendMessage?: () => (text: string) => void
  duckTTS?: () => void
  unduckTTS?: () => void
  stopTTS?: () => void
  resumeTTSIfNoSpeech?: () => void
  isSpeaking?: boolean
}

export function useContinuousVoice(options: ContinuousVoiceOptions) {
  const {
    duckTTS, unduckTTS, stopTTS, resumeSession, resumeTTSIfNoSpeech,
    isSpeaking = false, getAutoSend, getSendMessage,
  } = options

  // ── Barge-in 状态 ──
  const bargeinRef = useRef({
    warmupEnd: 0,
    echoFloor: 0,
    highCount: 0,
    lowCount: 0,
    ducking: false,
    lastHighTs: 0,
    noiseDuck: false,           // 当前 duck 是否由 noise 触发
    zcrValues: [] as number[],
  })

  // ── 自动发送定时器 ──
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastObservedTranscriptRef = useRef('')
  const lastTranscriptActivityTsRef = useRef(0)

  // ── 快速非语音检测状态 ──
  const bargeinFastCheckActiveRef = useRef(false)
  const bargeinFastCheckStartRef = useRef(0)
  const bargeinFastSilentFramesRef = useRef(0)
  const bargeinNoSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearBargeinNoSpeechTimer = useCallback(() => {
    if (bargeinNoSpeechTimerRef.current) {
      clearTimeout(bargeinNoSpeechTimerRef.current)
      bargeinNoSpeechTimerRef.current = null
    }
  }, [])

  const resetEchoFloor = useCallback(() => {
    bargeinRef.current.echoFloor = 0
  }, [])

  // ── 启动无语音恢复计时 ──
  const startBargeinNoSpeechTimer = useCallback(() => {
    clearBargeinNoSpeechTimer()
    // 3.5s 后如果还没有任何 ASR 结果，尝试恢复 TTS
    // 但只要用户在说话（音量触发），这个 timer 就会被 onFrame 取消
    bargeinNoSpeechTimerRef.current = setTimeout(() => {
      bargeinNoSpeechTimerRef.current = null
      resumeTTSIfNoSpeech?.()
    }, NO_SPEECH_RECOVERY_MS)
  }, [clearBargeinNoSpeechTimer, resumeTTSIfNoSpeech])

  // ── 自动发送逻辑 ──
  const noteTranscriptActivity = useCallback(() => {
    lastTranscriptActivityTsRef.current = Date.now()
  }, [])

  const scheduleAutoSend = useCallback(() => {
    if (options.pttHolding) return
    if (getAutoSend?.() === false) return
    noteTranscriptActivity()
    if (autoSendTimerRef.current) return

    const tick = () => {
      const idle = Date.now() - lastTranscriptActivityTsRef.current
      if (idle >= SILENCE_SEND_MS) {
        autoSendTimerRef.current = null
        lastObservedTranscriptRef.current = ''
        const sendMsg = getSendMessage?.()
        if (sendMsg) {
          ;(window as any).__voiceSessionSendCurrent?.()
        }
      } else {
        autoSendTimerRef.current = setTimeout(tick, SILENCE_SEND_MS - idle)
      }
    }
    autoSendTimerRef.current = setTimeout(tick, SILENCE_SEND_MS)
  }, [getAutoSend, getSendMessage, noteTranscriptActivity, options.pttHolding])

  const cancelAutoSend = useCallback(() => {
    if (autoSendTimerRef.current) {
      clearTimeout(autoSendTimerRef.current)
      autoSendTimerRef.current = null
    }
  }, [])

  // ── 每帧音量处理 ──
  const onFrame = useCallback((vol: number, text?: string, rawFrame?: Int16Array) => {
    const now = Date.now()
    const bd = bargeinRef.current

    if (text && text !== lastObservedTranscriptRef.current) {
      lastObservedTranscriptRef.current = text
      scheduleAutoSend()
    }

    // ── Barge-in 检测 ──
    if (!isSpeaking) return

    if (bd.warmupEnd === 0) bd.warmupEnd = now + WARMUP_MS

    // 对标 voice-continuous.js learnEchoFloor:
    // 预热期(aecReady=false)时用 force=true — AEC 还没适应，所有音量（包括高音量）
    // 都属于回音而非用户说话，必须让底噪快速收敛
    const aecReady = bd.warmupEnd > 0 && now >= bd.warmupEnd
    // 预热期：强制学习所有音量作为回音底噪，但不阻断检测
    if (!aecReady) {
      const sample = Math.min(vol, BARGEIN_THRESHOLD)
      bd.echoFloor = bd.echoFloor * 0.9 + sample * 0.1
    }

    // 预热期结束后的正常底噪学习：只学低于阈值的音量
    if (!bd.ducking && aecReady) {
      if (vol <= BARGEIN_THRESHOLD) {
        const sample = Math.min(vol, BARGEIN_THRESHOLD)
        bd.echoFloor = bd.echoFloor * 0.9 + sample * 0.1
      }
    }

    // ── 帧分类（ZCR + 音量） — 预热期也走分类，只是回音底噪偏高所以阈值也偏高 ──
    let classification: BargeInClassification = 'silence'
    if (rawFrame && rawFrame.length > 0) {
      const zcr = computeZCR(rawFrame)
      bd.zcrValues.push(zcr)
      if (bd.zcrValues.length > 30) bd.zcrValues = bd.zcrValues.slice(-20)
      const consistent = isZcrConsistent(bd.zcrValues)
      const threshold = Math.max(BARGEIN_THRESHOLD, bd.echoFloor + ECHO_MARGIN_VOL)
      classification = classifyFrame(vol, zcr, consistent, threshold, ECHO_HARD_VOL)
    } else {
      // 无原始 PCM 时回退到音量阈值
      const threshold = Math.max(BARGEIN_THRESHOLD, bd.echoFloor + ECHO_MARGIN_VOL)
      classification = vol > ECHO_HARD_VOL ? 'speech' : (vol > threshold ? 'noise' : 'silence')
    }

    if (classification === 'speech') {
      bd.highCount++
      bd.lowCount = 0
      bd.lastHighTs = now

      if (bd.highCount >= DUCK_FRAMES && !bd.ducking) {
        bd.ducking = true
        bd.noiseDuck = false
        duckTTS?.()
      }

      if (bd.ducking && !bd.noiseDuck && bd.highCount >= SUSTAIN_FRAMES) {
        // ── 确认打断 ──
        // v8 关键修复：TTS 正在播放时，barge-in 只 duck 不 stop！
        // 根因：TTS 声音从扬声器出来 → 麦克风捕获 → barge-in 误检测为"用户说话"
        // → stopTTS() → audio.pause() → play() AbortError → TTS 无声
        // 修复：TTS 播放期间，只有连续 BARGEIN_SUSTAIN_TTS 帧的真正人声才确认打断，
        // 否则只做 duck（降低音量），等 TTS 自然结束后恢复
        const ttsActive = (window as any).__ttsActive === true
        const BARGEIN_SUSTAIN_TTS = 25 // TTS播放期间需要更长的确认帧数（~1.25s），避免误打断

        if (ttsActive && bd.highCount < BARGEIN_SUSTAIN_TTS) {
          // TTS 播放中，还没达到打断阈值 → 只保持 duck，不打断
          console.log('[BargeIn] TTS active, highCount=%d < %d, keeping duck (not stopping)',
            bd.highCount, BARGEIN_SUSTAIN_TTS)
        } else {
          // 确认打断（TTS 未播放，或已达到更长的确认阈值）
          bd.highCount = 0
          bd.lowCount = 0
          bd.ducking = false
          bd.noiseDuck = false
          bd.warmupEnd = 0
          bd.echoFloor = 0           // 立即复位回音底噪，下一帧就能识别真实人声
          bd.zcrValues = []
          stopTTS?.()
          resumeSession(true)
          cancelAutoSend()           // 清空旧的自动发送定时器，新语音将重开
          clearBargeinNoSpeechTimer() // 用户正在说话，不需要恢复旧 TTS
          bargeinFastCheckActiveRef.current = true
          bargeinFastCheckStartRef.current = now
          bargeinFastSilentFramesRef.current = 0
        }
      }
    } else if (classification === 'noise') {
      bd.highCount++
      bd.lowCount = 0
      bd.lastHighTs = now

      if (bd.highCount >= DUCK_FRAMES && !bd.ducking) {
        bd.ducking = true
        bd.noiseDuck = true
        duckTTS?.()
      }
      // Noise 不会触发打断（不检查 SUSTAIN_FRAMES）
    } else {
      bd.lowCount++
      bd.highCount = Math.max(0, bd.highCount - 1)

      if (bd.ducking) {
        const decayThreshold = bd.noiseDuck ? NOISE_DECAY_FRAMES : DECAY_FRAMES
        if (bd.lowCount >= decayThreshold || (now - bd.lastHighTs) > DUCK_TIMEOUT_MS) {
          bd.ducking = false
          bd.noiseDuck = false
          bd.highCount = 0
          bd.lowCount = 0
          unduckTTS?.()
        }
      }
    }

    // ── 快速非语音检测 ──
    if (bargeinFastCheckActiveRef.current) {
      const elapsed = now - bargeinFastCheckStartRef.current
      if (vol < BARGEIN_THRESHOLD * 0.65) {
        if (++bargeinFastSilentFramesRef.current >= FAST_SILENT_FRAMES) {
          bargeinFastCheckActiveRef.current = false
          bargeinFastSilentFramesRef.current = 0
          clearBargeinNoSpeechTimer()
          resumeTTSIfNoSpeech?.()
        }
      } else {
        // 如果听到音量，说明用户真在说话，取消快速静默检查和无语音 timer
        bargeinFastSilentFramesRef.current = 0
        clearBargeinNoSpeechTimer()
      }
      if (elapsed >= 500) {
        bargeinFastCheckActiveRef.current = false
        bargeinFastSilentFramesRef.current = 0
      }
    }
  }, [isSpeaking, duckTTS, unduckTTS, stopTTS, resumeSession, clearBargeinNoSpeechTimer, resumeTTSIfNoSpeech, scheduleAutoSend, cancelAutoSend])

  // ── 收到转写后的策略 ──
  const onTranscript = useCallback((text: string) => {
    bargeinFastCheckActiveRef.current = false
    bargeinFastSilentFramesRef.current = 0
    clearBargeinNoSpeechTimer()

    const currentText = text.trim()
    if (!currentText || currentText === lastObservedTranscriptRef.current) return
    lastObservedTranscriptRef.current = currentText
    scheduleAutoSend()
  }, [clearBargeinNoSpeechTimer, scheduleAutoSend])

  // ── 无语音恢复定时器 ──
  // B3/H3: 移除"TTS 播放期间每秒检查并 resumeTTSIfNoSpeech"的 interval——
  // ① 其职责已由 startBargeinNoSpeechTimer(timeout 版)覆盖;
  // ② 它在 TTS 全程每秒触发(转录被抑制 → lastTranscriptActivityTs 恒旧),
  //    每次都置 __ttsResuming=true(2s);TTS 结束瞬间 ttsPlaying 翻转时,
  //    VoiceIntegration 的 if(__ttsResuming) return 会吞掉 resumeSession()
  //    → 会话永久卡在 bargeinBuffering=true(用户语音全进缓冲 tx=0)。
  //    —— 正是"不按空格无法监听"的核心根因之一。

  // ── 清理 ──
  useEffect(() => {
    return () => {
      if (autoSendTimerRef.current) clearTimeout(autoSendTimerRef.current)
      clearBargeinNoSpeechTimer()
    }
  }, [clearBargeinNoSpeechTimer])

  // ── 会话停止时清理 ──
  const onSessionStop = useCallback(() => {
    cancelAutoSend()
    clearBargeinNoSpeechTimer()
    bargeinFastCheckActiveRef.current = false
    bargeinFastSilentFramesRef.current = 0
    bargeinRef.current.ducking = false
    bargeinRef.current.noiseDuck = false
    bargeinRef.current.highCount = 0
    bargeinRef.current.lowCount = 0
    bargeinRef.current.zcrValues = []
    resetEchoFloor()
    lastTranscriptActivityTsRef.current = 0
    lastObservedTranscriptRef.current = ''
  }, [cancelAutoSend, clearBargeinNoSpeechTimer, resetEchoFloor])

  // ── 进入 TTS 挂起时重置 ──
  const onSuspendForTTS = useCallback(() => {
    bargeinRef.current.ducking = false
    bargeinRef.current.noiseDuck = false
    bargeinRef.current.highCount = 0
    bargeinRef.current.lowCount = 0
    bargeinRef.current.zcrValues = []
    resetEchoFloor()
  }, [resetEchoFloor])

  // ── 会话恢复时重置 ──
  const onResume = useCallback((fromBargein: boolean) => {
    bargeinRef.current.highCount = 0
    if (fromBargein) startBargeinNoSpeechTimer()
  }, [startBargeinNoSpeechTimer])

  return { onFrame, onTranscript, onSessionStop, onSuspendForTTS, onResume, cancelAutoSend, clearNoSpeechTimer: clearBargeinNoSpeechTimer }
}
