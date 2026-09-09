/**
 * regression-guard bundled plugin
 * 自动运行回归测试，检测技能变化导致的退化
 */
let _timer = null;

module.exports = {
  async onLoad({ manifest }) {
    console.log(`[RegressionGuard] 已加载 v${manifest.version}`);
  },
  async onStart() {
    // 2026-08-31 OOM 崩溃根因修复：此前 onStart 自动跑全量 419 条 eval（启动首跑 +
    // 24h interval）。服务进程内 eval 有三重问题：① config 已加载，EI2 隔离被宿主
    // 防线正确跳过 → 直接啃真实数据目录；② 每个 memory 用例同步 JSON.parse 435MB
    // memory.json（实测单进程堆爬至 3.5GB+）→ 首条用户消息触发再解析时 V8 致命
    // OOM，进程静默退出（exit 1）→ 桌面端连带关闭；③ 与 CI（eval job 全量）+
    // precommit 快速档重复。回归评估归属 CI/precommit，服务进程内禁跑。
    // 2026-08-25 S1 历史：当时修的是 runRegression 导出缺失导致的必抛异常。
    console.log('[RegressionGuard] 服务进程内不自动跑回归——归属 CI(全量)/precommit(快速档)。手动触发可用 npm run eval / eval:regression');
  },
  async onStop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    console.log('[RegressionGuard] 已停止');
  },
};
