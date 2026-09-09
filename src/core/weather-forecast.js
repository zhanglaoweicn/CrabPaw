/**
 * weather-forecast — 结构化天气预报
 *
 * wttr.in ?format=j1 主源（逐小时天气码+降雨量），Open-Meteo 备源。
 * fetchFn 可注入（测试用）；外部失败返回空对象，绝不抛错。
 */

const https = require('https');

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应非 JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}

async function fromWttrIn(city) {
  const j = await httpGetJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`);
  const hourly = [];
  const now = Date.now();
  const arr = (j && Array.isArray(j.hourly)) ? j.hourly : [];
  for (const h of arr) {
    const t = new Date(String(h.time).replace(' ', 'T') + ':00').getTime();
    if (Number.isNaN(t) || t < now - 3600 * 1000) continue;
    if (t > now + 12 * 3600 * 1000) break;
    const precip = Number(h.precipmm);
    hourly.push({ time: new Date(t).toISOString(), precipMm: Number.isFinite(precip) ? precip : 0, code: Number(h.weatherCode || 0) });
  }
  return { hourly, source: 'wttr.in' };
}

async function fromOpenMeteo() {
  // Open-Meteo 需经纬度；v1 由 getContext 提供坐标时启用（本任务保留空实现，回归 wttr.in 主源）
  return { hourly: [], source: 'open-meteo' };
}

async function fetchWeatherForecast(city, { fetchFn } = {}) {
  if (fetchFn) {
    try {
      const r = await fetchFn(city);
      if (r && r.hourly && r.hourly.length) {
        const next6h = r.hourly.filter((h) => new Date(h.time).getTime() <= Date.now() + 6 * 3600 * 1000);
        r.next6hMaxPrecipMm = next6h.reduce((m, h) => Math.max(m, h.precipMm || 0), 0);
      } else {
        r.next6hMaxPrecipMm = 0;
      }
      return r;
    } catch (e) { return { hourly: [], next6hMaxPrecipMm: 0, error: e.message || '注入源失败' }; }
  }
  const errors = [];
  for (const impl of [fromWttrIn, fromOpenMeteo]) {
    try {
      const r = await impl(city);
      if (r.hourly && r.hourly.length) {
        const next6h = r.hourly.filter((h) => new Date(h.time).getTime() <= Date.now() + 6 * 3600 * 1000);
        r.next6hMaxPrecipMm = next6h.reduce((m, h) => Math.max(m, h.precipMm || 0), 0);
        return r;
      }
      errors.push('无小时数据');
    } catch (e) { errors.push(e.message || String(e)); }
  }
  console.warn('[weather-forecast] 所有源失败:', errors.join('; '));
  return { hourly: [], next6hMaxPrecipMm: 0, error: errors.join('; ') };
}

module.exports = { fetchWeatherForecast };
