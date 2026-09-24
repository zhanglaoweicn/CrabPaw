import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCommandUsage,
  rankCommandIds,
  recordCommandUse,
  __resetUsageForTest,
} from './command-usage'

describe('command-usage', () => {
  beforeEach(() => {
    __resetUsageForTest()
  })

  describe('rankCommandIds（纯函数）', () => {
    it('无记录时保持原清单顺序（新用户不退化）', () => {
      expect(rankCommandIds(['a', 'b', 'c'], {})).toEqual(['a', 'b', 'c'])
    })

    it('高频项浮到前面', () => {
      const usage = { c: { count: 5, lastUsedAt: 1 }, a: { count: 2, lastUsedAt: 2 } }
      expect(rankCommandIds(['a', 'b', 'c'], usage)).toEqual(['c', 'a', 'b'])
    })

    it('次数相同则保持原顺序（稳定，不抖动）', () => {
      const usage = { a: { count: 1, lastUsedAt: 1 }, b: { count: 1, lastUsedAt: 1 } }
      expect(rankCommandIds(['a', 'b', 'c'], usage)).toEqual(['a', 'b', 'c'])
    })

    it('有记录但次数相同时，有记录的仍在无记录之前', () => {
      const usage = { c: { count: 1, lastUsedAt: 1 } }
      expect(rankCommandIds(['a', 'b', 'c'], usage)).toEqual(['c', 'a', 'b'])
    })

    it('不就地修改入参', () => {
      const ids = ['a', 'b']
      rankCommandIds(ids, { b: { count: 9, lastUsedAt: 1 } })
      expect(ids).toEqual(['a', 'b'])
    })

    it('空列表安全', () => {
      expect(rankCommandIds([], {})).toEqual([])
    })
  })

  describe('记录与持久化', () => {
    it('每记一次 count 加一', () => {
      recordCommandUse('present-toggle', 1000)
      recordCommandUse('present-toggle', 2000)
      const u = getCommandUsage()
      expect(u['present-toggle']).toEqual({ count: 2, lastUsedAt: 2000 })
    })

    it('空 id 不记录（防脏键）', () => {
      recordCommandUse('')
      expect(getCommandUsage()).toEqual({})
    })

    it('记录后能驱动排序', () => {
      recordCommandUse('c', 1)
      recordCommandUse('c', 2)
      recordCommandUse('a', 3)
      expect(rankCommandIds(['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
    })

    it('损坏的存档不炸，降级为无记录', () => {
      localStorage.setItem('crabpaw.commandUsage.v1', '{不是 JSON')
      expect(getCommandUsage()).toEqual({})
    })

    it('过滤掉形状不对的条目（count <= 0 / 非对象）', () => {
      localStorage.setItem('crabpaw.commandUsage.v1', JSON.stringify({
        good: { count: 3, lastUsedAt: 10 },
        zero: { count: 0, lastUsedAt: 10 },
        junk: 'x',
      }))
      expect(Object.keys(getCommandUsage())).toEqual(['good'])
    })

    it('超过上限时丢弃最久未用的', () => {
      for (let i = 0; i < 85; i++) recordCommandUse(`cmd${i}`, 1000 + i)
      const u = getCommandUsage()
      expect(Object.keys(u).length).toBe(80)
      expect(u.cmd0).toBeUndefined()      // 最早被挤出
      expect(u.cmd84).toBeDefined()       // 最近的留下
    })
  })
})
