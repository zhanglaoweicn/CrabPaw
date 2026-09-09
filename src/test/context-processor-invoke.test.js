/**
 * prepareAndCompressContext 调用安全回归测试（2026-08-17）
 *
 * 实机 bug：输入"查 大华股份" → 回复"出错"。
 * 根因：4e315f2 在 prepareAndCompressContext 入口加的读取侧过滤写了
 *   `messages = sanitized;` —— 但 messages 是从 deps 解构的 const，
 *   每次调用必抛 ReferenceError: Assignment to constant variable
 *   （日志：❌ 流式聊天失败: Assignment to constant variable）。
 * 修复：原地变异（messages.length = 0; push(...sanitized)），
 *   与网关预压缩的既有模式一致。
 *
 * 此测试直接调用 prepareAndCompressContext，确保含污染消息时不抛错
 * 且过滤生效——此前单测只测 sanitizeInternalNoise 纯函数，未覆盖调用链。
 */

const { prepareAndCompressContext } = require('../core/ai/context-processor');

const EXTRACT = 'Extract key info from this conversation turn. Return JSON array. ...';

function buildDeps(messages, extra = {}) {
  return {
    messages,
    bookmarkContent: null,
    bootstrapContent: null,
    contextCompressor: {
      maxTokens: 128000,
      async compress(msgs) {
        return { messages: msgs, compressed: false, originalTokens: 100 };
      },
    },
    focusTopic: '查 大华股份',
    userId: 'test-user',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    ...extra,
  };
}

describe('prepareAndCompressContext 调用安全（回归: Assignment to constant variable）', () => {
  test('含提取污染消息时不抛错，过滤生效且保留用户消息', async () => {
    const messages = [
      { role: 'user', content: EXTRACT },
      { role: 'assistant', content: '```json\n[]\n```\n\n不提取。' },
      { role: 'user', content: '查 大华股份' },
    ];
    const result = await prepareAndCompressContext(buildDeps(messages));
    expect(result.compressedMessages).toBeDefined();
    const texts = result.compressedMessages.map(m => m.content || '');
    expect(texts.some(t => t.startsWith(EXTRACT))).toBe(false);
    expect(texts.some(t => t.includes('大华股份'))).toBe(true);
  });

  test('无污染消息时正常返回（零开销路径不抛错）', async () => {
    const messages = [{ role: 'user', content: '你好' }];
    const result = await prepareAndCompressContext(buildDeps(messages));
    expect(result.compressedMessages.length).toBeGreaterThan(0);
  });

  test('原始消息数组被原地过滤（调用方引用一致性）', async () => {
    const messages = [
      { role: 'user', content: EXTRACT },
      { role: 'user', content: '播放铁血丹心' },
    ];
    const result = await prepareAndCompressContext(buildDeps(messages));
    // 原地变异：调用方持有的同一数组应已被过滤（不再含提取指令）
    expect(messages.some(m => m.content.startsWith(EXTRACT))).toBe(false);
    expect(messages.some(m => m.content === '播放铁血丹心')).toBe(true);
    // 返回值与输入数组同一引用
    expect(result.compressedMessages).toBe(messages);
  });
});
