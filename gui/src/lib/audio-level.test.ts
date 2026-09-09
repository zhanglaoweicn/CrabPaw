/**
 * audio-level 窗口化活跃检测测试(renderer TS 版,与 electron/kws/audio-level.test.js 同口径)
 */
import { AudioLevelDetector, pcmToLevel0127, rmsToLevel0127, convertLevelToLinear } from './audio-level'

describe('rmsToLevel0127 / pcmToLevel0127', () => {
  test('静音 → 127(最安静)', () => {
    expect(pcmToLevel0127(new Float32Array(1600))).toBe(127)
    expect(rmsToLevel0127(0)).toBe(127)
    expect(rmsToLevel0127(1e-7)).toBe(127)
  })
  test('满幅方波 → 0(最响)', () => {
    const buf = new Float32Array(1600).fill(1.0)
    expect(pcmToLevel0127(buf)).toBe(0)
  })
  test('0.1 幅值 → 20dBFS 附近', () => {
    const buf = new Float32Array(1600).fill(0.1)
    expect(pcmToLevel0127(buf)).toBe(20)
  })
  test('rms=0.5 → 6dBov', () => {
    expect(rmsToLevel0127(0.5)).toBe(6)
  })
})

describe('AudioLevelDetector 窗口化判定', () => {
  test('连续大声 → 活跃', () => {
    const det = new AudioLevelDetector()
    for (let i = 0; i < 8; i++) det.observeLevel(0, 100)
    expect(det.isActive()).toBe(true)
  })
  test('持续静音 → 不活跃', () => {
    const det = new AudioLevelDetector()
    for (let i = 0; i < 8; i++) det.observeLevel(127, 100)
    expect(det.isActive()).toBe(false)
  })
  test('短暂尖峰不判活跃(占比不足 40%)', () => {
    const det = new AudioLevelDetector()
    det.observeLevel(5, 100)
    for (let i = 0; i < 3; i++) det.observeLevel(127, 100)
    expect(det.isActive()).toBe(false)
  })
  test('陈旧重置:2 窗口无数据 → 静音', () => {
    const det = new AudioLevelDetector()
    let now = 1000000
    for (let i = 0; i < 4; i++) det.observeLevel(0, 100, now)
    expect(det.isActive(now)).toBe(true)
    now += 5000
    expect(det.isActive(now)).toBe(false)
  })
})

describe('observePcmF32 真实时长推进(时长通胀回归)', () => {
  test('8ms 子块 49 个(392ms)不结算,第 50 个(满 400ms)才结算且判活跃', () => {
    const det = new AudioLevelDetector()
    const chunk = new Float32Array(128).fill(0.5) // 128 样本 = 8ms @16kHz, 0.5 幅值 ≈ 6dBov(活跃)
    for (let i = 0; i < 49; i++) det.observePcmF32(chunk, 16000)
    expect(det.getLevel()).toBe(0)
    det.observePcmF32(chunk, 16000)
    expect(det.isActive()).toBe(true)
  })
  test('4 个 8ms 尖峰不判活跃(时长通胀下 4×100ms 构成 100% 活跃窗口)', () => {
    const det = new AudioLevelDetector()
    const spike = new Float32Array(128).fill(0.5)
    const silence = new Float32Array(128)
    for (let i = 0; i < 4; i++) det.observePcmF32(spike, 16000)
    for (let i = 0; i < 46; i++) det.observePcmF32(silence, 16000)
    expect(det.isActive()).toBe(false)
  })
})

describe('convertLevelToLinear', () => {
  test('0dBov → 1.0', () => {
    expect(convertLevelToLinear(0)).toBeCloseTo(1.0, 5)
  })
  test('35dBov → ~0.018(阈值)', () => {
    expect(convertLevelToLinear(35)).toBeCloseTo(0.01778, 3)
  })
})
