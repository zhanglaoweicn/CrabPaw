/**
 * usePushToTalk — 按住空格/按钮说话（实时流式 ASR）
 *
 * 采集链路（自主实现）：
 *   getUserMedia → AudioContext(16kHz) → AudioWorkletNode（Int16 转换 + 分块）
 *   → WebSocket /voice/cloud → 后端代理 → 云端 ASR
 *   ← 实时返回中间识别结果（interimText）
 *   → 按键释放 → flush → 最终结果 → 回调
 *
 * 健壮性机制（自主实现）：
 *   1. 自动重连 — WS 断开后 800ms 重连，cloudWsIntentional 标记避免主动关闭触发
 *   2. 看门狗 — 3.5s 无转录但用户在说话 → 强制断连触发重连
 *   3. 重连缓冲 — WS 断连期间 PCM 暂存 reconnectBuffer，连上后补发（上限 ~8s）
 *   4. commitPendingInterim — 重连前提级保存 interim，避免前半句丢失
 *   5. transcriptSuppressUntil — PTT 发送后吞尾随 final
 *   6. 诊断日志 — chunks/s, kB/s, maxGap, reconnects, sinceTx 等
 *
 * 优先使用 AudioWorkletNode（独立音频线程，低延迟），回退 ScriptProcessorNode。
 */

import { useState, useRef, useCallback, useEffect } from 'react'
import { getAuthenticatedWsUrl } from '../lib/api'
import { createCaptureNode, computeVol, PCM_CHUNK_SAMPLES } from '../lib/audio-capture'
// 2026-09-05 PTT 识别差深度优化: 语音增强共享件(HPF+AGC)——与连续语音管线
// 同源同参, 消除双管线增益/滤波差异
import { createHighPass, createAgcBoost } from '../lib/voice-enhance'
// 2026-08-14: 静音门控(与 useVoiceSession 同款 SilenceGate——连续 8 块静音丢弃)
import { SilenceGate } from '../lib/audio-silence'

interface UsePushToTalkOptions {
  onResult?: (text: string) => void
  onError?: (err: string) => void
  /** 录音最长时间（毫秒），默认 15s */
  maxDuration?: number
  /** 指定麦克风设备 ID（从配置加载，精确匹配） */
  micDeviceId?: string
}

interface UsePushToTalkReturn {
  isRecording: boolean
  isProcessing: boolean
  /** 实时识别的中间文本（录音过程中持续更新） */
  interimText: string
  recordingDuration: number
  error: string | null
  /** 直接触发麦克风采集（按钮 mousedown） */
  startRecording: () => Promise<void>
  /** 停止采集并提交 ASR（按钮 mouseup） */
  stopRecording: () => void
  /** 放弃本次录音（拖出按钮区域） */
  cancelRecording: () => void
  /** 兼容 keyboard 模式: 绑定 keydown/keyup */
  supported: boolean
}

/** 重连预缓冲上限 ≈8s，防长断连无限堆积 */
const RECONNECT_MAX_CHUNKS = Math.ceil(8000 * 16000 / 1000 / PCM_CHUNK_SAMPLES)

/** 看门狗：仍在说却这么久没转录 → 判定停滞，强制重连 */
const STALL_RECONNECT_MS = 3500

/** 判定「人在说话」的音量阈值（RMS） */
const WATCHDOG_SPEECH_VOL = 0.05

/** WS 断开后自动重连延迟 */
const RECONNECT_DELAY_MS = 800

/** PTT 发送后吞尾随 final 的时间窗口 */
const SUPPRESS_TRAILING_MS = 1500

/** flush 等待最终结果的超时时间（2026-08-15 S9: 1500→600——final 通常 100-300ms
 * 内到达, 松手后 1.5s 等待是多余的可感知延迟） */
const FLUSH_TIMEOUT_MS = 600

