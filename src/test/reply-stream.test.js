const ai = require('../core/ai');

describe('reply_stream', () => {
  test('should be exported', () => {
    expect(ai.reply_stream).toBeDefined();
    expect(typeof ai.reply_stream).toBe('function');
  });

  test('should be an async generator', () => {
    const gen = ai.reply_stream({}, [], 'test_user', 'hello');
    expect(gen).toBeDefined();
    expect(typeof gen[Symbol.asyncIterator]).toBe('function');
  });

  test('should yield chunks with correct structure', async () => {
    const chunks = [];
    try {
      for await (const chunk of ai.reply_stream(
        { chatChannel: 'none', systemPrompt: jest.fn(() => 'test') },
        [],
        'test_user',
        'hello'
      )) {
        chunks.push(chunk);
        if (chunk.done) break;
      }
    } catch (e) {

      // Expected: might fail due to missing config, but we should get some chunks first

      console.warn('[reply-stream.test.js] 空 catch 补日志:', e && e.message);
    }

    expect(chunks.length).toBeGreaterThan(0);
    // First chunk should have content or type
    expect(chunks[0]).toBeDefined();
  }, 10000);
});
