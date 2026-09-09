/**
 * anti-narration 反口播引导测试
 *
 * 背景(2026-08-13): scene 工具通过 display 字段表明"卡片已渲染给用户"，
 * 但 LLM 常复述卡片内容形成双份通知。withAntiNarrationHint 在工具结果
 * 序列化后追加系统提示，引导只给结论。
 */
const { withAntiNarrationHint, hasSurfaceDisplay, HINT } = require('./anti-narration');

describe('hasSurfaceDisplay(卡片展示语义检测)', () => {
  test('顶层 display 字段命中', () => {
    expect(hasSurfaceDisplay({ display: 'Surface "x" kind updated (rev 3)' })).toBe(true)
  })

  test('data.display 嵌套命中', () => {
    expect(hasSurfaceDisplay({ data: { display: 'Progress "x" = 42%' } })).toBe(true)
  })

  test('无 display 的普通工具结果不命中', () => {
    expect(hasSurfaceDisplay({ rows: [{ id: 1 }] })).toBe(false)
  })

  test('字符串/原始值不命中', () => {
    expect(hasSurfaceDisplay('just text')).toBe(false)
    expect(hasSurfaceDisplay(null)).toBe(false)
    expect(hasSurfaceDisplay(undefined)).toBe(false)
  })
})

describe('withAntiNarrationHint(追加反口播标记)', () => {
  test('含 display 的结果追加提示', () => {
    const out = withAntiNarrationHint('{"display":"x"}', { display: 'x' })
    expect(out).toContain(HINT)
    expect(out).toContain('不要复述卡片')
  })

  test('无 display 的结果原样返回', () => {
    const content = '{"ok":true}'
    expect(withAntiNarrationHint(content, { ok: true })).toBe(content)
  })

  test('非字符串 contentResult 原样返回', () => {
    expect(withAntiNarrationHint(undefined, { display: 'x' })).toBe(undefined)
  })

  test('字符串型结果(无卡片)不追加', () => {
    const text = 'file written'
    expect(withAntiNarrationHint(text, text)).toBe(text)
  })

  test('不修改工具结果对象本身(只改文本)', () => {
    const result = { display: 'x', data: { progress: 42 } }
    const snapshot = JSON.stringify(result)
    withAntiNarrationHint('{}', result)
    expect(JSON.stringify(result)).toBe(snapshot)
  })
})
