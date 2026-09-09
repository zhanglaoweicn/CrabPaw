/**
 * scenario-reminder-engine — 场景化复合提醒规则引擎
 *
 * 纯函数式评估：evaluateScenarios(context) → 命中规则列表。
 * 消费方调用 proactive.notify 播报（去重/静默/补播由 notify 保证）。
 */

const { fetchWeatherForecast } = require('../weather-forecast');

const TAX_DEADLINE_DAY = 15; // 每月 15 日（增值税/个税征期截止，节假日顺延由人工确认）
const LICENSE_MONTHS = new Set([1, 2, 3, 4, 5, 6]); // 营业执照年报期
// 2026 法定节假日（前一日触发 holiday_eve）——每年年初更新
// 节日名映射（2026-09-08 P1: 节日营销海报主动建议——festival_poster 规则用）
const HOLIDAY_NAMES_2026 = {
  '2026-01-01': '元旦',
  '2026-02-16': '春节', '2026-02-17': '春节', '2026-02-18': '春节', '2026-02-19': '春节', '2026-02-20': '春节',
  '2026-04-05': '清明', '2026-04-06': '清明',
  '2026-05-01': '劳动节', '2026-05-02': '劳动节', '2026-05-03': '劳动节', '2026-05-04': '劳动节',
  '2026-06-19': '端午',
  '2026-10-01': '国庆', '2026-10-02': '国庆', '2026-10-03': '国庆', '2026-10-04': '国庆', '2026-10-05': '国庆',
};
// 每个节日的首日（festival_poster 仅在首日前 3 天触发一次，避免假期中段连日重复建议）
const HOLIDAY_FIRST_DAY = {};
for (const d of Object.keys(HOLIDAY_NAMES_2026).sort()) {
  const n = HOLIDAY_NAMES_2026[d];
  if (!HOLIDAY_FIRST_DAY[n]) HOLIDAY_FIRST_DAY[n] = d;
}
const HOLIDAYS_2026 = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04',
  '2026-06-19', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
]);

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function isWeekend(dateStr) {
  const d = new Date(dateStr);
  return d.getDay() === 0 || d.getDay() === 6;
}

/** 评估全部规则（纯函数；context 可注入，便于测试） */
function evaluateScenarios(context = {}) {
  const hits = [];
  const now = new Date(context.now || new Date().toISOString());
  const todayStr = now.toISOString().slice(0, 10);
  const hour = now.getHours();
  const weather = context.weather || { next6hMaxPrecipMm: 0 };
  const schedules = Array.isArray(context.schedules) ? context.schedules : [];

  // 1) weather_exit：6h 降雨 ≥ 2mm 且有外出日程
  if ((weather.next6hMaxPrecipMm || 0) >= 2) {
    const hasOutdoor = schedules.some((s) => {
      const st = new Date(s.start);
      return !Number.isNaN(st.getTime()) && st.getTime() > now.getTime() && st.getTime() <= now.getTime() + 6 * 3600 * 1000;
    });
    if (hasOutdoor) {
      hits.push({ ruleId: 'weather_exit', intent: 'inform', text: '您接下来的行程期间预报有雨，出门记得带伞，并预留路上时间。' });
    }
  }

  // 2) meeting_departure：日程前 20-40 分钟
  for (const s of schedules) {
    const st = new Date(s.start);
    if (Number.isNaN(st.getTime())) continue;
    const diff = st.getTime() - now.getTime();
    if (diff > 20 * 60 * 1000 && diff <= 40 * 60 * 1000) {
      hits.push({ ruleId: 'meeting_departure', intent: 'inform', text: `「${s.title || '日程'}」快到了，建议出发准备。` });
    }
  }

  // 3) tax_deadline：截止日当天上午 或 前 1 天傍晚
  if (now.getDate() === TAX_DEADLINE_DAY && hour >= 8 && hour < 12) {
    hits.push({ ruleId: 'tax_deadline', intent: 'inform', text: '今天是征期申报截止日，记得确认财务已完成申报。' });
  } else if (now.getDate() === TAX_DEADLINE_DAY - 1 && hour >= 16) {
    hits.push({ ruleId: 'tax_deadline', intent: 'ambient', text: '明天是报税截止日，别忘了财务确认申报。' });
  }

  // 4) license_renewal：年报期（1-6 月）月初提醒一次
  if (LICENSE_MONTHS.has(now.getMonth() + 1) && now.getDate() <= 10 && hour < 12) {
    hits.push({ ruleId: 'license_renewal', intent: 'ambient', text: '本月是营业执照年报期，记得安排年度报告填报。' });
  }

  // 5) holiday_eve：节假日前一天
  const nextDay = addDays(todayStr, 1);
  if (HOLIDAYS_2026.has(nextDay) && hour < 14) {
    hits.push({ ruleId: 'holiday_eve', intent: 'ambient', text: '明天开始放假，记得安排对账、快递收发与值班。' });
  }

  // 6) festival_poster（2026-09-08 P1）: 节日前 3 天建议节日营销海报
  //    命中后由 proactive 层去重；text 直接给出可执行口令，降低行动门槛。
  const inThreeDays = addDays(todayStr, 3);
  const festName = HOLIDAY_NAMES_2026[inThreeDays];
  // 仅在"节日首日前 3 天"当天触发（且当天还不是假期——假期中另有 holiday_eve）
  if (festName && inThreeDays === HOLIDAY_FIRST_DAY[festName] && !HOLIDAYS_2026.has(todayStr)) {
    const festName = HOLIDAY_NAMES_2026[inThreeDays];
    hits.push({
      ruleId: 'festival_poster',
      intent: 'suggest',
      text: `「${festName}」还有 3 天，需要做一张${festName}营销海报的话直接说"做一张${festName}促销海报"即可（支持 9:16/1:1 多规格）。`,
    });
  }

  // 6) stock_preopen：交易日 9:00-9:30 有持仓
  if (context.holdings && context.holdings.length && hour === 9 && now.getMinutes() <= 30 && !isWeekend(todayStr)) {
    hits.push({ ruleId: 'stock_preopen', intent: 'inform', text: context.stockBriefText || '开盘早报已就绪，稍后为您播报持仓情况。' });
  }

  // 7) trend_interest：画像关键词命中热榜（8:00-22:00）
  const keywords = Array.isArray(context.profileKeywords) ? context.profileKeywords : [];
  const titles = Array.isArray(context.trendingTitles) ? context.trendingTitles : [];
  if (keywords.length && titles.length && hour >= 8 && hour < 22) {
    const hit = titles.find((t) => keywords.some((k) => k && String(t).includes(String(k))));
    if (hit) {
      hits.push({ ruleId: 'trend_interest', intent: 'ambient', text: `您关注的「${hit.slice(0, 30)}」正在热榜上，跟您的业务方向相关，值得一看。` });
    }
  }

  return hits;
}

