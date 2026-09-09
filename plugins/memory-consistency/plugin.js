/**
 * memory-consistency bundled plugin
 * 定期检查记忆系统中的不一致（重复标题 / 空内容）
 */
let _timer = null;

module.exports = {
  async onLoad({ manifest }) {
    console.log(`[MemoryConsistency] 已加载 v${manifest.version}`);
  },
  async onStart() {
    // 2026-08-25 S1 修复：此前调用不存在的 MemoryRelations.findContradictions()，
    // 6h 定时器每次运行必抛 "findContradictions is not a function"（实机噪音源）。
    // 改为对 unified-store 的确定性一致性信号：重复标题（同 title 多行）+ 空内容计数。
    _timer = setInterval(async () => {
      try {
        const { getUnifiedStore } = require('../../src/core/memory/unified-store');
        const store = getUnifiedStore();
        const dupes = store.all(
          "SELECT title, COUNT(*) AS c FROM memories WHERE title != '' GROUP BY title HAVING c > 1 ORDER BY c DESC LIMIT 5"
        );
        const empty = store.get("SELECT COUNT(*) AS c FROM memories WHERE content IS NULL OR content = ''");
        if ((dupes && dupes.length) || (empty && empty.c > 0)) {
          console.warn(`[MemoryConsistency] 发现记忆不一致: 重复标题 ${dupes ? dupes.length : 0} 组, 空内容 ${(empty && empty.c) || 0} 条`);
        }
      } catch (e) {
        console.warn('[MemoryConsistency] 检查失败:', e.message);
      }
    }, 6 * 60 * 60 * 1000); // 每 6 小时
    console.log('[MemoryConsistency] 已启动 (间隔: 6h)');
  },
  async onStop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    console.log('[MemoryConsistency] 已停止');
  },
};
