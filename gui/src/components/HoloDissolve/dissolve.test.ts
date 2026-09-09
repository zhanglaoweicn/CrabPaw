/**
 * HoloDissolve dissolveParams 纯函数测试（TDD：先写测试，再实现）
 *
 * dissolveParams(sourceRect, t) —— 计算 sourceRect 中心点在归一化时间 t 处的粒子状态。
 * 物理模型：vy 起始 -30px/s，重力 +160px/s²，alpha 从 0.9 线性衰减到 0，时长 1.2s。
 * 组件内 400 粒子使用相同物理公式，初始位置在 sourceRect 内随机采样。
 */

import { dissolveParams } from './index'

describe('dissolveParams 纯函数（粒子参数化）', () => {
  const rect = { x: 0, y: 0, w: 400, h: 300 }

  // ── 来自 task-2-brief 的必过用例 ──
  test('粒子参数化：数量/下坠距离/衰减（t=0.5）', () => {
    const p = dissolveParams(rect, 0.5)
    expect(p.y).toBeGreaterThan(0)   // 下坠（中心 y=150，t=0.5s 时下落约 10.8px）
    expect(p.alpha).toBeLessThan(1)
    expect(p.alpha).toBeGreaterThan(0)
  })

  // ── 补充边界用例 ──
  test('t=0 时粒子在 sourceRect 中心，alpha≈0.9', () => {
    const p = dissolveParams(rect, 0)
    expect(p.x).toBe(200)  // centerX = 0 + 400/2
    expect(p.y).toBe(150)  // centerY = 0 + 300/2
    expect(p.alpha).toBeCloseTo(0.9, 5)
  })

  test('t=1 时粒子已下坠，alpha≈0', () => {
    const p = dissolveParams(rect, 1)
    // 中心 y=150；vy0=-30 持续 1.2s + 重力：y = 150 - 36 + 115.2 = 229.2
    expect(p.y).toBeGreaterThan(200)
    expect(p.alpha).toBeCloseTo(0, 5)
  })

  test('y 抛物线轨迹：先微升（vy0=-30）后加速下坠（重力 +160）', () => {
    // vy0=-30 向上 → 粒子先升后降；顶点在 t = 30/160 = 0.1875 附近
    const y0 = dissolveParams(rect, 0).y       // t=0: 150
    const y10 = dissolveParams(rect, 0.1).y    // 微升
    const y50 = dissolveParams(rect, 0.5).y    // 已开始下落
    const y100 = dissolveParams(rect, 1).y     // 最终远低于起点
    expect(y10).toBeLessThan(y0)    // 初始上升（y 减小）
    expect(y0).toBeLessThan(y50)    // 中途已越过起点
    expect(y50).toBeLessThan(y100)  // 持续加速下坠
  })

  test('alpha 从 0.9 线性衰减到 0', () => {
    expect(dissolveParams(rect, 0).alpha).toBeCloseTo(0.9, 5)
    expect(dissolveParams(rect, 0.25).alpha).toBeCloseTo(0.675, 5)
    expect(dissolveParams(rect, 0.5).alpha).toBeCloseTo(0.45, 5)
    expect(dissolveParams(rect, 0.75).alpha).toBeCloseTo(0.225, 5)
    expect(dissolveParams(rect, 1).alpha).toBeCloseTo(0, 5)
  })

  test('非零原点 sourceRect 正确偏移', () => {
    const offsetRect = { x: 100, y: 200, w: 300, h: 100 }
    const p = dissolveParams(offsetRect, 0)
    expect(p.x).toBe(250)  // 100 + 300/2
    expect(p.y).toBe(250)  // 200 + 100/2
  })
})
