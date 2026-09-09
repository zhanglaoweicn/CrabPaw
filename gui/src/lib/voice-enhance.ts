/**
 * voice-enhance — 语音增强共享模块（2026-09-05 识别能力深度优化）
 *
 * 背景（真机反馈"空格模式识别差/人声识别差于手机声"）：USB 麦弱信号
 * (RMS~0.0018) 直发 ASR 识别差 + 低频隆隆声/喷麦拉低信噪比。
 *
 * 本模块提供两条采集管线(PTT/连续语音)共用的音频增强处理器：
 *   1. createHighPass — 一阶 IIR 高通(截止 ~100Hz@16k)：滤桌面振动/喷麦/电源哼声
 *   2. createAgcBoost — 软件 AGC(与 useVoiceSession 原 boostInt16 同算法)：
 *      自适应增益放大弱信号到目标 RMS(上限 AGC_MAX_GAIN)
 *
 * 接入顺序(两管线一致)：静音/门控判定(原始信号) → HPF → AGC → 发送。
 * 判定用原始信号(增强不污染门控)，增强只提升发往 ASR 的信号质量。
 */

import { computeAgcGain, AGC_TARGET_RMS, AGC_MAX_GAIN } from './voice-engine-utils'

/** 一阶 IIR 高通系数：fc=100Hz @16kHz → α ≈ 0.962 */
const HPF_ALPHA = 0.962

export interface HighPassFilter {
  process(i16: Int16Array): Int16Array
  reset(): void
}

/**
 * 创建有状态高通滤波器(每采集管线一个实例——跨帧保持滤波状态)。
 * 低频隆隆/喷麦/电源哼声(<100Hz)衰减, 语音频段(300Hz+)基本无损。
 */
export function createHighPass(): HighPassFilter {
  let prevIn = 0
  let prevOut = 0
  return {
    process(i16: Int16Array): Int16Array {
      const out = new Int16Array(i16.length)
      for (let i = 0; i < i16.length; i++) {
        const x = i16[i]
        const y = HPF_ALPHA * (prevOut + x - prevIn)
        prevIn = x
        prevOut = y
        out[i] = Math.max(-32768, Math.min(32767, Math.round(y)))
      }
      return out
    },
    reset() {
      prevIn = 0
      prevOut = 0
    },
  }
}

export interface AgcBoost {
  process(i16: Int16Array): Int16Array
  reset(): void
  /** 当前增益(诊断用) */
  gain(): number
}

/**
 * 创建软件 AGC 处理器(每采集管线一个实例——增益跨帧平滑)。
 * 算法与 useVoiceSession 原 boostInt16 逐行等价(computeAgcGain 平滑+钳位放大)，
 * 差异仅: 增益上限走 AGC_MAX_GAIN(2026-09-05 由 8 提至 24, 降噪+HPF+原始信号
 * 门控三重保护下安全), 弱麦(RMS~0.0018)可抬到 0.0432(-27dBFS, 接近目标)。
 */
export function createAgcBoost(): AgcBoost {
  let gain = 1
  return {
    process(i16: Int16Array): Int16Array {
      let sum = 0
      const step = 8
      for (let i = 0; i < i16.length; i += step) {
        const v = i16[i] / 32768
        sum += v * v
      }
      const rms = Math.sqrt(sum / Math.ceil(i16.length / step))
      gain = computeAgcGain(rms, gain, AGC_TARGET_RMS, AGC_MAX_GAIN)
      const out = new Int16Array(i16.length)
      for (let i = 0; i < i16.length; i++) {
        out[i] = Math.max(-32768, Math.min(32767, Math.round(i16[i] * gain)))
      }
      return out
    },
    reset() {
      gain = 1
    },
    gain() {
      return gain
    },
  }
}
