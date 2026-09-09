'use strict';

/**
 * time-parser.js — 自然语言时间解析
 *
 * 设计参考 的时间解析层（相对/绝对/区间）：
 * - 相对时间：今天、明天、后天、昨天、下周、上个月、3天后、2小时后
 * - 绝对时间：2026-07-12、2026/7/12 14:30、7月12日
 * - 中文数字：三天/两小时/半小时/一刻钟
 * - 区间：今天到明天、本周到下周
 *
 * 解析结果为结构化对象，便于：
 * - 时间感知系统增强（time-awareness 集成）
 * - 提醒/日程/计划类工具
 * - 记忆系统时间索引
 */

const CN_NUMBERS = {
 '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
 '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
 '十一': 11, '十二': 12, '十三': 13, '十四': 14, '十五': 15,
 '十六': 16, '十七': 17, '十八': 18, '十九': 19, '二十': 20,
 '三十': 30, '四十': 40, '五十': 50, '六十': 60, '九十': 90, '百': 100,
 '半': 0.5,
};

function parseChineseNumber(str) {
 if (!str) return NaN;
 // 阿拉伯数字
 if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
 // 纯中文数字
 if (str in CN_NUMBERS) return CN_NUMBERS[str];
 // 复合中文：X 十 Y
 const m = str.match(/^([零一二三四五六七八九十百]+)十([零一二三四五六七八九])?$/);
 if (m) {
 const left = CN_NUMBERS[m[1]] || 1;
 const right = m[2] ? CN_NUMBERS[m[2]] : 0;
 return left * 10 + right;
 }
 return NaN;
}

// 工具：返回 {year, month, day, hour, minute} 在指定时区
function tzDate(date) {
 return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
}

function startOfDay(d) {
 const x = new Date(d);
 x.setHours(0, 0, 0, 0);
 return x;
}

function addDays(d, n) {
 const x = new Date(d);
 x.setDate(x.getDate() + n);
 return x;
}

function addMonths(d, n) {
 const x = new Date(d);
 x.setMonth(x.getMonth() + n);
 return x;
}

function addHours(d, n) {
 return new Date(d.getTime() + n * 3600 * 1000);
}

function addMinutes(d, n) {
 return new Date(d.getTime() + n * 60 * 1000);
}

function isoDate(d) {
 return d.toISOString();
}

function formatDate(d) {
 const y = d.getFullYear();
 const m = String(d.getMonth() + 1).padStart(2, '0');
 const day = String(d.getDate()).padStart(2, '0');
 const hh = String(d.getHours()).padStart(2, '0');
 const mm = String(d.getMinutes()).padStart(2, '0');
 return `${y}-${m}-${day} ${hh}:${mm}`;
}

// ── 解析函数 ─────────────────────────────────────

/**
 * 解析相对时间：今天、明天、后天、下周、上个月、3天后、2小时后
 * @param {string} expr
 * @param {Date} [now=new Date()]
 * @returns {Date|null}
 */
