import { toProactiveNotice, INTENT_META } from './proactive-meta'

describe('proactive-meta', () => {
  test('合法事件 → ProactiveNotice（intent 默认 inform）', () => {
    const n = toProactiveNotice({ trigger: 'reminder', text: '老板，会议 15 分钟后开始' })
    expect(n).toEqual({ trigger: 'reminder', text: '老板，会议 15 分钟后开始', intent: 'inform', ts: expect.any(Number), surface: undefined })
    expect(n?.intent).toBe('inform')
  })

  test('未知 intent 回落 inform；silent 保留', () => {
    expect(toProactiveNotice({ text: 'x', intent: 'weird' })?.intent).toBe('inform')
    expect(toProactiveNotice({ text: 'x', intent: 'silent' })?.intent).toBe('silent')
  })

  test('空文本/非法事件 → null', () => {
    expect(toProactiveNotice(null)).toBeNull()
    expect(toProactiveNotice({ trigger: 'r' })).toBeNull()
    expect(toProactiveNotice({ text: '   ' })).toBeNull()
  })

  test('INTENT_META 覆盖四种 intent', () => {
    expect(Object.keys(INTENT_META).sort()).toEqual(['ambient', 'confront', 'inform', 'silent'])
    expect(INTENT_META.confront.color).toBe('#f44336')
  })
})
