/**
 * 自然语言日程解析器
 *
 * 把用户输入的描述解析成结构化字段：
 *   - title      标题（事件名）
 *   - date       YYYY-MM-DD
 *   - time       HH:mm
 *   - duration   时长（分钟）
 *   - description 剩余描述
 *
 * 支持的中文时间词：
 *   日期：今天 / 明天 / 后天 / 大后天 / 下周X / 周X / X月X日 / X日
 *   时段：上午 / 早上 / 下午 / 中午 / 晚上 / 凌晨
 *   时刻：X点 / X点X分 / X:XX
 *   时长：X小时 / X分钟 / 半小时 / 一刻钟
 */

const TIMEZONE_OFFSET = '+08:00';

const WEEKDAY_MAP = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0,
  '末': 6, // 周末 = 周六
};

const NUMBER_CN = {
  '零': 0, '〇': 0,
  '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
};

function cnToInt(s) {
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // 十几 / 二十几 / 二十 / 一十五
  if (s === '十') return 10;
  if (s.length === 2 && s[0] === '十') return 10 + NUMBER_CN[s[1]];
  if (s.length === 2 && s[1] === '十') return NUMBER_CN[s[0]] * 10;
  if (s.length === 3 && s[1] === '十') {
    return NUMBER_CN[s[0]] * 10 + (NUMBER_CN[s[2]] || 0);
  }
  let total = 0;
  for (const ch of s) {
    if (NUMBER_CN[ch] !== undefined) total += NUMBER_CN[ch];
    else return NaN;
  }
  return total;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDateString(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function shiftDays(base, n) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

function nextWeekday(base, target) {
  const cur = base.getDay();
  let diff = (target - cur + 7) % 7;
  if (diff === 0) diff = 7; // “下周五” 不算今天/明天
  return shiftDays(base, diff);
}

/**
 * 解析自然语言描述
 * @param {string} text 用户原始输入
 * @returns {{ title: string, date: string, time: string, duration: number, description: string, raw: string }}
 */
function parseScheduleText(text, now = new Date()) {
  const raw = (text || '').trim();
  if (!raw) {
    return {
      title: '',
      date: toDateString(now),
      time: '09:00',
      duration: 60,
      description: '',
      raw: '',
    };
  }

  let result = {
    title: '',
    date: toDateString(now),
    time: '09:00',
    duration: 60,
    description: raw,
  };

  let working = raw;

  // 1. 时长（X小时 / X分钟 / 半小时 / 一刻钟）
  const durationPatterns = [
    { regex: /(?:大约|约|大概|差不多)?\s*([\d一二三四五六七八九十两]+)\s*个?(?:半)?\s*小时(?:钟)?/, unit: 60 },
    { regex: /(?:大约|约|大概|差不多)?\s*([\d一二三四五六七八九十两]+)\s*分钟/, unit: 1 },
    { regex: /半(?:个)?小时/, unit: 30 },
    { regex: /一刻钟/, unit: 15 },
    { regex: /两小时/, unit: 120 },
  ];
  for (const { regex, unit } of durationPatterns) {
    const m = working.match(regex);
    if (m) {
      let mins;
      if (m[1]) {
        mins = cnToInt(m[1]) * unit;
      } else {
        mins = unit;
      }
      if (!isNaN(mins) && mins > 0) {
        result.duration = mins;
        working = working.replace(m[0], ' ');
      }
    }
  }

  // 2. 日期
  let matchedDate = false;

  // X月X日 / X月X号 / X日
  let m = working.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    const year = now.getFullYear();
    const d = new Date(year, month - 1, day);
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      d.setFullYear(year + 1);
    }
    result.date = toDateString(d);
    matchedDate = true;
    working = working.replace(m[0], ' ');
  } else {
    m = working.match(/(\d{1,2})\s*[日号](?!\d)/);
    if (m) {
      const day = parseInt(m[1], 10);
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        d.setMonth(d.getMonth() + 1);
      }
      result.date = toDateString(d);
      matchedDate = true;
      working = working.replace(m[0], ' ');
    }
  }

  if (!matchedDate) {
    if (/今天|今日/.test(working)) {
      result.date = toDateString(now);
      matchedDate = true;
      working = working.replace(/今天|今日/g, ' ');
    } else if (/明天|明日|明早|明晚|明上午|明下午/.test(working)) {
      result.date = toDateString(shiftDays(now, 1));
      matchedDate = true;
      // 只剥"明"前缀，保留时段词给后续时间解析（如"明下午3点"→"下午3点"→15:00）
      working = working.replace(/明天|明日/g, ' ');
      working = working.replace(/明早/g, '早');
      working = working.replace(/明上午/g, '上午');
      working = working.replace(/明下午/g, '下午');
      working = working.replace(/明晚/g, '晚');
    } else if (/大后天/.test(working)) {
      // 大后天必须在 后天 之前判定——「大后天」包含子串「后天」，反序会被吃掉少算一天
      result.date = toDateString(shiftDays(now, 3));
      matchedDate = true;
      working = working.replace(/大后天/g, ' ');
    } else if (/后天/.test(working)) {
      result.date = toDateString(shiftDays(now, 2));
      matchedDate = true;
      working = working.replace(/后天/g, ' ');
    } else if (/下周末/.test(working)) {
      result.date = toDateString(nextWeekday(now, 6));
      matchedDate = true;
      working = working.replace(/下周末/g, ' ');
    } else if (/周末/.test(working)) {
      result.date = toDateString(nextWeekday(now, 6));
      matchedDate = true;
      working = working.replace(/周末/g, ' ');
    } else {
      m = working.match(/下周\s*([一二三四五六日天])/);
      if (m) {
        const target = WEEKDAY_MAP[m[1]];
        if (target !== undefined) {
          result.date = toDateString(nextWeekday(now, target));
          matchedDate = true;
          working = working.replace(m[0], ' ');
        }
      } else {
        m = working.match(/(?:这|本)?周\s*([一二三四五六日天])(?!末)/);
        if (m) {
          const target = WEEKDAY_MAP[m[1]];
          if (target !== undefined) {
            const d = new Date(now);
            const cur = d.getDay();
            let diff = (target - cur + 7) % 7;
            d.setDate(d.getDate() + diff);
            result.date = toDateString(d);
            matchedDate = true;
            working = working.replace(m[0], ' ');
          }
        }
      }
    }
  }

  // 1.5 剥离"今"前缀，保留时段词供后续时间解析
  // 说明：如"今下午3点"→"下午3点"→下午检测→15:00
  // "今晚"天然包含"晚"，无需剥离；"明X"已在 step 2 剥离前缀
  working = working.replace(/今早/g, '早');
  working = working.replace(/今上午/g, '上午');
  working = working.replace(/今下午/g, '下午');

  // 3. 时间
  let matchedTime = false;
  let hour = NaN;
  let minute = 0;

  // X点X分 / X点 / X点半
  m = working.match(/([\d一二三四五六七八九十两]+)\s*点\s*(半|[\d一二三四五六七八九十]+)?\s*分?/);
  if (m) {
    hour = cnToInt(m[1]);
    if (m[2] === '半') minute = 30;
    else if (m[2]) minute = cnToInt(m[2]);
    matchedTime = true;
    working = working.replace(m[0], ' ');
  }

  // HH:MM
  if (!matchedTime) {
    m = working.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
    if (m) {
      hour = parseInt(m[1], 10);
      minute = parseInt(m[2], 10);
      matchedTime = true;
      working = working.replace(m[0], ' ');
    }
  }

  // 半点 / 整点
  if (!matchedTime) {
    m = working.match(/([\d一二三四五六七八九十两]+)\s*半/);
    if (m) {
      hour = cnToInt(m[1]);
      minute = 30;
      matchedTime = true;
      working = working.replace(m[0], ' ');
    }
  }

  // 时段修正：下午/晚上 + 12小时制
  let periodShift = 0;
  if (/下午|中午|午后/.test(working)) periodShift = 12;
  else if (/晚上|夜里|夜晚|晚间|晚|傍晚|今晚|明晚/.test(working)) periodShift = 12;
  else if (/凌晨/.test(working)) periodShift = 0;

  if (matchedTime && !isNaN(hour)) {
    let h = hour;
    if (periodShift && h < 12) h += periodShift;
    if (h < 0 || h > 23) h = Math.max(0, Math.min(23, h));
    if (minute < 0 || minute > 59) minute = Math.max(0, Math.min(59, minute));
    result.time = `${pad2(h)}:${pad2(minute)}`;
    working = working.replace(/下午|中午|午后|晚上|夜里|夜晚|晚间|傍晚|凌晨|上午|早上|早晨|清晨|今晚|明晚/g, ' ');
  } else if (periodShift || /上午|早上|早晨|清晨/.test(working)) {
    // 没显式时间，但有时段：默认 09:00
    working = working.replace(/下午|中午|午后|晚上|夜里|夜晚|晚间|傍晚|凌晨|上午|早上|早晨|清晨|今晚|明晚/g, ' ');
  }

  // 4. 标题：清理后的剩余文本
  const title = working
    .replace(/[，。！？、,!?;；:：\s]+/g, ' ')
    .replace(/^(?:要|需要|准备|记得|帮我|请|打算|计划)?/, '')
    .replace(/(?:一下|呀|啊|哦|吧|呢|哈|啦|嘛)$/, '')
    .trim();

  result.title = title || raw.slice(0, 30);
  result.description = raw;

  // 显式匹配标记（2026-09-02 R3）：区分「真实解析值」与默认值（今天/09:00），
  // 供 natural-datetime 做歧义诚实化——纯增量字段，既有消费方不受影响。
  return { ...result, dateExplicit: matchedDate, timeExplicit: matchedTime, raw };
}

module.exports = {
  parseScheduleText,
  TIMEZONE_OFFSET,
};
