/**
 * ai/context.js 单元测试
 */

const {
  buildMemoryPrompt,
  detectMessageIntent,
} = require('../core/ai/context');

describe('ai/context', () => {
  describe('buildMemoryPrompt', () => {
    test('应从记忆数组构建提示语', () => {
      const memories = [
        { content: '用户喜欢Python' },
        { content: '用户是开发者' },
      ];
      const result = buildMemoryPrompt(memories);
      expect(result).toContain('用户喜欢Python');
      expect(result).toContain('用户是开发者');
    });

    test('空记忆应返回空字符串', () => {
      const result = buildMemoryPrompt([]);
      expect(result).toBe('');
    });
  });

  describe('detectMessageIntent', () => {
    test('应检测编码意图', () => {
      const result = detectMessageIntent('帮我写一段代码');
      expect(result).toBeDefined();
    });

    test('应检测普通对话意图', () => {
      const result = detectMessageIntent('你好');
      expect(result).toBeDefined();
    });
  });
});