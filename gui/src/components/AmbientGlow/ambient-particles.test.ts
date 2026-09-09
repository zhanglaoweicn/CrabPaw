import { TRAIL_MAX, updateParticles } from './ambient-particles'

function mkParticle(x = 10, y = 10): any {
  return { x, y, r: 2, vx: 1, vy: 0.5, alpha: 0.1, phase: 0 }
}

describe('updateParticles', () => {
  it('移动粒子并记录 trail（含当前点）', () => {
    const out = updateParticles([mkParticle(10, 10)], 16, 100, 100)
    expect(out[0].x).toBeGreaterThan(10)
    expect(out[0].y).toBeGreaterThan(10)
    expect(out[0].trail.length).toBe(2) // 旧点 + 新点
  })

  it('trail 上限收敛于 TRAIL_MAX', () => {
    let p: any = mkParticle()
    for (let i = 0; i < 30; i++) p = updateParticles([p], 16, 100, 100)[0]
    expect(p.trail.length).toBeLessThanOrEqual(TRAIL_MAX)
  })

  it('reduced-motion 语义：dt=0 不推进', () => {
    const out = updateParticles([mkParticle(10, 10)], 0, 100, 100)
    expect(out[0].x).toBe(10)
    expect(out[0].y).toBe(10)
    expect(out[0].trail.length).toBe(1)
  })
})
