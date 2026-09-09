/**
 * Holiday Calendar — 中国节假日判断工具
 *
 * 用于自动化任务的"节假日跳过"功能。
 * 数据来源：国务院每年发布的法定节假日安排。
 *
 * 用法:
 *   const { isHoliday, isWorkday } = require('./holiday-calendar');
 *   isHoliday(new Date('2026-10-01'));  // true (国庆节)
 *   isWorkday(new Date('2026-01-04'));   // false (调休后的周日上班)
 */

// ─── 中国法定节假日（2025-2027） ─────────────────────────────
// 格式: 'YYYY-MM-DD' 列表
// 包含: 法定假日 + 调休后需要上班的周末

const HOLIDAYS = {
  // 2025 年节假日
  2025: {
    dates: [
      '2025-01-01', // 元旦
      '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', // 春节
      '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
      '2025-04-04', '2025-04-05', '2025-04-06', // 清明节
      '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05', // 劳动节
      '2025-05-31', '2025-06-01', '2025-06-02', // 端午节
      '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05',
      '2025-10-06', '2025-10-07', '2025-10-08', // 国庆+中秋
    ],
    workdays: [
      '2025-01-26', // 春节调休
      '2025-02-08',
      '2025-04-27', // 劳动节调休
      '2025-09-28', // 国庆调休
      '2025-10-11',
    ],
  },
  2026: {
    dates: [
      '2026-01-01', // 元旦
      '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
      '2026-02-21', '2026-02-22', '2026-02-23', // 春节
      '2026-04-04', '2026-04-05', '2026-04-06', // 清明节
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
      '2026-06-19', '2026-06-20', '2026-06-21', // 端午节
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
      '2026-10-06', '2026-10-07', '2026-10-08', // 国庆+中秋
    ],
    workdays: [
      '2026-02-14', // 春节调休
      '2026-02-15',
      '2026-04-26', // 劳动节调休
      '2026-05-09',
      '2026-09-27', // 国庆调休
      '2026-10-10',
    ],
  },
  2027: {
    dates: [
      '2027-01-01', // 元旦
      '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
      '2027-02-10', '2027-02-11', '2027-02-12', // 春节
      '2027-04-04', '2027-04-05', '2027-04-06', // 清明节
      '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05', // 劳动节
      '2027-06-08', '2027-06-09', '2027-06-10', // 端午节
      '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
      '2027-10-06', '2027-10-07', // 国庆+中秋
    ],
    workdays: [
      '2027-02-14', // 春节调休
      '2027-02-20',
      '2027-05-08', // 劳动节调休
      '2027-09-26', // 国庆调休
      '2027-10-09',
    ],
  },
};

// ─── 日期工具函数 ────────────────────────────────────────────

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

// ─── 公开 API ────────────────────────────────────────────────

/**
 * 判断给定日期是否为中国的法定假日或周末
 * @param {Date|string|number} date
 * @returns {boolean}
 */
function isHoliday(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dateStr = toDateStr(d);
  const year = d.getFullYear();

  const yearData = HOLIDAYS[year] || HOLIDAYS[year - 1] || HOLIDAYS[year + 1];
  if (yearData) {
    // 法定节假日
    if (yearData.dates.includes(dateStr)) return true;
    // 调休后上班的周末不算假日
    if (yearData.workdays.includes(dateStr)) return false;
  }

  // 默认: 周末算假日
  return isWeekend(d);
}

/**
 * 判断给定日期是否为工作日
 * @param {Date|string|number} date
 * @returns {boolean}
 */
function isWorkday(date) {
  return !isHoliday(date);
}

/**
 * 获取指定日期最近的之后的工作日
 * @param {Date|string|number} date
 * @returns {Date}
 */
function nextWorkday(date) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setDate(d.getDate() + 1);
  while (isHoliday(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * 获取指定日期的节假日名称（如果有）
 * @param {Date|string|number} date
 * @returns {string|null}
 */
function getHolidayName(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dateStr = toDateStr(d);
  const year = d.getFullYear();

  const yearData = HOLIDAYS[year];
  if (!yearData) return null;

  if (yearData.dates.includes(dateStr)) {
    // Determine which holiday
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (m === 1 && day === 1) return '元旦';
    if ((m === 1 && day >= 28) || (m === 2 && day <= 4)) return '春节';
    if (m === 4 && day >= 4 && day <= 6) return '清明节';
    if (m === 5 && day >= 1 && day <= 5) return '劳动节';
    if (m === 6 && day >= 19 && day <= 21) return '端午节'; // 2026
    if (m === 6 && day >= 8 && day <= 10) return '端午节'; // 2027
    if (m === 10 && day >= 1 && day <= 8) return '国庆节';
    return '节假日';
  }

  return null;
}

/**
 * 添加自定义节假日
 * @param {number} year
 * @param {string[]} dates - ['YYYY-MM-DD', ...]
 * @param {string[]} workdays - 调休上班日
 */
function addCustomHolidays(year, dates = [], workdays = []) {
  if (!HOLIDAYS[year]) {
    HOLIDAYS[year] = { dates: [], workdays: [] };
  }
  HOLIDAYS[year].dates.push(...dates);
  HOLIDAYS[year].workdays.push(...workdays);
}

module.exports = {
  isHoliday,
  isWorkday,
  nextWorkday,
  getHolidayName,
  addCustomHolidays,
};
