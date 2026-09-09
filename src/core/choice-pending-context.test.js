/**
 * choice 卡 pending 确认上下文注入测试(P1-6, 参考实现 data.pending 借鉴)
 *
 * 背景(2026-08-13): 用户点击选择卡后 intent 携带 { value, pending: true } 上行，
 * context-builder 将其识别为"已决策待执行"，以最高优先级指令注入上下文头部，
 * 引导 LLM 以确认句开头直接执行，不再罗列选项。
 */

// 用 mock 场景 store 控制 consumePendingIntents 返回值
const mockConsume = jest.fn();
jest.mock('./scene/scene-store', () => ({
  getSceneStore: () => ({
    getManifest: () => null,
    consumePendingIntents: () => mockConsume(),
  }),
}));

// 其余模块懒加载,避免真实依赖(boss-profile/memory-system 等)
jest.mock('./config', () => ({ WORKSPACE_DIR: process.cwd() }));
jest.mock('./credential-manager', () => ({ isChannelEnabled: () => true }));
jest.mock('./memory-system', () => ({ memoryManager: { getMemoryRefs: () => [] } }));
jest.mock('./context-cache', () => ({ contextCache: { get: () => null } }));
jest.mock('./system-prompt', () => ({
  buildSystemPrompt: () => 'sys',
  buildLayeredSystemPrompt: () => 'sys',
}));
jest.mock('./memory-smart-loader', () => ({
  buildCompactMemoryPrompt: () => 'mem',
  loadSmartContext: () => null,
}));
jest.mock('./context/context-references', () => ({ preprocessContextReferences: (x) => x }));
jest.mock('./bootstrap-injector', () => ({
  BOOTSTRAP_MARKER: '###BOOTSTRAP###',
  buildBootstrapBookmark: () => '',
  buildBootstrapDetail: () => '',
  injectFullBootstrap: (x) => x,
}));
jest.mock('./context/compressor', () => ({ estimateMessagesTokens: () => 0 }));
jest.mock('./hotspot-intent', () => ({ buildHotspotRuntimeContext: () => null }));
jest.mock('./aci', () => ({
  getACIInjector: () => ({ prepare: () => Promise.resolve(null) }),
  getPatternLearner: () => ({ suggestChains: () => [] }),
}));

describe('choice pending 确认注入', () => {
  afterEach(() => mockConsume.mockReset());

  test('pending 确认 intent 注入头部高优先级指令', async () => {
    mockConsume.mockReturnValue([
      { surface: 'choice-1', name: 'select', data: { value: '方案A', pending: true, ts: 123 } },
    ]);
    const { buildVolatileContext } = require('./context-builder');
    const { volatileParts } = await buildVolatileContext('u1', '测试', {}, {}, '', '');
    const head = volatileParts[0] || '';
    expect(head).toContain('[最高优先级指令]');
    expect(head).toContain('点击了「方案A」');
    expect(head).toContain('确认该选择');
  });

  test('非 pending intent 不注入高优先级指令', async () => {
    mockConsume.mockReturnValue([
      { surface: 'choice-1', name: 'select', data: { value: 'x' } },
    ]);
    const { buildVolatileContext } = require('./context-builder');
    const { volatileParts } = await buildVolatileContext('u1', '测试', {}, {}, '', '');
    expect(volatileParts.join('\n')).not.toContain('[最高优先级指令]');
    expect(volatileParts.join('\n')).toContain('[未处理的用户操作]');
  });

  test('toggle 且 pending 同样识别', async () => {
    mockConsume.mockReturnValue([
      { surface: 'choice-1', name: 'toggle', data: { value: 'A', pending: true } },
    ]);
    const { buildVolatileContext } = require('./context-builder');
    const { volatileParts } = await buildVolatileContext('u1', '测试', {}, {}, '', '');
    expect(volatileParts[0]).toContain('点击了「A」');
  });

  test('pending 但缺 value 不注入', async () => {
    mockConsume.mockReturnValue([
      { surface: 'choice-1', name: 'select', data: { pending: true } },
    ]);
    const { buildVolatileContext } = require('./context-builder');
    const { volatileParts } = await buildVolatileContext('u1', '测试', {}, {}, '', '');
    expect(volatileParts.join('\n')).not.toContain('[最高优先级指令]');
  });
});
