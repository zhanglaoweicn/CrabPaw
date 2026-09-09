const { describe, expect, it } = require('@jest/globals')
const experts = require('../core/experts')
const autoCollab = require('../core/experts/auto-collab')

// auto-collab.js 在 pickDefaultExperts 内部 require('./index')，与测试里
// require('../core/experts') 命中同一模块缓存，因此 spyOn 可以精确控制路由命中数。
describe('auto-collab 默认专家兜底（2026-08-21 review Important 1）', () => {
  it('路由命中不足 2 位专家时，兜底为现存老板专家 id', () => {
    const spy = jest.spyOn(experts, 'routeMessage').mockReturnValue([
      { expertId: 'boss_cockpit', name: '老板驾驶舱', score: 100, matchedKeywords: ['经营'], reason: '匹配关键词: 经营' },
    ])
    try {
      const picked = autoCollab.pickDefaultExperts('多个专家一起分析下经营状况')
      expect(picked).toEqual(['boss_cockpit', 'finance_advisor'])
      const existingIds = new Set(experts.getAllExperts().map(e => e.id))
      for (const id of picked) {
        expect(existingIds.has(id)).toBe(true)
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('路由零命中时同样退回兜底专家', () => {
    const spy = jest.spyOn(experts, 'routeMessage').mockReturnValue([])
    try {
      expect(autoCollab.pickDefaultExperts('多个专家协作分析')).toEqual(['boss_cockpit', 'finance_advisor'])
    } finally {
      spy.mockRestore()
    }
  })

  it('路由命中 ≥2 位专家时使用路由结果（不触发兜底）', () => {
    const spy = jest.spyOn(experts, 'routeMessage').mockReturnValue([
      { expertId: 'boss_cockpit', name: '老板驾驶舱', score: 100, matchedKeywords: ['经营'], reason: '匹配关键词: 经营' },
      { expertId: 'finance_advisor', name: '财务顾问', score: 90, matchedKeywords: ['财务'], reason: '匹配关键词: 财务' },
    ])
    try {
      expect(autoCollab.pickDefaultExperts('多个专家一起分析经营和财务')).toEqual(['boss_cockpit', 'finance_advisor'])
    } finally {
      spy.mockRestore()
    }
  })

  it('协作意图消息走真实路由时，兜底 id 均为现存专家（集成冒烟）', () => {
    expect(autoCollab.isCollabIntent('多个专家一起分析下经营状况')).toBe(true)
    const picked = autoCollab.pickDefaultExperts('多个专家一起分析下经营状况')
    const existingIds = new Set(experts.getAllExperts().map(e => e.id))
    expect(picked.length).toBeGreaterThanOrEqual(2)
    for (const id of picked) {
      expect(existingIds.has(id)).toBe(true)
    }
  })
})
