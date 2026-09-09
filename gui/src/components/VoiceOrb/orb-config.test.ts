import { MODE_CFG, SPECTRUM_CFG, mixColor } from './index'

describe('VoiceOrb MODE_CFG (P5.5 5 态)', () => {
  const REQUIRED_STATES = ['idle', 'listening', 'thinking', 'speaking', 'muted']

  test('5 态齐全', () => {
    for (const s of REQUIRED_STATES) {
      expect(MODE_CFG[s]).toBeDefined()
    }
  })

  test('fx 定义: thinking 为 scanring, speaking 为 pulse; 其余态无 fx (聆听涟漪已按用户反馈移除)', () => {
    expect(MODE_CFG.thinking.fx?.type).toBe('scanring')
    expect(MODE_CFG.speaking.fx?.type).toBe('pulse')
    expect(MODE_CFG.listening.fx).toBeUndefined()  // P5.5 用户反馈: 聆听只保留金色球体波动
    expect(MODE_CFG.muted.fx).toBeUndefined()      // 静音无动画
    expect(MODE_CFG.idle.fx).toBeUndefined()       // 待机无特效
  })

  test('思考态配色为品牌橙 (r 主色)', () => {
    const t = MODE_CFG.thinking
    expect(t.r[0]).toBeGreaterThan(150)   // 暗端偏橙红
    expect(t.g[0]).toBeLessThan(t.r[0])   // 绿弱于红
  })
})

// ─── P7 Task 1: mixColor 纯函数 ──────────────────────────────
describe('mixColor 色值混合', () => {
  test('按权重 0.6 混合', () => {
    expect(mixColor([249, 115, 22], [0, 200, 255], 0.6)).toEqual([100, 166, 162])
  })

  test('权重 0 返回 base 原色', () => {
    expect(mixColor([249, 115, 22], [0, 200, 255], 0)).toEqual([249, 115, 22])
  })

  test('权重 1 返回 tint 原色', () => {
    expect(mixColor([249, 115, 22], [0, 200, 255], 1)).toEqual([0, 200, 255])
  })

  test('权重超出 [0,1] 范围时自动钳位', () => {
    expect(mixColor([100, 100, 100], [200, 200, 200], -0.5)).toEqual([100, 100, 100])
    expect(mixColor([100, 100, 100], [200, 200, 200], 1.5)).toEqual([200, 200, 200])
  })
})

// ─── P7 Task 1: SPECTRUM_CFG 频谱形态 ────────────────────────
describe('SPECTRUM_CFG 频谱形态配置', () => {
  test('频谱配置已导出', () => {
    expect(SPECTRUM_CFG).toBeDefined()
  })

  test('频谱旋转速度更高 (rotSpd >= 1.5)', () => {
    expect(SPECTRUM_CFG.rotSpd).toBeGreaterThanOrEqual(1.5)
  })

  test('频谱音量放大系数更高 (volAmp >= 1.0)', () => {
    expect(SPECTRUM_CFG.volAmp).toBeGreaterThanOrEqual(1.0)
  })

  test('频谱基础色为暖橙→玫红系 (r 暗端 > 200)', () => {
    expect(SPECTRUM_CFG.r[0]).toBeGreaterThan(200)
  })
})
