/**
 * calendar-handler 更新契约测试（2026-08-19）
 * 覆盖 handleCalendarUpdate 的 date/time → startTime 转换：
 * - 只改 time（不带 date）不得静默丢弃——沿用现有事件日期重建 startTime
 * - 带 date 的完整更新保持旧行为（不读现有事件）
 * - 缺 id / 事件不存在 → 正确错误码
 */
'use strict';

const { sendJson, sendError, readJsonBody } = require('./http-utils');
const { createEventService, CalendarEvent, toISO8601 } = require('../schedule');

// handler 内部通过 getScheduleService() 惰性创建服务——mock createEventService
// 让测试注入假 service（getById/update 记录调用）。
const mockService = {
  getById: jest.fn(),
  update: jest.fn(),
  getAll: jest.fn(() => []),
  getByDateRange: jest.fn(() => []),
  create: jest.fn(),
  delete: jest.fn(),
  adapters: new Map(),
};
jest.mock('../schedule', () => ({
  createEventService: jest.fn(() => mockService),
  CalendarEvent: class { constructor(props) { Object.assign(this, props); } toJSON() { return { ...this }; } },
  toISO8601: (date, time) => `${date}T${time || '00:00'}:00+08:00`,
}));
jest.mock('./http-utils', () => ({
  readJsonBody: jest.fn(),
  sendJson: jest.fn((_res, status, body) => { sendJsonResponse = { status, body }; }),
  sendError: jest.fn((_res, status, error) => { sendJsonResponse = { status, body: { success: false, error } }; }),
}));
jest.mock('../core/sse-broadcast', () => ({ broadcastEvent: jest.fn() }));
jest.mock('../core/config', () => ({ loadConfig: jest.fn(() => ({ chatChannel: 'none' })) }));

// 2026-08-19: 变量在断言处读取（75/116/124 行），无需 disable 注释——
// 且 @typescript-eslint/* 规则名仅对 .ts 生效，在 .js 中引用会报"rule not found"
let sendJsonResponse;
const { handleCalendarUpdate, handleCalendarList, handleCalendarCreate, handleCalendarDelete } = require('./calendar-handler');
const { broadcastEvent } = require('../core/sse-broadcast');

const makeExisting = (id, dateStr, time) => ({
  id,
  startTime: `${dateStr}T${time}:00+08:00`,
  endTime: `${dateStr}T${String(Number(time.split(':')[0]) + 1).padStart(2, '0')}:00+08:00`,
  toJSON() {
    return { id, date: dateStr, time, startTime: this.startTime };
  },
  getDuration() {
    return 60; // 假数据:固定 1 小时
  },
});

describe('calendar-handler handleCalendarUpdate', () => {
  const req = {}; // readJsonBody 被 mock,req 内容无意义
  const res = {};

  beforeEach(() => {
    jest.clearAllMocks();
    sendJsonResponse = null;
    mockService.update.mockResolvedValue({ toJSON: () => ({ id: 'evt_1', title: 'ok' }) });
    readJsonBody.mockResolvedValue({});
  });

  test('只改 time(不带 date) → 沿用现有事件日期重建 startTime,不再静默丢弃', async () => {
    mockService.getById.mockReturnValue(makeExisting('evt_1', '2026-08-21', '15:00'));
    readJsonBody.mockResolvedValue({ id: 'evt_1', title: '改名', time: '16:00' });

    await handleCalendarUpdate(req, res, {});

    // 现有日期被读取
    expect(mockService.getById).toHaveBeenCalledWith('evt_1');
    // 传给 service 的是 startTime,time/date 已被清理
    const updates = mockService.update.mock.calls[0][1];
    expect(updates.startTime).toBe('2026-08-21T16:00:00+08:00');
    expect(updates.time).toBeUndefined();
    expect(updates.date).toBeUndefined();
    expect(updates.title).toBe('改名');
    // 只改 time 时携带原时长 → service 据此重算 endTime(否则时长归零)
    expect(updates.duration).toBe(60);
    expect(sendJsonResponse.status).toBe(200);
  });

  test('只改 time 且请求自带 duration → 不覆盖调用方时长', async () => {
    mockService.getById.mockReturnValue(makeExisting('evt_1', '2026-08-21', '15:00'));
    readJsonBody.mockResolvedValue({ id: 'evt_1', time: '16:00', duration: 30 });
    await handleCalendarUpdate(req, res, {});
    const updates = mockService.update.mock.calls[0][1];
    expect(updates.duration).toBe(30);
    expect(updates.startTime).toBe('2026-08-21T16:00:00+08:00');
  });

  test('只改 date(不带 time) → 沿用默认 09:00(旧行为保持)', async () => {
    readJsonBody.mockResolvedValue({ id: 'evt_1', date: '2026-08-22' });
    await handleCalendarUpdate(req, res, {});
    expect(mockService.getById).not.toHaveBeenCalled();
    const updates = mockService.update.mock.calls[0][1];
    expect(updates.startTime).toBe('2026-08-22T09:00:00+08:00');
  });

  test('完整更新(date+time) → 不读现有事件(旧行为保持)', async () => {
    readJsonBody.mockResolvedValue({ id: 'evt_1', title: 'x', date: '2026-08-23', time: '10:30', duration: 90 });
    await handleCalendarUpdate(req, res, {});
    expect(mockService.getById).not.toHaveBeenCalled();
    const updates = mockService.update.mock.calls[0][1];
    expect(updates.startTime).toBe('2026-08-23T10:30:00+08:00');
    expect(updates.duration).toBe(90);
  });

  test('只改其他字段(无 date/time) → 原样透传,不碰 startTime', async () => {
    readJsonBody.mockResolvedValue({ id: 'evt_1', description: '改备注' });
    await handleCalendarUpdate(req, res, {});
    expect(mockService.getById).not.toHaveBeenCalled();
    const updates = mockService.update.mock.calls[0][1];
    expect(updates.description).toBe('改备注');
    expect(updates.startTime).toBeUndefined();
  });

  test('缺 id → 400', async () => {
    readJsonBody.mockResolvedValue({ title: 'x', time: '16:00' });
    await handleCalendarUpdate(req, res, {});
    expect(sendJsonResponse.status).toBe(400);
    expect(mockService.update).not.toHaveBeenCalled();
  });

  test('只改 time 但事件不存在 → 404', async () => {
    mockService.getById.mockReturnValue(null);
    readJsonBody.mockResolvedValue({ id: 'ghost', time: '16:00' });
    await handleCalendarUpdate(req, res, {});
    expect(sendJsonResponse.status).toBe(404);
    expect(mockService.update).not.toHaveBeenCalled();
  });
});

