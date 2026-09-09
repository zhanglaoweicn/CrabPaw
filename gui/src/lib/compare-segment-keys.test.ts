import { describe, test, expect } from 'vitest'
import { compareSegmentKeys } from './compare-segment-keys'

describe('compareSegmentKeys 会议转写段排序', () => {
  test('段号 >9 时按数值序而非字典序', () => {
    const keys = ['seg_2', 'seg_10', 'seg_1', 'seg_11', 'seg_9']
    expect([...keys].sort(compareSegmentKeys)).toEqual(['seg_1', 'seg_2', 'seg_9', 'seg_10', 'seg_11'])
  })
  test('时间戳形 key（如 20260829-143001-003）数值段生效', () => {
    const keys = ['20260829-143001-10', '20260829-143001-2', '20260829-143001-1']
    expect([...keys].sort(compareSegmentKeys)).toEqual(['20260829-143001-1', '20260829-143001-2', '20260829-143001-10'])
  })
  test('非数值 key 退化为字典序（localeCompare 语义）', () => {
    expect(compareSegmentKeys('a', 'b')).toBeLessThan(0)
    expect(compareSegmentKeys('b', 'a')).toBeGreaterThan(0)
    expect(compareSegmentKeys('same', 'same')).toBe(0)
  })
})
