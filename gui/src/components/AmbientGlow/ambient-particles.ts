/** 粒子运动纯函数（canvas 拖尾用）——可 jest 单测，reduced-motion 由调用方跳过 */
export const TRAIL_MAX = 10

export interface TrailParticle {
  x: number; y: number; r: number; vx: number; vy: number; alpha: number; phase: number
  trail: { x: number; y: number }[]
}

export function updateParticles<T extends { x: number; y: number; vx: number; vy: number }>(
  particles: T[], dt: number, _w: number, _h: number
): (T & { trail: { x: number; y: number }[] })[] {
  return particles.map(p => {
    const nx = p.x + p.vx * (dt / 16)
    const ny = p.y + p.vy * (dt / 16)
    const prevTrail = (p as any).trail || [{ x: p.x, y: p.y }]
    // dt=0（reduced-motion 由调用方传 0）不推进：不重复追加同一点
    const moved = nx !== p.x || ny !== p.y
    const trail = moved ? [{ x: nx, y: ny }, ...prevTrail].slice(0, TRAIL_MAX) : prevTrail
    return { ...p, x: nx, y: ny, trail } as any
  })
}