// ── calendar List/Create/Delete（审计零覆盖补齐, 2026-09-02 R5）──

describe('calendar List/Create/Delete（审计零覆盖补齐）', () => {
  const res = {};

  beforeEach(() => {
    jest.clearAllMocks();
    sendJsonResponse = null;
    readJsonBody.mockResolvedValue({});
  });

  test('List 返回 events.toJSON 数组（start/end 窗口查询）', async () => {
    const ev = makeExisting('evt_1', '2026-09-04', '10:00');
    mockService.getByDateRange.mockReturnValue([ev]);
    const req = { url: '/api/calendar?start=2026-09-01&end=2026-09-07' };

    await handleCalendarList(req, res, {});

    expect(mockService.getByDateRange).toHaveBeenCalledWith(
      '2026-09-01T00:00:00+08:00',
      '2026-09-07T23:59:00+08:00',
      { expandRecurring: true },
    );
    expect(sendJsonResponse.status).toBe(200);
    expect(sendJsonResponse.body.success).toBe(true);
    expect(sendJsonResponse.body.events).toEqual([{ id: 'evt_1', date: '2026-09-04', time: '10:00', startTime: ev.startTime }]);
  });

  test('Create 缺 date → 400 标题和日期不能为空', async () => {
    readJsonBody.mockResolvedValue({ title: '只有标题' });

    await handleCalendarCreate({ url: '/api/calendar' }, res, {});

    expect(sendJsonResponse.status).toBe(400);
    expect(sendJsonResponse.body.error).toContain('标题和日期');
    expect(mockService.create).not.toHaveBeenCalled();
  });

  test('Create 成功 → service.create 收到 reminders 透传 + endTime=start+duration, 并广播 schedule:updated', async () => {
    readJsonBody.mockResolvedValue({
      title: '新日程', date: '2026-09-04', time: '10:00', duration: 90, reminders: [{ value: 10 }],
    });
    mockService.create.mockResolvedValue({ id: 'evt_new', title: '新日程', toJSON: () => ({ id: 'evt_new', title: '新日程' }) });

    await handleCalendarCreate({ url: '/api/calendar' }, res, {});

    const created = mockService.create.mock.calls[0][0];
    expect(created.startTime).toBe('2026-09-04T10:00:00+08:00');
    expect(created.endTime).toBe('2026-09-04T03:30:00.000Z'); // 10:00+08 + 90min = 11:30+08
    expect(created.reminders).toEqual([{ value: 10 }]);
    expect(created.duration).toBe(90);
    expect(broadcastEvent).toHaveBeenCalledWith('schedule:updated', expect.objectContaining({
      action: 'create', event: { id: 'evt_new', title: '新日程' },
    }));
    expect(sendJsonResponse.status).toBe(200);
    expect(sendJsonResponse.body.success).toBe(true);
  });

  test('Delete 缺 id → 400', async () => {
    await handleCalendarDelete({ url: '/api/calendar' }, res, {});

    expect(sendJsonResponse.status).toBe(400);
    expect(mockService.delete).not.toHaveBeenCalled();
  });

  test('Delete 未知 id → 404', async () => {
    mockService.delete.mockResolvedValue(null);

    await handleCalendarDelete({ url: '/api/calendar?id=nope' }, res, {});

    expect(sendJsonResponse.status).toBe(404);
  });

  test('Delete 成功 → 200 + 广播 delete', async () => {
    mockService.delete.mockResolvedValue(makeExisting('evt_1', '2026-09-04', '10:00'));

    await handleCalendarDelete({ url: '/api/calendar?id=evt_1' }, res, {});

    expect(mockService.delete).toHaveBeenCalledWith('evt_1');
    expect(sendJsonResponse.status).toBe(200);
    expect(sendJsonResponse.body.success).toBe(true);
    expect(sendJsonResponse.body.deleted.id).toBe('evt_1');
    expect(broadcastEvent).toHaveBeenCalledWith('schedule:updated', expect.objectContaining({ action: 'delete' }));
  });
});
