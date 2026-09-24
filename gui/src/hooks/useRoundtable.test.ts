import { describe, expect, it } from 'vitest'
import { RT_PHASES, rtDeptColor, rtPhaseIndex, rtPhaseLabel } from './useRoundtable'

describe('rtPhaseLabel（会议阶段 → 人话）', () => {
  it('覆盖后端全部五个阶段（_setPhase 调用点）', () => {
    expect(rtPhaseLabel('round1')).toBe('第 1 轮 · 各自陈述')
    expect(rtPhaseLabel('round2')).toBe('第 2 轮 · 交叉质询')
    expect(rtPhaseLabel('synthesis')).toBe('主持人收口')
    expect(rtPhaseLabel('document')).toBe('生成会议纪要')
    expect(rtPhaseLabel('done')).toBe('已结束')
  })

  it('未知阶段回落轮次数字，不编造说法', () => {
    expect(rtPhaseLabel('whatever', 2)).toBe('第 2 轮')
  })

  it('阶段与轮次都缺失时返回空串（横幅不渲染空 chip）', () => {
    expect(rtPhaseLabel()).toBe('')
    expect(rtPhaseLabel('')).toBe('')
    expect(rtPhaseLabel(undefined, 0)).toBe('')
  })
})

describe('rtPhaseIndex', () => {
  it('按阶段序列给出位置，可用于进度指示', () => {
    expect(rtPhaseIndex('round1')).toBe(0)
    expect(rtPhaseIndex('synthesis')).toBe(2)
    expect(rtPhaseIndex('done')).toBe(4)
  })

  it('未知阶段返回 -1——调用方据此不显示进度', () => {
    expect(rtPhaseIndex('nope')).toBe(-1)
    expect(rtPhaseIndex(undefined)).toBe(-1)
  })

  it('RT_PHASES 与后端 broadcast 顺序一致（round1→round2→收口→文档→结束）', () => {
    expect([...RT_PHASES]).toEqual(['round1', 'round2', 'synthesis', 'document', 'done'])
  })
})

describe('rtDeptColor', () => {
  it('部门有色取色，未知部门回落中性灰', () => {
    expect(rtDeptColor('finance')).toBe('#e91e63')
    expect(rtDeptColor('unknown')).toBe('#607d8b')
    expect(rtDeptColor()).toBe('#607d8b')
  })
})