class ScenarioReminderEngine {
  constructor() {
    this._timer = null;
    this._lastEval = new Map(); // ruleId → lastTs
  }

  async evaluateNow({ city, schedules, holdings, stockBriefText } = {}) {
    try {
      // 画像关键词（getBossProfile；失败降级空数组）
      let profileKeywords = [];
      try {
        const profile = require('../boss-profile').getBossProfile().getProfile();
        profileKeywords = Object.values(profile).flatMap(
          (v) => typeof v === 'string' ? v.split(/[，,、\s]+/).filter(Boolean).slice(0, 5) : []
        );
      } catch (e) {
        console.warn('[scenario-reminder] boss-profile 关键词提取失败:', e.message || e);
      }

      // 热榜标题（trending-scraper fetchAllTrending；失败降级空数组）
      let trendingTitles = [];
      try {
        const { fetchAllTrending } = require('../trending-scraper');
        if (typeof fetchAllTrending === 'function') {
          const allResults = await fetchAllTrending();
          const items = Object.values(allResults || {}).flatMap(
            (r) => Array.isArray(r.items) ? r.items : []
          );
          trendingTitles = items.map((x) => x.title || x.name || String(x)).slice(0, 50);
        }
      } catch (e) {
        console.warn('[scenario-reminder] 热榜标题获取失败:', e.message || e);
      }

      let weather = null;
      if (city) {
        weather = await fetchWeatherForecast(city).catch(() => ({ next6hMaxPrecipMm: 0 }));
      }
      const hits = evaluateScenarios({
        weather, schedules, holdings, stockBriefText,
        profileKeywords, trendingTitles,
        now: new Date().toISOString(),
      });
      const { notify } = require('./index');
      let count = 0;
      for (const h of hits) {
        const last = this._lastEval.get(h.ruleId) || 0;
        if (Date.now() - last < 60 * 60 * 1000) continue; // 同规则 1h 内不重复（叠加 notify 去重）
        const r = notify({ trigger: `scenario_${h.ruleId}`, text: h.text, intent: h.intent });
        if (r.ok) { this._lastEval.set(h.ruleId, Date.now()); count++; }
      }
      return count;
    } catch (e) {
      console.error('[scenario-reminder] 评估失败:', e.message || e);
      return 0;
    }
  }

  start({ intervalMs = 30 * 60 * 1000, getContext } = {}) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      const ctx = typeof getContext === 'function' ? getContext() : {};
      this.evaluateNow(ctx).catch((e) => console.error('[scenario-reminder] 定时评估异常:', e.message || e));
    }, intervalMs);
    if (this._timer.unref) this._timer.unref(); // 2026-08-18: 定时器不阻止进程退出（退出走 runCleanup → stop()）
    setTimeout(() => { this.evaluateNow({}).catch((e) => console.warn('[scenario-reminder] 启动巡检失败:', e.message || e)); }, 30 * 1000);
    console.log('🧠 场景化复合提醒引擎已启动');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

const globalScenarioReminderEngine = new ScenarioReminderEngine();

module.exports = { ScenarioReminderEngine, globalScenarioReminderEngine, evaluateScenarios };
