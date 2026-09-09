/**
 * ai.js 烟雾测试 - 验证核心模块加载与基础接口
 */

describe('ai.js 烟雾测试', () => {
  let ai;

  beforeAll(() => {
    // 设置测试环境变量，避免真实API调用
    process.env.NODE_ENV = 'test';
    ai = require('../core/ai');
  });

  afterAll(() => {
    // 清除 ai.js 模块级 setTimeout 避免 Jest teardown 后异步泄漏
    const lifecycleManager = require('../core/lifecycle-manager');
    lifecycleManager.shutdown?.();
    ai.globalHeartbeatPatrol?.stop();
    const { contextCache } = require('../core/context-cache');
    contextCache?.destroy();
    const { getThreatPatternLoader } = require('../core/security/threat-pattern-loader');
    getThreatPatternLoader()?.destroy();
    jest.clearAllTimers();
  });

  test('模块应正确加载', () => {
    expect(ai).toBeTruthy();
    expect(typeof ai).toBe('object');
  });

  test('应导出 chat 函数', () => {
    expect(typeof ai.chat).toBe('function');
  });

  test('应导出 enhancedChat 函数', () => {
    expect(typeof ai.enhancedChat).toBe('function');
  });

  test('应导出 summarize 函数', () => {
    expect(typeof ai.summarize).toBe('function');
  });

  test('应导出 parseSkillCall 函数', () => {
    expect(typeof ai.parseSkillCall).toBe('function');
  });

  test('应导出 parseToolCall 函数', () => {
    expect(typeof ai.parseToolCall).toBe('function');
  });

  test('应导出 executeToolCall 函数', () => {
    expect(typeof ai.executeToolCall).toBe('function');
  });

  test('应导出 chatStream 函数', () => {
    expect(typeof ai.chatStream).toBe('function');
  });

  test('应导出 deliveryRouter', () => {
    expect(ai.deliveryRouter).toBeTruthy();
  });

  test('应导出 globalCommitmentTracker', () => {
    expect(ai.globalCommitmentTracker).toBeTruthy();
  });

  test('应导出 globalToolResultMiddleware', () => {
    expect(ai.globalToolResultMiddleware).toBeTruthy();
  });

  test('应导出 globalConsoleSanitizer', () => {
    expect(ai.globalConsoleSanitizer).toBeTruthy();
  });

  test('应导出 setToolCallCallback 函数', () => {
    expect(typeof ai.setToolCallCallback).toBe('function');
  });

  describe('parseSkillCall', () => {
    test('应解析有效的技能调用', () => {
      const text = '🔧 调用技能: search_web\n参数: {"keyword": "test"}';
      const result = ai.parseSkillCall(text);
      // 返回值可能是 null 或解析结果，不应抛异常
      expect(result).toBeDefined();
    });

    test('应处理无技能调用的文本', () => {
      const text = '这是一段普通文本，没有技能调用';
      const result = ai.parseSkillCall(text);
      expect(result).toBeNull();
    });
  });

  describe('parseToolCall', () => {
    test('应处理空输入', () => {
      const result = ai.parseToolCall('');
      expect(result).toBeDefined();
    });

    test('应处理无工具调用的文本', () => {
      const text = '普通回复文本';
      const result = ai.parseToolCall(text);
      expect(result).toBeDefined();
    });
  });

  // 2026-08-20 弹卡治理: R19 自动 document 卡推送已删除——
  // 任何 >300 字符回答(资讯摘要/内部任务回答)都会无差别推卡进对话窗口,
  // 用户"已要求清除却反复出现"。文档产出改由显式工具承载。
  // 回归断言: 源码不得复活"长文本自动推 document 场景卡"逻辑。
  describe('弹卡治理回归(R19 删除)', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../core/ai.js'), 'utf8');

    test('ai.js 不含 R19 自动 document 卡推送逻辑', () => {
      expect(source).not.toContain('长文本产出已推送 document 场景卡');
      expect(source).not.toContain('[R19]');
    });

    test('长文本回答不因字符数产生 document surface（pushDocumentCard 无调用方）', () => {
      // 场景卡应只由显式工具/意图化行为创建, 不允许按回答长度自动创建
      const autoPushRefs = source.match(/cleanedContent\.length > 300/g);
      expect(autoPushRefs).toBeNull();
    });
  });
});
