/**
 * ai/streaming.js 测试
 */
const {
  StreamStateManager,
  globalStreamStateManager,
  formatSSEChunk,
  createStreamWriter,
} = require('../core/ai/streaming');

describe('ai/streaming', () => {
  describe('StreamStateManager', () => {
    let manager;
    beforeEach(() => { manager = new StreamStateManager(); });

    test('exports are defined', () => {
      expect(StreamStateManager).toBeDefined();
      expect(globalStreamStateManager).toBeDefined();
      expect(typeof formatSSEChunk).toBe('function');
      expect(typeof createStreamWriter).toBe('function');
    });

    test('should create instances', () => {
      const sm = new StreamStateManager();
      expect(sm).toBeDefined();
    });

    test('should start and end streams', () => {
      manager.startStream('test-1', { channel: 'test' });
      manager.endStream('test-1');
    });

    test('should handle unknown stream end gracefully', () => {
      expect(() => manager.endStream('nonexistent')).not.toThrow();
    });
  });

  describe('formatSSEChunk', () => {
    test('should format string data', () => {
      const result = formatSSEChunk('hello');
      expect(result).toContain('data:');
    });

    test('should handle objects', () => {
      const result = formatSSEChunk({ text: 'hi' });
      expect(typeof result).toBe('string');
    });
  });
});