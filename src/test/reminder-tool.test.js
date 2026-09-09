/**
 * reminder-tool 测试（P2-4：无消息通道时提醒不丢，转本机播报）
 *
 * 隔离策略：mock config（避免读写真实 schedules.json）与 registry（避免引入
 * 全量工具链副作用），scheduler 用真实实现验证"提醒可被调度器加载触发"。
 */
jest.mock('../core/config', () => {
  let schedules = { cron: [] };
  return {
    loadConfig: () => ({ chatChannel: undefined }),
    loadSchedules: () => schedules,
    saveSchedules: (s) => { schedules = s; },
  };
});

jest.mock('../tools/registry', () => ({
  ToolRegistry: class { },
  registry: { register: jest.fn() },
}));

jest.mock('../core/scheduler-bridge', () => ({
  reloadGlobalScheduler: jest.fn(() => true),
  setGlobalScheduler: jest.fn(),
  getGlobalScheduler: jest.fn(() => null),
}));

const { handleSetReminder, handleListReminders, handleRemoveReminder } = require('../tools/reminder-tool');
const { Scheduler } = require('../core/scheduler');

describe('SetReminder 无消息通道（桌面单机）', () => {
  test('channel=none 不再失败，返回应用内播报提示', async () => {
    const res = await handleSetReminder({ message: '喝水', time: '14:30' }, {});
    expect(res.success).toBe(true);
    expect(res.channel).toBe('none');
    expect(res.message).toContain('应用内播报');
  });

  test('保存的提醒含 name/action=reminder，可被调度器加载触发', async () => {
    const res = await handleSetReminder({ message: '站起来活动', time: '15:00' }, {});
    expect(res.success).toBe(true);

    const { loadSchedules } = require('../core/config');
    const sched = loadSchedules();
    const rem = sched.cron.find(r => r.id === res.reminderId);
    expect(rem).toBeTruthy();
    expect(rem.action).toBe('reminder');
    expect(rem.name).toBeTruthy();
    expect(rem.channel).toBe('none');
    expect(rem.type).toBe('temporary');

    // 调度器能加载该提醒（此前缺 name/action 会被 scheduler.load 跳过 → 提醒永不触发）
    const cron = new Scheduler();
    cron.load(sched);
    const loaded = cron.tasks.find(t => t.id === res.reminderId);
    expect(loaded).toBeTruthy();
    expect(loaded.action).toBe('reminder');
  });

  test('外部通道（wecom/lark）正常路径不受影响', async () => {
    const res = await handleSetReminder({ message: '开会', time: '16:00', channel: 'wecom' }, {});
    expect(res.success).toBe(true);
    expect(res.message).toContain('提醒已创建');
    expect(res.message).not.toContain('应用内播报');
  });

  test('ListReminders 能列出无通道提醒', async () => {
    await handleSetReminder({ message: '吃药', time: '18:00' }, {});
    const list = await handleListReminders();
    expect(list.success).toBe(true);
    expect(list.reminders.length).toBeGreaterThanOrEqual(1);
    expect(list.reminders.some(r => r.message === '吃药')).toBe(true);
  });

  test('非法时间仍返回错误', async () => {
    const res = await handleSetReminder({ message: 'x', time: '不是时间' }, {});
    expect(res.success).toBe(false);
    expect(res.error).toContain('无法解析时间');
  });

  test('一次性提醒触发后可被移除（server 触发点调 removeReminderFromSchedules）', async () => {
    const res = await handleSetReminder({ message: '拉伸', time: '17:00' }, {});
    const { removeReminderFromSchedules } = require('../tools/reminder-tool');
    expect(removeReminderFromSchedules(res.reminderId)).toBe(true);
    const list = await handleListReminders();
    expect(list.reminders.some(r => r.id === res.reminderId)).toBe(false);
    // 重复移除返回 false（幂等）
    expect(removeReminderFromSchedules(res.reminderId)).toBe(false);
  });
});

describe('R1 热加载：运行中 SetReminder 即时进运行实例', () => {
  test('add 与 remove 后都触发 reloadGlobalScheduler', async () => {
    const { reloadGlobalScheduler } = require('../core/scheduler-bridge');
    reloadGlobalScheduler.mockClear();
    await handleSetReminder({ message: '测试热加载', time: '23:59' }, {});
    expect(reloadGlobalScheduler).toHaveBeenCalled();
    reloadGlobalScheduler.mockClear();
    const res = await handleSetReminder({ message: '待删除', time: '23:58' }, {});
    await handleRemoveReminder({ reminder_id: res.reminderId });
    expect(reloadGlobalScheduler).toHaveBeenCalled();
  });
});
