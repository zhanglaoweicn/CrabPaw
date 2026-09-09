/**
 * audio-silence — 静音门控纯函数（2026-08-04,移植 LiveKit DTX 思想）
 *
 * LiveKit 客户端在静音时停发媒体包(Opus DTX),服务端注入静音帧保持流连续。
 * 对应到本地 ASR 链路:持续静音帧不送云端识别——
 *   省 API 调用 + 防 no-speech 死循环 + 服务端凭"包超时"更快切句。
 *
 * 设计约束:
 * - 在 AGC 自适应增益**之前**判定(AGC 会把噪声放大到目标 RMS,污染静音判定)
 * - 阈值取原始 RMS(0-1 浮点域),默认 0.001(-60dBFS):
 *   参考实测 USB 麦克风说话 RMS ≈ 0.0018,静音 ≈ 0.0002-0.0005
 * - 连续静音超过 N 块才丢弃(说话间隙短停顿不切音),语音帧立即放行
 */

/** 判定单个 PCM 块是否静音(0-1 浮点域) */
export function isSilentChunk(i16: Int16Array, threshold = 0.001): boolean {
  let sum = 0
  let count = 0
  const step = 8
  for (let i = 0; i < i16.length; i += step) {
    const v = i16[i] / 32768
    sum += v * v
    count++
  }
  if (count === 0) return true
  return Math.sqrt(sum / count) < threshold
}

/**
 * 静音门控状态机:输入当前块,输出"是否应丢弃(不送 ASR)"
 * 连续静音 ≥ dropAfterChunks 块 → 丢弃;任一语音块 → 立即放行并清零计数
 */
export class SilenceGate {
  private silenceRun = 0

  constructor(private dropAfterChunks = 8) {}

  /** 返回 true = 静音帧应丢弃 */
  shouldDrop(i16: Int16Array, threshold = 0.001): boolean {
    const silent = isSilentChunk(i16, threshold)
    if (silent) {
      this.silenceRun++
      return this.silenceRun >= this.dropAfterChunks
    }
    this.silenceRun = 0
    return false
  }

  reset(): void {
    this.silenceRun = 0
  }
}
