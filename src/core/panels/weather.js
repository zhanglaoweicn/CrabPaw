/**
 * Weather Panel — 天气信息面板
 *
 * 天气能力（wttr.in 数据源 + weather kind 投影到 Scene UI）。
 * CrabPaw 作为 CLI Agent，天气面板输出终端友好的彩色表格。
 *
 * 数据源：wttr.in（固定，无需 API Key）
 * 缓存：结果缓存 30 分钟，减少重复请求
 */

const https = require('https');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

/**
 * 城市名清理（voice-interrupt-panels-analysis 问题 #3 修复）：
 * - 去首尾空白/内部空格：" 海 口 " → "海口"
 * - 去尾部"的"："海口的" → "海口"（"海口的天气"预投影贪婪匹配把"的"吃进城市名 → wttr.in 500）
 * - 空值兜底北京
 */
function cleanCityName(city) {
  return String(city || '北京').replace(/\s+/g, '').replace(/的$/, '').trim() || '北京';
}

class WeatherPanel {
 constructor() {
 this._cache = new Map(); // city → { data, ts }
 }

 /**
 * 获取天气数据
 * @param {string} city 城市名（中文或英文）
 * @param {object} options
 * @param {boolean} options.forceRefresh 强制刷新缓存
 * @returns {Promise<object>} 天气数据
 */
 async getWeather(city = '北京', options = {}) {
 const cleanCity = cleanCityName(city);
 const cacheKey = cleanCity.toLowerCase();

 // 检查缓存
 if (!options.forceRefresh && this._cache.has(cacheKey)) {
 const cached = this._cache.get(cacheKey);
 if (Date.now() - cached.ts < CACHE_TTL_MS) {
 return cached.data;
 }
 }

 try {
 const data = await this._fetchWeather(cleanCity);
 this._cache.set(cacheKey, { data, ts: Date.now() });
 return data;
 } catch (err) {
 // 缓存降级：过期缓存仍可用但不新鲜
 if (this._cache.has(cacheKey)) {
 const stale = this._cache.get(cacheKey);
 return { ...stale.data, _stale: true, _error: err.message };
 }
 throw err;
 }
 }

 /**
 * 将天气数据渲染为终端文本
 * @param {object} data 天气数据
 * @returns {string} 终端友好的天气摘要
 */
 render(data) {
 if (!data || !data.current) return '🌤 天气数据不可用';

 const lines = [];
 lines.push('┌────────────────────────────────────────────┐');
 lines.push(`│ 🌤 ${data.city || '未知'} · ${new Date(data.ts || data.fetchedAt || Date.now()).toLocaleTimeString()} 更新`);
 if (data._stale) lines.push('│ ⚠️ 数据可能不是最新的（使用缓存）');
 lines.push('├────────┬──────┬──────┬──────┬──────┬───────┤');

 // 当前天气
 const c = data.current;
 lines.push(`│ 当前 │ ${c.temp || '?'}° ${c.condition || ''} │ 风 ${c.wind || '?'} │ 湿度 ${c.humidity || '?'} │ 体感 ${c.feelsLike || '?'}° │`);

 // 预报
 const forecasts = data.forecast || [];
 if (forecasts.length > 0) {
 const header = '│ 预报 │ ' + forecasts.slice(0, 5).map(d =>
 this._padCenter(d.day || '', 4)
 ).join(' │ ') + ' │';
 lines.push(header);

 const temps = '│ │ ' + forecasts.slice(0, 5).map(d =>
 `${d.high || '?'}°/${d.low || '?'}°`.padStart(4)
 ).join(' │ ') + ' │';
 lines.push(temps);

 const conds = '│ │ ' + forecasts.slice(0, 5).map(d =>
 this._padCenter(d.condition || '', 4)
 ).join(' │ ') + ' │';
 lines.push(conds);
 }

 lines.push('└────────┴──────┴──────┴──────┴──────┴───────┘');
 return lines.join('\n');
 }

 /**
 * 渲染为紧凑单行摘要（注入 prompt 用）
 */
 renderCompact(data) {
 if (!data || !data.current) return '';

 const c = data.current;
 return `[天气] ${data.city} ${c.temp}°${c.condition ? ' ' + c.condition : ''} 风${c.wind || '?'} 湿度${c.humidity || '?'}%`;
 }

 /**
 * 清除缓存
 */
 clearCache() { this._cache.clear(); }

 // ─── 内部 ───

 _fetchWeather(city) {
 return new Promise((resolve, reject) => {
 const encoded = encodeURIComponent(city);
 const url = `https://wttr.in/${encoded}?format=j1`;

 https.get(url, { timeout: 10000 }, (res) => {
 let body = '';
 res.on('data', chunk => body += chunk);
 res.on('end', () => {
 try {
 const json = JSON.parse(body);
 resolve(this._parseWttrResponse(json, city));
 } catch (e) {
 reject(new Error(`解析天气数据失败: ${e.message}`));
 }
 });
 }).on('error', reject).on('timeout', function() {
 this.destroy();
 reject(new Error('天气 API 请求超时'));
 });
 });
 }

 _parseWttrResponse(json, city) {
 const cc = json.current_condition?.[0] || {};

 const forecast = (json.weather || []).map(d => ({
 day: this._dateToDay(d.date),
 date: d.date,
 high: d.maxtempC,
 low: d.mintempC,
 condition: d.hourly?.[0]?.weatherDesc?.[0]?.value || '',
 }));

 return {
 city,
 ts: Date.now(),
 current: {
 temp: cc.temp_C || '?',
 feelsLike: cc.FeelsLikeC || cc.temp_C || '?',
 condition: cc.weatherDesc?.[0]?.value || '',
 wind: cc.windspeedKmph ? `${cc.windspeedKmph}km/h` : '?',
 humidity: cc.humidity || '?',
 pressure: cc.pressure || '?',
 uvIndex: cc.uvIndex || '?',
 visibility: cc.visibility || '?',
 },
 forecast,
 fetchedAt: Date.now(),
 };
 }

 _dateToDay(dateStr) {
 if (!dateStr) return '';
 const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
 const d = new Date(dateStr);
 return days[d.getDay()] || '';
 }

 _padCenter(str, width) {
 if (str.length >= width) return str.slice(0, width);
 const left = Math.floor((width - str.length) / 2);
 return ' '.repeat(left) + str + ' '.repeat(width - str.length - left);
 }
}

// 全局单例
const globalWeatherPanel = new WeatherPanel();

module.exports = {
 WeatherPanel,
 globalWeatherPanel,
 cleanCityName,
};
