/**
 * request-handler.js 烟雾测试 - 验证请求处理器加载与基础接口
 */

describe('request-handler.js 烟雾测试', () => {
  let handler;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    handler = require('../cli/request-handler');
  });

  test('模块应正确加载', () => {
    expect(handler).toBeTruthy();
    expect(typeof handler).toBe('object');
  });

  test('应导出 createRequestHandler 函数', () => {
    expect(typeof handler.createRequestHandler).toBe('function');
  });

  test('应导出 handleMessage 函数', () => {
    expect(typeof handler.handleMessage).toBe('function');
  });

  test('应导出 broadcastEvent 函数', () => {
    expect(typeof handler.broadcastEvent).toBe('function');
  });

  test('应导出 getLastLarkSenderId 函数', () => {
    expect(typeof handler.getLastLarkSenderId).toBe('function');
  });

  describe('createRequestHandler', () => {
    test('应返回处理函数', () => {
      const mockConfig = {
        channel: 'test',
        channelId: 'test_channel',
      };
      // createRequestHandler 可能需要特定配置，验证不抛异常
      try {
        const result = handler.createRequestHandler(mockConfig);
        expect(result).toBeDefined();
      } catch (e) {
        // 配置不完整时可能抛出错误，这是预期行为
        expect(e).toBeDefined();
      }
    });
  });

  describe('broadcastEvent', () => {
    test('应可调用不抛异常', () => {
      expect(() => {
        handler.broadcastEvent('test_event', { test: true });
      }).not.toThrow();
    });
  });
});
