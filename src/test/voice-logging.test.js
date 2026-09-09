const { getLogger } = require('../core/observability');

describe('voice structured logging', () => {
  it('getLogger 可创建 voice 模块 logger', () => {
    const log = getLogger({ module: 'voice:cloud' });
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.error).toBe('function');
    log.close();
  });
});
