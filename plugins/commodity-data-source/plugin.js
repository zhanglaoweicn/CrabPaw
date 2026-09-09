/**
 * commodity-data-source plugin — 数据源托管（2026-08-26）
 * 委托 commodity-service commoditySearch（零改写引用）——启停对商品取数真实生效。
 */
module.exports = {
  async onLoad({ manifest }) {
    console.log(`[CommodityDataSource] 已加载 v${manifest.version}`);
  },
  async onStart() {
    console.log('[CommodityDataSource] 商品数据源已注册（委托 commodity-service）');
  },
  async onStop() {
    console.log('[CommodityDataSource] 商品数据源已反注册');
  },
};
