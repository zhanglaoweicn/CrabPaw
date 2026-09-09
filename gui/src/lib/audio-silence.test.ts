import { isSilentChunk, SilenceGate } from './audio-silence'

function makeChunk(value: number, len = 2048): Int16Array {
  const a = new Int16Array(len)
  for (let i = 0; i < len; i++) a[i] = Math.round(value * 32768)
  return a
}

describe('isSilentChunk (静音判定,0-1 浮点域)', () => {
  test('全零 → 静音', () => {
    expect(isSilentChunk(new Int16Array(2048))).toBe(true)
  })
  test('幅度 0.0003 → 静音(阈值下)', () => {
    expect(isSilentChunk(makeChunk(0.0003))).toBe(true)
  })
  test('幅度 0.002 → 非静音(说话量级)', () => {
    expect(isSilentChunk(makeChunk(0.002))).toBe(false)
  })
  test('幅度 0.1 → 非静音', () => {
    expect(isSilentChunk(makeChunk(0.1))).toBe(false)
  })
  test('空数组 → 视为静音', () => {
    expect(isSilentChunk(new Int16Array(0))).toBe(true)
  })
})

describe('SilenceGate (静音门控状态机)', () => {
  test('短暂静音(少于阈值)不丢弃——说话间隙不切音', () => {
    const gate = new SilenceGate(8)
    // 7 块静音(累积 7<8) → 全部放行
    for (let i = 0; i < 7; i++) {
      expect(gate.shouldDrop(makeChunk(0.0003))).toBe(false)
    }
    // 第 8 块起(累积 8=8)丢弃
    expect(gate.shouldDrop(makeChunk(0.0003))).toBe(true)
  })

  test('语音帧立即放行并清零计数', () => {
    const gate = new SilenceGate(8)
    for (let i = 0; i < 10; i++) gate.shouldDrop(makeChunk(0.0003))
    expect(gate.shouldDrop(makeChunk(0.1))).toBe(false)
    // 清零后,重新连续静音需再次累积
    expect(gate.shouldDrop(makeChunk(0.0003))).toBe(false)
  })

  test('交替说话/静音永不丢弃', () => {
    const gate = new SilenceGate(4)
    for (let i = 0; i < 100; i++) {
      const silent = i % 3 === 0
      expect(gate.shouldDrop(makeChunk(silent ? 0.0003 : 0.01))).toBe(false)
    }
  })

  test('reset 清除累积', () => {
    const gate = new SilenceGate(2)
    for (let i = 0; i < 5; i++) gate.shouldDrop(makeChunk(0.0003))
    gate.reset()
    expect(gate.shouldDrop(makeChunk(0.0003))).toBe(false)
  })
})
