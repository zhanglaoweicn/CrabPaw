import { nextPhaseThreshold, phaseText, sceneFromPhase } from './holo-phase'

describe('nextPhaseThreshold (30/60/90 阈值触发)', () => {
  test('progress=0 + 空 done → null（未达任何阈值）', () => {
    expect(nextPhaseThreshold(0, new Set())).toBeNull()
  })

  test('progress=30 + 空 done → 触发 30', () => {
    expect(nextPhaseThreshold(30, new Set())).toBe(30)
  })

  test('progress=29 + 空 done → null（未达 30）', () => {
    expect(nextPhaseThreshold(29, new Set())).toBeNull()
  })

  test('progress=30 但 done 已含 30 → null（不重复触发）', () => {
    expect(nextPhaseThreshold(30, new Set([30]))).toBeNull()
  })

  test('progress=40 + done 已含 30 → null（40 < 60，下一个阈值未达）', () => {
    expect(nextPhaseThreshold(40, new Set([30]))).toBeNull()
  })

  test('progress=60 + done 已含 30 → 触发 60', () => {
    expect(nextPhaseThreshold(60, new Set([30]))).toBe(60)
  })

  test('progress=90 + done 已含 30,60 → 触发 90', () => {
    expect(nextPhaseThreshold(90, new Set([30, 60]))).toBe(90)
  })

  test('progress=99 + done 已含 30,60,90 → null（全部消费完毕）', () => {
    expect(nextPhaseThreshold(99, new Set([30, 60, 90]))).toBeNull()
  })

  test('progress=65（从 29 跳至 65，done 为空）→ 先触发 30（依次消费）', () => {
    expect(nextPhaseThreshold(65, new Set())).toBe(30)
  })

  test('progress=65 + done 已含 30 → 触发 60（跳过 30，消费下一个）', () => {
    expect(nextPhaseThreshold(65, new Set([30]))).toBe(60)
  })

  test('progress=100 + done 已含 30,60 → 触发 90', () => {
    expect(nextPhaseThreshold(100, new Set([30, 60]))).toBe(90)
  })

  test('done 集合消费——逐步添加验证', () => {
    const done = new Set<number>()
    // 首次 progress=35 → 触发 30
    expect(nextPhaseThreshold(35, done)).toBe(30)
    done.add(30)
    // 再调 progress=65 → 触发 60
    expect(nextPhaseThreshold(65, done)).toBe(60)
    done.add(60)
    // 再调 progress=95 → 触发 90
    expect(nextPhaseThreshold(95, done)).toBe(90)
    done.add(90)
    // 全部消费后 → null
    expect(nextPhaseThreshold(99, done)).toBeNull()
  })
})

describe('phaseText (阈值 → 播报文案)', () => {
  test('30 + 无场景 → 中性文案', () => {
    expect(phaseText(30)).toBe('进度 30%，正在分析中...')
  })

  test('60 + 无场景 → 中性文案', () => {
    expect(phaseText(60)).toBe('进度 60%，已有初步发现...')
  })

  test('90 + 无场景 → 中性文案', () => {
    expect(phaseText(90)).toBe('进度 90%，即将完成...')
  })

  test('30 + data 场景 → 数据文案', () => {
    expect(phaseText(30, 'data')).toBe('正在识别数据维度...')
  })

  test('60 + data 场景 → 数据文案', () => {
    expect(phaseText(60, 'data')).toBe('发现季节性波动，继续深挖...')
  })

  test('90 + data 场景 → 数据文案', () => {
    expect(phaseText(90, 'data')).toBe('即将完成，正在汇总关键结论...')
  })

  test('30 + analytics 场景 → 同 data 文案', () => {
    expect(phaseText(30, 'analytics')).toBe('正在识别数据维度...')
  })

  test('30 + dashboard 场景 → 同 data 文案', () => {
    expect(phaseText(30, 'dashboard')).toBe('正在识别数据维度...')
  })

  test('未知阈值 → 兜底文案', () => {
    expect(phaseText(50)).toBe('进度 50%')
  })
})

describe('sceneFromPhase (phase → 场景映射)', () => {
  test('research → data', () => {
    expect(sceneFromPhase('research')).toBe('data')
  })

  test('execute → data', () => {
    expect(sceneFromPhase('execute')).toBe('data')
  })

  test('deliver → data', () => {
    expect(sceneFromPhase('deliver')).toBe('data')
  })

  test('plan → undefined（无专属文案场景）', () => {
    expect(sceneFromPhase('plan')).toBeUndefined()
  })

  test('review → undefined（无专属文案场景）', () => {
    expect(sceneFromPhase('review')).toBeUndefined()
  })

  test('未知 phase → undefined', () => {
    expect(sceneFromPhase('unknown')).toBeUndefined()
  })

  test('空字符串 → undefined', () => {
    expect(sceneFromPhase('')).toBeUndefined()
  })
})
