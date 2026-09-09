/** 天气数据源 factory——委托 globalWeatherPanel（与 builtin 同款签名） */
const { globalWeatherPanel } = require('../../src/core/panels/weather');
module.exports = (params = {}) => globalWeatherPanel.getWeather(params.city || '北京', params);
