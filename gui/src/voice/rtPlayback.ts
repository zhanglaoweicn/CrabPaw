/**
 * rtPlayback — 实时语音通道下行播放模块（纯函数单例, 非 React hook）
 *
 * 消费 /voice/realtime 下行 {type:'audio', data: base64} 块:
 * 火山 duplex 默认输出 PCM 24kHz 32bit float（PoC 实测, session.audio.output.format
 * 的 pcm 类型即 32bit——官方文档"32bit位深"）, base64 解码即 Float32Array,
 * 直接装 AudioBuffer(WebAudio 自动重采样到设备率)。
 *
 * 播放队列: 逐块 schedule(nextTime 单调推进), 全部播完触发 onEnd。
 * 打断: rtStopPlayback() 立即停所有 source（打断后 nextTime 归零防"快进"）。
 *
 * 由 useVoiceSession 的实时分支驱动:
 *   audio_start → onStart 回调(GUI 发 mute 上行)
 *   audio       → rtPlayChunk
 *   audio_end/interrupt → rtStopPlayback / 自然播完 → onEnd(GUI 发 unmute)
 */

let audioCtx: AudioContext | null = null
let nextTime = 0
let activeSources = new Set<AudioBufferSourceNode>()
let playing = false
let onStartCb: (() => void) | null = null
let onEndCb: (() => void) | null = null

function ensurePlayingState() {
  if (!playing) {
    playing = true
    try { onStartCb?.() } catch (e) { console.warn('[rtPlayback] onStart 回调失败:', e) }
  }
}

function checkDrained() {
  if (playing && activeSources.size === 0) {
    playing = false
    nextTime = 0
    try { onEndCb?.() } catch (e) { console.warn('[rtPlayback] onEnd 回调失败:', e) }
  }
}

/** 注入 AudioContext（复用采集链的 ctx, 由 useVoiceSession 在会话启动时调用） */
export function rtInitPlayback(ctx: AudioContext | null) {
  audioCtx = ctx
}

export function rtSetCallbacks(onStart: (() => void) | null, onEnd: (() => void) | null) {
  onStartCb = onStart
  onEndCb = onEnd
}

/** base64 PCM 块 → 排队播放（支持 32bit float 与 16bit int 两种格式自适应） */
export function rtPlayChunk(b64: string, sampleRate = 24000) {
  if (!audioCtx) {
    console.warn('[rtPlayback] AudioContext 未注入, 丢弃音频块')
    return
  }
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)

    // 自适应: 按帧长判定 32bit(4B/样本, float 或 s32) vs 16bit int(2B/样本)。
    // 官方文档 6561/1594356: extension.tts.audio_config 可选 pcm(32bit)/pcm_s16le(16bit)
    const isFloat32 = bytes.length % 4 === 0 && bytes.length % 2 === 0
    let samples: Float32Array
    if (isFloat32) {
      samples = new Float32Array(bytes.buffer, 0, bytes.length / 4)
      // 32bit 整数 PCM 与 float PCM 的区分: float 取值域 [-1,1] 之外出现即按 s32 处理
      let looksLikeFloat = true
      for (let i = 0; i < Math.min(samples.length, 64); i++) {
        const v = samples[i]
        if (!Number.isFinite(v) || Math.abs(v) > 4) { looksLikeFloat = false; break }
      }
      if (!looksLikeFloat) {
        // s32le → f32 归一
        const i32 = new Int32Array(bytes.buffer, 0, bytes.length / 4)
        const out = new Float32Array(i32.length)
        for (let i = 0; i < i32.length; i++) out[i] = i32[i] / 2147483648
        samples = out
      }
    } else {
      const i16 = new Int16Array(bytes.buffer, 0, bytes.length / 2)
      samples = new Float32Array(i16.length)
      for (let i = 0; i < i16.length; i++) samples[i] = i16[i] / 32768
    }
    if (samples.length === 0) return

    const buffer = audioCtx.createBuffer(1, samples.length, sampleRate)
    buffer.getChannelData(0).set(samples)

    const src = audioCtx.createBufferSource()
    src.buffer = buffer
    src.connect(audioCtx.destination)
    const t = Math.max(audioCtx.currentTime + 0.06, nextTime)
    nextTime = t + buffer.duration
    activeSources.add(src)
    ensurePlayingState()
    src.onended = () => {
      activeSources.delete(src)
      checkDrained()
    }
    try { src.start(t) } catch (e) {
      activeSources.delete(src)
      checkDrained()
      console.warn('[rtPlayback] start 失败:', e)
    }
  } catch (e) {
    console.warn('[rtPlayback] 音频块解码失败:', e)
  }
}

/** 立即停止全部播放（打断/挂起） */
export function rtStopPlayback() {
  for (const src of activeSources) {
    try { src.stop() } catch { /* already stopped */ }
    try { src.disconnect() } catch { /* ignore */ }
  }
  activeSources.clear()
  checkDrained()
}

export function rtIsPlaying(): boolean {
  return playing
}
