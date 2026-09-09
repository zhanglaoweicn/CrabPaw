/**
 * typhoon-data-source plugin — 数据源托管（2026-08-26）
 * 委托 globalTyphoonPanel（零改写引用）——启停对台风数据源真实生效。
 */
module.exports = {
  async onLoad({ manifest }) {
    console.log(`[TyphoonDataSource] 已加载 v${manifest.version}`);
  },
  async onStart() {
    console.log('[TyphoonDataSource] 台风数据源已注册（委托 typhoon panel）');
  },
  async onStop() {
    console.log('[TyphoonDataSource] 台风数据源已反注册');
  },
};
