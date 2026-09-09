/**
 * Task 1（死代码收口轮）: 轨迹 30 天保留调度接线
 * 背景: trajectory.js cleanup(maxAgeDays=30) 定义后全仓零调用——JSONL 无限增长，
 * 文档声称的保留策略名存实亡。本套件验证 scheduleTrajectoryCleanup 调度函数。
 */
const {
  scheduleTrajectoryCleanup,
  globalTrajectorySaver,
} = require('../core/trajectory');

describe('scheduleTrajectoryCleanup 轨迹保留调度', () => {
  test('返回句柄含 stop；stop 后不再重复执行（短间隔+计数）', async () => {
    const calls = [];
    const handle = scheduleTrajectoryCleanup({
      intervalMs: 30,
      maxAgeDays: 30,
      _exec: () => calls.push(1),
    });

    expect(typeof handle.stop).toBe('function');

    await new Promise((r) => setTimeout(r, 100));
    handle.stop();
    const n = calls.length;

    expect(n).toBeGreaterThan(0); // 调度确实生效

    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBe(n); // stop 后不再增长
  });

  test('默认 _exec 走 globalTrajectorySaver.cleanup(maxAgeDays)（不触真实文件删除）', async () => {
    const spy = jest
      .spyOn(globalTrajectorySaver, 'cleanup')
      .mockReturnValue(0);

    const handle = scheduleTrajectoryCleanup({ intervalMs: 20, maxAgeDays: 7 });
    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(spy).toHaveBeenCalled();
    expect(spy.mock.calls.some((c) => c[0] === 7)).toBe(true);

    spy.mockRestore();
  });

  test('_exec 抛错不崩溃调度、不炸进程', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = scheduleTrajectoryCleanup({
      intervalMs: 20,
      _exec: () => {
        throw new Error('boom');
      },
    });

    await new Promise((r) => setTimeout(r, 60));
    handle.stop();

    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