function parseRelative(expr, now = new Date()) {
 if (!expr || typeof expr !== 'string') return null;
 const e = expr.trim().toLowerCase();
 const today = startOfDay(tzDate(now));

 // 直接关键字
 if (e === '今天' || e === '今日' || e === 'now' || e === 'today') return today;
 if (e === '明天' || e === '明日' || e === 'tomorrow') return addDays(today, 1);
 if (e === '后天' || e === '后天') return addDays(today, 2);
 if (e === '大后天') return addDays(today, 3);
 if (e === '昨天' || e === '昨日' || e === 'yesterday') return addDays(today, -1);
 if (e === '前天' || e === '前日') return addDays(today, -2);
 if (e === '上周' || e === '上星期') return addDays(today, -7);
 if (e === '下周' || e === '下星期' || e === 'next week') return addDays(today, 7);
 if (e === '上个月' || e === '上月') return addMonths(today, -1);
 if (e === '下个月' || e === '下月' || e === 'next month') return addMonths(today, 1);
 if (e === '去年') {
 const x = new Date(today);
 x.setFullYear(x.getFullYear() - 1);
 return x;
 }
 if (e === '明年' || e === 'next year') {
 const x = new Date(today);
 x.setFullYear(x.getFullYear() + 1);
 return x;
 }

 // N 天/周/月/年 后/前
 let m = e.match(/^(\d+|[\u4e00-\u9fff]+)\s*(天|日)\s*(后|前|之后|之前|after|before)?$/);
 if (m) {
 const n = parseChineseNumber(m[1]);
 if (Number.isFinite(n)) {
 const dir = m[3] && /前|之前|before/.test(m[3]) ? -1 : 1;
 return addDays(today, n * dir);
 }
 }
 m = e.match(/^(\d+|[\u4e00-\u9fff]+)\s*(周|星期)\s*(后|前|之后|之前)?$/);
 if (m) {
 const n = parseChineseNumber(m[1]);
 if (Number.isFinite(n)) {
 const dir = m[3] && /前|之前/.test(m[3]) ? -1 : 1;
 return addDays(today, n * 7 * dir);
 }
 }
 m = e.match(/^(\d+|[\u4e00-\u9fff]+)\s*(个月|月)\s*(后|前|之后|之前)?$/);
 if (m) {
 const n = parseChineseNumber(m[1]);
 if (Number.isFinite(n)) {
 const dir = m[3] && /前|之前/.test(m[3]) ? -1 : 1;
 return addMonths(today, n * dir);
 }
 }
 m = e.match(/^(\d+|[\u4e00-\u9fff]+)\s*(年)\s*(后|前|之后|之前)?$/);
 if (m) {
 const n = parseChineseNumber(m[1]);
 if (Number.isFinite(n)) {
 const dir = m[3] && /前|之前/.test(m[3]) ? -1 : 1;
 const x = new Date(today);
 x.setFullYear(x.getFullYear() + n * dir);
 return x;
 }
 }
 // 小时/分钟
 m = e.match(/^(\d+|[\u4e00-\u9fff]+)\s*(小时|个小时|时|hour|hours|h)\s*(后|前|之后|之前)?$/);
 if (m) {
 const n = parseChineseNumber(m[1]);
 if (Number.isFinite(n)) {
 const dir = m[3] && /前|之前/.test(m[3]) ? -1 : 1;
 return addHours(today, n * dir);
 }
 }
 m = e.match(/^(\d+|[\u4e00-\u9fff]+)\s*(分钟|分|minute|minutes|min)\s*(后|前|之后|之前)?$/);
 if (m) {
 const n = parseChineseNumber(m[1]);
 if (Number.isFinite(n)) {
 const dir = m[3] && /前|之前/.test(m[3]) ? -1 : 1;
 return addMinutes(today, n * dir);
 }
 }
 // 半小时
 if (e === '半小时后' || e === '半小时') return addMinutes(today, 30);
 if (e === '一刻钟后' || e === '一刻钟') return addMinutes(today, 15);

 // 时段 + 具体时间：明天下午 3 点 / 今天上午 10:30 / 今晚 8 点
 m = e.match(/^(今天|明天|后天|昨天|前天|大后天|本周|下周|上周|这个月|下个月)?\s*(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜里|深夜|今晚|明早|明晚)?\s*(\d{1,2}|[\u4e00-\u9fff]+)\s*(点|时|:)(?:\s*(\d{1,2})\s*分?)?$/);
 if (m) {
 const dayExpr = m[1] || '今天';
 let base = parseRelative(dayExpr, now);
 if (!base) base = today;
 const tod = m[2] || '';
 let hour = parseChineseNumber(m[3]);
 if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
 // 时段修正（如果时段存在且与数字冲突）
 if (/下午|傍晚|晚上|夜里|深夜|今晚|明晚/.test(tod) && hour < 12) hour += 12;
 if (/凌晨|早上|上午|清晨|明早/.test(tod) && hour === 12) hour = 0;
 const minute = m[4] ? (parseChineseNumber(m[4]) || 0) : 0;
 if (minute < 0 || minute > 59) return null;
 return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0);
 }

 return null;
}

/**
 * 解析绝对时间
 * @param {string} expr
 * @param {Date} [now=new Date()]
 * @returns {Date|null}
 */
