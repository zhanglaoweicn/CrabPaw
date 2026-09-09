/**
 * 日程系统单元测试 - Jest 兼容版本
 */

const path = require('path');
const fs = require('fs');
const { CalendarEvent, EVENT_STATUS, EVENT_PRIORITY, RECURRENCE_TYPES } = require('../models/event');
const { toISO8601, parseISO8601, addMinutes, addDays, getDurationMinutes } = require('../utils/time-utils');
const { RecurrenceEngine } = require('../utils/recurrence');

const testStoragePath = path.join(__dirname, 'test-schedule.json');

function cleanup() {
  try {
    if (fs.existsSync(testStoragePath)) {
      fs.unlinkSync(testStoragePath);
    }
  } catch (e) {
    /* 清理测试文件，忽略 */
    console.warn('[schedule.test.js] 空 catch 补日志:', e && e.message);
  }

}

afterAll(() => {
  cleanup();
});

// ── 日程数据模型测试 ──

describe('日程数据模型', () => {
  test('创建日程事件', () => {
    const event = new CalendarEvent({
      title: '测试会议',
      startTime: '2026-05-22T10:00+08:00',
      endTime: '2026-05-22T11:00+08:00'
    });

    expect(event.title).toBe('测试会议');
    expect(event.status).toBe(EVENT_STATUS.CONFIRMED);
    expect(event.priority).toBe(EVENT_PRIORITY.NORMAL);
    expect(event.id).toMatch(/^evt_/);
  });

  test('日程事件默认值', () => {
    const event = new CalendarEvent({ title: '测试' });

    expect(event.status).toBe(EVENT_STATUS.CONFIRMED);
    expect(event.priority).toBe(EVENT_PRIORITY.NORMAL);
    expect(event.color).toBe('blue');
    expect(event.source).toBe('local');
  });

  test('日程事件JSON序列化', () => {
    const event = new CalendarEvent({
      title: '测试会议',
      startTime: '2026-05-22T10:00+08:00',
      endTime: '2026-05-22T11:00+08:00'
    });

    const json = event.toJSON();
    const restored = CalendarEvent.fromJSON(json);

    expect(restored.title).toBe(event.title);
    expect(restored.startTime).toBe(event.startTime);
    expect(restored.endTime).toBe(event.endTime);
  });

  test('日程事件克隆', () => {
    const event = new CalendarEvent({
      title: '原始会议',
      startTime: '2026-05-22T10:00+08:00'
    });

    const cloned = event.clone();
    cloned.title = '修改后的会议';

    expect(event.title).toBe('原始会议');
    expect(cloned.title).toBe('修改后的会议');
  });

  test('日程事件更新', () => {
    const event = new CalendarEvent({
      title: '原始会议',
      startTime: '2026-05-22T10:00+08:00'
    });

    const updated = event.update({ title: '更新后的会议' });

    expect(event.title).toBe('原始会议');
    expect(updated.title).toBe('更新后的会议');
  });

  test('日程持续时间计算', () => {
    const event = new CalendarEvent({
      title: '测试会议',
      startTime: '2026-05-22T10:00+08:00',
      endTime: '2026-05-22T11:30+08:00'
    });

    expect(event.getDuration()).toBe(90);
  });

  test('重复日程判断', () => {
    const normalEvent = new CalendarEvent({ title: '普通会议' });
    const recurringEvent = new CalendarEvent({
      title: '每日站会',
      recurrence: { type: RECURRENCE_TYPES.DAILY }
    });

    expect(normalEvent.isRecurring()).toBe(false);
    expect(recurringEvent.isRecurring()).toBe(true);
  });
});

// ── 时间工具测试 ──

describe('时间工具', () => {
  test('ISO 8601 格式转换', () => {
    const iso = toISO8601('2026-05-22', '14:30');
    expect(iso).toBe('2026-05-22T14:30:00+08:00');
  });

  test('ISO 8601 解析', () => {
    const parsed = parseISO8601('2026-05-22T14:30:00+08:00');
    expect(parsed.date).toBe('2026-05-22');
    expect(parsed.time).toBe('14:30');
  });

  test('添加分钟', () => {
    const result = addMinutes('2026-05-22T14:30:00+08:00', 30);
    const parsed = parseISO8601(result);
    expect(parsed.time).toBe('15:00');
  });

  test('添加天数', () => {
    const result = addDays('2026-05-22T14:30:00+08:00', 1);
    const parsed = parseISO8601(result);
    expect(parsed.date).toBe('2026-05-23');
  });

  test('持续时间计算', () => {
    const duration = getDurationMinutes(
      '2026-05-22T10:00:00+08:00',
      '2026-05-22T11:30:00+08:00'
    );
    expect(duration).toBe(90);
  });
});

