/**
 * 专家音色人设 (P4) — 后端 voiceStyle 字段测试
 */
const { describe, expect, it } = require('@jest/globals')
const experts = require('../core/experts')

describe('专家音色人设 (P4)', () => {
  it('内置专家全部带非空 voiceStyle', () => {
    const list = experts.getAllExperts()
    const builtins = list.filter(e => e.builtin === true)
    // 2026-08-28 EX-1: 内置 4→11 位（老板视角专家体系 7 新增）——断言同步
    expect(builtins.length).toBe(11)
    for (const e of builtins) {
      expect(typeof e.voiceStyle).toBe('string')
      expect(e.voiceStyle.trim().length).toBeGreaterThan(0)
    }
  })

  it('自定义专家兜底：无 voiceStyle 时输出默认人设（数据集无自定义专家则跳过）', () => {
    const list = experts.getAllExperts()
    const custom = list.filter(e => e.builtin === false)
    if (custom.length === 0) return // 当前数据集无自定义专家，跳过
    for (const e of custom) {
      expect(e.voiceStyle).toBe('自然亲切的助手口吻')
    }
  })
})
