import { computeCenterOffset } from './geometry'

describe('computeCenterOffset 居中偏移', () => {
  test('常规视口：面板几何居中', () => {
    // x = (1600-360)/2 - 16 = 604；y = (900-420)/2 - 16 = 224
    expect(computeCenterOffset(1600, 900, 360, 420)).toEqual({ x: 604, y: 224 })
  })

  test('面板等于视口：clamp 不出界', () => {
    const r = computeCenterOffset(1600, 900, 1600, 900)
    expect(r.x).toBeLessThanOrEqual(1600 - 40)
    expect(r.x).toBeGreaterThanOrEqual(8 - 1600)
    expect(r.y).toBeLessThanOrEqual(900 - 40)
    expect(r.y).toBeGreaterThanOrEqual(8 - 900)
  })

  test('小视口 + 高卡：未越界时保持居中公式值', () => {
    // x = (500-420)/2 - 16 = 24；y = (400-500)/2 - 16 = -66（负值合法=面板上缘超出顶部, 属 clamp 内）
    const r = computeCenterOffset(500, 400, 420, 500)
    expect(r.x).toBe(24)
    expect(r.y).toBe(-66)
  })

  test('超小视口：clamp 到可视区间内', () => {
    const r = computeCenterOffset(300, 300, 320, 360)
    expect(r.x).toBeGreaterThanOrEqual(8 - 320)
    expect(r.x).toBeLessThanOrEqual(300 - 40)
    expect(r.y).toBeGreaterThanOrEqual(8 - 360)
    expect(r.y).toBeLessThanOrEqual(300 - 40)
  })
})
