/**
 * ai-utils.isEmptyInvalidReply 测试
 *
 * 背景(2026-08-06): deepseek-v4-flash 对模糊/口语输入输出 "```json\n[]\n```"，
 * 被透传成用户看到的空白回复。此函数统一检测无效空输出。
 */
const { isEmptyInvalidReply } = require('../core/ai-utils');

describe('isEmptyInvalidReply(空 JSON/无效回复检测)', () => {
  test('JSON 空数组被识别为无效', () => {
    expect(isEmptyInvalidReply('[]')).toBe(true)
  })

  test('JSON 空对象被识别为无效', () => {
    expect(isEmptyInvalidReply('{}')).toBe(true)
  })

  test('```json 包裹的空数组被识别为无效', () => {
    expect(isEmptyInvalidReply('```json\n[]\n```')).toBe(true)
  })

  test('``` 包裹的空数组被识别为无效', () => {
    expect(isEmptyInvalidReply('```\n[]\n```')).toBe(true)
  })

  test('null / undefined 字符串被识别为无效', () => {
    expect(isEmptyInvalidReply('null')).toBe(true)
    expect(isEmptyInvalidReply('undefined')).toBe(true)
  })

  test('空字符串被识别为无效', () => {
    expect(isEmptyInvalidReply('')).toBe(true)
    expect(isEmptyInvalidReply('   ')).toBe(true)
  })

  test('正常回复不被误判', () => {
    expect(isEmptyInvalidReply('哎呀，一个月五百积分确实挺坑的。')).toBe(false)
    expect(isEmptyInvalidReply('好的，已帮你搜索《铁血丹心》。')).toBe(false)
    expect(isEmptyInvalidReply('好的')).toBe(false)
    expect(isEmptyInvalidReply('抱歉，我刚才没听清您的问题。')).toBe(false)
  })

  test('非字符串输入被识别为无效', () => {
    expect(isEmptyInvalidReply(null)).toBe(true)
    expect(isEmptyInvalidReply(undefined)).toBe(true)
  })
})
