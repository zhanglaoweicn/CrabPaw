/**
 * 自然语言调度解析器
 *
 * 将用户友好的自然语言时间表达式转换为标准 Cron 表达式或一次性时间戳。
 *
 * 支持格式：
 * - 相对延迟（一次性）：30m, 2h, 1d
 * - 间隔（重复）：every 30m, every 2h, every 1d
 * - ISO 时间戳（一次性）：2026-03-15T09:00:00
 * - 中文自然语言：每天早上9点, 工作日8:30, 每小时
 * - 标准 Cron 表达式：0 9 * * *
 */

const { CronExpressionParser } = require('cron-parser');

// ─── 类型常量 ───────────────────────────────────────────────
const SCHEDULE_TYPE = {
  CRON: 'cron',           // 标准 Cron 表达式（重复）
  ONCE: 'once',           // 一次性延迟（相对时间）
  ONCE_AT: 'once_at',     // 一次性定点（ISO 时间戳）
  INTERVAL: 'interval',   // 间隔重复（every X）
};

// ─── 正则模式 ───────────────────────────────────────────────

// 相对延迟：30m, 2h, 1d, 90s
const RELATIVE_RE = /^(\d+)\s*(s|m|h|d|秒|分钟?|小时|天)$/i;

// 间隔：every 30m, every 2h, every 1d
const INTERVAL_RE = /^every\s+(\d+)\s*(s|m|h|d|秒|分钟?|小时|天)$/i;

// ISO 时间戳：2026-03-15T09:00:00
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

// 中文自然语言
const ZH_DAILY_RE = /^每天\s*(早上|上午|下午|晚上|凌晨)?\s*(\d{1,2})[点时:：](\d{1,2})?分?\s*$/;
const ZH_WEEKDAY_RE = /^工作日\s*(\d{1,2})[点时:：](\d{1,2})?分?\s*$/;
const ZH_HOURLY_RE = /^每(小时|60分钟)\s*$/;
const ZH_MINUTE_RE = /^每(\d+)\s*分钟\s*$/;

// 单位映射
const UNIT_MAP = {
  s: 'seconds', 秒: 'seconds',
  m: 'minutes', 分: 'minutes', 分钟: 'minutes',
  h: 'hours', 小时: 'hours',
  d: 'days', 天: 'days',
};

// 中文时段映射
const ZH_PERIOD_MAP = {
  '凌晨': 0, '早上': 0, '上午': 0,
  '下午': 12, '晚上': 12,
};

// ─── 解析函数 ───────────────────────────────────────────────

/**
 * 解析自然语言调度表达式
 * @param {string} input 用户输入的调度表达式
 * @returns {{ type, cron?, runAt?, intervalMs?, repeat?, description? } | null}
 */
function parseSchedule(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  // 1. 标准 Cron 表达式
  if (_isCronExpression(s)) {
    return {
      type: SCHEDULE_TYPE.CRON,
      cron: s,
      repeat: Infinity,
      description: _describeCron(s),
    };
  }

  // 2. 间隔：every 30m
  const intervalMatch = s.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = UNIT_MAP[intervalMatch[2].toLowerCase()] || UNIT_MAP[intervalMatch[2]];
    const intervalMs = _toMs(value, unit);
    const cron = _intervalToCron(value, unit);
    return {
      type: SCHEDULE_TYPE.INTERVAL,
      cron,
      intervalMs,
      repeat: Infinity,
      description: _describeInterval(value, unit),
    };
  }

  // 3. 相对延迟：30m, 2h, 1d
  const relativeMatch = s.match(RELATIVE_RE);
  if (relativeMatch) {
    const value = parseInt(relativeMatch[1], 10);
    const unit = UNIT_MAP[relativeMatch[2].toLowerCase()] || UNIT_MAP[relativeMatch[2]];
    const runAt = Date.now() + _toMs(value, unit);
    return {
      type: SCHEDULE_TYPE.ONCE,
      runAt,
      repeat: 1,
      description: _describeRelative(value, unit),
    };
  }

  // 4. ISO 时间戳
  if (ISO_RE.test(s)) {
    const runAt = new Date(s).getTime();
    if (isNaN(runAt) || runAt <= Date.now()) return null;
    return {
      type: SCHEDULE_TYPE.ONCE_AT,
      runAt,
      repeat: 1,
      description: `在 ${s} 执行一次`,
    };
  }

  // 5. 中文自然语言
  const zhResult = _parseChinese(s);
  if (zhResult) return zhResult;

  return null;
}

