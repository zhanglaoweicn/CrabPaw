/**
 * orb-dynamics 单测（2026-09-23 球体动感增强轮）
 *
 * 守住三件事：
 *   1. 手感参数成立（快起慢落 / 弹簧过冲回弹 / 感知曲线抬中段）
 *   2. 与帧率无关（掉帧不改变包络与弹簧的收敛结果）
 *   3. 静音门控（v=0 → 包络 0、拉扯 0）——「安静=静态」的既有裁决不能被增强打破
 */
import {
  ORB_DYN,
  clampPull,
  envStep,
  isFastFresh,
  perceptual,
  pullTarget,
  radialScale,
  springStep,
  tideWeight,
} from './orb-dynamics'

describe('envStep 非对称包络', () => {
  test('单调逼近目标且不越界', () => {
    let env = 0
    let prev = -1
    for (let i = 0; i < 200; i++) {
      env = envStep(env, 1, 0.016)
      expect(env).toBeGreaterThanOrEqual(prev)
      expect(env).toBeLessThanOrEqual(1)
      prev = env
    }
    expect(env).toBeCloseTo(1, 3)
  })

  test('快起慢落：同样 100ms，上升比下降走得远', () => {
    let up = 0
    let down = 1
    for (let i = 0; i < 10; i++) {
      up = envStep(up, 1, 0.01)
      down = envStep(down, 0, 0.01)
    }
    expect(up).toBeGreaterThan(1 - down)
  })

  test('与帧率无关：一次 100ms ≈ 两次 50ms', () => {
    const once = envStep(0, 1, 0.1)
    const twice = envStep(envStep(0, 1, 0.05), 1, 0.05)
    expect(twice).toBeCloseTo(once, 3)
  })

  test('静音门控：目标 0 时包络衰减到 0（安静=静态）', () => {
    let env = 1
    for (let i = 0; i < 300; i++) env = envStep(env, 0, 0.016)
    expect(env).toBeLessThan(0.001)
  })

  test('dt<=0 时保持不变（暂停/首帧保护）', () => {
    expect(envStep(0.4, 1, 0)).toBe(0.4)
  })
})

describe('perceptual 感知曲线', () => {
  test('端点固定：0→0、1→1', () => {
    expect(perceptual(0)).toBe(0)
    expect(perceptual(1)).toBe(1)
  })

  test('抬高中小音量（0.3 抬到 0.4 以上）', () => {
    expect(perceptual(0.3)).toBeGreaterThan(0.4)
  })

  test('单调不减', () => {
    let prev = -1
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const cur = perceptual(v)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })

  test('越界与非法输入钳位', () => {
    expect(perceptual(-1)).toBe(0)
    expect(perceptual(5)).toBe(1)
    expect(perceptual(Number.NaN)).toBe(0)
  })
})

describe('springStep 弹簧拉扯', () => {
  test('收敛到目标', () => {
    let v = 0
    let vel = 0
    for (let i = 0; i < 600; i++) {
      const r = springStep(v, vel, 1, 0.016)
      v = r.value
      vel = r.vel
    }
    expect(v).toBeCloseTo(1, 2)
  })

  test('欠阻尼→过冲并回弹（"拉扯"手感来源）', () => {
    let v = 0
    let vel = 0
    let peak = 0
    for (let i = 0; i < 200; i++) {
      const r = springStep(v, vel, 1, 0.016)
      v = r.value
      vel = r.vel
      if (v > peak) peak = v
    }
    expect(peak).toBeGreaterThan(1.02)   // 过冲 >2%
    expect(peak).toBeLessThan(1.6)       // 但不过冲失控
  })

  test('静音门控：目标 0 时回到 0 且静止', () => {
    let v = 1
    let vel = 0
    for (let i = 0; i < 600; i++) {
      const r = springStep(v, vel, 0, 0.016)
      v = r.value
      vel = r.vel
    }
    expect(Math.abs(v)).toBeLessThan(0.01)
    expect(Math.abs(vel)).toBeLessThan(0.01)
  })

  test('长时间积分不发散/不产生 NaN', () => {
    let v = 0
    let vel = 0
    for (let i = 0; i < 5000; i++) {
      const r = springStep(v, vel, i % 60 < 30 ? 1 : 0, 0.033)
      v = r.value
      vel = r.vel
    }
    expect(Number.isFinite(v)).toBe(true)
    expect(Math.abs(v)).toBeLessThanOrEqual(2)
  })

  test('dt<=0 时保持不变', () => {
    const r = springStep(0.3, 1.2, 1, 0)
    expect(r.value).toBe(0.3)
    expect(r.vel).toBe(1.2)
  })
})

describe('pullTarget / clampPull 全局拉扯', () => {
  test('聆听=收缩（负）、播报=扩张（正）', () => {
    expect(pullTarget('listening', 1)).toBeLessThan(0)
    expect(pullTarget('speaking', 1)).toBeGreaterThan(0)
  })

  test('无关状态不拉扯（idle/thinking/muted/未知）', () => {
    for (const m of ['idle', 'thinking', 'muted', 'spectrum']) {
      expect(pullTarget(m, 1)).toBe(0)
    }
  })

  test('静音门控：vEff=0 时拉扯归零', () => {
    expect(pullTarget('listening', 0)).toBe(0)
    expect(pullTarget('speaking', 0)).toBe(0)
  })

  test('夹取到安全上限（防顶出画布）', () => {
    expect(clampPull(5)).toBe(ORB_DYN.pullMax)
    expect(clampPull(-5)).toBe(-ORB_DYN.pullMax)
    expect(clampPull(Number.NaN)).toBe(0)
    expect(clampPull(0.05)).toBe(0.05)
  })
})

describe('tideWeight 潮汐形变权重', () => {
  test('极点 +1、赤道 -0.5（四极子）', () => {
    expect(tideWeight(1)).toBeCloseTo(1, 5)
    expect(tideWeight(-1)).toBeCloseTo(1, 5)
    expect(tideWeight(0)).toBeCloseTo(-0.5, 5)
  })
})

describe('radialScale 软饱和（防点云溢出画布）', () => {
  test('零位移 → 半径不变', () => {
    expect(radialScale(0)).toBe(1)
  })

  test('中小位移近似线性（说话音量下的动态不被吃掉）', () => {
    expect(radialScale(0.17)).toBeCloseTo(1.17, 2)
    expect(radialScale(-0.1)).toBeCloseTo(0.9, 2)
  })

  test('有界：任意极端输入都不超过 ±dispMax', () => {
    for (const raw of [-100, -5, -1, 1, 5, 100]) {
      const d = radialScale(raw)
      expect(Math.abs(d - 1)).toBeLessThanOrEqual(ORB_DYN.dispMax + 1e-9)
    }
    // 实测满音量未饱和时会到 1.66×（溢出画布），饱和后必须收进余量内
    expect(radialScale(0.66)).toBeLessThan(1.31)
  })

  test('单调不减', () => {
    let prev = -1
    for (let raw = -1; raw <= 1.0001; raw += 0.05) {
      const cur = radialScale(raw)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })

  test('非法输入回退为不变', () => {
    expect(radialScale(Number.NaN)).toBe(1)
    expect(radialScale(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('isFastFresh 快速通道新鲜度', () => {
  test('从未收到 → 不新鲜（球退回静态）', () => {
    expect(isFastFresh(1000, 0)).toBe(false)
  })

  test('窗口内新鲜、超时陈旧', () => {
    expect(isFastFresh(1000, 900)).toBe(true)
    expect(isFastFresh(1000, 1000 - ORB_DYN.fastStaleMs - 1)).toBe(false)
  })
})
