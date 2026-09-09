/**
 * provider-meta-registry.test.js — Provider 元数据注册表（Phase 3d）
 */
const {
  registerProviderMeta, getProviderMeta, listProviderMeta, installBuiltinProviderMeta,
} = require('../core/providers/meta-registry');

describe('provider meta-registry（能力/窗口清单化）', () => {
  test('内置安装：llm/tts/doc-engine 三类齐全', () => {
    const results = installBuiltinProviderMeta();
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(10);
    expect(listProviderMeta('llm').map((m) => m.id)).toContain('deepseek');
    expect(listProviderMeta('tts').map((m) => m.id).sort()).toEqual(['doubao', 'edge', 'piper', 'sapi']);
    expect(listProviderMeta('doc-engine').length).toBe(8);
  });

  test('llm 元数据引用单一事实源（deepseek 模型窗口 65536/128000 无漂移）', () => {
    const deepseek = getProviderMeta('deepseek');
    expect(deepseek).not.toBeNull();
    expect(deepseek.models).toBeDefined();
    const flash = deepseek.models.find((m) => m.id === 'deepseek-v4-flash');
    expect(flash.contextWindow).toBe(65536);
    const pro = deepseek.models.find((m) => m.id === 'deepseek-v4-pro');
    expect(pro.contextWindow).toBe(128000);
    // 单一事实源：与 provider-registry 同对象（引用而非复制）
    const { PROVIDER_MODEL_DEFS } = require('../core/llm/provider-registry');
    expect(deepseek.models).toBe(PROVIDER_MODEL_DEFS.deepseek);
  });

  test('注册校验：重名拒绝/kind 非法/id 缺失', () => {
    expect(registerProviderMeta({ id: 'deepseek', kind: 'llm' }).ok).toBe(false);
    expect(registerProviderMeta({ id: 'x', kind: 'nope' }).ok).toBe(false);
    expect(registerProviderMeta({ kind: 'llm' }).ok).toBe(false);
    // 正常注册后查询
    expect(registerProviderMeta({ id: 'test-vendor', kind: 'llm', name: 'T' }).ok).toBe(true);
    expect(getProviderMeta('test-vendor').name).toBe('T');
  });
});
