/**
 * bootstrap 注入尾置回归测试（缓存优化 A, 2026-08-28）
 *
 * 背景：bootstrap（书签层 + 详细层：记忆全文/Instinct/facets/目标/线程/Scene）
 * 原注入首条 user 消息（h1 最旧历史）。内容随消息变化
 * （memoryPrompt=loadSmartContext 逐消息变）→ h1 字节变 → 历史前缀从 h1 起全量
 * cache miss（60.9% 缓存命中的最大残留失配源）。现注入末条 user 消息（当前消息），
 * 前缀 = stable system + 历史（字节稳定）全命中。
 *
 * 锁定断言：
 *  1. injectBootstrapIntoMessages 注入到最后一条 user 消息（历史非空时=当前消息）
 *  2. 首条 user 消息保持原样（前缀缓存稳定）
 *  3. 末条已含标记时防重复注入；无 user 消息时原样返回
 *  4. prepareAndCompressContext 集成链路注入位置 = 末条 user
 */

const {
  BOOTSTRAP_MARKER,
  BOOTSTRAP_BOOKMARK_MARKER,
  injectBootstrapIntoMessages,
} = require('../core/bootstrap-injector');
const { prepareAndCompressContext } = require('../core/ai/context-processor');

const DETAIL = `${BOOTSTRAP_MARKER}\n[记忆上下文] m\n</crabpaw-bootstrap>`;
const BOOKMARK = `${BOOTSTRAP_BOOKMARK_MARKER}\n[技能索引] x\n</crabpaw-bookmark>`;

describe('bootstrap 注入尾置（缓存优化 A）', () => {
  test('injectBootstrapIntoMessages 注入到最后一条 user 消息，首条 user 保持原样', () => {
    const messages = [
      { role: 'user', content: '历史第一问' },
      { role: 'assistant', content: '历史第一答' },
      { role: 'user', content: '当前问题' },
    ];
    const result = injectBootstrapIntoMessages(messages, DETAIL);
    // 首条 user 原样 → 历史前缀字节稳定（缓存命中）
    expect(result[0].content).toBe('历史第一问');
    // 末条 user 含注入内容且保留原文
    expect(result[2].content.startsWith(BOOTSTRAP_MARKER)).toBe(true);
    expect(result[2].content).toContain('当前问题');
    // 原地变异（调用方引用一致）
    expect(result).toBe(messages);
  });

  test('历史为空时注入当前消息本身', () => {
    const messages = [{ role: 'user', content: '你好' }];
    const result = injectBootstrapIntoMessages(messages, DETAIL);
    expect(result[0].content.startsWith(BOOTSTRAP_MARKER)).toBe(true);
    expect(result[0].content).toContain('你好');
  });

  test('末条 user 已含标记时跳过（防重复注入）', () => {
    const messages = [
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: DETAIL },
    ];
    const result = injectBootstrapIntoMessages(messages, DETAIL);
    expect(result[1].content).toBe(DETAIL);
  });

  test('早期历史 user 携带旧标记不阻断末条注入（每轮尾置刷新）', () => {
    const messages = [
      { role: 'user', content: DETAIL },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '新问题' },
    ];
    const result = injectBootstrapIntoMessages(messages, DETAIL);
    expect(result[0].content).toBe(DETAIL);
    expect(result[2].content.startsWith(BOOTSTRAP_MARKER)).toBe(true);
    expect(result[2].content).toContain('新问题');
  });

  test('无 user 消息时原样返回', () => {
    const messages = [{ role: 'system', content: 'sys' }];
    const result = injectBootstrapIntoMessages(messages, DETAIL);
    expect(result).toBe(messages);
  });

  test('中间历史 user 消息不被注入（历史字节稳定）', () => {
    const messages = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二问' },
      { role: 'assistant', content: '第二答' },
      { role: 'user', content: '第三问' },
    ];
    const result = injectBootstrapIntoMessages(messages, DETAIL);
    expect(result[0].content).toBe('第一问');
    expect(result[2].content).toBe('第二问');
    expect(result[4].content.startsWith(BOOTSTRAP_MARKER)).toBe(true);
  });
});

describe('prepareAndCompressContext 注入链路（尾置集成）', () => {
  test('书签层+详细层注入落在末条 user 消息', async () => {
    const messages = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '当前问' },
    ];
    const result = await prepareAndCompressContext({
      messages,
      bookmarkContent: BOOKMARK,
      bootstrapContent: DETAIL,
      contextCompressor: {
        maxTokens: 128000,
        async compress(msgs) {
          return { messages: msgs, compressed: false, originalTokens: 100 };
        },
      },
      focusTopic: '当前问',
      userId: 'test-user',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    const last = result.compressedMessages[result.compressedMessages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('crabpaw-bookmark');
    expect(last.content).toContain(BOOTSTRAP_MARKER);
    expect(last.content).toContain('当前问');
    // 首条 user 原样（前缀缓存稳定）
    expect(result.compressedMessages[0].content).toBe('第一问');
  });

  test('bookmark 为 null 时仅详细层注入末条 user', async () => {
    const messages = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '当前问' },
    ];
    const result = await prepareAndCompressContext({
      messages,
      bookmarkContent: null,
      bootstrapContent: DETAIL,
      contextCompressor: {
        maxTokens: 128000,
        async compress(msgs) {
          return { messages: msgs, compressed: false, originalTokens: 100 };
        },
      },
      focusTopic: '当前问',
      userId: 'test-user',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    const last = result.compressedMessages[result.compressedMessages.length - 1];
    expect(last.content.startsWith(BOOTSTRAP_MARKER)).toBe(true);
    expect(result.compressedMessages[0].content).toBe('第一问');
  });
});
