'use strict';

jest.mock('../core/usage-stats', () => {
  // 动态今天键: 硬编码日期会在月份过后使 byDay 断言恒 0 失去验证力。
  // 键在工厂内计算(jest.mock 工厂禁引用外部变量, 且可读性优于 mock 前缀命名)。
  const todayKey = new Date().toISOString().split('T')[0];
  return {
    getUsageStats: jest.fn(() => ({
      total: { estimatedCost: 88, requests: 5 },
      byDay: { [todayKey]: { estimatedCost: 5.5 } },
      byModel: {}, byProvider: {}, byType: {},
    })),
    getTodayUsage: jest.fn(() => ({ estimatedCost: 5.5 })),
    getRecentUsage: jest.fn(() => []),
    resetUsage: jest.fn(),
  };
});
jest.mock('../core/plugin/assembly-view', () => ({
  buildAssemblyView: jest.fn(async () => ({
    assembly: { loaded: 6, known: 8, disabled: [], loadedList: ['a', 'b'] },
    tree: { summary: 'ok', ok: true },
    panels: [{ key: 'stock' }],
    sources: [{ key: 'stock' }],
    providers: { llm: [], tts: [], docEngine: [] },
  })),
}));
jest.mock('../core/mcp', () => ({
  getMCPManager: jest.fn(() => ({
    getServers: jest.fn(() => [
      { name: 'a', status: 'connected' },
      { name: 'b', status: 'error' },
    ]),
  })),
}));
jest.mock('../core/experts', () => ({
  getAllExperts: jest.fn(() => [{ id: 'e1', name: '专家甲' }, { id: 'e2', name: '专家乙' }]),
}));
jest.mock('../core/expert-context', () => ({
  getActiveExpert: jest.fn(() => ({ name: '专家甲' })),
}));
jest.mock('../core/skill-system', () => ({
  getRegistry: jest.fn(() => ({ s1: { name: 's1' }, s2: { name: 's2' } })),
}));
jest.mock('../handlers/skill-handler', () => ({
  getSkillsOverviewStats: jest.fn(() => ({ total: 2, active: 1, disabled: 1 })),
}));

let handleCockpitOverview;

// 20s 模块级缓存跨用例共享会互相污染（用例2 需冷缓存验证单源降级、用例3 需冷缓存
// 验证「首调取数、次调命中」）——每用例前 resetModules 重建模块（jest.mock 工厂保留）。
beforeEach(() => {
  jest.resetModules();
  ({ handleCockpitOverview } = require('../handlers/local-handlers/cockpit'));
});

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.writeHead = jest.fn();   // sendJson 会调用 writeHead
  res.end = jest.fn();
  return res;
}

describe('handleCockpitOverview', () => {
  test('返回聚合数据与 sources 全部 ok', async () => {
    const res = mockRes();
    await handleCockpitOverview({ url: '/api/cockpit/overview', headers: {} }, res, {});
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.success).toBe(true);
    expect(body.data.plugins.loaded).toBe(6);
    expect(body.data.plugins.known).toBe(8);
    expect(body.data.usage.monthCostCny).toBe(5.5);
    expect(body.data.skills.total).toBe(2);
    expect(body.data.mcp.connected).toBe(1);
    expect(body.data.experts.total).toBe(2);
    expect(body.data.experts.activeName).toBe('专家甲');
    expect(body.data.sources.plugins.ok).toBe(true);
  });

  test('单源失败降级为 null + sources 记录错误', async () => {
    const core = require('../core/usage-stats');
    core.getUsageStats.mockImplementationOnce(() => { throw new Error('db locked'); });
    const res = mockRes();
    await handleCockpitOverview({ url: '/api/cockpit/overview', headers: {} }, res, {});
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.data.usage).toBeNull();
    expect(body.data.sources.usage.ok).toBe(false);
    expect(body.data.sources.usage.detail).toContain('db locked');
  });

  test('20s 内缓存命中：第二次调用不再重新取数', async () => {
    const assembly = require('../core/plugin/assembly-view');
    assembly.buildAssemblyView.mockClear();
    await handleCockpitOverview({ url: '/api/cockpit/overview', headers: {} }, mockRes(), {});
    await handleCockpitOverview({ url: '/api/cockpit/overview', headers: {} }, mockRes(), {});
    expect(assembly.buildAssemblyView).toHaveBeenCalledTimes(1);
  });
});
