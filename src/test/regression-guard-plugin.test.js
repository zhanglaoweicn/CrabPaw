/**
 * regression-guard 插件守卫测试（2026-08-31）
 *
 * 背景（OOM 崩溃根因修复）：插件此前在服务进程内自动跑全量 419 条 eval——
 * 每个记忆用例同步 JSON.parse 真实 435MB memory.json，多轮解析把堆推到
 * V8 上限（复现实测 3.07GB→3.51GB 持续攀升）→ 首条用户消息触发再解析时
 * 致命 OOM，进程静默退出（exit 1），桌面端随之关闭。
 * 回归评估的正确归属：CI（eval job 全量）+ precommit 快速档。服务进程内禁跑。
 */
jest.mock('../../evals/regression-check', () => ({
  runRegression: jest.fn(() => {
    throw new Error('SHOULD NOT BE CALLED IN SERVER PROCESS');
  }),
}));

const plugin = require('../../plugins/regression-guard/plugin');

describe('regression-guard 插件（服务进程内禁跑 eval）', () => {
  test('onStart 不再自动运行全量回归（OOM 崩溃根因 2026-08-31）', async () => {
    await plugin.onStart();
    const { runRegression } = require('../../evals/regression-check');
    expect(runRegression).not.toHaveBeenCalled();
  });

  test('onStart 可重复调用且幂等（重启场景不叠加定时器）', async () => {
    await plugin.onStart();
    await plugin.onStart();
    await expect(plugin.onStop()).resolves.toBeUndefined();
  });
});
