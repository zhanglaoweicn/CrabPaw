/**
 * audio-capture — 共享音频采集模块（2026-08-12）
 *
 * 从 useVoiceSession / usePushToTalk 提取的重复 AudioWorklet 采集实现。
 * 纯函数(convertF32ToInt16 / computeVol)可独立单测。
 */

export const PCM_CHUNK_SAMPLES = 2048

export const PCM_WORKLET_SRC = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._size = (options && options.processorOptions && options.processorOptions.chunk) || 2048;
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

/** Float32 帧 → Int16 PCM（钳位） */
export function convertF32ToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

/** 从 Int16 PCM 计算 RMS 音量（0~1） */
export function computeVol(i16: Int16Array): number {
  if (i16.length === 0) return 0
  let sum = 0
  for (let i = 0; i < i16.length; i++) {
    const s = i16[i] / 0x8000
    sum += s * s
  }
  return Math.sqrt(sum / i16.length)
}

/**
 * 创建 PCM 采集节点 — 优先 AudioWorkletNode，回退 ScriptProcessorNode
 * onFrame 接收 Int16Array 块（已在音频线程转换完毕）
 * 通过静音增益节点连接 destination,防止麦克风音频从扬声器外放造成回声/啸叫
 */
export async function createCaptureNode(
  audioCtx: AudioContext,
  source: MediaStreamAudioSourceNode,
  onFrame: (samples: Int16Array) => void,
  signal: AbortSignal,
  opts: { chunk?: number } = {},
): Promise<AudioNode> {
  const chunk = opts.chunk ?? PCM_CHUNK_SAMPLES
  if (audioCtx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      const blob = new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      await audioCtx.audioWorklet.addModule(url)
      URL.revokeObjectURL(url)
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const worklet = new AudioWorkletNode(audioCtx, 'pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        processorOptions: { chunk },
      })
      worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => onFrame(new Int16Array(e.data))
      const silentGain = audioCtx.createGain()
      silentGain.gain.value = 0
      source.connect(worklet).connect(silentGain).connect(audioCtx.destination)
      return worklet
    } catch {
      console.warn('[audio-capture] AudioWorklet 不可用, 降级 ScriptProcessor')
      /* fall through 到回退方案 */
    }
  }
  const processor = audioCtx.createScriptProcessor(chunk, 1, 1)
  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    onFrame(convertF32ToInt16(e.inputBuffer.getChannelData(0)))
  }
  const silentGain = audioCtx.createGain()
  silentGain.gain.value = 0
  source.connect(processor).connect(silentGain).connect(audioCtx.destination)
  return processor
}
