/**
 * context-processor 读取侧过滤测试（2026-08-17 答非所问根因兜底）
 *
 * 根因：auto-dream resolveLLMCall 把记忆提取 prompt（"Extract key info..."）当
 * message 传 ai.chat() → chat() 写入主对话历史 → 模型把用户消息当提取任务 →
 * 回复 "```json\n[]\n```…不提取"（驴唇不对马嘴）。
 * silent 参数阻止新增污染；sanitizeInternalNoise 兜底剔除历史已有污染：
 *  - role=user 以提取指令前缀开头 → 剔除
 *  - 紧跟其后的 role=assistant ```json 短回复（<600 字符）→ 提取结果，剔除
 */

const { sanitizeInternalNoise } = require('../core/ai/context-processor');

const EXTRACT = 'Extract key info from this conversation turn. Return JSON array. ...';

describe('sanitizeInternalNoise（内部提取噪声过滤）', () => {
  test('剔除提取指令消息与紧跟的提取 JSON 回复', () => {
    const messages = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: EXTRACT },
      { role: 'assistant', content: '```json\n[]\n```\n\n本回合用户消息为一次性播放指令，不提取。' },
      { role: 'user', content: '播放铁血丹心' },
      { role: 'assistant', content: '好的，已播放。' },
    ];
    const out = sanitizeInternalNoise(messages);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[1]).toEqual({ role: 'user', content: '播放铁血丹心' });
    expect(out[2]).toEqual({ role: 'assistant', content: '好的，已播放。' });
  });

  test('连续多条提取指令成批剔除，正常对话保留', () => {
    const messages = [
      { role: 'user', content: EXTRACT + 'A' },
      { role: 'user', content: EXTRACT + 'B' },
      { role: 'user', content: EXTRACT + 'C' },
      { role: 'assistant', content: '```json\n[{"type":"intent","content":"x"}]\n```' },
      { role: 'user', content: '生成报告' },
    ];
    const out = sanitizeInternalNoise(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('生成报告');
  });

  test('无污染消息时返回原数组（引用不变，零开销）', () => {
    const messages = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
    ];
    expect(sanitizeInternalNoise(messages)).toBe(messages);
  });

  test('紧跟提取指令的长回复（>=600 字符）保留——保守只删短提取结果', () => {
    const longReply = '```json\n' + 'x'.repeat(700);
    const messages = [
      { role: 'user', content: EXTRACT },
      { role: 'assistant', content: longReply },
    ];
    // 不满足 <600 条件 → 不判定为提取结果，保留（避免误删正常内容）
    const out = sanitizeInternalNoise(messages);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe(longReply);
  });

  test('非紧跟提取指令的 assistant JSON 回复保留（正常工具结果）', () => {
    const messages = [
      { role: 'user', content: '查一下股票' },
      { role: 'assistant', content: '```json\n{"price": 10}\n```' },
    ];
    const out = sanitizeInternalNoise(messages);
    expect(out).toHaveLength(2);
  });

  test('空数组/非数组输入安全', () => {
    expect(sanitizeInternalNoise([])).toEqual([]);
    expect(sanitizeInternalNoise(null)).toBeNull();
  });
});