// ── 重复规则引擎测试 ──

describe('重复规则引擎', () => {
  test('每日重复展开', () => {
    const engine = new RecurrenceEngine();
    const event = new CalendarEvent({
      title: '每日站会',
      startTime: '2026-05-22T09:00+08:00',
      endTime: '2026-05-22T09:15+08:00',
      recurrence: {
        type: RECURRENCE_TYPES.DAILY,
        endAfter: 3
      }
    });

    const occurrences = engine.expand(event);
    expect(occurrences.length).toBe(3);
  });

  test('每周重复展开', () => {
    const engine = new RecurrenceEngine();
    const event = new CalendarEvent({
      title: '周会',
      startTime: '2026-05-22T10:00+08:00',
      endTime: '2026-05-22T11:00+08:00',
      recurrence: {
        type: RECURRENCE_TYPES.WEEKLY,
        daysOfWeek: [1, 3, 5],
        endAfter: 3
      }
    });

    const occurrences = engine.expand(event);
    expect(occurrences.length).toBe(3);
  });

  test('重复规则描述', () => {
    const engine = new RecurrenceEngine();

    const dailyDesc = engine.getRecurrenceDescription({ type: RECURRENCE_TYPES.DAILY });
    expect(dailyDesc).toBe('每天');

    const weeklyDesc = engine.getRecurrenceDescription({
      type: RECURRENCE_TYPES.WEEKLY,
      daysOfWeek: [1, 3, 5]
    });
    expect(weeklyDesc).toContain('周一');
    expect(weeklyDesc).toContain('周三');
    expect(weeklyDesc).toContain('周五');
  });
});

// ── 本地存储测试 ──

