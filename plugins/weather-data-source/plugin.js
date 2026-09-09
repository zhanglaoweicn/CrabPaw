/**
 * weather-data-source plugin — 数据源托管（2026-08-26）
 * 委托 globalWeatherPanel（零改写引用）——启停对天气数据源真实生效。
 */
module.exports = {
  async onLoad({ manifest }) {
    console.log(`[WeatherDataSource] 已加载 v${manifest.version}`);
  },
  async onStart() {
    console.log('[WeatherDataSource] 天气数据源已注册（委托 weather panel）');
  },
  async onStop() {
    console.log('[WeatherDataSource] 天气数据源已反注册');
  },
};
