const { splitSyllable, buildKeywordsFile, validateWakeWord } = require('./keywords')

describe('splitSyllable', () => {
  test('带声母音节拆分为 声母+韵母', () => {
    expect(splitSyllable('xiǎo')).toBe('x iǎo')
    expect(splitSyllable('bái')).toBe('b ái')
    expect(splitSyllable('lóng')).toBe('l óng')
  })
  test('双字母声母 zh/ch/sh 优先匹配', () => {
    // 期望值以 pinyin-pro 实际输出为准（zh/ch/sh 作为整体声母拆分）
    expect(splitSyllable('zhù')).toBe('zh ù')
    expect(splitSyllable('shǒu')).toBe('sh ǒu')
    expect(splitSyllable('chá')).toBe('ch á')
  })
  test('无韵头音节原样返回', () => {
    expect(splitSyllable('èr')).toBe('èr')
  })
})

describe('buildKeywordsFile', () => {
  test('小助手 → 带标签的完整词表行', () => {
    const out = buildKeywordsFile('小助手')
    expect(out.trim()).toBe('x iǎo zh ù sh ǒu @小助手')
  })
  test('小螃蟹（品牌默认唤醒词）→ 完整词表行', () => {
    const out = buildKeywordsFile('小螃蟹')
    expect(out.trim()).toBe('x iǎo p áng x iè @小螃蟹')
  })
  test('四字词表', () => {
    const out = buildKeywordsFile('聪明助手')
    expect(out.trim()).toMatch(/@聪明助手$/)
  })
  test('无效输入抛错', () => {
    expect(() => buildKeywordsFile('')).toThrow()
    expect(() => buildKeywordsFile('ab12')).toThrow()
  })
})

describe('validateWakeWord', () => {
  test('2-6 个中文字符合法', () => {
    expect(validateWakeWord('小助手').ok).toBe(true)
    expect(validateWakeWord('聪明小助手').ok).toBe(true)
  })
  test('非中文/超长/为空非法', () => {
    expect(validateWakeWord('').ok).toBe(false)
    expect(validateWakeWord('hello').ok).toBe(false)
    expect(validateWakeWord('一二三四五六七').ok).toBe(false)
  })
})
