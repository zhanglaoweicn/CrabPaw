import { convertF32ToInt16, computeVol, PCM_CHUNK_SAMPLES } from './audio-capture'

describe('audio-capture 纯函数', () => {
  it('convertF32ToInt16 钳位转换', () => {
    const f32 = new Float32Array([0, 1, -1, 2, -2, 0.5, -0.5])
    const out = convertF32ToInt16(f32)
    expect(out[1]).toBe(32767)
    expect(out[2]).toBe(-32768)
    expect(out[3]).toBe(32767) // 2.0 钳位到 1.0
    expect(out[4]).toBe(-32768)
    expect(out[5]).toBe(16383) // 0.5 × 0x7fff = 16383.5 → Int16Array 截断为 16383（与迁移前 usePushToTalk 回退路径行为一致）
  })
  it('computeVol 全零→0, 满幅→1 附近', () => {
    expect(computeVol(new Int16Array(16))).toBe(0)
    const loud = new Int16Array(16).fill(32767)
    expect(computeVol(loud)).toBeGreaterThan(0.9)
  })
  it('PCM_CHUNK_SAMPLES 常量', () => {
    expect(PCM_CHUNK_SAMPLES).toBe(2048)
  })
})
