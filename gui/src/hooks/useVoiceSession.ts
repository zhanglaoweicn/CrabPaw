/**
 * useVoiceSession — 连续语音对话引擎核心
 *
 * 语音会话管理 Hook — 提供完整的语音交互流程控制。
 * - AudioWorklet PCM 捕获（Float32 → Int16, 16kHz monochannel）
 * - ASR WebSocket 实时流传输（替代原来的 POST 批量模式）
 * - 断句累积 / 段 ID 去重（adapt 到现有 backend POST 接口）
 * - 自愈 Watchdog（3.5s 无结果时重连）
 * - Barge-in 缓冲（TTS 播放期间不丢麦克风音频）
 * - 连续模式 / PTT 模式 / 闲置三层状态机
 *
 * 向后兼容：如果后端 WS 可用则使用 WS，否则降级到 POST /api/voice/asr
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { getAuthenticatedWsUrl } from '../lib/api'
// 2026-08-04: P3 静音门控(移植 LiveKit DTX 思想)——持续静音帧不送 ASR
import { SilenceGate, isSilentChunk } from '../lib/audio-silence'
// 2026-08-14: 窗口化活跃检测(移植 KWS audio-level.cjs 的 renderer 纯 TS 版)——
// listening 期能量信号源(KWS probe 暂停期间,主进程 wake:audio-level 广播停摆)
import { AudioLevelDetector, rmsToLevel0127 } from '../lib/audio-level'
// F4/F5: AGC 增益计算 + AudioContext 启动重试（纯函数，可单测）
import { ensureAudioContextRunning, shouldBackpressure, WS_BUFFERED_THRESHOLD_BYTES } from '../lib/voice-engine-utils'
// 2026-09-05 深度优化: HPF+AGC 收敛为共享件 voice-enhance(与 PTT 管线同源同参)
import { createHighPass, createAgcBoost } from '../lib/voice-enhance'
import { createCaptureNode, PCM_CHUNK_SAMPLES } from '../lib/audio-capture'

// ─── 常量 ───────────────────────────────────────────────
const SAMPLE_RATE = 16000
// R21: 3500→8000——用户正常说话停顿 3-4s 很常见,旧值误判"stalled"强制重连
// → 打断识别、丢语音("有时能接收有时没反应")。8s 给 ASR 足够处理时间,
// 只有真正长时间无转录才重连。
// 2026-08-08: 8000→15000——思考停顿 8s 仍会误判强制重连 → 重连后开头语音
// 丢失,听感"时好时坏"（ASR 不稳定修复 A4）。
const STALL_RECONNECT_MS = 15000
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_RESET_WINDOW_MS = 30000
const BARGEIN_MAX_CHUNKS = Math.ceil(1500 * 16000 / 1000 / PCM_CHUNK_SAMPLES)
const RECONNECT_MAX_CHUNKS = Math.ceil(8000 * 16000 / 1000 / PCM_CHUNK_SAMPLES)
// 2026-08-12: 客户端背压缓冲上限 2s(≈16 块)
const BACKPRESSURE_MAX_CHUNKS = Math.ceil(2000 * 16000 / 1000 / PCM_CHUNK_SAMPLES)
// 2026-08-08(ASR 不稳定修复 A3): 连续模式静音保活帧间隔。
// 连续模式为保活火山会话(服务端 ~8s 无包判会话结束)此前每 128ms 都发静音帧——
// 浪费 API 配额 + 静音被 AGC 放大后污染端点检测。改为静音时每 3.5s 发一帧保活,
// 有语音恢复每帧发送。3.5s < 8s 服务端超时,留足余量。
const KEEPALIVE_INTERVAL_MS = 3500

// ─── ASR 诊断系统（对标 CrabPaw voice-core.js diagStart/diagNoteChunk） ───
// 定位长语音丢字、云端静默停识别等问题的指纹
// localStorage 'crabpaw-voice-diag'='0' 可关闭，默认开
const DIAG_ON = (() => { try { return localStorage.getItem('crabpaw-voice-diag') !== '0' } catch { return true } })()
let diagTimer: ReturnType<typeof setInterval> | null = null
let diagChunks = 0, diagBytes = 0, diagReconnects = 0, diagMaxGapMs = 0, diagLastChunkTs = 0
let diagTranscripts = 0, diagLastTranscriptTs = 0
function diag(tag: string, info?: any) { if (DIAG_ON) console.log('[asr-diag] ' + tag, info ?? '') }
function diagNoteTranscript() { diagTranscripts++; diagLastTranscriptTs = performance.now() }
function diagNoteChunk(byteLen: number) {
  if (!DIAG_ON) return
  diagChunks++; diagBytes += byteLen
  const now = performance.now()
  if (diagLastChunkTs) { const gap = now - diagLastChunkTs; if (gap > diagMaxGapMs) diagMaxGapMs = gap }
  diagLastChunkTs = now
}
function diagStart() {
  if (!DIAG_ON || diagTimer) return
  diagLastChunkTs = 0; diagMaxGapMs = 0
  diagTimer = setInterval(() => {
    // 期望：~7.8 块/s、~31 kB/s、maxGap≈128ms。maxGap 飙到 300ms+ = 采集被抢占丢帧
    const sinceTx = diagLastTranscriptTs ? (performance.now() - diagLastTranscriptTs).toFixed(0) : 'na'
    console.log('[asr-diag] chunks/s=' + (diagChunks / 3).toFixed(1)
      + ' kB/s=' + (diagBytes / 1024 / 3).toFixed(1)
      + ' maxGap=' + diagMaxGapMs.toFixed(0) + 'ms'
      + ' reconnects=' + diagReconnects
      + ' tx=' + diagTranscripts
      + ' sinceTx=' + sinceTx + 'ms')
    diagChunks = 0; diagBytes = 0; diagMaxGapMs = 0
  }, 3000)
}
function diagStop() {
  if (diagTimer) { clearInterval(diagTimer); diagTimer = null }
  diagLastChunkTs = 0; diagReconnects = 0; diagTranscripts = 0; diagLastTranscriptTs = 0
  ;(window as any).__asrReconnects = 0
}

// ─── 类型 ───────────────────────────────────────────────
// 2026-08-04: P4 状态机定义抽至 lib/voice-state(独立可测,useVoiceSession 消费)
import { VoiceStateMachine, type VoiceSessionState } from '../lib/voice-state'
export type { VoiceSessionState } from '../lib/voice-state'

export interface VoiceSessionOptions {
  continuous?: boolean
  asrWsUrl?: string
  asrProvider?: string
  /** 每帧音量回调(0-1)。info 为可选第二参:1s 节流的窗口化活跃检测 {level, active}(能量驱动球体用,向后兼容) */
  onVolume?: (vol: number, info?: { level: number; active: boolean }) => void
  onInterim?: (text: string) => void
  onFinal?: (text: string) => void
  onStateChange?: (state: VoiceSessionState) => void
  onError?: (err: string) => void
  getSendMessage?: () => (text: string) => void
}

interface VoiceSessionAPI {
  state: VoiceSessionState
  isActive: boolean
  isContinuous: boolean
  interimText: string
  startSession: () => Promise<boolean>
  stopSession: () => void
  suspendForTTS: () => void
  resumeSession: (fromBargein?: boolean) => void
  /** 2026-08-07: PTT 按住前释放 session 麦克风 + 暂停 KWS probe（三方抢占修复） */
  releaseMicForPtt: () => Promise<boolean> | void
  /** 2026-08-07: PTT 松手后重建 session 采集 + 恢复 KWS probe */
  restoreMicAfterPtt: () => Promise<void>
  pttStart: () => void
  pttEnd: (options?: { send?: boolean }) => void
  pttHolding: boolean
  /** 对标 CrabPaw flushAsr: 请求ASR立即返回最终结果 */
  flushAsr: () => void
  /** 2026-08-01: 获取当前累积识别文本（usePushToTalk 的 800ms 等待循环依赖此方法，此前不存在导致永远走超时分支） */
  getText: () => string
  sendCurrentText: () => void
  /** P1: 丢弃当前累积文本(不发消息)——PTT 失焦/非主动松手用 */
  discardCurrentText: () => void
  suppressTranscripts: (ms: number) => void
  /** V10 fix: 清除转录抑制，TTS 结束/中断时调用 */
  clearTranscriptSuppress: () => void
  setLang: (lang: string) => void
  suspendForMedia: () => void
  resumeAfterMedia: () => void
  mediaActive: boolean
  setMediaActive: (active: boolean) => void
}

