import { useRef, useCallback, useState, useEffect } from 'react'
import { getAuthenticatedWsUrl } from '../lib/api'
import { compareSegmentKeys } from '../lib/compare-segment-keys'

export interface TranscriptSegment {
  id: string
  text: string
  sequenceId: number
  isFinal: boolean
  timestamp: number
  audioStartTime: number
}

interface UseMeetingTranscriptionOptions {
  onTranscript?: (segment: TranscriptSegment) => void
  onError?: (error: string) => void
  onStateChange?: (state: 'idle' | 'starting' | 'recording' | 'stopping' | 'error') => void
  /** MT1: 音量回调，录制期间报告 RMS 音量 (0~1) */
  onVolume?: (volume: number) => void
}

const SAMPLE_RATE = 16000
const PCM_CHUNK_SAMPLES = 4096

const PCM_WORKLET_CODE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._size = (options && options.processorOptions && options.processorOptions.chunk) || 4096;
    this._buf = new Int16Array(this._size);
    this._n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i];
        if (s > 1) s = 1; else if (s < -1) s = -1;
        this._buf[this._n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this._n >= this._size) {
          const out = this._buf.slice(0, this._n);
          this.port.postMessage(out.buffer, [out.buffer]);
          this._n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`.trim()

export function useMeetingTranscription(options: UseMeetingTranscriptionOptions = {}) {
  const { onTranscript, onError, onStateChange, onVolume } = options

  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'stopping' | 'error'>('idle')
  const stateRef = useRef(state)
  const updateState = useCallback((s: typeof state) => {
    stateRef.current = s
    setState(s)
    onStateChange?.(s)
  }, [onStateChange])

  // Audio resources
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const captureNodeRef = useRef<AudioNode | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const wsReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wsReconnectCountRef = useRef(0)
  const wsEverOpenedRef = useRef(false)
  const MAX_RECONNECT = 5

  // Transcription buffering (seg-keyed dedup like usePushToTalk)
  const segMapRef = useRef<Map<string, { text: string; isFinal: boolean }>>(new Map())
  const sequenceCounterRef = useRef(0)
  // 2026-08-19 修复(纪要落库失败根因): 旧实现把全部 seg 合并成一条 emit,
  // isFinal = 所有段都 final —— 只要任一正在说的句子是 partial, 整条 emit 就是
  // partial, 消费者(MeetingPanel)按 isFinal 收集时恒收不到 final 段 → 停止时
  // segments 恒空 → summarize 400「转写内容为空」。
  // 现改为逐段 emit(每段各自 isFinal), emittedMap 记录上次 emit 快照做变化检测。
  const emittedMapRef = useRef<Map<string, string>>(new Map())
  const processTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Recording timer
  const recordingStartRef = useRef(0)

  // ── 语音配置(provider/lang)——config 帧不再硬编码 ──
  // 2026-08-18 恢复自 c1311b5 时对齐 usePushToTalk 同口径：IPC 优先、HTTP 兜底，
  // 默认 volcengine/zh；'config-updated-voice' 事件时刷新缓存。
  const asrCfgRef = useRef({ provider: 'volcengine', lang: 'zh' })
  const asrCfgLoadedRef = useRef(false)
  const loadAsrCfg = useCallback(async () => {
    if (asrCfgLoadedRef.current) return
    try {
      let cfg: any = null
      try {
        if (window.electronAPI?.config?.get) cfg = await window.electronAPI.config.get()
      } catch (e) { console.warn('[MeetingTranscription] IPC 读取配置失败,降级 HTTP:', e) }
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
      console.warn('[MeetingTranscription] 语音配置读取失败,使用默认 provider/lang:', e)
    }
    asrCfgLoadedRef.current = true
  }, [])
  useEffect(() => {
    void loadAsrCfg()
    const refresh = () => { asrCfgLoadedRef.current = false; void loadAsrCfg() }
    window.addEventListener('config-updated-voice', refresh)
    return () => window.removeEventListener('config-updated-voice', refresh)
  }, [loadAsrCfg])

  const emitTranscript = useCallback(() => {
    const segments = Array.from(segMapRef.current.entries())
      .sort(([a], [b]) => compareSegmentKeys(a, b))
    // 逐段 emit：每条 seg 保持自己的 isFinal 语义（段内文本增量更新）。
    // 变化检测按 (key → text|final 快照) 进行——同一段只在文本或 final 状态
    // 变化时发出一条,避免每帧全量重发导致 UI 抖动/重复累积。
    let anyChanged = false
    for (const [key, v] of segments) {
      const snapshot = v.text + '' + (v.isFinal ? 'F' : 'P')
      if (emittedMapRef.current.get(key) === snapshot) continue
      emittedMapRef.current.set(key, snapshot)
      anyChanged = true
      const seqId = ++sequenceCounterRef.current
      const seg: TranscriptSegment = {
        id: `mtg_${key}`,
        text: v.text,
        sequenceId: seqId,
        isFinal: v.isFinal,
        timestamp: Date.now(),
        audioStartTime: Date.now() - recordingStartRef.current,
      }
      onTranscript?.(seg)
    }
    return anyChanged
  }, [onTranscript])

  const connectWS = useCallback(async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return
    try {
      const wsUrl = await getAuthenticatedWsUrl('/voice/cloud')
      const ws = new WebSocket(wsUrl)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws

      ws.onopen = () => {
        wsEverOpenedRef.current = true
        wsReconnectCountRef.current = 0
        ws.send(JSON.stringify({ type: 'config', provider: asrCfgRef.current.provider, lang: asrCfgRef.current.lang }))
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'transcript' && msg.text) {
            const seg = (msg.seg === undefined || msg.seg === null) ? 'default' : String(msg.seg)
            const text = (msg.text || '').trim()
            if (!text) return

            segMapRef.current.set(seg, { text, isFinal: msg.is_final !== false })

            if (processTimerRef.current) clearTimeout(processTimerRef.current)
            processTimerRef.current = setTimeout(emitTranscript, 50)
          }
        } catch (e: any) { console.warn("[MeetingTranscription] WS message parse error:", e?.message || e) }
      }

      ws.onclose = () => {
        wsRef.current = null
        if (stateRef.current === 'recording' && wsReconnectCountRef.current < MAX_RECONNECT) {
          wsReconnectCountRef.current++
          wsReconnectTimerRef.current = setTimeout(connectWS, 2000)
        }
      }

      ws.onerror = () => {
        if (!wsEverOpenedRef.current) {
          onError?.('ASR WebSocket 连接失败，请检查服务是否运行')
        }
        ws.close()
      }
    } catch (e: any) {
      onError?.('无法连接 ASR 服务: ' + (e.message || ''))
    }
  }, [emitTranscript, onError])

  async function createCaptureNode(audioCtx: AudioContext, source: MediaStreamAudioSourceNode): Promise<AudioNode> {
    const sendPcm = (i16: Int16Array) => {
      if (stateRef.current !== 'recording') return
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(i16.buffer)
      }
    }

    if (audioCtx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' })
        const url = URL.createObjectURL(blob)
        await audioCtx.audioWorklet.addModule(url)
        URL.revokeObjectURL(url)

        const worklet = new AudioWorkletNode(audioCtx, 'pcm-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: { chunk: PCM_CHUNK_SAMPLES },
        })
        worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          const pcm = new Int16Array(e.data)
          sendPcm(pcm)
          // MT1: calculate RMS volume from PCM data for volume indicator
          if (onVolume) {
            let sumSq = 0
            for (let i = 0; i < pcm.length; i++) {
              const normalized = pcm[i] / 0x7FFF
              sumSq += normalized * normalized
            }
            const rms = Math.sqrt(sumSq / pcm.length)
            onVolume(Math.min(1, rms * 3))
          }
        }
        source.connect(worklet).connect(audioCtx.destination)
        return worklet
      } catch (e: any) {
        console.debug("[MeetingTranscription] AudioWorklet not available, falling back to ScriptProcessorNode:", e?.message || e)
      }
    }

    const processor = audioCtx.createScriptProcessor(PCM_CHUNK_SAMPLES, 1, 1)
    processor.onaudioprocess = (e) => {
      if (stateRef.current !== 'recording') return
      const input = e.inputBuffer.getChannelData(0)
      const pcm = new Int16Array(input.length)
      // MT1: calculate RMS volume for volume indicator
      let sumSq = 0
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = s * 0x7FFF
        sumSq += s * s
      }
      sendPcm(pcm)
      // MT1: report RMS volume (0~1)
      const rms = Math.sqrt(sumSq / input.length)
      onVolume?.(Math.min(1, rms * 3)) // scale up for visibility
    }
    // 回退路径：连到静音 GainNode 避免麦克风直连扬声器回声
    const silentGain = audioCtx.createGain()
    silentGain.gain.value = 0
    source.connect(processor).connect(silentGain).connect(audioCtx.destination)
    return processor
  }

  const startRecording = useCallback(async () => {
    // 2026-08-18: 原版要求 state === 'idle' 才能开录——error 态（如麦克风权限
    // 被拒）后永远无法重试。改为仅挡 recording/starting（重试/错误态均可重开）。
    if (stateRef.current === 'recording' || stateRef.current === 'starting') return
    updateState('starting')

    try {
      // 2026-08-19 修复:对齐 usePushToTalk 采集参数——裸 { audio: true } 拿不到
      // 稳定的 16kHz 单声道/降噪参数(PTT 实测可用的组合)。
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      streamRef.current = stream

      const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
      audioCtxRef.current = audioCtx
      // 2026-08-19 修复(录制失败根因):语音命令回调不在用户手势上下文,
      // Chromium autoplay policy 会以 suspended 创建 AudioContext——不 resume 则
      // AudioWorklet/ScriptProcessor 的 process() 永不执行,后端收不到 PCM,
      // watchdog 10s 无转录回收云端会话(实测:WS 已连接但零转写)。
      // usePushToTalk 同款显式 resume,resume 失败直接走 catch 报错。
      await audioCtx.resume()
      const source = audioCtx.createMediaStreamSource(stream)
      sourceNodeRef.current = source

      // Reset state
      sequenceCounterRef.current = 0
      segMapRef.current.clear()
      emittedMapRef.current.clear()
      recordingStartRef.current = Date.now()
      wsEverOpenedRef.current = false

      // Connect WebSocket first
      await connectWS()

      // Create capture node (AudioWorkletNode preferred, ScriptProcessorNode fallback)
      const captureNode = await createCaptureNode(audioCtx, source)
      captureNodeRef.current = captureNode

      updateState('recording')
    } catch (e: any) {
      if (e.name === 'NotAllowedError') {
        onError?.('需要麦克风权限才能录制会议')
      } else {
        onError?.('启动录制失败: ' + (e.message || ''))
      }
      updateState('error')
    }
  }, [connectWS, onError, updateState])

  const stopRecording = useCallback(async (): Promise<number> => {
    if (stateRef.current !== 'recording') return 0
    updateState('stopping')

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'flush' }))
      // 2026-08-19: flush 后火山回最终帧有网络延迟——600ms 兜底 + 200ms 再发一次,
      // 保证最后一句话的 final 段(可能稍晚到达)不丢;emitTranscript 幂等
      // (per-key 变化检测),多发无副作用。
      await new Promise(r => setTimeout(r, 600))
      emitTranscript()
      await new Promise(r => setTimeout(r, 200))
      emitTranscript()
    }

    if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current)
    if (wsRef.current) { try { wsRef.current.close() } catch (e: any) { console.debug("[MeetingTranscription] WS close error:", e?.message || e) } wsRef.current = null }

    if (captureNodeRef.current) {
      try { captureNodeRef.current.disconnect() } catch (e: any) { console.debug("[MeetingTranscription] captureNode disconnect error:", e?.message || e) }
      captureNodeRef.current = null
    }
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.disconnect() } catch (e: any) { console.debug("[MeetingTranscription] sourceNode disconnect error:", e?.message || e) }
      sourceNodeRef.current = null
    }
    if (audioCtxRef.current) {
      await audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (processTimerRef.current) {
      clearTimeout(processTimerRef.current)
      processTimerRef.current = null
    }

    const duration = Math.floor((Date.now() - recordingStartRef.current) / 1000)
    updateState('idle')
    return duration
  }, [emitTranscript, updateState])

  const cleanup = useCallback(() => {
    if (stateRef.current === 'recording') stopRecording()
    if (wsReconnectTimerRef.current) clearTimeout(wsReconnectTimerRef.current)
  }, [stopRecording])

  return {
    state,
    startRecording,
    stopRecording,
    cleanup,
    // 2026-08-29 修复: fullTranscriptRef 从不 push(死逻辑恒返回空)——改从
    // segMapRef 派生,与 emitTranscript 同一数据源、同一 numeric 排序。
    getFullTranscript: () => {
      const segs = Array.from(segMapRef.current.entries())
        .sort(([a], [b]) => compareSegmentKeys(a, b))
      return segs.map(([, s]) => s.text).join('\n').trim()
    },
  }
}