/**
 * 判断是否为标准 Cron 表达式
 */
function _isCronExpression(s) {
  const parts = s.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;
  try {
    CronExpressionParser.parse(s);
    return true;
  } catch {
    return false;
  }
}

/**
 * 间隔转 Cron 表达式
 */
function _intervalToCron(value, unit) {
  switch (unit) {
    case 'minutes': return `*/${value} * * * *`;
    case 'hours': return `0 */${value} * * *`;
    case 'days': return `0 0 */${value} * *`;
    case 'seconds': return `* * * * *`; // 秒级降级为每分钟
    default: return `*/${value} * * * *`;
  }
}

/**
 * 单位转毫秒
 */
function _toMs(value, unit) {
  switch (unit) {
    case 'seconds': return value * 1000;
    case 'minutes': return value * 60 * 1000;
    case 'hours': return value * 3600 * 1000;
    case 'days': return value * 86400 * 1000;
    default: return value * 60 * 1000;
  }
}

/**
 * 中文自然语言解析
 */
function _parseChinese(s) {
  // 每天早上9点 / 每天9:30
  const dailyMatch = s.match(ZH_DAILY_RE);
  if (dailyMatch) {
    const period = dailyMatch[1] || '';
    let hour = parseInt(dailyMatch[2], 10);
    const minute = dailyMatch[3] ? parseInt(dailyMatch[3], 10) : 0;

    if (ZH_PERIOD_MAP[period] === 12 && hour < 12) hour += 12;
    if (period === '凌晨' && hour === 12) hour = 0;

    const cron = `${minute} ${hour} * * *`;
    return {
      type: SCHEDULE_TYPE.CRON,
      cron,
      repeat: Infinity,
      description: `每天 ${hour}:${String(minute).padStart(2, '0')}`,
    };
  }

  // 工作日8:30
  const weekdayMatch = s.match(ZH_WEEKDAY_RE);
  if (weekdayMatch) {
    const hour = parseInt(weekdayMatch[1], 10);
    const minute = weekdayMatch[2] ? parseInt(weekdayMatch[2], 10) : 0;
    const cron = `${minute} ${hour} * * 1-5`;
    return {
      type: SCHEDULE_TYPE.CRON,
      cron,
      repeat: Infinity,
      description: `工作日 ${hour}:${String(minute).padStart(2, '0')}`,
    };
  }

  // 每小时
  if (ZH_HOURLY_RE.test(s)) {
    return {
      type: SCHEDULE_TYPE.CRON,
      cron: '0 * * * *',
      repeat: Infinity,
      description: '每小时整点',
    };
  }

  // 每 N 分钟
  const minuteMatch = s.match(ZH_MINUTE_RE);
  if (minuteMatch) {
    const n = parseInt(minuteMatch[1], 10);
    return {
      type: SCHEDULE_TYPE.CRON,
      cron: `*/${n} * * * *`,
      repeat: Infinity,
      description: `每 ${n} 分钟`,
    };
  }

  return null;
}

// ─── 描述生成 ───────────────────────────────────────────────

function _describeCron(cronExpr) {
  try {
    const parts = cronExpr.trim().split(/\s+/);
    // eslint-disable-next-line no-unused-vars
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    if (minute === '*' && hour === '*') return '每分钟';
    if (minute === '0' && hour === '*') return '每小时整点';
    if (minute.startsWith('*/') && hour === '*') return `每 ${minute.slice(2)} 分钟`;
    if (hour.startsWith('*/') && minute === '0') return `每 ${hour.slice(2)} 小时`;
    if (minute !== '*' && hour !== '*' && dayOfWeek === '1-5') return `工作日 ${hour}:${minute.padStart(2, '0')}`;
    if (minute !== '*' && hour !== '*') return `每天 ${hour}:${minute.padStart(2, '0')}`;
    return cronExpr;
  } catch {
    return cronExpr;
  }
}

function _describeInterval(value, unit) {
  const unitNames = { seconds: '秒', minutes: '分钟', hours: '小时', days: '天' };
  return `每 ${value} ${unitNames[unit] || unit}`;
}

function _describeRelative(value, unit) {
  const unitNames = { seconds: '秒', minutes: '分钟', hours: '小时', days: '天' };
  return `${value} ${unitNames[unit] || unit}后执行一次`;
}

// ─── 导出 ───────────────────────────────────────────────────

module.exports = {
  parseSchedule,
  SCHEDULE_TYPE,
  UNIT_MAP,
};
