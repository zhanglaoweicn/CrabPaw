/**
 * scheduler-bridge 测试——注入式调度器桥（R1 热加载/双实例收敛的枢纽）
 * 用真实 Scheduler 实例验证 reload 语义，不 mock Scheduler 本身。
 */
jest.mock('../core/config', () => {
  let schedules = { cron: [] };
  return {
    loadSchedules: () => schedules,
    saveSchedules: (s) => { schedules = s; },
  };
});
const { Scheduler } = require('../core/scheduler');
const {
  setGlobalScheduler, getGlobalScheduler, reloadGlobalScheduler,
} = require('../core/scheduler-bridge');

describe('scheduler-bridge', () => {
  test('set/get 环回；未设置时 get 返回 null、reload 安全返回 false', () => {
    expect(getGlobalScheduler()).toBeNull();
    expect(reloadGlobalScheduler()).toBe(false);
    const cron = new Scheduler();
    setGlobalScheduler(cron);
    expect(getGlobalScheduler()).toBe(cron);
  });

  test('reloadGlobalScheduler 重读 schedules.json → 任务即时出现在实例（不重启生效的合同）', () => {
    const cron = new Scheduler();
    setGlobalScheduler(cron);
    expect(cron.tasks).toHaveLength(0);
    // 直接写内存 schedules（mock 的 config），模拟 SetReminder 落盘
    const { saveSchedules } = require('../core/config');
    saveSchedules({ cron: [{ id: 'r1', type: 'temporary', cron: '30 9 * * *', name: '提醒-喝水', action: 'reminder', message: '喝水', channel: 'none' }] });
    expect(reloadGlobalScheduler()).toBe(true);
    expect(cron.tasks).toHaveLength(1);
    expect(cron.tasks[0].id).toBe('r1');
  });

  test('load 二次调用幂等（不重复累积任务）', () => {
    const cron = new Scheduler();
    setGlobalScheduler(cron);
    reloadGlobalScheduler();
    reloadGlobalScheduler();
    expect(cron.tasks).toHaveLength(1);
  });
});