// ─── Helpers ─────────────────────────────────────────────
/** 合并多个 Float32Array */
// ─── Hook ───────────────────────────────────────────────
export function useVoiceSession(options: VoiceSessionOptions = {}): VoiceSessionAPI {
  const {
    continuous,
    onVolume, onInterim, onFinal, onStateChange, onError,
    getSendMessage,
    // 2026-08-01: ASR provider 此前只定义未消费，config 帧硬编码 volcengine
    asrProvider,
  } = options

  const [state, setState] = useState<VoiceSessionState>('idle')
  const [interimText, setInterimText] = useState('')
  // 2026-08-07: isActive 改为 useState 镜像——此前仅 activeRef(ref 快照),
  // React 组件(如 VoiceIntegration 的 ttsPlaying effect)把 session.isActive 当
  // 响应式依赖时永远拿不到更新 → effect 不重跑 → TTS 播放期间会话异步启动
  // 时 suspend 逻辑失效(审查报告 P3)。ref+state 双写,暴露真实响应式值。
  const [isActive, setIsActive] = useState(false)
  const setActive = useCallback((v: boolean) => {
    if (activeRef.current !== v) {
      activeRef.current = v
      setIsActive(v)
    }
  }, [])

  // ── Refs ──
  const activeRef = useRef(false)
  const stateRef = useRef<VoiceSessionState>('idle')
  const pttHoldingRef = useRef(false)
  const continuousEnabledRef = useRef(continuous !== false)
  // P2 修复: continuous prop 变化时同步到 ref——此前仅在挂载时初始化,
  // effectiveContinuous 变化(如专注模式切换)后门控/WS config 帧仍读旧值。
  useEffect(() => { continuousEnabledRef.current = continuous !== false }, [continuous])
  const micStreamRef = useRef<MediaStream | null>(null)
  // 2026-08-13 (审查 P1): 采集代际——startMic 每次递增并捕获代号,onFrame 校验;
  // stopMic 递增使所有旧代链的帧立即失效(即使孤儿链未被 disconnect 也发不出音频)。
  // 根治"恢复-挂起竞态泄漏多路采集链 → 音频 18x 风暴 → 火山零转录"。
  const micGenRef = useRef(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const captureNodeRef = useRef<AudioNode | null>(null)
  const bargeinBufferRef = useRef<Int16Array[]>([])
  const bargeinBufferingRef = useRef(false)
  const reconnectBufferRef = useRef<Int16Array[]>([])
  const isSuspendedForTTsRef = useRef(false)
  // 2026-08-15 S3: 挂起(TTS/PTT)期间 WS 常开保活定时器——每 3.5s 发一帧静音
  // 防云端 ASR 8s 无包回收(45000081), 连续模式长 TTS 期间会话存活
  const suspendKeepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const lastTranscriptTsRef = useRef(0)
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 2026-08-07: 句级最终转录后 2s 回 'listening' 的延迟定时器——此前未入 ref,
  // stopSession/卸载后仍可能触发(泄漏 + 卸载后 setState);统一入 ref 清除
  const listeningStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // 2026-09-09 (资源保护): 设备类启动失败(未找到/被拒/被占)的冷却记录——无麦克风
  // 机器上语音会话曾无限重试+toast 风暴耗尽资源(打包版实测)。冷却期内 startMic
  // 直接返回 false,不尝试不弹窗;设备恢复后冷却期满自动恢复
  const micDeviceFailureRef = useRef<{ name: string; ts: number } | null>(null)
  const langRef = useRef('zh')
  const asrWsRef = useRef<WebSocket | null>(null)
  const asrWsIntentionalRef = useRef(false)
  const committedRef = useRef<Array<{ seg: string | null; text: string }>>([])
  const pendingInterimRef = useRef('')
  // V2: locked_prefix — 锁定已提交的段级最终文本，防止长句多段预览闪烁
  const lockedPrefixRef = useRef('')
  const lastObservedTranscriptRef = useRef('')
  const transcriptSuppressUntilRef = useRef(0)
  const wsUrlRef = useRef('')
  // 2026-08-12: 服务端会话 ID——{type:'session'} 回传后保存,重连 config 帧携带
  const sessionIdRef = useRef('')
  // 2026-08-12: 服务端背压信号——'high' 时暂停发送(见 handlePcmChunk)
  const backpressureRef = useRef<'ok' | 'high'>('ok')
  // 2026-08-12: 背压期间本地暂存(保序冲刷)
  const bpBufferRef = useRef<Int16Array[]>([])
  // V6 fix: 防止 watchdog 和 onclose 对同一次断开双重计数/触发重连
  const reconnectScheduledRef = useRef(false)
  // 对标 CrabPaw voice-core.js: 最近听到人声级音量的时刻（watchdog 用）
  const lastLoudTsRef = useRef(0)
  // 2026-08-04: P5 全量重建兜底——最后全量重连时刻与冷却(10s 内不重复全量,防无限循环)
  const lastFullReconnectRef = useRef(0)
  const FULL_RECONNECT_COOLDOWN_MS = 10000
  // R9: watchdog 听诊重连节流——lastListenReconnectTs 距上次强制重连 >2s;
  // lastWarnedOfflineTs 距上次离线报警 >10s(连续不在线才累加 attempts,防短暂抖动刷爆)
  const lastListenReconnectTsRef = useRef(0)
  const lastWarnedOfflineTsRef = useRef(0)

  // ── 状态更新辅助 ──
  // 2026-08-04: P4 状态转换守卫(移植 LiveKit 状态机思想,轻量版)
  // 语音会话状态是环(非线性单向),照搬 CAS 单向推进会破坏循环语义;
  // 改为"转换表 + 非法转换 warn 收集"——先暴露真实非法路径,再按数据收紧。
  // 2026-08-12(P4→硬约束): 非法转换 dev 下 throw,生产 ERROR 日志 + 停留原状态
  const machineRef = useRef<VoiceStateMachine | null>(null)
  if (!machineRef.current) machineRef.current = new VoiceStateMachine(stateRef.current)
  const updateState = useCallback((s: VoiceSessionState) => {
    const prev = stateRef.current
    if (prev !== s && !machineRef.current!.setState(s)) return // 非法:已记录/抛出
    stateRef.current = s
    setState(s)
    onStateChange?.(s)
  }, [onStateChange])

  // ── 转录累积 / 去重 ──
  const committedText = useCallback(() => {
    return committedRef.current.map(s => s.text).join('，')
  }, [])

  const resetTranscriptAccumulation = useCallback(() => {
    committedRef.current = []
    pendingInterimRef.current = ''
    lastObservedTranscriptRef.current = ''
    lockedPrefixRef.current = ''
  }, [])

  const commitPendingInterim = useCallback(() => {
    const text = pendingInterimRef.current.trim()
    if (!text) return
    const last = committedRef.current[committedRef.current.length - 1]
    if (!last || last.text !== text) {
      committedRef.current.push({ seg: null, text })
    }
    lastObservedTranscriptRef.current = committedText()
    pendingInterimRef.current = ''
  }, [committedText])

  // V2: applyTranscript 支持三层语义：
  // - speech_final: 句级最终，覆盖所有，清空 locked_prefix
  // - is_final && !speech_final: 段级最终，锁定到 locked_prefix
  // - interim: 非最终，叠加到 committed + locked_prefix
  const applyTranscript = useCallback((msg: { text: string; is_final: boolean; speech_final?: boolean; seg?: string | null }) => {
    let text = (msg.text || '').trim()
    if (!text) return false
    const seg = (msg.seg === undefined || msg.seg === null) ? null : msg.seg
    const speechFinal = msg.speech_final === true

    // 2026-08-15 修复("打开股票"进入文档卡片的根因): 火山 result_type:full
    // 返回会话累计全文——发送后新转录以"已发送文本"开头(旧句+新句拼接)。
    // 剥离已发送前缀, 只保留新增部分; 纯重复(无新增)直接忽略。云端会话重建
    // (requestId 变)后累计重置, 新文本不以旧前缀开头 → 不剥离, 自然兼容。
    if (lastSentTextRef.current && text.length > lastSentTextRef.current.length && text.startsWith(lastSentTextRef.current)) {
      text = text.slice(lastSentTextRef.current.length).replace(/^[，。！？、\s]+/, '').trim()
      if (!text) return false
    }

    // speech_final: 句级最终 — 清空 locked_prefix
    // B5: 保留前文——旧实现整体覆盖 committedRef,多句连续语音里 speech_final 逐句
    // 到达时前文语境被丢弃,发送的只剩最后一句。改为:若新段是既有累积的重复/延续
    // 则跳过,否则追加。
    if (speechFinal) {
      const existingText = committedText()
      // 2026-08-15 S12(审计 P2): 重复判定从 includes 改为双向尾缀匹配——
      // "好的好的"后跟"好的"曾因包含关系被误杀(用户重复短语丢失)。
      // 尾缀语义: 新句是旧句整体重复/旧句的延伸(ASR 补全)→ 丢弃;
      // 新句是旧句的前缀或全新内容 → 保留。
      const isDuplicate = !!existingText && (existingText.endsWith(text) || text.endsWith(existingText))
      if (existingText && !isDuplicate) {
        committedRef.current = [...committedRef.current, { seg, text }]
      } else if (!isDuplicate) {
        committedRef.current = [{ seg, text }]
      }
      lastObservedTranscriptRef.current = committedText()
      pendingInterimRef.current = ''
      lockedPrefixRef.current = ''

      onFinal?.(lastObservedTranscriptRef.current)
      updateState('recognizing')
      return true
    }

    if (msg.is_final) {
      // is_final: 段级最终 — 锁定到 locked_prefix
      // 如果 seg 已存在则更新，否则新增
      let idx = -1
      if (seg !== null) {
        idx = committedRef.current.findIndex(s => s.seg === seg)
      } else {
        const last = committedRef.current[committedRef.current.length - 1]
        if (last && last.text === text) idx = committedRef.current.length - 1
      }

      if (idx >= 0) {
        committedRef.current[idx].text = text
      } else {
        committedRef.current.push({ seg, text })
      }

      // V2: 锁定最后一段到 locked_prefix — 长句多段时保持预览稳定
      lockedPrefixRef.current = committedText()
      pendingInterimRef.current = ''
      lastObservedTranscriptRef.current = lockedPrefixRef.current

      onFinal?.(lockedPrefixRef.current)
      updateState('recognizing')
      return true
    }

    // interim: 非最终 —  committed + locked_prefix + 当前 interim
    pendingInterimRef.current = text
    const base = lockedPrefixRef.current || committedText()
    const displayText = base ? base + '，' + text : text
    lastObservedTranscriptRef.current = displayText
    setInterimText(displayText)
    onInterim?.(displayText)
    return false
  }, [committedText, onFinal, onInterim, updateState])

  // 2026-08-15: 最近一次已发送文本——applyTranscript 用它剥离火山累计前缀
  const lastSentTextRef = useRef('')

  const sendRecognizedVoiceText = useCallback(() => {
    const text = lastObservedTranscriptRef.current
    if (!text) return
    // 2026-08-15: 记录已发送文本(火山累计前缀剥离基准)
    lastSentTextRef.current = text
    resetTranscriptAccumulation()
    setInterimText('')
    // 对标 CrabPaw: 发送后吞尾 1.5s — 防止 WS 关闭前的尾随 final 被重复处理
    transcriptSuppressUntilRef.current = Date.now() + 1500
    const sendMsg = getSendMessage?.()
    if (sendMsg) sendMsg(text)
  }, [getSendMessage, resetTranscriptAccumulation])

  // 2026-08-03: 自适应增益——USB 麦克风输入微弱（RMS ~0.0018/-55dB），
  // 火山 ASR 无法识别微弱语音 → no-speech 10s 循环。发送前放大到目标 RMS。
  // 2026-09-05 深度优化: AGC+HPF 收敛为共享件 voice-enhance(与 PTT 管线同源
  // 同参, 消除双管线增益/滤波差异), 增益上限随 AGC_MAX_GAIN 提至 24。
  const agcBoost = useMemo(() => createAgcBoost(), [])
  const hpf = useMemo(() => createHighPass(), [])

  function boostInt16(i16: Int16Array): Int16Array {
    return agcBoost.process(hpf.process(i16))
  }

  // ── 处理 PCM 块 ──
  // 2026-08-04: P3 静音门控(移植 LiveKit DTX 思想)——持续静音帧不送 ASR
  // (省 API + 防 no-speech 循环 + 服务端凭包超时更快切句)。
  // 必须在 AGC 之前判定:AGC 会放大噪声到目标 RMS,污染静音判定。
  const silenceGateRef = useRef(new SilenceGate(8)) // 连续 8 块(~1s)静音后丢弃
  // 2026-08-14: 能量检测器(ref 持有防重建——onFrame 是高频回调,实例必须稳定跨帧/
  // 跨重渲染存活)+ 1s 节流时间戳(listening 期 ASR 侧能量广播;待机期能量由 KWS
  // 主进程 wake:audio-level 广播承担)
  const levelDetectorRef = useRef<AudioLevelDetector | null>(null)
  const energyEmitTsRef = useRef(0)
  // 2026-08-08(A3): 连续模式静音保活帧时间戳——静音时降频发送保活
  const lastKeepaliveTsRef = useRef(0)
  const handlePcmChunk = useCallback((i16: Int16Array) => {
    diagNoteChunk(i16.byteLength) // ASR 诊断：记一次 chunk
    // 2026-08-04 修复:连续对话模式禁用静音门控——持续静音丢包 → 火山 ASR
    // 服务端 8s 无包判定会话结束(45000081)→ 用户停顿后会话已断,重连丢开头语音
    // → 连续对话"收听困难"(PTT 按住说话无停顿所以正常)。
    // 门控只保留给单轮/PTT 模式(停顿即断句,省 API 合理)
    // 2026-08-08(A3): 连续模式不再每帧全量送静音——静音帧降频为
    // KEEPALIVE_INTERVAL_MS(3.5s)一帧保活(服务端 ~8s 无包才判断,余量足够),
    // 省 API 配额 + 静音不再被 AGC 放大后污染端点检测;有语音恢复每帧发送。
    if (continuousEnabledRef.current) {
      // 2026-08-15 灵敏度修复: 连续模式静音判定阈值 0.001 → 0.0004——USB 麦
      // 实测说话 RMS 0.0018、静音 0.0002, 旧阈值贴着语音线, 正常音量的轻音
      // 音节被误判静音 → 只留 3.5s 保活帧 → 火山听到碎片 → "喊半天只识别
      // 几个字/灵敏度被限制"。0.0004 高于真实噪声底(0.0002)仍能滤噪。
      if (isSilentChunk(i16, 0.0004)) {
        const now = Date.now()
        if (now - lastKeepaliveTsRef.current < KEEPALIVE_INTERVAL_MS) return
        lastKeepaliveTsRef.current = now
        // 保活帧不放大(静音放大无意义),直接走发送链路
      } else {
        lastKeepaliveTsRef.current = 0 // 语音帧:重置保活计数(连续发送无需保活帧)
        i16 = boostInt16(i16)
      }
    } else {
      if (silenceGateRef.current.shouldDrop(i16)) return // 静音帧丢弃(语音帧立即放行)
      i16 = boostInt16(i16)
    }

    if (bargeinBufferingRef.current) {
      bargeinBufferRef.current.push(i16)
      if (bargeinBufferRef.current.length > BARGEIN_MAX_CHUNKS) {
        bargeinBufferRef.current.shift()
      }
      return
    }

    if (!asrWsRef.current || asrWsRef.current.readyState !== WebSocket.OPEN) {
      reconnectBufferRef.current.push(i16)
      if (reconnectBufferRef.current.length > RECONNECT_MAX_CHUNKS) {
        reconnectBufferRef.current.shift()
      }
      return
    }

    // 2026-08-12: 客户端背压——服务端 high 信号或本地缓冲积压时暂停发送
    // (音频继续采集进本地小缓冲,恢复后按序冲刷;上限 2s,防内存无界)
    const asrWs = asrWsRef.current
    if (asrWs && shouldBackpressure(backpressureRef.current, asrWs.bufferedAmount || 0)) {
      bpBufferRef.current.push(i16)
      if (bpBufferRef.current.length > BACKPRESSURE_MAX_CHUNKS) bpBufferRef.current.shift()
      return
    }
    // 恢复:先冲刷本地背压缓冲(保序),再发新帧
    if (asrWs && bpBufferRef.current.length > 0) {
      while (bpBufferRef.current.length > 0 && (asrWs.bufferedAmount || 0) < WS_BUFFERED_THRESHOLD_BYTES) {
        try { asrWs.send(bpBufferRef.current.shift()!.buffer) } catch (e) { console.warn('[ASR] 背压缓冲冲刷失败:', e); break }
      }
    }

    // 2026-08-07: ws.send 加 try/catch——WS 竞态下(如 onclose 中 asrWsRef 已置 null
    // 但本帧仍在途)send 抛 InvalidStateError 会打断 onFrame 链,整帧丢失且无日志
    try { asrWsRef.current.send(i16.buffer) } catch (e) { console.warn('[ASR] PCM 发送失败:', e) }
  }, [])

  // ── 统一 ASR 消息处理（connectCloudWs 和 resumeSession 共用） ──
  const handleAsrMessage = useCallback((ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data.toString())
      if (msg && msg.type === 'session' && msg.sessionId) {
        sessionIdRef.current = msg.sessionId
        ;(window as any).__voiceSessionId = msg.sessionId
        diag('[asr-session]', msg.sessionId)
        return
      }
      if (msg && msg.type === 'backpressure') {
        backpressureRef.current = msg.level === 'high' ? 'high' : 'ok'
        diag('[asr-backpressure]', msg.level)
        return
      }
      if (msg && msg.type !== 'transcript' && msg.type !== 'error' && msg.type !== 'no_speech_timeout' && msg.type !== 'diag') {
        return // 未知消息类型:向后兼容忽略
      }
      if (msg.type === 'transcript') {
        diagNoteTranscript() // ASR 诊断：记一次转录
        if (Date.now() < transcriptSuppressUntilRef.current) {
          // 2026-08-15 S5(审计 P1): 抑制窗内不再整句丢弃——按 seg 去重:
          // 已提交段的尾随 final 是真重复(丢弃); 新 seg(下一句开头)正常累积,
          // 连续模式"说完一句紧跟第二句"不再丢字头。无 seg 的 interim 保守丢弃。
          const seg = msg.seg
          const isCommittedDuplicate = seg !== undefined && seg !== null
            && committedRef.current.some(s => s.seg === seg)
          if (isCommittedDuplicate || (!msg.is_final && !msg.speech_final)) {
            setInterimText('')
            return
          }
        }
        lastTranscriptTsRef.current = Date.now()
        // V2: pass speech_final through to applyTranscript
        const isFinal = applyTranscript(msg)
        if (isFinal) {
          // 2026-08-07: 定时器句柄入 ref——stopSession/suspendForTTS 时清除,
          // 避免"会话已停/已挂起后 2s 延迟把状态盖回 listening"的竞态与泄漏
          if (listeningStateTimerRef.current) clearTimeout(listeningStateTimerRef.current)
          listeningStateTimerRef.current = setTimeout(() => {
            listeningStateTimerRef.current = null
            if (activeRef.current) updateState('listening')
          }, 2000)
        }
      } else if (msg.type === 'no_speech_timeout') {
        // V2: 后端 no-speech 看门狗触发 — 无语音超时
        console.warn('[VoiceSession] No-speech timeout from backend')
        // P5.5 修复: 连续对话空闲断开属正常行为 — 重置重连计数。
        // 此前每次断开 +1，5 次上限（约 50s）后会话永久死亡，用户再说话无反应
        reconnectAttemptsRef.current = 0
        // 2026-08-15 S4(审计 P0): 空闲超时统一保持 WS 常开——此前非连续模式
        // close → onclose 800ms 重连 → 新云端会话 → 10s 又超时 → 无界循环,
        // 每次唤醒白烧 5-6 个无用云端 ASR 会话。后端看门狗只回收云端会话
        // (session=null), 前端 WS 保持; 新语音帧到达时后端惰性重建(voice-cloud-ws.js
        // 配对改动)。pending interim 照常提交。
        commitPendingInterim()
      } else if (msg.type === 'error') {
        // 2026-08-14: ASR 错误分类消费——后端新增 retryable 字段(auth/配置类=false)。
        // 缺省视为 retryable=true 兼容旧后端。此前任何 error 都置 MAX_RECONNECT_ATTEMPTS
        // 且不关 WS → 瞬态错误(网络抖动等)最长 ~25s 完全聋(重连计数被封死)。
        const retryable = msg.retryable !== false
        console.error('[ASR] Error:', msg.message, 'retryable=' + retryable)
        updateState('error')
        onError?.(msg.message)
        if (retryable) {
          // 瞬态错误:走正常重连链——主动 close 触发 onclose(非 intentional)
          // 的重连计数路径,不再直接封死重连计数
          try { asrWsRef.current?.close() } catch { console.warn('[ASR] 错误重连关闭 WS 失败(ws already closed)') }
        } else {
          // auth/配置类错误:不可恢复——阻止重连循环,保留明确 UI 错误提示(onError 已发出)
          reconnectAttemptsRef.current = MAX_RECONNECT_ATTEMPTS
          reconnectScheduledRef.current = false
        }
      } else if (msg.type === 'diag') {
        // V2: 转发云端诊断事件
        console.log('[ASR] diag:', msg.event, msg.info || '')
      }
    } catch (e) {
      console.error('[ASR] Parse error:', e)
    }
  }, [applyTranscript, onError, resetTranscriptAccumulation, updateState, commitPendingInterim])

  // ── 创建 ASR WebSocket 并绑定统一处理器 ──
  // 三处连接点（初始/barge-in/TTS恢复）共享此辅助函数，消除重复代码
  const createAsrWs = useCallback((
    wsUrl: string,
    onReady?: (ws: WebSocket) => void,
    useReconnectGuard?: boolean,
  ): WebSocket => {
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    try { asrWsRef.current?.close() } catch { console.warn('[ASR] WS 关闭失败(ws already closed, safe to replace)') }
    asrWsRef.current = ws
    asrWsIntentionalRef.current = false

    ws.onopen = () => {
      if (asrWsRef.current !== ws) return
      // B5: 会话已停止(activeRef=false)时这条晚到的连接作废——connectCloudWs 是异步
      // (await getAuthenticatedWsUrl),stopSession 可能在 wsUrl 返回前已跑完,此时
      // onopen 若无守卫会 updateState('listening') + 留下永不关闭的幽灵 WS。
      if (!activeRef.current) {
        asrWsIntentionalRef.current = true
        try { ws.close() } catch { console.warn('[ASR] 幽灵 WS 关闭失败(ws already closed)') }
        if (asrWsRef.current === ws) asrWsRef.current = null
        console.log('[VoiceSession] 会话已停止,丢弃晚到的 WS 连接')
        return
      }
      // 2026-08-13 (审查 I-1 修复): 新 WS 连接 = 服务端 backlog 从 'ok' 基线起步、
      // 且仅边缘转换才发通知——旧会话 'high' 残留会永久闩锁(客户端停发音频,完全静默)。
      // 每次连接建立(含重连/恢复)时重置背压状态与本地缓冲。
      backpressureRef.current = 'ok'
      bpBufferRef.current = []
      // 2026-08-01: provider 读配置（aliyun/tencent/xunfei/volcengine），默认 volcengine
      ws.send(JSON.stringify({ type: 'config',
      sessionId: sessionIdRef.current || undefined, provider: asrProvider || 'volcengine', lang: langRef.current, continuous: continuousEnabledRef.current }))
      updateState('listening')
      lastTranscriptTsRef.current = Date.now()
      // V11 fix: ASR WS 重连成功后重置唤醒词重连计数器，避免陈旧计数器阻止唤醒检测
      if (typeof (window as any).__voiceWakeResetCounter === 'function') {
        ;(window as any).__voiceWakeResetCounter()
      }
      onReady?.(ws)
    }

    ws.onmessage = (ev) => {
      if (asrWsRef.current !== ws) return
      handleAsrMessage(ev)
    }

    ws.onerror = () => {
      if (asrWsRef.current === ws) updateState('error')
    }

    ws.onclose = () => {
      if (asrWsRef.current !== ws) return
      asrWsRef.current = null
      if (!asrWsIntentionalRef.current && activeRef.current) {
        commitPendingInterim()
        if (useReconnectGuard) {
          diagReconnects++
          // 2026-08-01: 暴露重连计数给 VoiceDiagnostics（此前诊断面板硬编码 0）
          ;(window as any).__asrReconnects = diagReconnects
          diag('ws-closed → reconnect in 800ms', 'reconnects=' + diagReconnects)
          // V6 fix: 标记重连已调度，防止 watchdog 再次对同一次断开递增计数器
          if (!reconnectScheduledRef.current) {
            reconnectScheduledRef.current = true
            reconnectAttemptsRef.current++
            setTimeout(() => {
              reconnectScheduledRef.current = false
              if (activeRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
                connectCloudWs()
              } else if (activeRef.current) {
                // 2026-08-04: P5 全量重建兜底(移植 LiveKit IssueFullReconnect 思想)
                // 轻量重连 5 次失败 → 重新拉取 wsUrl 全量重连(新 token),而非会话永久死亡。
                // 10s 内已全量重建仍失败 → 放弃并置 error(防无限循环)。
                const now = Date.now()
                if (now - lastFullReconnectRef.current >= FULL_RECONNECT_COOLDOWN_MS) {
                  lastFullReconnectRef.current = now
                  reconnectAttemptsRef.current = 0
                  console.warn('[ASR] 轻量重连 5 次失败 → 全量重建连接')
                  diag('full-reconnect', 'attempts exhausted, full rebuild')
                  connectCloudWs()
                } else {
                  console.error('[ASR] 全量重建仍失败(10s 冷却),会话置 error')
                  updateState('error')
                }
              }
            }, 800)
          }
        } else {
          setTimeout(() => { if (activeRef.current) connectCloudWs() }, 800)
        }
      } else {
        asrWsIntentionalRef.current = false
      }
    }

    return ws
  }, [handleAsrMessage, commitPendingInterim, updateState])

  // ── 连接 WebSocket（初始连接入口） ──
  const connectCloudWs = useCallback(async () => {
    let wsUrl: string
    try {
      // 2026-08-07 fix: getAuthenticatedWsUrl 此前在 try 外——Electron api:streamUrl
      // 或凭证获取失败时抛 rejection,startSession 的 await 链未接 .catch →
      // 未处理 rejection(审查报告 P2)。包进 try/catch 返回失败信号:不建 WS,
      // 由 watchdog/onclose 的既有重连机制继续重试
      wsUrl = await getAuthenticatedWsUrl('/voice/cloud')
    } catch (e: any) {
      console.error('[ASR] 获取 WS 地址失败:', e?.message || e)
      onError?.('语音识别连接失败:无法获取服务地址')
      return
    }
    wsUrlRef.current = wsUrl

    try {
      createAsrWs(wsUrl, (ws) => {
        // 初始连接：flush reconnectBuffer
        if (reconnectBufferRef.current.length > 0) {
          for (const chunk of reconnectBufferRef.current) {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk.buffer)
          }
          reconnectBufferRef.current = []
        }
      }, true) // useReconnectGuard=true：使用重连计数器+MAX_RECONNECT_ATTEMPTS
    } catch (e) {
      console.error('[ASR] WebSocket connect error:', e)
    }
  }, [createAsrWs, onError])

  // ── 开始麦克风 ──
  const startMic = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    // 2026-08-13 (审查 P1): 声明本链代际——后续任何 stopMic/新 startMic 会使本链失效
    const gen = ++micGenRef.current
    // 2026-09-09 (资源保护): 设备类失败后 60s 冷却——直接返回 false,不尝试不弹窗
    {
      const fail = micDeviceFailureRef.current
      if (fail && Date.now() - fail.ts < 60000 &&
          (fail.name === 'NotFoundError' || fail.name === 'NotAllowedError' || fail.name === 'NotReadableError')) {
        return false
      }
    }
    try {
      // P5(GUI 全量修复): 删除 __releaseMicForSession 死调用(无写入方的孤儿键,
      // 会议转录未接线, 调用恒静默 no-op)
      // 2026-08-03: 选择真实麦克风——排除'显示器音频'等无声虚拟设备
      // （系统默认输入被切到 Intel 显示器音频时 getUserMedia 无声 → 无法识别）
      // 2026-08-12 (P2 杂项 5a): 规则与 wake-probe.html:21 统一——补 communications|通信
      //（通信默认设备常被系统静音/压低音量,probe 已排除,此处漏排导致 ASR 全静音）
      let micDeviceId: string | undefined
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mics = devices.filter(d => d.kind === 'audioinput')
        const bad = /display|显示器|虚拟|virtual|communications|通信|默认通信设备/i
        const remembered = (() => { try { return localStorage.getItem('mic-device-id') } catch { return null } })()
          || (window as any).__audioInputDeviceId as string | undefined
        const good = mics.filter(m => m.deviceId !== 'default' && m.label && !bad.test(m.label))
        micDeviceId = (remembered && mics.some(m => m.deviceId === remembered) ? remembered : undefined)
          || (good.length > 0 ? good[0].deviceId : undefined)
          || (mics.find(m => m.deviceId !== 'default')?.deviceId)
      } catch (e) { console.warn('[ASR] 麦克风设备枚举失败:', e) }
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        // F5: 对齐 usePushToTalk(noiseSuppression:true)——关闭降噪后弱麦噪声
        // 被 AGC 放大,ASR 持续收到噪声语音识别不出。开启浏览器降噪更稳。
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
      }
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: micDeviceId ? { ...audioConstraints, deviceId: { exact: micDeviceId } } : audioConstraints,
        })
      } catch (exactErr: any) {
        // 指定设备失败（拔出/占用）→ 回退系统默认
        console.warn('[ASR] 指定麦克风失败, 回退默认:', exactErr?.name || exactErr?.message)
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      }
      // 诊断：打印麦克风轨道设置
      const track = stream.getAudioTracks()[0]
      if (track) {
        const settings = track.getSettings()
        console.log('[ASR] 麦克风设置:', JSON.stringify({
          deviceId: settings.deviceId?.substring(0, 8) + '...',
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          sampleRate: settings.sampleRate,
          channelCount: settings.channelCount,
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
        }))
      }
      if (signal.aborted) { stream.getTracks().forEach(t => t.stop()); return false }
      micStreamRef.current = stream
      // 2026-08-04: P5 设备断开自动恢复(移植 LiveKit 轻量恢复思想)
      // 麦克风拔出/系统切换 → track ended → 重新 getUserMedia 并替换 stream 内轨道
      // (MediaStreamSourceNode 跟随 stream 内首个可用轨,无需重建 AudioContext)
      track?.addEventListener('ended', async () => {
        if (!activeRef.current || micStreamRef.current !== stream) return
        console.warn('[ASR] 麦克风设备断开,尝试自动恢复…')
        try {
          const fresh = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
          const freshTrack = fresh.getAudioTracks()[0]
          const oldStream = micStreamRef.current
          if (oldStream && freshTrack) {
            oldStream.getAudioTracks().forEach(t => { try { t.stop() } catch { console.warn('[ASR] 轨道停止失败(track already stopped)') } })
            oldStream.removeTrack(oldStream.getAudioTracks()[0])
            oldStream.addTrack(freshTrack)
            console.log('[ASR] 麦克风自动恢复成功:', freshTrack.label)
          } else {
            fresh.getTracks().forEach(t => t.stop())
          }
        } catch (e: any) {
          console.error('[ASR] 麦克风自动恢复失败:', e?.message || e)
        }
      })

      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
      // 2026-08-05 fix: 浏览器 autoplay 策略下 AudioContext 默认 suspended——
      // 连续对话自动启动(无用户手势)时音频流不流动 → PCM 静音 → 火山 ASR 零转录
      // （PTT 有手势所以正常）。
      // F4: 显式 resume 且失败不静默——周期性重试；仍失败则上报可见错误并中止
      // 会话启动（而非"看起来在听、实际 ASR 收全静音"）。
      const ctxRunning = await ensureAudioContextRunning(audioCtx)
      if (!ctxRunning) {
        console.warn('[ASR] AudioContext 无法运行(autoplay 策略拦截)——上报可见错误')
        onError?.('浏览器音频策略阻止自动开麦，请点击页面或按一次空格后重试')
        try { audioCtx.close() } catch { console.warn('[ASR] close 失败(audioCtx already closed)') }
        stream.getTracks().forEach(t => t.stop())
        return false
      }
      console.log('[ASR] AudioContext running (state=' + audioCtx.state + ')')
      if (signal.aborted) { audioCtx.close(); stream.getTracks().forEach(t => t.stop()); return false }
      audioCtxRef.current = audioCtx

      const source = audioCtx.createMediaStreamSource(stream)
      sourceRef.current = source

      bargeinBufferRef.current = []
      reconnectBufferRef.current = []

      const onFrame = (frame: Int16Array) => {
        // 2026-08-13 (审查 P1): 旧代采集链(竞态泄漏/未被 disconnect)的帧立即丢弃——
        // 防多路链并发把音频叠加成 18x 风暴,火山识别不出
        if (gen !== micGenRef.current) return
        if (!activeRef.current) return

        let sum = 0
        for (let i = 0; i < frame.length; i++) {
          sum += (frame[i] / 32768) * (frame[i] / 32768)
        }
        const rms = Math.sqrt(sum / frame.length)
	        const vol = Math.min(1, rms * 3)
		        // 2026-08-07: 移除 setVolume 死状态——session.volume 无 UI 消费方,
		        // 每 128ms setState 造成无谓重渲染(审查报告 P2);onVolume 回调保留
		        // (VoiceIntegration 经 onFrameRef 接 continuousPolicy 帧分类)
		        onVolume?.(vol)
		        // 2026-08-14: 能量驱动球体(listening 期能量信号源)——KWS probe 在会话期间被
		        // 暂停(setMicEnabled(false)),ASR 采集帧是唯一实时能量源。窗口化百分位+EMA
		        // 检测器(ref 持有防重建)判定活跃/电平;1s 节流经 crabpaw:voice-energy 事件
		        // 广播给 VoiceShell 驱动球体聆听/微光;info 作为 onVolume 可选第二参透传。
		        try {
		          if (!levelDetectorRef.current) levelDetectorRef.current = new AudioLevelDetector()
		          const ldet = levelDetectorRef.current
		          ldet.observeLevel(rmsToLevel0127(rms), frame.length / SAMPLE_RATE * 1000)
		          const nowTs = Date.now()
		          if (nowTs - energyEmitTsRef.current >= 1000) {
		            energyEmitTsRef.current = nowTs
		            const info = { level: ldet.getLevel(nowTs), active: ldet.isActive(nowTs) }
		            onVolume?.(vol, info)
		            window.dispatchEvent(new CustomEvent('crabpaw:voice-energy', { detail: info }))
		          }
		        } catch (e) {
		          console.error('[ASR] 能量检测失败:', e)
		        }

	        // 对标 CrabPaw voice-core.js: 记录最近一次人声级音量的时刻
	        // watchdog 用它判断"用户是否还在说话"，避免安静时误触发重连
	        const WATCHDOG_SPEECH_VOL = 0.05
	        if (vol > WATCHDOG_SPEECH_VOL) lastLoudTsRef.current = Date.now()

	        handlePcmChunk(frame)
      }

      const captureNode = await createCaptureNode(audioCtx, source, onFrame, signal)
      if (signal.aborted) {
        captureNode.disconnect(); audioCtx.close(); stream.getTracks().forEach(t => t.stop())
        return false
      }
      captureNodeRef.current = captureNode
      micDeviceFailureRef.current = null // 成功即清冷却,设备恢复后立即可用
      return true
    } catch (e: any) {
      const msg = e.name === 'NotAllowedError' ? '麦克风权限被拒绝'
        : e.name === 'NotFoundError' ? '未找到麦克风设备'
        : `麦克风启动失败: ${e.message}`
      // 2026-09-09 (资源保护): 设备类错误记录冷却戳,阻断无限重试循环
      if (e.name === 'NotFoundError' || e.name === 'NotAllowedError' || e.name === 'NotReadableError') {
        micDeviceFailureRef.current = { name: e.name, ts: Date.now() }
      }
      onError?.(msg)
      // 2026-08-07 fix(泄漏): 异常路径此前只 onError 不清理——audioCtxRef/micStreamRef
      // 在失败前可能已赋值(getUserMedia 成功/ctx 已建),不清理则每次启动失败泄漏
      // 一个 AudioContext + 麦克风流,设备占用无法释放(审查报告 P1)。
      // 注:不能直接调 stopMic(其声明在下方,此处引用会 TDZ),故等价内联清理。
      try {
        if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null }
        if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
      } catch (cleanupErr) { console.warn('[ASR] 启动失败清理异常:', cleanupErr) }
      return false
    }
  }, [handlePcmChunk, onError, onVolume])

  // ── 停止麦克风 ──
  const stopMic = useCallback(() => {
    // 2026-08-13 (审查 P1): 代际递增——所有旧代采集链立即失效(即使未被 disconnect)
    micGenRef.current++
    try {
      if (captureNodeRef.current) { captureNodeRef.current.disconnect(); captureNodeRef.current = null }
      if (sourceRef.current) { sourceRef.current.disconnect(); sourceRef.current = null }
      if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null }
      if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null }
    } catch { console.warn('[ASR] 停止麦克风失败') }
  }, [])

  // ── 发送 PCM 到 ASR（降级路径） ──
  // ── 开始会话 ──
  const startSession = useCallback(async (): Promise<boolean> => {
    if (activeRef.current) {
      if (isSuspendedForTTsRef.current) {
        isSuspendedForTTsRef.current = false
        bargeinBufferingRef.current = false

        const connectAfterMic = () => {
          if (bargeinBufferRef.current.length > 0) {
            // R5 fix: 在 WS onopen 回调中发送缓冲块，与 resumeSession 路径一致
            // 旧实现用 500ms setTimeout，WS 未就绪时缓冲块丢失
            const bufferedChunks = bargeinBufferRef.current.slice()
            bargeinBufferRef.current = []

            const wsUrl = wsUrlRef.current
            if (!wsUrl) {
              // 尚未连接过，走通用路径（无法预发缓冲块，但至少不会丢）
              connectCloudWs()
            } else {
              createAsrWs(wsUrl, (ws) => {
                // Barge-in 重连：在 onopen 中安全发送缓冲 PCM
                for (const chunk of bufferedChunks) {
                  if (ws.readyState === WebSocket.OPEN) ws.send(chunk.buffer)
                }
              }, false) // useReconnectGuard=false：简单重连，不计数
            }
          } else {
            connectCloudWs()
          }
          if (activeRef.current) updateState('listening')
        }

        // 2026-08-08(A1): suspendForTTS 已 stopMic——挂起中唤醒/PTT 重新激活会话
        // 时先重建采集（mic 已归 KWS,须先抢回）再连 WS
        if (!captureNodeRef.current) {
          const abort = new AbortController()
          abortRef.current = abort
          const micOk = await startMic(abort.signal)
          if (abort.signal.aborted || !micOk) return false
        }
        connectAfterMic()
        return true
      }
      return true
    }

    setActive(true)
    // 2026-08-05 fix(防御): 完整路径启动时强制清 bargein 缓冲旗标——
    // 避免 TTS 播放中停止会话(suspendForTTS 卡 true)后重启时所有 PCM
    // 进缓冲不发送 → tx=0 → 火山无音频断开 → 重连死循环
    bargeinBufferingRef.current = false
    bargeinBufferRef.current = []
    const abort = new AbortController()
    abortRef.current = abort

    // V11 fix: 主动启动会话时重置重连计数器，因为这是正常启动而非异常重连
    // 唤醒词/用户操作触发的新会话不应继承之前的异常重连计数
    reconnectAttemptsRef.current = 0
    reconnectScheduledRef.current = false

    // F7: 先停 KWS probe 采集(await 回执)再 getUserMedia——消除 probe 与 ASR
    // 并发抢 mic 的竞态窗口。旧顺序在 startMic 之后才停(webContents.send 异步),
    // Windows 独占/半独占模式下 ASR 可能拿到静音流 → no-speech 循环重连。
    try { await window.electronAPI?.wake?.setMicEnabled?.(false) } catch (e) { console.warn('[ASR] 暂停 KWS 采集失败:', e) }

    const micOk = await startMic(abort.signal)
    if (!micOk) { setActive(false); return false }

    resetTranscriptAccumulation()
    await connectCloudWs()
    diagStart() // ASR 诊断：开始采集统计

    // 对标 CrabPaw voice-core.js 看门狗: 用户还在说话但 ASR 无响应 → 强制重连
    // 条件: 最近 1.2s 内有人声级音量(lastLoudTs) 且 超过 3.5s 没收到转录(lastTranscriptTs)
    // 安静环境下 lastLoudTs 不会更新，不会误触发重连
    watchdogTimerRef.current = setInterval(() => {
      if (!activeRef.current || isSuspendedForTTsRef.current) return
      const ws = asrWsRef.current
      // F6: 会话 active 但 WS 为空/非 OPEN 且未在重连窗口 → 强制重连。
      // 旧逻辑直接 return——createAsrWs 失败路径(旧 ws close 后 asrWsRef 置 null、
      // 新 ws 未建立)下 onclose 不会触发,会话停在"active 但聋",用户说话无反应。
      // B5: 轻量重连 5 次耗尽后接全量重建兜底——旧实现此分支无兜底,WS 反复建连
      // 失败(拿不到 wsUrl/建连即失败,onclose 永不触发)时会话永久"活跃但聋"。
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // R9: watchdog 的 null-WS 重连加"静默期节流"——WS 短暂 not-open(如刚 close
        // 等重连)时,旧逻辑每次 1s 检查都 attempts++ 并建连,与 onclose 的重连竞争
        // 创建多个 WS → 音频乱序 → 识别不稳定("有时监听有时不行")。
        // 修复: 距上次重连 > 2s 才触发(给 onclose 的重连优先),且单次 not-open
        // 状态不无限累加 attempts(连续 10s 不在线才计一次)。
        const now = Date.now()
        if (now - lastListenReconnectTsRef.current < 2000) return
        if (now - lastWarnedOfflineTsRef.current < 10000) return
        if (!reconnectScheduledRef.current) {
          if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
            reconnectScheduledRef.current = true
            lastListenReconnectTsRef.current = now
            lastWarnedOfflineTsRef.current = now
            reconnectAttemptsRef.current++
            console.warn('[VoiceSession] 听诊: WS 不在线,强制重连(attempts=%d)', reconnectAttemptsRef.current)
            setTimeout(() => {
              reconnectScheduledRef.current = false
              if (activeRef.current && !isSuspendedForTTsRef.current) {
                // 2026-08-07: catch + 回滚调度标记——connectCloudWs 已内部消化 rejection,
                // 此处防御性兜底,失败时允许下一次巡检重试(审查报告 P2)
                try { connectCloudWs() } catch (e) {
                  console.error('[ASR] 听诊强制重连失败:', e)
                  reconnectScheduledRef.current = false
                }
              }
            }, 800)
          } else {
            // 轻量重连耗尽 → 全量重建(重新拉 wsUrl 拿新 token),10s 冷却防无限循环
            if (now - lastFullReconnectRef.current >= FULL_RECONNECT_COOLDOWN_MS) {
              lastFullReconnectRef.current = now
              lastListenReconnectTsRef.current = now
              reconnectAttemptsRef.current = 0
              console.warn('[VoiceSession] 听诊: 轻量重连耗尽 → 全量重建')
              reconnectScheduledRef.current = true
              setTimeout(() => {
                reconnectScheduledRef.current = false
                if (activeRef.current && !isSuspendedForTTsRef.current) {
                  try { connectCloudWs() } catch (e) {
                    console.error('[ASR] 全量重建失败:', e)
                    reconnectScheduledRef.current = false
                  }
                }
              }, 800)
            }
          }
        }
        return
      }
      const now = Date.now()
      // R21: 1200→3000——用户说完话后 1.2s 内没音量就判"不活跃"太敏感,
      // 配合 8s stalled 窗口,只在真正长时间无响应时才重连。
      const loudRecently = now - lastLoudTsRef.current < 3000
      const noTranscriptFor = now - lastTranscriptTsRef.current
      if (loudRecently && noTranscriptFor > STALL_RECONNECT_MS && !reconnectScheduledRef.current && reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
        console.warn('[VoiceSession] watchdog: stalled → force reconnect, sinceTx=' + noTranscriptFor + 'ms')
        lastTranscriptTsRef.current = now // 防重连窗口内重复触发
        reconnectScheduledRef.current = true
        reconnectAttemptsRef.current++
        try { ws.close() } catch { console.warn('[ASR] WS 关闭失败(ws already closing)') } // onclose(!intentional) → commitPendingInterim + 重连
        setTimeout(() => { reconnectScheduledRef.current = false }, RECONNECT_RESET_WINDOW_MS)
      }
    }, 1000)

    return true
    // 2026-08-07: 删除 watchdogTimerRef.unref() 死代码——浏览器环境无 unref 方法,
    // 恒为 no-op(审查报告 P3 轻微项)
  }, [connectCloudWs, resetTranscriptAccumulation, setActive, startMic, updateState])

  // ── 停止会话 ──
  const stopSession = useCallback(() => {
    setActive(false)
    isSuspendedForTTsRef.current = false
    // 2026-08-05 fix: TTS 播放中(suspendForTTS)停止会话时 bargeinBuffering 卡 true——
    // 下次启动所有 PCM 进缓冲不发送 → tx=0 → 火山无音频断开 → 重连死循环
    // （日志实锤: chunks/s=8.0 但 tx=0 sinceTx=nams）
    bargeinBufferingRef.current = false
    pttHoldingRef.current = false

    if (watchdogTimerRef.current) { clearInterval(watchdogTimerRef.current); watchdogTimerRef.current = null }
    if (listeningStateTimerRef.current) { clearTimeout(listeningStateTimerRef.current); listeningStateTimerRef.current = null }
    if (suspendKeepaliveRef.current != null) { clearInterval(suspendKeepaliveRef.current); suspendKeepaliveRef.current = null }
    abortRef.current?.abort()

    // 对标 CrabPaw voice-core.js stopCloudStream: 先 flush 再关闭 WS
    // V2: 使用 flush_speech_final 确保最后一段被标记为 speechFinal
    const ws = asrWsRef.current
    asrWsIntentionalRef.current = true
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'flush_speech_final' }))
        // 200ms 后关闭，给 flush 消息到达的时间
        setTimeout(() => { try { ws.close() } catch { console.warn('[ASR] WS 关闭失败(ws already gone)') } }, 200)
      } else {
        ws?.close()
      }
    } catch { console.warn('[ASR] WS flush/close 失败(stopMic will clean up)') }
    asrWsRef.current = null

    stopMic()
    bargeinBufferRef.current = []
    reconnectBufferRef.current = []
    // 2026-08-13 (审查 I-1 修复): 背压状态跨会话清理——旧会话 'high' 残留会永久闩锁
    // (新会话服务端仅边缘通知,'ok' 永不送达 → 客户端停发音频,完全静默)。
    backpressureRef.current = 'ok'
    bpBufferRef.current = []
    resetTranscriptAccumulation()
    updateState('idle')
    setInterimText('')

    // 2026-08-03: 会话结束 → 恢复 KWS 唤醒采集（回到待机唤醒态）
    try { window.electronAPI?.wake?.setMicEnabled?.(true) } catch (e) { console.warn('[ASR] 恢复 KWS 采集失败:', e) }
    diagStop() // ASR 诊断：停止采集统计
    // 2026-08-13 (审查 Important 修复): 主动停止清 sessionId——stop→start 携带旧 ID 会被服务端
    // Set 复用检测计为 reconnect(voice_ws_reconnects_total 虚高 + 跨会话日志同 ID 关联错误)。
    // 仅主动 stop 清;unexpected 断线走 onclose→connectCloudWs 重连路径不清(重连仍正确计数)。
    sessionIdRef.current = ''
    ;(window as any).__voiceSessionId = undefined
  }, [resetTranscriptAccumulation, setActive, stopMic, updateState])

  // ── TTS 暂停 / 恢复 ──
  // 2026-08-07: 挂起公共逻辑抽为 suspendShared(restoreProbe)——两个挂起入口共用:
  //   suspendForTTS     (TTS 播报场景): 保留 session mic 流给 barge-in 缓冲,
  //                     restoreProbe=true 恢复 KWS 唤醒采集(喊唤醒词可打断播报)
  //   releaseMicForPtt  (PTT 场景):     停止 session 采集 + 不恢复 probe,
  //                     让 PTT 自己的 getUserMedia 独占麦克风(三方抢占修复)
  const suspendShared = useCallback((restoreProbe: boolean) => {
    // 幂等保护：避免 onSuspendMic（同步调用）和 ttsPlaying useEffect（异步调用）双重触发导致 bargeinBuffer 被清空
    if (isSuspendedForTTsRef.current) return
    isSuspendedForTTsRef.current = true
    bargeinBufferRef.current = []
    // 2026-08-08(A1 根因修复): TTS 播放期间停止 session 麦克风采集——mic 归 KWS
    // probe 单一独占。此前保留 mic 流做 barge-in 缓冲:
    //   ① 与 KWS probe 并发占麦(Windows 独占/半独占模式一路拿静音流,F7 实锤)
    //      → 用户语音录到静音/噪声 → 打断不灵、TTS 后 flush 噪声给 ASR 识别差;
    //   ② TTS 回声被 barge-in 分类器误判为"用户说话" → duck 忽大忽小(V1)。
    // 打断语义改为:唤醒词(KWS probe)或空格 PTT。bargeinBuffering 不再置位。
    bargeinBufferingRef.current = false
    // 2026-08-13 (审查 P1): 中止进行中的 startMic/restoreMicAfterPtt——
    // 否则其 await(addModule) 完成后创建的采集链无人断开(孤儿链),反复
    // suspend/resume 累积多路链 → 音频 18x 风暴 → ASR 零转录。
    // 与 releaseMicForPtt 的 abort 行为对齐;abort 幂等,双调用无副作用。
    abortRef.current?.abort()
    // 2026-08-15 S3(LiveKit 全双工解耦 + 审计 P0): 挂起只停采集, 不再拆 ASR WS——
    // 每轮 TTS 后整体重建曾付出 getUserMedia+WS+云端握手 0.3-1.1s 恢复空窗。
    // WS 常开期间后端 no-speech 看门狗(非连续模式 10s)会回收云端会话,
    // 恢复说话时后端惰性重建会话 + backlog 补发(voice-cloud-ws.js 配对改动),
    // 用户抢话开头不丢。KWS probe 仍独占麦克风, 打断语义不变。
    // 配套: 启动静音保活帧定时器——防云端 ASR 8s 无包回收(连续模式长 TTS)
    if (asrWsRef.current && asrWsRef.current.readyState === WebSocket.OPEN) {
      suspendKeepaliveRef.current = setInterval(() => {
        const w = asrWsRef.current
        if (w && w.readyState === WebSocket.OPEN) {
          try { w.send(new Int16Array(128 * 16).buffer) } catch (e) { console.warn('[ASR] 挂起保活帧发送失败:', e) }
        }
      }, KEEPALIVE_INTERVAL_MS)
    }
    // 挂起期间不允许 2s 延迟的 'listening' 盖回状态
    if (listeningStateTimerRef.current) { clearTimeout(listeningStateTimerRef.current); listeningStateTimerRef.current = null }
    updateState('speaking')
    stopMic()

    if (restoreProbe) {
      // 2026-08-03: TTS 播放中 mic 空闲 → 恢复 KWS 唤醒采集，
      // 让'喊唤醒词打断播报'可用（此前 KWS 持续暂停 → 无法打断）。
      // 单一采集源(仅 probe)不再并发占麦
      try { window.electronAPI?.wake?.setMicEnabled?.(true) } catch (e) { console.warn('[ASR] suspend 恢复 KWS 失败:', e) }
    }
  }, [updateState, stopMic])

  const suspendForTTS = useCallback(() => {
    suspendShared(true)
    // 2026-08-15: barge-in 打断窗口开启——TTS 播放期间 probe 采集做能量打断
    // 检测(说任何话即可打断, 无需喊唤醒词; 主进程 wake-word.cjs 消费)
    try { window.electronAPI?.wake?.setBargeinWindow?.(true) } catch (e) { console.warn('[ASR] bargein 窗口开启失败:', e) }
  }, [suspendShared])

  /**
   * releaseMicForPtt — PTT 按住前释放 session 侧麦克风（三方抢占修复,审查报告 P1）
   *
   * 背景: 旧流程 PTT down 只调 suspendForTTS——它关 ASR WS 但保留 session 的
   * getUserMedia 流,且无条件 setMicEnabled(true) 恢复 KWS probe;随后
   * usePushToTalk 再新建 getUserMedia → session mic + KWS probe + PTT mic
   * 三方并发占麦(Windows 独占/半独占模式) → PTT 拿到静音流/NotReadable。
   *
   * 语义: 挂起会话(关 ASR WS,同 suspendForTTS) + 停止 session 采集(stopMic)
   * + 暂停 KWS probe,让 PTT 独占麦克风;且不置 bargeinBuffering
   * (PTT 期间无 session 采集,barge-in 缓冲无意义)。
   */
  const releaseMicForPtt = useCallback((): Promise<boolean> | void => {
    suspendShared(false)
    // 中止可能进行中的采集流程(startSession/restoreMicAfterPtt 的 getUserMedia
    // await 中)——快速"松手再按"时空窗期旧采集完成会复活 session mic 与 PTT
    // 并发占麦;startMic 的 abort 分支自会清理已建的流/ctx
    abortRef.current?.abort()
    stopMic()
    bargeinBufferRef.current = []
    bargeinBufferingRef.current = false
    // 2026-09-03 修复(面板打开后 PTT 只录到部分声音): 返回 probe 暂停的
    // 可等待 ack(F7 机制,含 300ms 兜底)——调用方(PTT)await 后再 getUserMedia,
    // 消除"开麦时 probe 还没停完"的抢麦竞态(此前 ack 被丢弃,PTT 拿哑流)。
    try {
      const ack = window.electronAPI?.wake?.setMicEnabled?.(false)
      if (ack && typeof ack.then === 'function') return ack
    } catch (e) { console.warn('[ASR] PTT 暂停 KWS probe 失败:', e) }
  }, [suspendShared, stopMic])

  /**
   * restoreMicAfterPtt — PTT 松手后重建 session 采集 + 恢复 KWS probe（三方抢占修复）
   *
   * 顺序: ① 会话未激活(pttOnly/待机)→ 只恢复 KWS probe(唤醒监听回待机态);
   * ② 会话激活 → 新建 AbortController + startMic 重建采集(复用设备选择/AGC/
   *    断线自愈),失败则报可见错误——ASR WS 重连由调用方(PTT up 的 resumeSession)
   *    负责,采集先于 WS 就绪时 PCM 进 reconnectBuffer 兜底不丢。
   */
  const restoreMicAfterPtt = useCallback(async () => {
    if (!activeRef.current) {
      // 会话未激活: 无需重建采集,恢复 KWS probe 回待机态
      try { window.electronAPI?.wake?.setMicEnabled?.(true) } catch (e) { console.warn('[ASR] PTT 恢复 KWS probe 失败:', e) }
      return
    }
    const abort = new AbortController()
    abortRef.current = abort
    const micOk = await startMic(abort.signal)
    if (!micOk) {
      console.error('[ASR] PTT 结束后 session 麦克风重建失败')
      onError?.('PTT 结束后麦克风恢复失败')
    }
  }, [startMic, onError])

  const resumeSession = useCallback((fromBargein = false) => {
    // 2026-08-15 S3: 恢复时清挂起保活定时器(真实采集帧接管)
    if (suspendKeepaliveRef.current != null) {
      clearInterval(suspendKeepaliveRef.current)
      suspendKeepaliveRef.current = null
    }
    // 2026-08-15: 恢复时关闭 barge-in 打断窗口(会话接管麦克风, probe 已暂停)
    try { window.electronAPI?.wake?.setBargeinWindow?.(false) } catch (e) { console.warn('[ASR] bargein 窗口关闭失败:', e) }
    // 幂等保护：避免 onResumeMic 和 ttsPlaying useEffect 双重恢复创建两个 WS
    if (!isSuspendedForTTsRef.current && asrWsRef.current && asrWsRef.current.readyState === WebSocket.OPEN) {
      // 2026-08-07: 守卫去重日志——双重恢复(onResumeMic + ttsPlaying effect)时仅
      // 首次建 WS,重复调用打日志便于诊断(此前静默返回,无法区分"正常幂等"与
      // "重复恢复路径")(审查报告 P3 轻微项)
      console.log('[VoiceSession] resumeSession 幂等跳过(WS 已 OPEN,重复恢复去重)')
      return
    }
    isSuspendedForTTsRef.current = false
    bargeinBufferingRef.current = false

    const finishResume = () => {
      if (fromBargein && bargeinBufferRef.current.length > 0) {
        // 对标 CrabPaw：创建专用 WS，在 onopen 中发送缓冲 PCM
        // 原实现 connectCloudWs() 是异步的，后面同步 send() 时 WS 尚未 open，PCM 100% 丢失
        const bufferedChunks = bargeinBufferRef.current.slice()
        bargeinBufferRef.current = []
        resetTranscriptAccumulation()
        setInterimText('')

        const wsUrl = wsUrlRef.current
        if (!wsUrl) {
          // 尚未连接过，走通用路径
          connectCloudWs()
          return
        }

        createAsrWs(wsUrl, (ws) => {
          // TTS 恢复重连：把预缓冲的历史音频一次性发出，补回 TTS 播放期间说的内容
          for (const chunk of bufferedChunks) {
            if (ws.readyState === WebSocket.OPEN) ws.send(chunk.buffer)
          }
        }, false) // useReconnectGuard=false：简单重连，不计数
      } else {
        bargeinBufferRef.current = []
        // B5: 与 fromBargein 分支一致——恢复时清空未发送的已提交累积。旧实现 else 分支
        // 不 reset,TTS 前未及自动发送的已提交文本残留,恢复后与用户新语句拼接重复发送。
        resetTranscriptAccumulation()
        setInterimText('')
        // 2026-08-15 S3: suspendForTTS 已不再关 WS——仍 OPEN 则直接复用,跳过
        // 重建(config 帧+云端会话握手)。WS 已死(错误/手动关闭)才走重连。
        if (asrWsRef.current && asrWsRef.current.readyState === WebSocket.OPEN) {
          console.log('[VoiceSession] resumeSession 复用现有 ASR WS(常开保活, 不重建)')
        } else {
          connectCloudWs()
        }
      }

      if (activeRef.current) updateState('listening')

      // 2026-08-03: TTS 播完恢复 ASR → 再暂停 KWS（mic 归 ASR）
      try { window.electronAPI?.wake?.setMicEnabled?.(false) } catch (e) { console.warn('[ASR] resume 暂停 KWS 失败:', e) }
    }

    // 2026-08-08(A1): suspendForTTS 已 stopMic(TTS 期间 mic 归 KWS 独占)——恢复时
    // 先重建采集再连 WS。异步链 startMic → finishResume;失败报可见错误。
    if (activeRef.current && !captureNodeRef.current) {
      const abort = new AbortController()
      abortRef.current = abort
      startMic(abort.signal).then(micOk => {
        if (abort.signal.aborted) return
        if (!micOk) {
          console.error('[ASR] TTS 结束后麦克风重建失败')
          onError?.('TTS 结束后麦克风恢复失败')
          return
        }
        finishResume()
      })
      return
    }
    finishResume()
  }, [connectCloudWs, handleAsrMessage, commitPendingInterim, resetTranscriptAccumulation, setInterimText, updateState, startMic, onError])

  // ── 向云端 ASR 请求立即给最终结果（对标 CrabPaw voice-core.js flushAsr） ──
  // V2: 使用 flush_speech_final 确保后端将最后一段标记为 speechFinal
  // PTT 松手 / 停止会话时调用，让 ASR 立即 flush 当前 buffer 中的部分识别结果
  const flushAsr = useCallback(() => {
    try {
      const ws = asrWsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        // V2: 使用 flush_speech_final 替代 flush，确保最后一段被标记为 speechFinal
        ws.send(JSON.stringify({ type: 'flush_speech_final' }))
        console.log('[VoiceSession] flushAsr: sent flush_speech_final to ASR server')
      }
    } catch (e) {
      console.warn('[VoiceSession] flushAsr failed:', e)
    }
  }, [])

  // ── PTT 分层控制 ──
  const pttStart = useCallback(() => {
    pttHoldingRef.current = true
    setInterimText('')

    if (isSuspendedForTTsRef.current) {
      // 2026-08-03: TTS 播放中按空格 → 先打断 TTS 再恢复 ASR。
      // 此前只 resumeSession——TTS 继续播 + ASR 录到 TTS 回声 → 用户感觉"无法打断"
      try {
        if ((window as any).__ttsActive && typeof (window as any).__voiceInterruptTTS === 'function') {
          ;(window as any).__voiceInterruptTTS(true)
        }
      } catch (e) { console.warn('[VoiceSession] PTT 打断 TTS 失败:', e) }
      resumeSession(true)
    } else if (!activeRef.current) {
      // 2026-08-07: 防御性 .catch——startSession 内部已消化 rejection,此处兜底
      startSession().catch(e => console.warn('[VoiceSession] PTT 启动会话失败:', e))
    }
  }, [resumeSession, startSession])

  const pttEnd = useCallback(async ({ send = true } = {}) => {
    pttHoldingRef.current = false

    if (!send) return

    // 对标 CrabPaw voice-ptt.js: 先 flush ASR，等最终结果后再发送
    // 这修复了 PTT 松手丢最后几个字的问题
    flushAsr()
    // B5: 等 ~300ms 让 flush_speech_final 的尾段(最后 ~200ms 语音)到达并更新累积,
    // 再发送——旧实现同步立即发送,flush 最终结果必落进 transcriptSuppress 窗口被丢弃
    // → PTT 松手丢尾字(数据丢失)。300ms 足够本地 WS 往返,不显著增加感知延迟。
    await new Promise(r => setTimeout(r, 300))
    // 2026-08-07: 移除尾行 2000ms suppress——sendRecognizedVoiceText 内部已置
    // 1500ms 抑制窗,此处再覆盖为双重抑制(审查报告 P3 轻微项);1500ms 足够
    // 吞掉 WS 关闭前的尾随 final
    sendRecognizedVoiceText()
  }, [flushAsr, sendRecognizedVoiceText])

  // ── 发送当前文本 ──
  const sendCurrentText = useCallback(() => {
    sendRecognizedVoiceText()
  }, [sendRecognizedVoiceText])

  // ── 设置语言 ──
  // ── 转录抑制（TTS 开始播放时同步调用，不等 React 渲染） ──
  const suppressTranscripts = useCallback((ms: number) => {
    transcriptSuppressUntilRef.current = Date.now() + ms
    // V10 fix: 抑制期间只清空 interim 文本，不重置已提交的转录累积
    pendingInterimRef.current = ''
    setInterimText('')
  }, [])

  /** V10 fix: 清除转录抑制 — TTS 播放结束/中断时调用，防止 ASR 持续静默 */
  const clearTranscriptSuppress = useCallback(() => {
    transcriptSuppressUntilRef.current = 0
  }, [])

  /** P1 修复: 丢弃当前累积文本(不发消息)——PTT 失焦/非主动松手用。
   *  区别于 sendCurrentText(清空并发送),本方法仅清空累积、抑制尾随转录。 */
  const discardCurrentText = useCallback(() => {
    committedRef.current = []
    pendingInterimRef.current = ''
    lockedPrefixRef.current = ''
    lastObservedTranscriptRef.current = ''
    setInterimText('')
    transcriptSuppressUntilRef.current = Date.now() + 1500
  }, [])

  const setLang = useCallback((lang: string) => { langRef.current = lang }, [])

  // ── Voice-Media Coordination ──
  const [mediaActive, setMediaActive] = useState(false)

  const suspendForMedia = useCallback(() => {
    // 2026-08-15 S8/S3: 媒体播放挂起改为 stopMic + WS 常开(suspendShared 已改,
    // 不再拆 WS)——喇叭声不进麦克风(防连续模式幻听转写), 结束时复用现有连接
    suspendShared(false)
    updateState('media_paused')
  }, [suspendShared, updateState])

  const resumeAfterMedia = useCallback(() => {
    // 2026-08-15 S3: WS 常开——仅重建采集复用现有连接; WS 已死才重连
    updateState('idle')
    if (suspendKeepaliveRef.current != null) {
      clearInterval(suspendKeepaliveRef.current)
      suspendKeepaliveRef.current = null
    }
    if (asrWsRef.current && asrWsRef.current.readyState === WebSocket.OPEN) {
      isSuspendedForTTsRef.current = false
      if (activeRef.current && !captureNodeRef.current) {
        const abort = new AbortController()
        abortRef.current = abort
        startMic(abort.signal).then(micOk => {
          if (abort.signal.aborted) return
          if (!micOk) onError?.('媒体播放后麦克风恢复失败')
        })
      }
    } else {
      isSuspendedForTTsRef.current = false
      connectCloudWs()
    }
  }, [connectCloudWs, updateState, startMic, onError])

  // ── 清理 ──
  useEffect(() => {
    return () => {
      setActive(false)
      if (watchdogTimerRef.current) clearInterval(watchdogTimerRef.current)
      if (listeningStateTimerRef.current) { clearTimeout(listeningStateTimerRef.current); listeningStateTimerRef.current = null }
      // 2026-08-15 修复: 卸载清理未清 suspendKeepaliveRef——挂起中(媒体/TTS)卸载时
      // 3.5s 保活 interval 泄漏, 继续向已关闭 WS 发送静音帧
      if (suspendKeepaliveRef.current != null) { clearInterval(suspendKeepaliveRef.current); suspendKeepaliveRef.current = null }
      abortRef.current?.abort()
      stopMic()
      diagStop() // B5: 卸载清理诊断定时器,防泄漏(每 3s 打日志)
      try { asrWsRef.current?.close() } catch { console.warn('[ASR] WS 关闭失败(component unmounting)') }
    }
  }, [setActive, stopMic])

  return {
    state,
    isActive,
    isContinuous: continuousEnabledRef.current,
    interimText,
    startSession,
    stopSession,
    suspendForTTS,
    releaseMicForPtt,
    restoreMicAfterPtt,
    resumeSession,
    pttStart,
    pttEnd,
    pttHolding: pttHoldingRef.current,
    flushAsr,
    sendCurrentText,
    discardCurrentText,
    getText: committedText,
    suppressTranscripts,
    clearTranscriptSuppress,
    setLang,
    suspendForMedia,
    resumeAfterMedia,
    mediaActive,
    setMediaActive,
  }
}
