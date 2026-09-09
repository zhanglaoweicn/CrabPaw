const TIMEZONE_OFFSET = '+08:00';

function toISO8601(date, time = '00:00') {
  if (!date) return null;

  if (typeof date === 'string' && date.includes('T')) {
    return date;
  }

  const [h, m] = time.split(':').map(Number);
  const hour = isNaN(h) ? 0 : String(h).padStart(2, '0');
  const minute = isNaN(m) ? 0 : String(m).padStart(2, '0');

  return `${date}T${hour}:${minute}:00${TIMEZONE_OFFSET}`;
}

function parseISO8601(isoStr) {
  if (!isoStr) return null;

  try {
    const date = new Date(isoStr);
    if (isNaN(date.getTime())) return null;

    const y = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');

    return {
      date: `${y}-${mo}-${d}`,
      time: `${h}:${min}`,
      datetime: date,
      iso: isoStr
    };
  } catch {
    return null;
  }
}

function _formatLocalISO(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day}T${h}:${min}:00${TIMEZONE_OFFSET}`;
}

function addMinutes(isoStr, minutes) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return null;

  const newDate = new Date(parsed.datetime.getTime() + minutes * 60000);
  return _formatLocalISO(newDate);
}

function addDays(isoStr, days) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return null;

  const newDate = new Date(parsed.datetime);
  newDate.setDate(newDate.getDate() + days);
  return _formatLocalISO(newDate);
}

function addMonths(isoStr, months) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return null;

  const newDate = new Date(parsed.datetime);
  newDate.setMonth(newDate.getMonth() + months);
  return _formatLocalISO(newDate);
}

function addYears(isoStr, years) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return null;

  const newDate = new Date(parsed.datetime);
  newDate.setFullYear(newDate.getFullYear() + years);
  return _formatLocalISO(newDate);
}

function getDurationMinutes(startISO, endISO) {
  const start = parseISO8601(startISO);
  const end = parseISO8601(endISO);

  if (!start || !end) return 0;

  return Math.round((end.datetime - start.datetime) / 60000);
}

function formatDuration(minutes) {
  if (minutes < 60) {
    return `${minutes}分钟`;
  }

  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (mins === 0) {
    return `${hours}小时`;
  }

  return `${hours}小时${mins}分钟`;
}

function isSameDay(iso1, iso2) {
  const p1 = parseISO8601(iso1);
  const p2 = parseISO8601(iso2);

  if (!p1 || !p2) return false;

  return p1.date === p2.date;
}

function isToday(isoStr) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return false;

  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${mo}-${d}`;
  return parsed.date === today;
}

function isTomorrow(isoStr) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return false;

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const y = tomorrow.getFullYear();
  const mo = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const d = String(tomorrow.getDate()).padStart(2, '0');
  const tomorrowStr = `${y}-${mo}-${d}`;

  return parsed.date === tomorrowStr;
}

function isThisWeek(isoStr) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return false;

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);

  return parsed.datetime >= startOfWeek && parsed.datetime < endOfWeek;
}

function getRelativeTime(isoStr) {
  const parsed = parseISO8601(isoStr);
  if (!parsed) return '未知时间';

  const now = new Date();
  const diff = parsed.datetime - now;
  const diffMinutes = Math.round(diff / 60000);
  const diffHours = Math.round(diff / 3600000);
  const diffDays = Math.round(diff / 86400000);

  if (diffMinutes < 0) {
    const absMinutes = Math.abs(diffMinutes);
    const absHours = Math.abs(diffHours);
    const absDays = Math.abs(diffDays);

    if (absMinutes < 60) {
      return `${absMinutes}分钟前`;
    }
    if (absHours < 24) {
      return `${absHours}小时前`;
    }
    if (absDays < 7) {
      return `${absDays}天前`;
    }

    return parsed.date;
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}分钟后`;
  }
  if (diffHours < 24) {
    return `${diffHours}小时后`;
  }
  if (diffDays === 1) {
    return '明天';
  }
  if (diffDays < 7) {
    return `${diffDays}天后`;
  }

  return parsed.date;
}

function parseNaturalTime(text) {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const today = `${y}-${mo}-${d}`;

  const patterns = [
    { regex: /^今天(\d{1,2}):(\d{2})$/, handler: (_, h, m) => ({ date: today, time: `${h.padStart(2, '0')}:${m}` }) },
    { regex: /^明天(\d{1,2}):(\d{2})$/, handler: (_, h, m) => {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const ty = tomorrow.getFullYear();
      const tmo = String(tomorrow.getMonth() + 1).padStart(2, '0');
      const td = String(tomorrow.getDate()).padStart(2, '0');
      // 2026-08-19 修复: 原 handler 漏返回 time → "明天15:30" 解析结果缺时刻(默认为 00:00/09:00)
      return { date: `${ty}-${tmo}-${td}`, time: `${h.padStart(2, '0')}:${m}` };
    }},
    { regex: /^后天(\d{1,2}):(\d{2})$/, handler: (_, h, m) => {
      const dayAfter = new Date(now);
      dayAfter.setDate(dayAfter.getDate() + 2);
      const dy = dayAfter.getFullYear();
      const dmo = String(dayAfter.getMonth() + 1).padStart(2, '0');
      const dd = String(dayAfter.getDate()).padStart(2, '0');
      return { date: `${dy}-${dmo}-${dd}`, time: `${h.padStart(2, '0')}:${m}` };
    }},
    { regex: /^(\d{4})-(\d{1,2})-(\d{1,2})\s*(\d{1,2}):(\d{2})$/, handler: (_, y, m, d, h, min) => ({
      date: `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
      time: `${h.padStart(2, '0')}:${min}`
    })},
    { regex: /^(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})$/, handler: (_, m, d, h, min) => ({
      date: `${now.getFullYear()}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
      time: `${h.padStart(2, '0')}:${min}`
    })},
    { regex: /^下周([一二三四五六日])\s*(\d{1,2}):(\d{2})$/, handler: (_, day, h, min) => {
      const dayMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0 };
      const targetDay = dayMap[day];
      const result = new Date(now);
      const currentDay = result.getDay();
      const daysUntil = (targetDay + 7 - currentDay) % 7 || 7;
      result.setDate(result.getDate() + daysUntil);
      const ry = result.getFullYear();
      const rmo = String(result.getMonth() + 1).padStart(2, '0');
      const rd = String(result.getDate()).padStart(2, '0');
      return { date: `${ry}-${rmo}-${rd}`, time: `${h.padStart(2, '0')}:${min}` };
    }}
  ];

  for (const { regex, handler } of patterns) {
    const match = text.match(regex);
    if (match) {
      return handler(...match);
    }
  }

  return null;
}

/** 本地时区 YYYY-MM-DD（2026-09-02 R5: 全仓 UTC 切日清扫共用——toISOString 是 UTC, 东八区凌晨取昨天） */
function localDateISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = {
  toISO8601,
  parseISO8601,
  addMinutes,
  addDays,
  addMonths,
  addYears,
  getDurationMinutes,
  formatDuration,
  isSameDay,
  isToday,
  isTomorrow,
  isThisWeek,
  getRelativeTime,
  parseNaturalTime,
  TIMEZONE_OFFSET,
  localDateISO
};
