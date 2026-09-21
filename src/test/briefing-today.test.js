/**
 * 晨报带聚合端点测试（2026-09-21 创新-A 配套）
 * 覆盖：正常聚合结构、单源失败独立降级、60s 缓存命中。
 * morning-briefing-service 与 schedule 全 mock（不触真实业务库/日程库）。
 */
jest.mock('../core/proactive/morning-briefing-service', () => ({
  buildBriefingSnapshot: jest.fn(() => ({
    date: '2026-09-21',
    revenue: { month: 571000, prevMonth: 500000, yesterday: 30000, deltaPct: 14.2 },
    risks: { receivableOverdue: 2, totalReceivable: 437000, contractsExpiring: 1 },
    generatedAt: 1,
  })),
  listOverdueReceivables: jest.fn(() => [
    { customer: '客户甲', amount: 12000, expireDate: '2026-09-01', daysLeft: -20, count: 1 },
  ]),
  listExpiringContracts: jest.fn(() => [
    { customer: '客户乙', amount: 8000, expireDate: '2026-09-25', daysLeft: 4, count: 1 },
  ]),
}));
jest.mock('../schedule', () => {
  const { toISO8601 } = jest.requireActual('../schedule');
  return {
    toISO8601,
    createEventService: jest.fn(() => ({
      getByDateRange: jest.fn(() => [
        { toJSON: () => ({ title: '周会', startTime: '2026-09-21 10:00', location: null }) },
      ]),
    })),
  };
});

let handleBriefingToday;

// 60s 模块级缓存跨用例污染——每用例 resetModules 重建（mock 工厂保留）
beforeEach(() => {
  jest.resetModules();
  ({ handleBriefingToday } = require('../handlers/local-handlers/briefing-handler'));
});

function mockRes() {
  const res = {};
  res.statusCode = 200;
  res.writeHead = jest.fn();
  res.end = jest.fn();
  return res;
}

describe('handleBriefingToday', () => {
  test('聚合四源并返回结构化快照', async () => {
    const res = mockRes();
    await handleBriefingToday({ url: '/api/briefing/today', headers: {} }, res, {});
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.success).toBe(true);
    expect(body.data.snapshot.revenue.month).toBe(571000);
    expect(body.data.receivables.count).toBe(1);
    expect(body.data.receivables.amount).toBe(12000);
    expect(body.data.contracts.count).toBe(1);
    expect(body.data.schedule.count).toBe(1);
    expect(body.data.schedule.items[0].title).toBe('周会');
    expect(body.data.sources.snapshot.ok).toBe(true);
    expect(body.data.sources.schedule.ok).toBe(true);
  });

  test('单源失败降级为 null + sources 记录错误（其余源不受影响）', async () => {
    const svc = require('../schedule');
    svc.createEventService.mockImplementationOnce(() => { throw new Error('schedule down'); });
    const res = mockRes();
    await handleBriefingToday({ url: '/api/briefing/today', headers: {} }, res, {});
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body.data.schedule).toBeNull();
    expect(body.data.sources.schedule.ok).toBe(false);
    expect(body.data.sources.schedule.detail).toContain('schedule down');
    expect(body.data.snapshot).not.toBeNull();
    expect(body.data.receivables).not.toBeNull();
  });

  test('60s 内缓存命中：第二次调用不再取数', async () => {
    const svc = require('../core/proactive/morning-briefing-service');
    await handleBriefingToday({ url: '/api/briefing/today', headers: {} }, mockRes(), {});
    await handleBriefingToday({ url: '/api/briefing/today', headers: {} }, mockRes(), {});
    expect(svc.buildBriefingSnapshot).toHaveBeenCalledTimes(1);
  });
});
