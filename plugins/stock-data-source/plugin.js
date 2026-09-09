/**
 * stock-data-source plugin — 数据源托管示范（2026-08-26）
 *
 * 通过 contributes.dataSources 把「股票行情/资讯」数据源交给插件托管：
 * 插件 enable → 数据源注册（装配视图 sources 出现 stock）
 * 插件 disable → 数据源反注册（装配视图 sources 摘除 stock, 取数降级）
 * 数据源实现委托现有 stock-data-source-manager（零改写引用——同 builtin 同款）。
 */
module.exports = {
  async onLoad({ manifest }) {
    console.log(`[StockDataSource] 已加载 v${manifest.version}`);
  },
  async onStart() {
    console.log('[StockDataSource] 数据源已注册（委托 stock-data-source-manager）');
  },
  async onStop() {
    console.log('[StockDataSource] 数据源已反注册');
  },
};
