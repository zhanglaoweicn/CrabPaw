/**
 * SelfAwareness 工具感知回归测试（2026-09-24）
 *
 * 实机 bug：_perceivePerception() 内 require('../../tools/registry') 路径错一级
 * （从 src/core/ 解析到仓库根 tools/，不存在），异常被空 catch 吞掉 →
 * perception.tools.total 恒 0，经 formatForPrompt 每轮向模型注入"0 tools"
 * （ai.js 两处 perceiveLite() 调用点）。同文件技能感知曾因同类解构错误恒 0
 * （self-awareness.js 内 BUG FIX 注释），工具这一半漏修。
 *
 * 锁两件事：
 *  1. 注册进全局 registry 的工具必须被 perceive 如实计数（路径正确性）；
 *  2. formatForPrompt 的 Resources 行不得出现 "0 tools"（防错误事实再进 prompt）。
 *
 * 技能/代理/渠道段被 mock：那些段会连带全技能库扫描+sqlite 初始化（慢且留
 * 活跃句柄导致 jest 不退出），且它们不是本回归锁的对象。
 */

jest.mock('../core/skills', () => ({ loadSkills: () => [] }));
jest.mock('../core/agent/agent-registry', () => ({
  getAgentRegistry: () => ({ listSpawnable: () => [] }),
}));
jest.mock('../core/channel-registry', () => ({
  channelRegistry: { list: () => [] },
}));
jest.mock('../core/activity-state', () => ({
  globalActivityState: { state: 'idle' },
}));

const { SelfAwareness, formatForPrompt } = require('../core/self-awareness');
const { registry } = require('../tools/registry');

const FAKE_SOURCE = 'self-awareness-perception-test';

describe('SelfAwareness 工具感知（require 路径回归锁）', () => {
  afterEach(() => {
    if (registry.get('PerceptionProbeTool')) {
      registry.unregisterBySource(FAKE_SOURCE);
    }
  });

  test('注册的工具被如实计数（不再恒 0）', async () => {
    registry.register({
      name: 'PerceptionProbeTool',
      toolset: 'perception-test',
      description: 'self-awareness 感知探针',
      riskLevel: 'low',
      whenNotToUse: ['仅测试用'],
      source: FAKE_SOURCE,
      handler: async () => ({ ok: true }),
    });

    const aw = new SelfAwareness();
    aw.setToolRegistry(registry);
    const p = await aw._perceivePerception();

    expect(p.tools.total).toBeGreaterThanOrEqual(1);
    expect(p.tools.byToolset['perception-test']).toBeGreaterThanOrEqual(1);
  });

  test('未注入注册表时诚实降级 0（不抛错、不假装有工具）', async () => {
    const aw = new SelfAwareness();
    const p = await aw._perceivePerception();
    expect(p.tools.total).toBe(0);
  });

  test('formatForPrompt 的 Resources 行不出现 "0 tools"', () => {
    const line = formatForPrompt({
      knowledge: { name: 'CrabPaw', version: 'test', description: '', capabilities: [] },
      perception: {
        tools: { total: 7, byToolset: {} },
        skills: { total: 0, names: [] },
        agents: { total: 0, byTier: {} },
        channels: [],
        currentState: 'idle',
      },
      evolution: {},
    });
    expect(line).toContain('7 tools');
    expect(line).not.toContain('0 tools');
  });
});
