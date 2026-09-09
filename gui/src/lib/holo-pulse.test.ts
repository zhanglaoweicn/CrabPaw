import { pulseTarget } from './holo-pulse'

describe('pulseTarget（段索引与 KPI 数量取模轮换）', () => {
  test('0 段 → KPI 0', () => {
    expect(pulseTarget(0, 3)).toBe(0)
  })

  test('段数 > KPI 数 → 取模轮换', () => {
    // 3 个 KPI：段 0→KPI0, 段1→KPI1, 段2→KPI2, 段3→KPI0
    expect(pulseTarget(0, 3)).toBe(0)
    expect(pulseTarget(1, 3)).toBe(1)
    expect(pulseTarget(2, 3)).toBe(2)
    expect(pulseTarget(3, 3)).toBe(0)
    expect(pulseTarget(4, 3)).toBe(1)
    expect(pulseTarget(5, 3)).toBe(2)
  })

  test('kpiCount=1 → 始终返回 0', () => {
    expect(pulseTarget(0, 1)).toBe(0)
    expect(pulseTarget(5, 1)).toBe(0)
    expect(pulseTarget(99, 1)).toBe(0)
  })

  test('kpiCount=0 → 兜底返回 0', () => {
    expect(pulseTarget(0, 0)).toBe(0)
    expect(pulseTarget(5, 0)).toBe(0)
  })

  test('kpiCount 为负数 → 兜底返回 0', () => {
    expect(pulseTarget(0, -1)).toBe(0)
    expect(pulseTarget(5, -3)).toBe(0)
  })

  test('segmentIndex 很大时仍正确取模', () => {
    expect(pulseTarget(100, 3)).toBe(1)   // 100 % 3 = 1
    expect(pulseTarget(1000, 7)).toBe(6)  // 1000 % 7 = 6
  })

  test('段索引递增轮换——模拟 TTS 播放全过程', () => {
    const kpiCount = 4
    const targets: number[] = []
    for (let i = 0; i < 10; i++) {
      targets.push(pulseTarget(i, kpiCount))
    }
    // 应轮换: 0,1,2,3,0,1,2,3,0,1
    expect(targets).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1])
  })
})
