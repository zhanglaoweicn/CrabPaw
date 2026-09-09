/**
 * natural-datetime — 统一自然语言日期时刻解析（2026-09-02, R3）。
 *
 * 三套并存收编：nlp-parser.parseScheduleText（事件形态, 能力最全）为主干,
 * 结构化 ISO 片段与 time-utils.parseNaturalTime（时刻语义）为回退。
 * 旧入口（calendar-tool.parseEventTime / SetReminder.timeToCron /
 * /api/calendar/parse）薄委托至此——能力只增不减, 行为不回退。
 *
 * 歧义诚实化：解析不出 → { ambiguous: true, reason }——不再拿
 * nlp-parser 的默认值（今天 / 09:00）冒充解析结果半猜。
 * 判定依赖 parseScheduleText 增量暴露的 dateExplicit / timeExplicit 标记。
 */
const { parseScheduleText } = require('./nlp-parser');
const { parseNaturalTime } = require('./time-utils');

const AMBIGUOUS = (reason) => ({ ambiguous: true, reason: reason || '未能识别日期或时间' });

/** 本地日期 YYYY-MM-DD */
function _fmtDate(d) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** 从事件形态结果抽取 {date, time}；日期时刻均非显式匹配 → null（默认值不算数） */
function _extractFromEventShape(parsed) {
  if (!parsed || (!parsed.dateExplicit && !parsed.timeExplicit)) return null;
  return {
    date: parsed.date,
    time: parsed.time,
    dateExplicit: !!parsed.dateExplicit,
    timeExplicit: !!parsed.timeExplicit,
  };
}

/**
 * 纯日期时刻解析：文本 → { date: 'YYYY-MM-DD', time: 'HH:mm', ambiguous: false }
 * 或 { ambiguous: true, reason }。
 * 解析顺序：结构化 ISO → nlp-parser 事件形态 → time-utils 时刻语义。
 * 裸时刻（无日期词）沿用旧语义：今天，已过顺延明天。
 */
function parseNaturalDateTime(text, now = new Date()) {
  const t = String(text || '').trim();
  if (!t) return AMBIGUOUS('内容为空');

  // 1) 结构化 ISO 片段（空格/T 双分隔，单双位月日都收；日期级默认 00:00）
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?$/);
  if (iso) {
    const date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    const time = iso[4] ? `${iso[4].padStart(2, '0')}:${iso[5]}` : '00:00';
    return { date, time, ambiguous: false };
  }

  // 2) 事件形态（顺带吃掉「开会/周会一小时」等尾巴）
  const fromEvent = _extractFromEventShape(parseScheduleText(t, now));
  if (fromEvent) {
    if (fromEvent.timeExplicit && !fromEvent.dateExplicit) {
      // 裸时刻：今天，已过顺延明天（与旧 SetReminder / parseEventTime 语义一致）
      const [h, mi] = fromEvent.time.split(':').map(Number);
      const d = new Date(now);
      if (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= mi)) {
        d.setDate(d.getDate() + 1);
      }
      return { date: _fmtDate(d), time: fromEvent.time, ambiguous: false };
    }
    return { date: fromEvent.date, time: fromEvent.time, ambiguous: false };
  }

  // 3) time-utils 时刻语义回退（只处理绝对/相对日期锚定的整句, 内部用真实时钟）
  const natural = parseNaturalTime(t.replace(/T(?=\d{1,2}:\d{2})/, ' '));
  if (natural && natural.date && natural.time) {
    return { date: natural.date, time: natural.time, ambiguous: false };
  }

  return AMBIGUOUS(`无法从「${t.slice(0, 30)}」识别出日期时间`);
}

/** 事件形态解析（保留 title/duration 等）；date 非显式匹配 → ambiguous 标记 */
function parseNaturalEvent(text, now = new Date()) {
  const t = String(text || '');
  const parsed = parseScheduleText(t, now);
  if (parsed && parsed.dateExplicit) {
    return { ...parsed, ambiguous: false };
  }
  // 纯 ISO 片段（parseScheduleText 不识别，此前会被默认值冒充成"今天"）→ 结构化快路径
  const iso = t.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?$/);
  if (iso) {
    const r = parseNaturalDateTime(t.trim(), now);
    if (!r.ambiguous) {
      return { ...parsed, date: r.date, time: r.time, dateExplicit: true, timeExplicit: true, ambiguous: false };
    }
  }
  return { ...(parsed || {}), ambiguous: true, reason: '未能识别出日期' };
}

module.exports = { parseNaturalDateTime, parseNaturalEvent };
