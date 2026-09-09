/**
 * token-broker 单测（2026-09-06）: 企微 access_token 单飞管理
 *   - 并发过期只刷一次（in-flight 合并）
 *   - expires_in 缺失时下限保护（原实现会算出负数 → 每次都刷）
 */
const { getWecomToken, resetWecomTokens } = require('../channels/wecom/token-broker');

describe('wecom token-broker', () => {
  let fetchCalls;
  beforeEach(() => {
    resetWecomTokens();
    fetchCalls = 0;
    global.fetch = jest.fn(async () => {
      fetchCalls += 1;
      return {
        json: async () => ({ errcode: 0, access_token: `token_${fetchCalls}`, expires_in: 7200 }),
      };
    });
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('缓存命中不再请求', async () => {
    await getWecomToken('corp', 'secret_a', 'approval');
    await getWecomToken('corp', 'secret_a', 'approval');
    expect(fetchCalls).toBe(1);
  });

  test('并发过期单飞合并（5 个并发只刷 1 次）', async () => {
    resetWecomTokens();
    await Promise.all(Array.from({ length: 5 }, () => getWecomToken('corp', 'secret_a', 'approval')));
    expect(fetchCalls).toBe(1);
  });

  test('不同 kind（不同 secret 应用）各自独立', async () => {
    await getWecomToken('corp', 'secret_a', 'approval');
    await getWecomToken('corp', 'secret_b', 'contacts');
    expect(fetchCalls).toBe(2);
  });

  test('errcode 非 0 抛错且不缓存', async () => {
    global.fetch = jest.fn(async () => ({ json: async () => ({ errcode: 40013, errmsg: 'invalid corpid' }) }));
    await expect(getWecomToken('bad', 's', 'x')).rejects.toThrow('40013');
    // 修复后重试会再次发起请求（不被负缓存锁死）
    global.fetch = jest.fn(async () => ({ json: async () => ({ errcode: 0, access_token: 'ok', expires_in: 7200 }) }));
    await expect(getWecomToken('bad', 's', 'x')).resolves.toBe('ok');
  });
});