describe('本地存储', () => {
  beforeEach(() => {
    cleanup();
  });

  test('存储初始化', () => {
    const { LocalScheduleStorage } = require('../storage/local-storage');
    const storage = new LocalScheduleStorage({ storagePath: testStoragePath });
    storage.ensureStorage();
    const count = storage.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('添加日程', () => {
    const { LocalScheduleStorage } = require('../storage/local-storage');
    const storage = new LocalScheduleStorage({ storagePath: testStoragePath });
    const event = new CalendarEvent({
      title: '测试会议',
      startTime: '2026-05-22T10:00+08:00',
      endTime: '2026-05-22T11:00+08:00'
    });

    const added = storage.add(event);
    expect(added).toBeTruthy();
    expect(added.title).toBe('测试会议');
  });

  test('查询日程', () => {
    const { LocalScheduleStorage } = require('../storage/local-storage');
    const storage = new LocalScheduleStorage({ storagePath: testStoragePath });
    const event = new CalendarEvent({
      title: '查询测试',
      startTime: '2026-05-22T14:00+08:00'
    });

    storage.add(event);
    const found = storage.getById(event.id);
    expect(found).toBeTruthy();
    expect(found.title).toBe('查询测试');
  });

  test('更新日程', () => {
    const { LocalScheduleStorage } = require('../storage/local-storage');
    const storage = new LocalScheduleStorage({ storagePath: testStoragePath });
    const event = new CalendarEvent({
      title: '更新测试',
      startTime: '2026-05-22T15:00+08:00'
    });

    storage.add(event);
    const updated = storage.update(event.id, { title: '已更新' });
    expect(updated).toBeTruthy();
    expect(updated.title).toBe('已更新');
  });

  test('删除日程', () => {
    const { LocalScheduleStorage } = require('../storage/local-storage');
    const storage = new LocalScheduleStorage({ storagePath: testStoragePath });
    const event = new CalendarEvent({
      title: '删除测试',
      startTime: '2026-05-22T16:00+08:00'
    });

    storage.add(event);
    const deleted = storage.delete(event.id);
    expect(deleted).toBeTruthy();

    const found = storage.getById(event.id);
    expect(found).toBeNull();
  });

  test('搜索日程', () => {
    const { LocalScheduleStorage } = require('../storage/local-storage');
    const storage = new LocalScheduleStorage({ storagePath: testStoragePath });
    const event = new CalendarEvent({
      title: '搜索关键词测试',
      startTime: '2026-05-22T17:00+08:00'
    });

    storage.add(event);
    const results = storage.search('关键词');
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── 日程服务测试 ──

describe('日程服务', () => {
  beforeEach(() => {
    cleanup();
  });

  test('创建日程服务', () => {
    const { EventService } = require('../services/event-service');
    const service = new EventService({
      storageOptions: { storagePath: testStoragePath },
      syncEnabled: false
    });

    expect(service.storage).toBeTruthy();
    expect(service.recurrenceEngine).toBeTruthy();
  });

  test('服务创建日程', async () => {
    const { EventService } = require('../services/event-service');
    const service = new EventService({
      storageOptions: { storagePath: testStoragePath },
      syncEnabled: false
    });

    const event = await service.create({
      title: '服务测试会议',
      startTime: '2026-05-22T18:00+08:00',
      endTime: '2026-05-22T19:00+08:00'
    });

    expect(event).toBeTruthy();
    expect(event.title).toBe('服务测试会议');
  });

  test('服务查询日程', async () => {
    const { EventService } = require('../services/event-service');
    const service = new EventService({
      storageOptions: { storagePath: testStoragePath },
      syncEnabled: false
    });

    const event = await service.create({
      title: '查询服务测试',
      startTime: '2026-05-23T10:00+08:00'
    });

    const found = service.getById(event.id);
    expect(found).toBeTruthy();
    expect(found.title).toBe('查询服务测试');
  });

  test('服务更新日程', async () => {
    const { EventService } = require('../services/event-service');
    const service = new EventService({
      storageOptions: { storagePath: testStoragePath },
      syncEnabled: false
    });

    const event = await service.create({
      title: '更新服务测试',
      startTime: '2026-05-23T11:00+08:00'
    });

    const updated = await service.update(event.id, { title: '已更新服务测试' });
    expect(updated).toBeTruthy();
    expect(updated.title).toBe('已更新服务测试');
  });

  test('服务删除日程', async () => {
    const { EventService } = require('../services/event-service');
    const service = new EventService({
      storageOptions: { storagePath: testStoragePath },
      syncEnabled: false
    });

    const event = await service.create({
      title: '删除服务测试',
      startTime: '2026-05-23T12:00+08:00'
    });

    const deleted = await service.delete(event.id);
    expect(deleted).toBeTruthy();
  });

  test('冲突检测', async () => {
    const { EventService } = require('../services/event-service');
    const service = new EventService({
      storageOptions: { storagePath: testStoragePath },
      syncEnabled: false
    });

    await service.create({
      title: '冲突测试1',
      startTime: '2026-05-24T10:00+08:00',
      endTime: '2026-05-24T11:00+08:00'
    });

    const conflicts = service.detectConflicts({
      title: '冲突测试2',
      startTime: '2026-05-24T10:30+08:00',
      endTime: '2026-05-24T11:30+08:00'
    });

    expect(conflicts.length).toBeGreaterThan(0);
  });

  test('日程统计', async () => {
    const { EventService } = require('../services/event-service');
    const service = new EventService({
      storageOptions: { storagePath: testStoragePath },
      syncEnabled: false
    });

    const stats = service.getStats();
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.recurring).toBe('number');
  });
});

// ── ICS 导出时区（R5 2026-09-02）──

describe('ICS 导出时区（R5）', () => {
  test('DTSTART/DTEND 带 TZID=Asia/Shanghai 且为 +08:00 锚定墙钟（与服务器时区无关）', () => {
    const { LocalScheduleStorage } = require('../storage/local-storage');
    const icsPath = path.join(__dirname, 'test-ics.json');
    const storage = new LocalScheduleStorage({ storagePath: icsPath });
    const ev = new CalendarEvent({
      id: 'ics1',
      title: 'T',
      startTime: toISO8601('2026-09-04', '10:00'),
      endTime: toISO8601('2026-09-04', '11:00'),
    });
    storage.add(ev);
    const ics = storage.export('ics');
    expect(ics).toContain('TZID:Asia/Shanghai');
    expect(ics).toContain('DTSTART;TZID=Asia/Shanghai:20260904T100000');
    expect(ics).toContain('DTEND;TZID=Asia/Shanghai:20260904T110000');
    try { fs.unlinkSync(icsPath); } catch (e) { /* 清理 */ }
  });
});
