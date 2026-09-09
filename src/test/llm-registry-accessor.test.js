/**
 * llm-registry-accessor.test.js — getAdapterRegistry() 访问器契约（2026-08-17）
 *
 * 回归锁定：v2.2.0 起 getAdapterRegistry() 误返回静态定义表 PROVIDER_REGISTRY
 * （纯对象，无 chat/register/listProviders 方法），stock-interpret 等直接消费方
 * 调用 reg.chat 必 TypeError 恒走规则兜底。修复后应返回 AdapterRegistry 实例。
 * 另锁 registerFromConfig：从 config.models.providers 注册后能解析出适配器。
 */

const { getAdapterRegistry } = require('../core/llm');

describe('getAdapterRegistry 访问器契约', () => {
  test('返回 AdapterRegistry 实例（非静态表）——含 chat/register/registerFromConfig/listProviders', () => {
    const reg = getAdapterRegistry();
    expect(reg).toBeTruthy();
    expect(typeof reg.chat).toBe('function');
    expect(typeof reg.register).toBe('function');
    expect(typeof reg.registerFromConfig).toBe('function');
    expect(typeof reg.listProviders).toBe('function');
    expect(typeof reg.getAdapterForModel).toBe('function');
  });

  test('连续调用返回同一单例', () => {
    expect(getAdapterRegistry()).toBe(getAdapterRegistry());
  });

  test('registerFromConfig 注册配置内提供商（deepseek 有 apiKey/baseUrl）后能按模型解析适配器', () => {
    const reg = getAdapterRegistry();
    // 2026-09-03(Runtime差距分析轮): 改用合成配置——此前 require 真实
    // data/.crabpaw/config.json 并假设 deepseek 带 apiKey,本机配置换 provider
    // 即挂(环境性失败)。合成配置使断言只依赖代码契约。
    const config = {
      models: {
        providers: {
          deepseek: { apiKey: 'sk-test-deterministic', baseUrl: 'https://api.deepseek.com/v1' },
        },
      },
    };
    const before = reg.listProviders().length;
    reg.registerFromConfig(config.models.providers);
    const after = reg.listProviders().length;
    // deepseek 配置含 apiKey + baseUrl → 应被注册
    expect(after).toBeGreaterThan(before);
    // 'deepseek-chat' 在 deepseek 适配器支持模型内 → 应解析到 deepseek 适配器
    const adapter = reg.getAdapterForModel('deepseek-chat');
    expect(adapter).toBeTruthy();
  });
});
