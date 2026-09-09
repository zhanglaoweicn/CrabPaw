// audio-level.cjs —— 窗口化音频活跃检测（移植自 LiveKit pkg/sfu/audio/audiolevel.go,2026-08-04）
//
// 核心思想（LiveKit 生产验证）:
// - 400ms 观察窗口内,统计超过活跃阈值(默认 -35dBov,即 level<=35)的采样时长占比
// - 占比 ≥ MinPercentile(40%) 才判定"活跃"——短暂尖峰不算说话
// - 活跃度加权: activityWeight = 20*log10(activeDuration/window)
//   满窗活跃权重 0(最响),断续说话被对数压低——物理意义:断续说话"听起来"不如连续说话
// - EMA 平滑(smoothFactor = 2/(N+1))衰减瞬态
// - 陈旧重置:2 个窗口无数据 → 平滑值归零(静音)
//
// 用法:
//   const det = new AudioLevelDetector()
//   det.observeLevel(rmsLevel0127, durationMs)   // rmsLevel0127: 0-127(0 最响)
//   det.isActive()  /  det.getLevel()
//   det.observePcmF32(buf)                       // 便捷:Float32 PCM 数组 → 内部按块算 RMS

const silentAudioLevel = 127

const DEFAULT_CONFIG = {
  activeLevel: 35,        // -35dBov 阈值
  minPercentile: 40,      // 窗口内活跃时长占比 ≥40%
  updateInterval: 400,    // 观察窗口 ms
  smoothIntervals: 2,     // EMA 平滑窗口数
}

/** Float32 PCM 数组 → 0-127 dBov 刻度(0 最响),静音返回 127 */
function pcmToLevel0127(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    sum += s * s
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length))
  if (rms <= 1e-6) return silentAudioLevel
  const dBFS = 20 * Math.log10(rms)
  return Math.max(0, Math.min(silentAudioLevel, Math.round(-dBFS)))
}

/** dBov(0-127) → 线性幅度(与 LiveKit ConvertAudioLevel 一致) */
function convertLevelToLinear(level) {
  return Math.pow(10, level * (-1 / 20))
}

class AudioLevelDetector {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.minActiveDuration = this.config.minPercentile * this.config.updateInterval / 100
    this.smoothFactor = this.config.smoothIntervals > 0
      ? 2 / (this.config.smoothIntervals + 1)
      : 1
    this.activeThreshold = convertLevelToLinear(this.config.activeLevel)

    this.smoothedLevel = 0
    this.loudestObservedLevel = silentAudioLevel
    this.activeDuration = 0
    this.observedDuration = 0
    this.lastObservedAt = 0
  }

  /** 喂入一块音频电平(0-127, 0 最响) */
  observeLevel(level, durationMs, arrivalTime = Date.now()) {
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

  /** 便捷:Float32 PCM 数组,按 blockMs 分块喂入 */
  observePcmF32(samples, sampleRate = 16000, blockMs = 100) {
    if (!this.config.updateInterval) return
    const blockSamples = Math.floor(sampleRate * blockMs / 1000)
    for (let off = 0; off < samples.length; off += blockSamples) {
      const chunk = samples.subarray(off, off + blockSamples)
      if (chunk.length === 0) continue
      // 2026-08-14 fix(时长通胀): 不足 blockSamples 的尾块(如 128 样本=8ms@16kHz)
      // 此前一律按满 blockMs 计 → 32ms 实际音频即可结算 400ms 窗口(12.5 倍通胀),
      // 抗尖峰设计被稀释(4 个 8ms 尖峰即构成"100% 活跃窗口")。改为按真实时长结算。
      const durationMs = chunk.length / sampleRate * 1000
      this.observeLevel(pcmToLevel0127(chunk), durationMs)
    }
  }

  /** 当前是否活跃(带陈旧重置) */
  isActive(now = Date.now()) {
    this.resetIfStaleLocked(now)
    return this.smoothedLevel >= this.activeThreshold
  }

  /** 当前平滑电平(线性,0-1) */
  getLevel(now = Date.now()) {
    this.resetIfStaleLocked(now)
    return this.smoothedLevel
  }

  resetIfStaleLocked(now) {
    if ((now - this.lastObservedAt) < 2 * this.config.updateInterval) return
    this.resetLocked(0)
  }

  resetLocked(smoothedLevel) {
    this.smoothedLevel = smoothedLevel
    this.loudestObservedLevel = silentAudioLevel
    this.activeDuration = 0
    this.observedDuration = 0
  }
}

module.exports = { AudioLevelDetector, pcmToLevel0127, convertLevelToLinear, silentAudioLevel }
