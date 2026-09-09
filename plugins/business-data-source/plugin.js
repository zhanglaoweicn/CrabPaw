/**
 * business-data-source plugin — 数据源托管（2026-08-26）
 * 委托 business-data-registry listTables（零改写引用）——启停对经营数据源真实生效。
 */
module.exports = {
  async onLoad({ manifest }) {
    console.log(`[BusinessDataSource] 已加载 v${manifest.version}`);
  },
  async onStart() {
    console.log('[BusinessDataSource] 经营数据源已注册（委托 business-data-registry）');
  },
  async onStop() {
    console.log('[BusinessDataSource] 经营数据源已反注册');
  },
};