export function usePushToTalk(options: UsePushToTalkOptions = {}): UsePushToTalkReturn {
  const { onResult, onError, maxDuration = 15000, micDeviceId } = options

  const [isRecording, setIsRecording] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Refs — 采集
  const streamRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const captureNodeRef = useRef<AudioNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 静音流自愈定时器(P1) */
  const healTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recordingRef = useRef(false)
  const startTimeRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const frameCountRef = useRef(0)

  // Refs — WebSocket 流式 ASR
  const wsRef = useRef<WebSocket | null>(null)
  const wsReadyRef = useRef(false)
  /** 重连缓冲：WS 断连期间暂存 PCM，连上后补发（上限 RECONNECT_MAX_CHUNKS） */
  const reconnectBufferRef = useRef<Int16Array[]>([])
  /** 段落去重 Map: seg → text（与后端 segMap 逻辑一致） */
  const segMapRef = useRef<Map<string, string>>(new Map())
  /** flush 后等待最终结果的 resolve */
  const flushResolveRef = useRef<((text: string) => void) | null>(null)
  /** 标记 WS 是否为主动关闭（避免 onclose 触发重连） */
  const wsIntentionalCloseRef = useRef(false)

  // Refs — 自动重连
  /** 重连定时器 */
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Refs — 看门狗
  /** 看门狗定时器 */
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 最近收到转录的时刻（Date.now） */
  const lastInboundTsRef = useRef(0)
  /** 最近听到人声级音量的时刻（Date.now，sendPcm 写） */
  const lastLoudTsRef = useRef(0)

  // Refs — commitPendingInterim
  /** 重连前已识别的前半句文本（重连后新会话的 seg 会重新计数，前半句需冻结保住） */
  const prefixTextRef = useRef('')

  // Refs — transcriptSuppressUntil
  /** PTT 发送后吞尾随 final 的截止时刻（Date.now() + ms） */
  const transcriptSuppressUntilRef = useRef(0)

  // Refs — 诊断
  // B4: PTT 会话 token——快速"松手再按"时旧 flush 尚未完成,其 finishProcessing
  // 不得影响新录音(否则吞掉新录音开头转录/置错 isProcessing)。startRecording/
  // cancelRecording 递增 token,旧 flush 完成时检查 token 失效则丢弃。
  const pttSessionRef = useRef(0)
  // R1: PTT 启动意图标记——startRecording 开头置 true(WS 可能在 getUserMedia 前就
  // open),onopen 用"启动中或正在录"判定,避免 B4 的 recordingRef 时序误杀正常录音
  const startPendingRef = useRef(false)
  const diagTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const diagChunksRef = useRef(0)
  const diagBytesRef = useRef(0)
  const diagMaxGapMsRef = useRef(0)
  const diagLastChunkTsRef = useRef(0)
  const diagTranscriptsRef = useRef(0)
  const diagLastTranscriptTsRef = useRef(0)
  const diagReconnectsRef = useRef(0)

  // 麦克风设备 ID ref
  const micDeviceIdRef = useRef(micDeviceId)
  useEffect(() => { micDeviceIdRef.current = micDeviceId }, [micDeviceId])

  // ── 语音配置(provider/lang)——config 帧不再硬编码 ──
  // 2026-08-14: 此前硬编码 provider:'volcengine',lang:'zh' 与用户 Settings 选择脱节。
  // IPC 优先、HTTP 兜底,读取失败用默认;'config-updated-voice' 事件时刷新缓存
  // (与 VoiceShell 配置单源化同口径:config.json voice 段为唯一来源)。
  const asrCfgRef = useRef({ provider: 'volcengine', lang: 'zh' })
  const asrCfgLoadedRef = useRef(false)
  const loadAsrCfg = useCallback(async () => {
    if (asrCfgLoadedRef.current) return
    try {
      let cfg: any = null
      try {
        if (window.electronAPI?.config?.get) cfg = await window.electronAPI.config.get()
      } catch (e) { console.warn('[PTT] IPC 读取配置失败,降级 HTTP:', e) }
      if (!cfg) {
        const { apiGet } = await import('../lib/api')
        const res = await apiGet('/config')
        if (res?.success && res?.data) cfg = res.data
      }
      const v = cfg?.voice as Record<string, unknown> | undefined
      if (v) {
        if (typeof v.asrProvider === 'string' && v.asrProvider) asrCfgRef.current.provider = v.asrProvider
        if (typeof v.lang === 'string' && v.lang) asrCfgRef.current.lang = v.lang
      }
    } catch (e) {
      console.warn('[PTT] 语音配置读取失败,使用默认 provider/lang:', e)
    }
    asrCfgLoadedRef.current = true
  }, [])
  useEffect(() => {
    void loadAsrCfg()
    const refresh = () => { asrCfgLoadedRef.current = false; void loadAsrCfg() }
    window.addEventListener('config-updated-voice', refresh)
    return () => window.removeEventListener('config-updated-voice', refresh)
  }, [loadAsrCfg])

  // 静音门控(每轮录音重建——ref 惰性持有,8 块≈1s 连续静音后丢弃)
  const pttSilenceGateRef = useRef<SilenceGate | null>(null)
  // 2026-09-05 PTT 识别差深度优化: HPF+AGC 共享处理器(每管线一个实例——跨帧保持状态)
  const hpfRef = useRef(createHighPass())
  const agcRef = useRef(createAgcBoost())

  // 检查浏览器是否支持
  const supported = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices
    && !!navigator.mediaDevices.getUserMedia

  // ─── 诊断函数 ───
  const diag = (tag: string, info?: string) => {
    console.log('[asr-diag] ' + tag, info ?? '')
  }

  const diagNoteChunk = (byteLen: number) => {
    diagChunksRef.current++
    diagBytesRef.current += byteLen
    const now = performance.now()
    if (diagLastChunkTsRef.current) {
      const gap = now - diagLastChunkTsRef.current
      if (gap > diagMaxGapMsRef.current) diagMaxGapMsRef.current = gap
    }
    diagLastChunkTsRef.current = now
  }

  const diagNoteTranscript = () => {
    diagTranscriptsRef.current++
    diagLastTranscriptTsRef.current = performance.now()
  }

  const diagStart = () => {
    if (diagTimerRef.current) return
    diagLastChunkTsRef.current = 0
    diagMaxGapMsRef.current = 0
    diagChunksRef.current = 0
    diagBytesRef.current = 0
    diagTranscriptsRef.current = 0
    diagLastTranscriptTsRef.current = 0
    diagReconnectsRef.current = 0
    diagTimerRef.current = setInterval(() => {
      const sinceTx = diagLastTranscriptTsRef.current
        ? (performance.now() - diagLastTranscriptTsRef.current).toFixed(0)
        : 'na'
      console.log('[asr-diag] chunks/s=' + (diagChunksRef.current / 3).toFixed(1)
        + ' kB/s=' + (diagBytesRef.current / 1024 / 3).toFixed(1)
        + ' maxGap=' + diagMaxGapMsRef.current.toFixed(0) + 'ms'
        + ' reconnects=' + diagReconnectsRef.current
        + ' ws=' + (wsRef.current ? wsRef.current.readyState : 'null')
        + ' tx=' + diagTranscriptsRef.current
        + ' sinceTx=' + sinceTx + 'ms'
        + ' reconBuf=' + reconnectBufferRef.current.length)
      diagChunksRef.current = 0
      diagBytesRef.current = 0
      diagMaxGapMsRef.current = 0
    }, 3000)
  }

  const diagStop = () => {
    if (diagTimerRef.current) {
      clearInterval(diagTimerRef.current)
      diagTimerRef.current = null
    }
    diagLastChunkTsRef.current = 0
    diagReconnectsRef.current = 0
    diagTranscriptsRef.current = 0
    diagLastTranscriptTsRef.current = 0
  }

  // ─── 看门狗 ───
  const startWatchdog = () => {
    if (watchdogTimerRef.current) return
    lastInboundTsRef.current = Date.now()
    watchdogTimerRef.current = setInterval(() => {
      if (!recordingRef.current) return
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return // 重连窗口内不判
      const now = Date.now()
      // 仍在说（最近 1.2s 内有人声级音量）但超过 STALL_RECONNECT_MS 没收到转录 → 强制重连
      if (now - lastLoudTsRef.current < 1200 && now - lastInboundTsRef.current > STALL_RECONNECT_MS) {
        diag('watchdog: stalled → force reconnect', 'sinceTx=' + (now - lastInboundTsRef.current) + 'ms')
        lastInboundTsRef.current = now // 防重连窗口内重复触发
        try { ws.close() } catch (e) {
          console.error('[PTT] 看门狗关闭 WebSocket 失败:', e)
        } // onclose(!intentional) → commitPendingInterim + 重连
      }
    }, 1000)
  }

  const stopWatchdog = () => {
    if (watchdogTimerRef.current) {
      clearInterval(watchdogTimerRef.current)
      watchdogTimerRef.current = null
    }
    lastInboundTsRef.current = 0
    lastLoudTsRef.current = 0
  }

  /** 收集去重后的完整文本（含重连前冻结的前半句） */
  const collectText = () => {
    // B4: numeric:true 排序——数字型 seg id('0','1','10','2')用默认 localeCompare 会排成
    // 1,10,2...,分段数>9 时转录文本顺序错乱。numeric 按数值排序恢复时间序。
    const segments = Array.from(segMapRef.current.entries())
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    const segText = segments.map(([, text]) => text).join('')
    return prefixTextRef.current + segText
  }

  /**
   * 重连前兜底：把当前已识别的文本提级冻结，避免重连后新会话的尾巴 final 覆盖丢失。
   * 新会话 begin_time 重新计数，seg 不会与历史句撞车，尾巴会作为新句追加在前半句之后。
   */
  const commitPendingInterim = () => {
    const text = collectText()
    if (text && text.trim()) {
      prefixTextRef.current = text
      segMapRef.current.clear()
      diag('commitPendingInterim', 'frozen text: (' + text.length + ' chars)')
    }
  }

  /** 连接 WebSocket 并设置消息处理 */
  const connectWS = useCallback(async () => {
    // 2026-08-14: config 帧 provider/lang 取真实配置——挂载时已预取(loadAsrCfg),
    // 此处 await 兜底覆盖"刚挂载立即按 PTT"的竞态(已加载则立即返回)
    await loadAsrCfg()
    // 鉴权修复: /voice/cloud 要求 API token（与 useVoiceSession 一致），
    // getAuthenticatedWsUrl 在 Electron 态经 api:streamUrl 注入 token、浏览器态拼 token 查询参数
    const wsUrl = await getAuthenticatedWsUrl('/voice/cloud')
    console.log('[PTT] 连接 WebSocket:', wsUrl)

    // B4: 建新 WS 前关掉旧 WS——旧实现遗留孤儿连接(getUserMedia 被拒/多次 start 失败
    // 时旧 WS 仍连,累积无主连接 + 内存泄漏)
    const prevWs = wsRef.current
    if (prevWs && prevWs.readyState === WebSocket.OPEN || prevWs && prevWs.readyState === WebSocket.CONNECTING) {
      wsIntentionalCloseRef.current = true
      try { prevWs.close() } catch (e) {
        /* best-effort */
        console.warn('[usePushToTalk.ts] 空 catch 补日志:', e instanceof Error ? e.message : e);
      }

    }
    wsReadyRef.current = false
    wsIntentionalCloseRef.current = false
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
        if (wsRef.current !== ws) return
        // R1: 用"启动意图"判定(修正 B4 时序误杀)——startRecording 是异步的,
        // getUserMedia/AudioContext 之后才设 recordingRef=true,而 WS 在之前就发起,
        // 故 WS open 时 recordingRef 可能仍 false(但录音正要开始)。用 startPending
        // 标记意图;仅当"既非启动中又非正在录"(启动已失败/已取消)才作废关闭。
        if (!startPendingRef.current && !recordingRef.current) {
        wsIntentionalCloseRef.current = true
        try { ws.close() } catch (e) {
          /* best-effort */
          console.warn('[usePushToTalk.ts] 空 catch 补日志:', e instanceof Error ? e.message : e);
        }
        if (wsRef.current === ws) wsRef.current = null
        wsReadyRef.current = false
        console.log('[PTT] WS 已连接但录音未进行,主动关闭')
        return
      }
      console.log('[PTT] WebSocket 已连接，发送 config 帧')
      // 2026-08-14: 发送配置帧——provider/lang 从真实语音配置读取(见 loadAsrCfg:
      // IPC 优先/HTTP 兜底/缺省 volcengine+zh),后端凭 provider 读取对应凭证
      const { provider, lang } = asrCfgRef.current
      ws.send(JSON.stringify({ type: 'config', provider, lang }))
      wsReadyRef.current = true
      // 看门狗：（重）连后给一个新鲜起点，避免连上瞬间误判停滞
      lastInboundTsRef.current = Date.now()

      // 补发重连死区里暂存的音频，避免断连期间说的话丢失
      if (reconnectBufferRef.current.length > 0) {
        console.log('[PTT] 补发重连缓冲:', reconnectBufferRef.current.length, '块')
        for (const chunk of reconnectBufferRef.current) {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk.buffer)
        }
        reconnectBufferRef.current = []
      }
    }

    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'transcript') {
          const text = (msg.text || '').trim()
          if (!text) return
          diagNoteTranscript()
          // 看门狗：刷新「最近收到转录」时刻
          lastInboundTsRef.current = Date.now()

          // PTT 刚发过这条话 → flush 的尾随 final 属于同一句，吞掉避免二次处理
          if (Date.now() < transcriptSuppressUntilRef.current) {
            console.log('[PTT] 吞尾随 transcript（suppress 窗口内）')
            return
          }

          const seg = (msg.seg === undefined || msg.seg === null) ? 'default' : msg.seg
          // 同一段落只保留最新文本（流式 ASR 增量更新）
          segMapRef.current.set(seg, text)
          // 更新实时显示
          const full = collectText()
          setInterimText(full)
          console.log('[PTT] 转录[%s] %s: (%d chars)', seg, msg.is_final ? 'final' : 'interim', text.length)
        } else if (msg.type === 'error') {
          console.error('[PTT] ASR 错误:', msg.message)
          setError(msg.message || 'ASR 错误')
          onError?.(msg.message || 'ASR 错误')
        } else if (msg.type === 'diag') {
          console.log('[PTT] 诊断:', msg.event, msg.info || '')
        }
      } catch (e) {
        console.error('[PTT] WebSocket 消息解析失败:', e)
      }
    }

    ws.onerror = (e) => {
      if (wsRef.current !== ws) return
      console.error('[PTT] WebSocket 错误:', e)
      if (!wsIntentionalCloseRef.current) {
        setError('语音识别连接失败')
        onError?.('语音识别连接失败')
      }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return // 已被新连接取代，忽略旧连接的 close 事件
      console.log('[PTT] WebSocket 已关闭')
      wsRef.current = null
      wsReadyRef.current = false

      // 自动重连：非主动断开（超时/网络抖动）且用户仍在录音 → 800ms 后重连
      if (!wsIntentionalCloseRef.current && recordingRef.current) {
        diagReconnectsRef.current++
        diag('ws-closed → reconnect in ' + RECONNECT_DELAY_MS + 'ms', 'reconnects=' + diagReconnectsRef.current)
        // 先把当前句未定稿的前半句提级保住，否则新会话只 finalize 尾巴会覆盖丢失
        commitPendingInterim()
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          if (recordingRef.current) {
            connectWS().catch(e => console.warn('[PTT] 自动重连异常:', e))
          }
        }, RECONNECT_DELAY_MS)
      } else {
        // 主动关闭或已停止录音：如果 flush 正在等待，用已收到的文本 resolve
        if (flushResolveRef.current) {
          const text = collectText()
          flushResolveRef.current(text)
          flushResolveRef.current = null
        }
      }
    }
  }, [onError, loadAsrCfg])

  /** 发送 PCM 块到 WebSocket（未连接时暂存到重连缓冲） */
  const sendPcm = (pcm: Int16Array) => {
    // 诊断：记录块大小
    diagNoteChunk(pcm.byteLength)

    // 看门狗：记录最近一次人声级音量的时刻
    const vol = computeVol(pcm)
    if (vol > WATCHDOG_SPEECH_VOL) {
      lastLoudTsRef.current = Date.now()
    }

    // 2026-08-14: 静音门控——此前每帧全送(128ms/块),按住不说话也持续烧 API 配额。
    // 与 useVoiceSession 同款 SilenceGate:连续 8 块(~1s)静音丢弃,语音块立即放行;
    // 在发送前判定(用原始信号,与 useVoiceSession"AGC 之前判定"语义一致)。
    if (!pttSilenceGateRef.current) pttSilenceGateRef.current = new SilenceGate(8)
    if (pttSilenceGateRef.current.shouldDrop(pcm)) return

    // 2026-09-05 PTT 识别差深度修复: 发送前 HPF(滤低频隆隆)→ 软件 AGC(弱信号
    // 放大到目标 RMS)——此前 PTT 无任何增强,弱麦原始信号直发 ASR 导致识别差
    // (实时模式有 boostInt16 故正常)。静音判定保持用原始信号(AGC 会放大噪声
    // 污染门控)。
    pcm = agcRef.current.process(hpfRef.current.process(pcm))

    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      // 2026-08-07: ws.send 加 try/catch——WS 竞态下(如 close 处理中 onFrame 仍在途)
      // send 抛 InvalidStateError 会中断采集循环且无日志(审查报告 P3 轻微项)
      try {
        ws.send(pcm.buffer)
      } catch (e) {
        console.warn('[PTT] PCM 发送失败(转重连缓冲):', e)
        // 发送失败等同 WS 不可用: 转入重连缓冲,onopen 时补发
        reconnectBufferRef.current.push(pcm)
        if (reconnectBufferRef.current.length > RECONNECT_MAX_CHUNKS) {
          reconnectBufferRef.current.shift()
        }
      }
    } else {
      // WS 重连死区：暂存音频，连上后由 onopen 补发，绝不丢字
      reconnectBufferRef.current.push(pcm)
      if (reconnectBufferRef.current.length > RECONNECT_MAX_CHUNKS) {
        reconnectBufferRef.current.shift() // 上限保护，防长断连无限堆积
      }
    }
  }

  /** 开始录音 */
  const startRecording = useCallback(async () => {
    if (recordingRef.current) return
    // B4: 领取新会话 token——使上一次 stopRecording 仍在等待的 flush 失效
    pttSessionRef.current++
    // R1: 标记启动中——WS 可能在采集就绪前 open,onopen 以此判定录音意图
    startPendingRef.current = true
    setError(null)
    setInterimText('')
    segMapRef.current.clear()
    reconnectBufferRef.current = []
    prefixTextRef.current = ''
    transcriptSuppressUntilRef.current = 0
    frameCountRef.current = 0
    pttSilenceGateRef.current = null // 每轮录音重建静音门控(上轮静音计数清零)
    lastLoudTsRef.current = 0 // P1: 静音流自愈判定的电平基准归零

    // 清理可能残留的重连定时器
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    // 准备中止信号
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    // 2026-09-03 修复(面板打开后 PTT 录到静音): KWS probe 暂停竞态已改由上层
    // releaseMicForPtt 的可等待 ack 消除(VoiceIntegration await 确认后才调本函数),
    // 此处不再需要盲等;600ms 静音流自愈保留作兜底。

    try {
      // 1. 连接 WebSocket（异步，不阻塞麦克风采集）
      connectWS().catch(e => console.warn('[PTT] WebSocket 连接异常:', e))

      // 2. 获取麦克风
      // P5(GUI 全量修复): 删除 __releaseMicForSession 死调用——该全局键无任何
      // 写入方(会议转录 useMeetingTranscription 未接线, 审计孤儿键), 调用恒静默 no-op
      const deviceId = micDeviceIdRef.current
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 16000,
      }
      if (deviceId) {
        audioConstraints.deviceId = { exact: deviceId }
      }
      console.log('[PTT] 请求麦克风, deviceId=', deviceId || '(默认设备)')
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      } catch (e1: any) {
        if (deviceId && e1?.name !== 'NotAllowedError' && e1?.name !== 'SecurityError') {
          console.warn('[PTT] 指定麦克风失败，回退到默认设备:', e1.message)
          const fallbackConstraints = { ...audioConstraints }
          delete fallbackConstraints.deviceId
          stream = await navigator.mediaDevices.getUserMedia({ audio: fallbackConstraints })
        } else {
          throw e1
        }
      }
      if (abort.signal.aborted) { stream.getTracks().forEach(t => t.stop()); return }
      streamRef.current = stream

      // 3. AudioContext @ 16kHz —— 2026-08-07: 缓存复用(审查报告 P3 轻微项)。
      // 旧实现每次录音 new + 卸载/清理时 close,快速按放 PTT 时反复创建/销毁
      // 音频线程(百 ms 级开销 + 内存抖动);首个会话创建后缓存,组件卸载时统一关闭
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext({ sampleRate: 16000 })
      }
      const audioCtx = audioCtxRef.current
      await audioCtx.resume()
      console.log('[PTT] AudioContext sampleRate:', audioCtx.sampleRate, '(期望 16000)')
      if (abort.signal.aborted) { stream.getTracks().forEach(t => t.stop()); return }
      const source = audioCtx.createMediaStreamSource(stream)
      sourceRef.current = source

      // 4. 创建采集节点 — onFrame 收到 Int16Array 块，直接发 WS
      const onFrame = (i16: Int16Array) => {
        if (!recordingRef.current) return
        frameCountRef.current++
        sendPcm(i16)
      }

      const captureNode = await createCaptureNode(audioCtx, source, onFrame, abort.signal)
      if (abort.signal.aborted) {
        captureNode.disconnect()
        // 2026-08-07: 不再 close audioCtx——缓存复用,卸载时统一关闭
        stream.getTracks().forEach(t => t.stop())
        return
      }
      captureNodeRef.current = captureNode

      recordingRef.current = true
      startPendingRef.current = false // R1: 采集就绪,清除启动意图标记
      setIsRecording(true)
      startTimeRef.current = Date.now()
      setRecordingDuration(0)

      // 启动看门狗 + 诊断
      startWatchdog()
      diagStart()

      // 2026-09-03 静音流自愈(P1): 开录 600ms 全程零电平 → 大概率仍与 KWS/会话
      // 抢麦拿到哑流(宽限期也不够时) → 断开重开一次采集链,用户无感。仅自愈一次。
      let healedOnce = false
      const healTimer = setTimeout(async () => {
        try {
          if (!recordingRef.current || abort.signal.aborted || healedOnce) return
          if (lastLoudTsRef.current !== 0) return // 有过声音电平,流健康
          healedOnce = true
          console.warn('[PTT] 检测到静音流(600ms 零电平),自愈重开采集链')
          captureNodeRef.current?.disconnect()
          sourceRef.current?.disconnect()
          streamRef.current?.getTracks().forEach(t => t.stop())
          const stream2 = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
          if (abort.signal.aborted) { stream2.getTracks().forEach(t => t.stop()); return }
          streamRef.current = stream2
          const source2 = audioCtx.createMediaStreamSource(stream2)
          sourceRef.current = source2
          const node2 = await createCaptureNode(audioCtx, source2, onFrame, abort.signal)
          if (abort.signal.aborted) { node2.disconnect(); stream2.getTracks().forEach(t => t.stop()); return }
          captureNodeRef.current = node2
          console.log('[PTT] 静音流自愈完成,采集链已重建')
        } catch (e: any) {
          console.warn('[PTT] 静音流自愈失败(继续原链):', e?.message || e)
        }
      }, 600)
      healTimer.unref?.()
      healTimerRef.current = healTimer

      // 计时器
      durationTimerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }, 200)

      // 最长录音限制
      maxTimerRef.current = setTimeout(() => {
        if (recordingRef.current) stopRecording()
      }, maxDuration)

    } catch (e: any) {
      const msg = e.name === 'NotAllowedError'
      ? '麦克风权限被拒绝'
      : e.name === 'NotFoundError'
      ? '未找到麦克风设备'
      : e.name === 'NotReadableError'
      ? '麦克风被其他应用占用'
      : `麦克风启动失败: ${e.message}`
      setError(msg)
      onError?.(msg)
      cleanup()
      startPendingRef.current = false // R1: 启动失败,清除启动意图
      // B4: 启动失败也关掉已建立的 WS——connectWS 是 fire-and-forget,可能已连上。
      // recordingRef 仍为 false,connectWS.onopen 的录音状态检查(见下)也会兜底关闭。
      wsIntentionalCloseRef.current = true
      const ws = wsRef.current
      if (ws) {
      try { ws.close() } catch (e) {
        /* best-effort */
        console.warn('[usePushToTalk.ts] 空 catch 补日志:', e instanceof Error ? e.message : e);
      }
      wsRef.current = null
    }
      wsReadyRef.current = false
    }
  }, [maxDuration, onError, connectWS])

  /** 停止录音 → flush → 等待最终结果 */
  const stopRecording = useCallback(() => {
    if (!recordingRef.current) {
      // P1(Runtime优化轮): 宽限期内快速点按——采集还在 150ms 启动延迟中,
      // 中止启动流程,防止孤儿麦克风(开麦后无人叫停,最长挂 15s)
      if (startPendingRef.current) {
        startPendingRef.current = false
        abortRef.current?.abort()
        wsIntentionalCloseRef.current = true
        try { wsRef.current?.close() } catch (e) {
          console.warn('[usePushToTalk.ts] 快速点按关闭 WS 失败:', e instanceof Error ? e.message : e)
        }
        wsRef.current = null
        if (healTimerRef.current) { clearTimeout(healTimerRef.current); healTimerRef.current = null }
      }
      return
    }
    recordingRef.current = false
    startPendingRef.current = false // R1: 停止录音,清除启动意图
    setIsRecording(false)

    if (healTimerRef.current) { clearTimeout(healTimerRef.current); healTimerRef.current = null }

    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }

    // 停止看门狗 + 诊断
    stopWatchdog()
    diagStop()

    // 清理重连定时器
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    // 停止采集
    cleanup()

    // 发送 flush 并等待最终结果
    setIsProcessing(true)
    flushAndResolve()
  }, [onResult, onError])

  /** 发送 flush，等待最终结果，然后关闭 WS */
  const flushAndResolve = async () => {
    // B4: 捕获本会话 token——等待期间若新录音开始/取消,结果作废
    const myToken = pttSessionRef.current
    const ws = wsRef.current

    // 如果 WS 未连接或已关闭，直接用已收到的文本
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('[PTT] WS 未连接，直接使用已收到文本')
      const text = collectText()
      finishProcessing(text, myToken)
      return
    }

    // 发送 flush
    try {
      // V2: 使用 flush_speech_final 确保最后一段被标记为 speechFinal
      // 对齐 useVoiceSession flushAsr 路径，避免 PTT 松手时 ASR 尾部 interim 段未 final 化而丢失
      ws.send(JSON.stringify({ type: 'flush_speech_final' }))
      console.log('[PTT] 已发送 flush_speech_final，等待最终结果...')
    } catch (e) {
      console.error('[PTT] 发送 flush 失败:', e)
    }

    // 等待最终结果 — 设置超时
    const text = await new Promise<string>((resolve) => {
      flushResolveRef.current = resolve
      // 超时：用已收到的文本 resolve
      setTimeout(() => {
        if (flushResolveRef.current) {
          console.log('[PTT] flush 超时(' + FLUSH_TIMEOUT_MS + 'ms)，使用已收到文本')
          flushResolveRef.current(collectText())
          flushResolveRef.current = null
        }
      }, FLUSH_TIMEOUT_MS)
    })

    finishProcessing(text, myToken)
  }

  /** 处理最终结果 */
  const finishProcessing = (text: string, myToken?: number) => {
    // B4: token 失效（新录音开始/用户取消）→ 本结果作废，不产生副作用
    if (myToken !== undefined && myToken !== pttSessionRef.current) {
      console.log('[PTT] finishProcessing 跳过(会话已切换)')
      return
    }
    setIsProcessing(false)
    setInterimText('')

    // 设置 suppress 窗口：吞掉 WS 关闭前可能到达的尾随 final
    transcriptSuppressUntilRef.current = Date.now() + SUPPRESS_TRAILING_MS

    // 关闭 WebSocket
    wsIntentionalCloseRef.current = true
    const ws = wsRef.current
    if (ws) {
      try { ws.close() } catch (e) {
        console.error('[PTT] 关闭 WebSocket 失败:', e)
      }
      wsRef.current = null
    }
    wsReadyRef.current = false

    if (text && text.trim()) {
      console.log('[PTT] 最终结果: (%d chars)', text.length)
      onResult?.(text.trim())
    } else {
      // B4: 空文本仅在"正常录音结束但确实没识别到"时报错；
      // 用户主动 cancelRecording 走 finishProcessing 前的 token 检查被跳过,
      // 不再误报"未能识别到语音内容"(取消≠识别失败)。
      console.warn('[PTT] 无识别结果')
      setError('未能识别到语音内容')
      onError?.('未能识别到语音内容')
    }
  }

  /** 取消录音（放弃） */
  const cancelRecording = useCallback(() => {
    recordingRef.current = false
    startPendingRef.current = false // R1: 取消录音,清除启动意图(迟到的 WS open 会作废)
    // B4: 递增 token 使进行中的 flush 完成时被丢弃——用户主动放弃不应触发
    // "未能识别到语音内容"假错误
    pttSessionRef.current++
    setIsRecording(false)
    setIsProcessing(false)
    setInterimText('')
    segMapRef.current.clear()
    reconnectBufferRef.current = []
    prefixTextRef.current = ''
    transcriptSuppressUntilRef.current = 0
    if (healTimerRef.current) { clearTimeout(healTimerRef.current); healTimerRef.current = null }
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current)
      maxTimerRef.current = null
    }
    // 停止看门狗 + 诊断
    stopWatchdog()
    diagStop()
    // 清理重连定时器
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    cleanup()

    // 关闭 WS
    wsIntentionalCloseRef.current = true
    const ws = wsRef.current
    if (ws) {
      try { ws.close() } catch (e) {
        console.error('[PTT] 取消录音时关闭 WebSocket 失败:', e)
      }
      wsRef.current = null
    }
    wsReadyRef.current = false
  }, [])

  /** 清理采集资源（2026-08-07: 不再关闭 AudioContext——缓存复用,卸载时统一关闭） */
  const cleanup = () => {
    try {
      if (captureNodeRef.current) {
        captureNodeRef.current.disconnect()
        captureNodeRef.current = null
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect()
        sourceRef.current = null
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
    } catch (e) {
      console.error('[PTT] 清理采集资源失败:', e)
    }
  }

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      recordingRef.current = false
      startPendingRef.current = false // R1: 卸载,清除启动意图
      abortRef.current?.abort()
      cleanup()
      if (durationTimerRef.current) clearInterval(durationTimerRef.current)
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current)
      // 停止看门狗 + 诊断
      stopWatchdog()
      diagStop()
      // 清理重连定时器
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      // 关闭 WS
      wsIntentionalCloseRef.current = true
      try { wsRef.current?.close() } catch (e) {
        console.error('[PTT] 组件卸载时关闭 WebSocket 失败:', e)
      }
      // 2026-08-07: 卸载时统一关闭缓存的 AudioContext(录制期间不再 close)
      try { audioCtxRef.current?.close() } catch (e) {
        console.error('[PTT] 组件卸载时关闭 AudioContext 失败:', e)
      }
      audioCtxRef.current = null
    }
  }, [])

  return {
    isRecording,
    isProcessing,
    interimText,
    recordingDuration,
    error,
    supported,
    startRecording,
    stopRecording,
    cancelRecording,
  }
}
