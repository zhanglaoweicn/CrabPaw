/**
 * audio-level — 窗口化音频活跃检测（renderer 纯 TS 版，照抄 electron/kws/audio-level.cjs）
 *
 * 2026-08-14: listening 期 KWS probe 被暂停(setMicEnabled(false))，主进程
 * wake:audio-level 广播随之停摆——ASR 采集帧是聆听期唯一实时能量信号源。
 * 本模块与 KWS 侧同算法(窗口化百分位 + EMA + 陈旧重置)，供 useVoiceSession
 * 在 onFrame 内驱动能量球体，保证待机/聆听两态能量语义一致。
 *
 * 核心思想（LiveKit 生产验证）:
 * - 400ms 观察窗口内,统计超过活跃阈值(默认 -35dBov,即 level<=35)的采样时长占比
 * - 占比 ≥ MinPercentile(40%) 才判定"活跃"——短暂尖峰不算说话
 * - EMA 平滑(smoothFactor = 2/(N+1))衰减瞬态
 * - 陈旧重置:2 个窗口无数据 → 平滑值归零(静音)
 */

export const silentAudioLevel = 127

const DEFAULT_CONFIG = {
  activeLevel: 35,        // -35dBov 阈值
  minPercentile: 40,      // 窗口内活跃时长占比 ≥40%
  updateInterval: 400,    // 观察窗口 ms
  smoothIntervals: 2,     // EMA 平滑窗口数
}

/** RMS(0-1 浮点域) → 0-127 dBov 刻度(0 最响),静音返回 127 */
export function rmsToLevel0127(rms: number): number {
  if (rms <= 1e-6) return silentAudioLevel
  const dBFS = 20 * Math.log10(rms)
  return Math.max(0, Math.min(silentAudioLevel, Math.round(-dBFS)))
}

/** Float32 PCM 数组 → 0-127 dBov 刻度(0 最响),静音返回 127 */
export function pcmToLevel0127(samples: Float32Array): number {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    sum += s * s
  }
  return rmsToLevel0127(Math.sqrt(sum / Math.max(1, samples.length)))
}

/** dBov(0-127) → 线性幅度(与 LiveKit ConvertAudioLevel 一致) */
export function convertLevelToLinear(level: number): number {
  return Math.pow(10, level * (-1 / 20))
}

export class AudioLevelDetector {
  private config: typeof DEFAULT_CONFIG
  private minActiveDuration: number
  private smoothFactor: number
  private activeThreshold: number

  private smoothedLevel = 0
  private loudestObservedLevel = silentAudioLevel
  private activeDuration = 0
  private observedDuration = 0
  private lastObservedAt = 0

  constructor(config: Partial<typeof DEFAULT_CONFIG> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.minActiveDuration = this.config.minPercentile * this.config.updateInterval / 100
    this.smoothFactor = this.config.smoothIntervals > 0
      ? 2 / (this.config.smoothIntervals + 1)
      : 1
    this.activeThreshold = convertLevelToLinear(this.config.activeLevel)
  }

  /** 喂入一块音频电平(0-127, 0 最响) */
  observeLevel(level: number, durationMs: number, arrivalTime = Date.now()): void {
    if (!this.config.updateInterval) return
    this.lastObservedAt = arrivalTime
    this.observedDuration += durationMs
    if (level <= this.config.activeLevel) {
      this.activeDuration += durationMs
      if (this.loudestObservedLevel > level) {
        this.loudestObservedLevel = level
      }
    }
    if (this.observedDuration >= this.config.updateInterval) {
      let smoothed = 0
      if (this.activeDuration >= this.minActiveDuration) {
        // 活跃度加权 + EMA 平滑(与 LiveKit 一致)
        const activityWeight = 20 * Math.log10(this.activeDuration / this.config.updateInterval)
        const adjusted = this.loudestObservedLevel - activityWeight
        const linear = convertLevelToLinear(adjusted)
        smoothed = this.smoothedLevel + (linear - this.smoothedLevel) * this.smoothFactor
      }
      this.resetLocked(smoothed)
    }
  }

  /**
   * 便捷:Float32 PCM 数组,按 blockMs 分块喂入。
   * 按真实时长结算——不足 blockSamples 的尾块不再按满 blockMs 计
   * (时长通胀会让 32ms 实际音频即可结算 400ms 窗口,稀释抗尖峰设计)。
   */
  observePcmF32(samples: Float32Array, sampleRate = 16000, blockMs = 100): void {
    if (!this.config.updateInterval) return
    const blockSamples = Math.floor(sampleRate * blockMs / 1000)
    for (let off = 0; off < samples.length; off += blockSamples) {
      const chunk = samples.subarray(off, off + blockSamples)
      if (chunk.length === 0) continue
      const durationMs = chunk.length / sampleRate * 1000
      this.observeLevel(pcmToLevel0127(chunk), durationMs)
    }
  }

  /** 当前是否活跃(带陈旧重置) */
  isActive(now = Date.now()): boolean {
    this.resetIfStale(now)
    return this.smoothedLevel >= this.activeThreshold
  }

  /** 当前平滑电平(线性,0-1) */
  getLevel(now = Date.now()): number {
    this.resetIfStale(now)
    return this.smoothedLevel
  }

  private resetIfStale(now: number): void {
    if ((now - this.lastObservedAt) < 2 * this.config.updateInterval) return
    this.resetLocked(0)
  }

  private resetLocked(smoothedLevel: number): void {
    this.smoothedLevel = smoothedLevel
    this.loudestObservedLevel = silentAudioLevel
    this.activeDuration = 0
    this.observedDuration = 0
  }
}
