/**
 * event-reminder-bridge 测试（R2 激活日程事件提醒）
 * 隔离：内存 schedules（mock config）+ 注入 storagePath 的临时 schedule.json。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../core/config', () => {
  let schedules = { cron: [] };
  return {
    loadSchedules: () => schedules,
    saveSchedules: (s) => { schedules = s; },
    loadConfig: () => ({ chatChannel: 'none' }),
    DATA_DIR: require('path').join(require('os').tmpdir(), 'crabpaw-test-data'),
  };
});
jest.mock('../core/scheduler-bridge', () => ({
  reloadGlobalScheduler: jest.fn(() => true),
}));

const { CalendarEvent } = require('../schedule/models/event');
const { toISO8601 } = require('../schedule/utils/time-utils');
const {
  computeDesiredReminders, syncEventReminders,
} = require('../schedule/event-reminder-bridge');

let tmpDir;
beforeEach(() => {
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evt-bridge-'));
});

/**
 * 鲁棒未来整点起点：floor(now) 整点 +2h。距 now 恒在 [1h,2h]——必在 24h SCAN_WINDOW 内，
 * 且 start-30min 提醒时刻必在未来；makeEvent 内部"当天整点已过则 +1 天"的守卫
 * 与本计算同构（跨零点场景自动落到明天同一整点）。
 * 此前固定 10:00/14:00 起点：当天提醒时刻一过（如 09:30 后跑 30min 提醒）即被
 * "迟到不补响"过滤，天数依赖偶发失败（实测复现两轮）。
 */
function futureStartHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 2);
  return d.getHours();
}

/** 造一个未来 startHour 点开始的事件（今天），reminders = 提前分钟数组 */
function makeEvent(id, startHour, leads, title = '项目评审') {
  const d = new Date(); d.setHours(startHour, 0, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); // 保证未来
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ev = new CalendarEvent({
    id, title, startTime: toISO8601(date, `${String(startHour).padStart(2, '0')}:00`),
    endTime: toISO8601(date, `${String(Math.min(startHour + 1, 23)).padStart(2, '0')}:00`),
    reminders: leads.map(v => ({ type: 'relative', value: v, enabled: true })),
  });
  return ev;
}

describe('computeDesiredReminders（纯函数）', () => {
  test('每条 enabled reminder → 一条 evt_ 前缀一次性任务（Asia/Shanghai 墙钟 cron）', () => {
    // 事件起点用 futureStartHour()——避免固定 10:00 的"提醒时刻已过被过滤"脆弱性
    const ev = makeEvent('e1', futureStartHour(), [10, 30]);
    const now = new Date();
    const out = computeDesiredReminders([ev], now);
    expect(out).toHaveLength(2);
    expect(out.map(r => r.id).sort()).toEqual(['evt_e1_10', 'evt_e1_30']);
    for (const r of out) {
      expect(r.action).toBe('reminder');
      expect(r.type).toBe('temporary');
      expect(r.message).toContain('项目评审');
      expect(r.cron.split(' ')).toHaveLength(5);
      expect(r.expireAt).toBeGreaterThan(Date.now());
    }
  });

  test('disabled/非数值 reminder 跳过；已过提醒时刻（事件未开始）不排；过去事件整体跳过', () => {
    const past = new Date(); past.setHours(past.getHours() - 2);
    const pastEv = new CalendarEvent({ id: 'p1', title: '已过', startTime: past.toISOString(), endTime: new Date(past.getTime() + 3600000).toISOString(), reminders: [{ type: 'relative', value: 10, enabled: true }] });
    const lateEv = makeEvent('late', 10, [60 * 24]); // 提前 24h——提醒时刻已过但事件未开始
    const dis = makeEvent('dis', 10, [10]);
    dis.reminders[0].enabled = false;
    const out = computeDesiredReminders([pastEv, lateEv, dis], new Date());
    expect(out).toEqual([]);
  });
});

describe('syncEventReminders（diff 写盘 + 热重载）', () => {
  test('补写缺失任务、清除改期/删除事件的遗留 evt_ 任务、幂等', () => {
    const storagePath = path.join(tmpDir, 'schedule.json');
    const ev = makeEvent('e1', futureStartHour(), [10]);
    const storage = { events: [JSON.parse(JSON.stringify(ev))] };
    fs.writeFileSync(storagePath, JSON.stringify(storage));
    // 预置一条遗留 evt_ 任务（事件已删除的场景）
    const { saveSchedules, loadSchedules } = require('../core/config');
    saveSchedules({ cron: [{ id: 'evt_gone_10', type: 'temporary', cron: '30 9 * * *', name: '遗留', action: 'reminder', message: 'x', channel: 'none' }] });

    const r1 = syncEventReminders({ storagePath });
    expect(r1.added).toBe(1);
    expect(r1.removed).toBe(1);
    const ids = loadSchedules().cron.map(t => t.id);
    expect(ids).toContain('evt_e1_10');
    expect(ids).not.toContain('evt_gone_10');

    // 幂等：再扫一遍零变化
    const r2 = syncEventReminders({ storagePath });
    expect(r2.added).toBe(0);
    expect(r2.removed).toBe(0);
  });

  test('事件改期（startTime 变化）→ 旧任务被替换', () => {
    const storagePath = path.join(tmpDir, 'schedule.json');
    const ev = makeEvent('e2', futureStartHour(), [10]);
    fs.writeFileSync(storagePath, JSON.stringify({ events: [JSON.parse(JSON.stringify(ev))] }));
    syncEventReminders({ storagePath });
    // 改期到「整点+5h」（必在 24h SCAN_WINDOW 内，提醒时刻必未来）
    const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 5);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const movedHour = String(d.getHours()).padStart(2, '0');
    const endHour = String((d.getHours() + 1) % 24).padStart(2, '0');
    const moved = new CalendarEvent({ id: 'e2', title: '项目评审', startTime: toISO8601(date, `${movedHour}:00`), endTime: toISO8601(date, `${endHour}:00`), reminders: [{ type: 'relative', value: 10, enabled: true }] });
    fs.writeFileSync(storagePath, JSON.stringify({ events: [JSON.parse(JSON.stringify(moved))] }));
    syncEventReminders({ storagePath });
    const task = require('../core/config').loadSchedules().cron.find(t => t.id === 'evt_e2_10');
    expect(task).toBeTruthy();
    // 新 cron 的小时应为整点提前 10 分钟（跨小时落到上一小时 :50；0 点跨到 23）
    const expectedHour = (d.getHours() + 23) % 24;
    expect(task.cron.startsWith(`50 ${expectedHour} `)).toBe(true);
  });
});