function parseAbsolute(expr, now = new Date()) {
 if (!expr || typeof expr !== 'string') return null;
 const e = expr.trim();
 const today = startOfDay(tzDate(now));

 // YYYY-MM-DD HH:mm 或 YYYY/MM/DD HH:mm
 let m = e.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
 if (m) {
 return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
 }
 // MM-DD HH:mm
 m = e.match(/^(\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
 if (m) {
 return new Date(today.getFullYear(), +m[1] - 1, +m[2], +(m[3] || 0), +(m[4] || 0));
 }
 // X月X日 [HH:mm]
 m = e.match(/^(\d{1,2}|[\u4e00-\u9fff]+)月(\d{1,2}|[\u4e00-\u9fff]+)日?(?:[ T](\d{1,2}):(\d{2}))?$/);
 if (m) {
 const month = parseChineseNumber(m[1]);
 const day = parseChineseNumber(m[2]);
 if (Number.isFinite(month) && Number.isFinite(day)) {
 return new Date(today.getFullYear(), month - 1, day, +(m[3] || 0), +(m[4] || 0));
 }
 }
 // 农历节日（粗略匹配，按 LUNAR_HOLIDAYS 近似为阳历）
 // 略：留给 LLM 推断

 return null;
}

/**
 * 解析区间：今天到明天、本周到下周
 * @param {string} expr
 * @param {Date} [now]
 * @returns {{ start: Date, end: Date } | null}
 */
function parseRange(expr, now = new Date()) {
 if (!expr || typeof expr !== 'string') return null;
 const e = expr.trim();

 // X 到 Y
 const m = e.match(/^(.+?)\s*(?:到|至|~|-|—|to)\s*(.+)$/);
 if (m) {
 const start = parseTime(m[1].trim(), now);
 const end = parseTime(m[2].trim(), now);
 if (start && end && end >= start) {
 return { start, end };
 }
 }
 return null;
}

/**
 * 顶层解析：相对、绝对、区间都尝试
 * @param {string} expr
 * @param {Date} [now]
 * @returns {Date|{ start: Date, end: Date }|null}
 */
function parseTime(expr, now = new Date()) {
 if (!expr) return null;
 const r = parseRange(expr, now);
 if (r) return r;
 const rel = parseRelative(expr, now);
 if (rel) return rel;
 const abs = parseAbsolute(expr, now);
 if (abs) return abs;
 return null;
}

/**
 * 判断时间是否在过去
 */
function isPast(d, now = new Date()) {
 return d.getTime() < now.getTime();
}

/**
 * 计算"X 秒前/X 分钟后"相对显示
 */
function relativeLabel(target, now = new Date()) {
 const diff = target.getTime() - now.getTime();
 const abs = Math.abs(diff);
 const past = diff < 0;
 const minute = 60 * 1000;
 const hour = 60 * minute;
 const day = 24 * hour;
 const week = 7 * day;
 const month = 30 * day;
 const year = 365 * day;
 let value, unit;
 if (abs < minute) { value = Math.round(abs / 1000); unit = '秒'; }
 else if (abs < hour) { value = Math.round(abs / minute); unit = '分钟'; }
 else if (abs < day) { value = Math.round(abs / hour); unit = '小时'; }
 else if (abs < week) { value = Math.round(abs / day); unit = '天'; }
 else if (abs < month) { value = Math.round(abs / week); unit = '周'; }
 else if (abs < year) { value = Math.round(abs / month); unit = '个月'; }
 else { value = Math.round(abs / year); unit = '年'; }
 return past ? `${value} ${unit}前` : `${value} ${unit}后`;
}

// ── 工具类 ─────────────────────────────────────
class TimeParser {
 constructor() {
 this._now = null;
 }

 setNow(d) { this._now = d; }

 parse(expr) {
 return parseTime(expr, this._now || new Date());
 }

 parseRelative(expr) {
 return parseRelative(expr, this._now || new Date());
 }

 parseAbsolute(expr) {
 return parseAbsolute(expr, this._now || new Date());
 }

 parseRange(expr) {
 return parseRange(expr, this._now || new Date());
 }

 isPast(d) {
 return isPast(d, this._now || new Date());
 }

 relativeLabel(target) {
 return relativeLabel(target, this._now || new Date());
 }
}

let _instance = null;
function getTimeParser() {
 if (!_instance) _instance = new TimeParser();
 return _instance;
}

module.exports = {
 TimeParser,
 getTimeParser,
 parseTime,
 parseRelative,
 parseAbsolute,
 parseRange,
 parseChineseNumber,
 relativeLabel,
 isPast,
 formatDate,
 isoDate,
 CN_NUMBERS,
};
