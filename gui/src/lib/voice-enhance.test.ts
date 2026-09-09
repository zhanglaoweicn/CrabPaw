/**
 * voice-enhance 单元测试——语音增强共享件（2026-09-05 识别能力深度优化）
 * HPF 频率选择性 + AGC 增益行为。两管线(PTT/连续语音)共用此模块。
 */

import {
  createHighPass,
  createAgcBoost,
} from './voice-enhance'
import { AGC_MAX_GAIN } from './voice-engine-utils'

/** 生成正弦波 Int16 块(16kHz 假设) */
function sine(freq: number, seconds: number, amplitude = 0.5): Int16Array {
  const n = Math.round(16000 * seconds)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / 16000) * amplitude * 0x7fff)
  }
  return out
}

function rms(i16: Int16Array): number {
  let sum = 0
  for (let i = 0; i < i16.length; i++) {
    const s = i16[i] / 0x8000
    sum += s * s
  }
  return Math.sqrt(sum / i16.length)
}

describe('createHighPass 高通滤波', () => {
  test('低频隆隆(60Hz)显著衰减, 语音主频(440Hz)基本保留', () => {
    const hpf = createHighPass()
    // 预热滤波器状态(前 0.5s 只喂同频信号, 让状态收敛)
    hpf.process(sine(60, 0.5))
    const rumbleIn = rms(sine(60, 1))
    const rumbleOut = rms(hpf.process(sine(60, 1)))
    hpf.reset()
    hpf.process(sine(440, 0.5))
    const voiceIn = rms(sine(440, 1))
    const voiceOut = rms(hpf.process(sine(440, 1)))
    const rumbleRms = rumbleOut / rumbleIn
    const voiceRms = voiceOut / voiceIn
    // 一阶 IIR @100Hz 对 60Hz 理论增益 ≈ 0.51(-5.8dB), 440Hz ≈ 0.975
    expect(rumbleRms).toBeLessThan(0.6)
    expect(voiceRms).toBeGreaterThan(0.9)
  })

  test('reset 清空状态(防跨会话泄漏)', () => {
    const hpf = createHighPass()
    hpf.process(sine(60, 0.5))
    hpf.reset()
    const out = hpf.process(new Int16Array(1600))
    expect(rms(out)).toBe(0) // 全零输入 → 全零输出
  })
})

describe('createAgcBoost 软件 AGC', () => {
  test('弱信号被放大(增益向上, 不超过 AGC_MAX_GAIN)', () => {
    const agc = createAgcBoost()
    const weak = new Int16Array(1600).map((_, i) => Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.0018 * 0x7fff))
    const before = rms(weak)
    let after = rms(agc.process(weak))
    // 多帧后增益爬满
    for (let i = 0; i < 20; i++) after = rms(agc.process(weak))
    expect(after).toBeGreaterThan(before)
    expect(after).toBeLessThanOrEqual(before * AGC_MAX_GAIN + 1)
  })

  test('增益上限=AGC_MAX_GAIN(24): 强弱信号混合下输出不超原始×上限', () => {
    const agc = createAgcBoost()
    const weak = new Int16Array(1600).map((_, i) => Math.round(Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.001 * 0x7fff))
    for (let i = 0; i < 30; i++) agc.process(weak) // 增益爬满
    const out = agc.process(weak)
    const inRms = rms(weak)
    const outRms = rms(out)
    expect(outRms).toBeLessThanOrEqual(inRms * (AGC_MAX_GAIN + 1))
  })

  test('强信号增益趋近 1(不放大, 防削顶)', () => {
    const agc = createAgcBoost()
    const loud = sine(440, 0.2, 0.6)
    for (let i = 0; i < 20; i++) agc.process(loud)
    const out = rms(agc.process(loud))
    expect(out).toBeLessThanOrEqual(rms(loud) * 1.05 + 1)
  })

  test('reset 清空增益(PTT 每次会话重新自适应)', () => {
    const agc = createAgcBoost()
    const weak = new Int16Array(1600).map((_, i) => Math.round(Math.sin((2 * Math.PI * 300 * i) / 16000) * 0.001 * 0x7fff))
    for (let i = 0; i < 30; i++) agc.process(weak)
    agc.reset()
    expect(agc.gain()).toBe(1)
  })

  test('AGC_MAX_GAIN=24(2026-09-05 深度优化值)被引用', () => {
    expect(AGC_MAX_GAIN).toBe(24)
  })
})
