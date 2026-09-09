/**
 * temporal-rewrite.js — 时间意图抽取与查询改写（semantica TemporalQueryRewriter 范式 JS 版）
 *
 * 原则（与 semantica 一致）：
 * - 正则为王：意图词正则主通道（置信 0.85），不做 LLM 依赖；
 * - 日期解析全程确定性：年/季/月/日规约 + time-parser（relative/absolute/range），
 *   解析失败（含歧义）→ matched:false，绝不猜；
 * - 只做参数抽取与查询文本改写（rewrittenQuery），不重建任何数据；
 * - 边界与 semantica 相同：before/after/at 取区间起点为边界，during/between 取两端。
 */
const { parseTime } = require('../time-parser');

const DELIM = '[^，。；,.?!！？、()]';

// 意图模式：type=prefix（意图词在短语前）/ suffix（短语在意图词前）/ bare（无意图词纯时点锚）/ full（双短语）
// 优先级：between > during > after > before > at > bare（避免 "在 X 期间" 被 at 提前截走）
const PATTERNS = [
  { type: 'full', intent: 'between', re: new RegExp(`(${DELIM}{1,20})\\s*(?:和|与|、|and|to)\\s*(${DELIM}{1,20}?)\\s*(?:之间|间|中间)`) },
  { type: 'full', intent: 'between', re: /between\s+([^，。；,.?!！？\s]{1,20})\s+and\s+([^，。；,.?!！？\s]{1,20}?)\s*$/i },
  { type: 'prefix', intent: 'during', re: new RegExp(`(?:在|于)\\s*(${DELIM}{1,24}?)\\s*期间`) },
  { type: 'suffix', intent: 'during', re: new RegExp(`(${DELIM}{1,24}?)\\s*期间(?:内|之中)?(?!年|月|日|旬)`) },
  { type: 'prefix', intent: 'during', re: /during\s*([^，。；,.?!！？\s]{1,24})/i },
  { type: 'prefix', intent: 'after', re: new RegExp(`(?:after|自|自从|从)\\s*(${DELIM}{1,24})`, 'i') },
  { type: 'suffix', intent: 'after', re: new RegExp(`(${DELIM}{1,24}?)\\s*之后|以后`) },
  { type: 'prefix', intent: 'before', re: new RegExp(`(?:截至|截止到?|before|until|prior\\s+to|up\\s+to)\\s*(${DELIM}{1,24})`, 'i') },
  { type: 'suffix', intent: 'before', re: new RegExp(`(${DELIM}{1,24}?)\\s*之前|以前`) },
  { type: 'prefix', intent: 'at', re: new RegExp(`(?:at|在|于)\\s*(${DELIM}{1,24})`, 'i') },
  {
    type: 'bare', intent: 'at',
    // 无意图词的时点锚：相对词白名单 + 年/季锚（Q2 2022 / 2022年 / 2022年第二季度）
    re: /(?:^|[\s，,、])(今年|本年|去年|上季度|本季度|本季|上季|这个月|本月|当月|上个月|上月|下个月|下月|上周|上星期|昨天|昨日|今天|今日|明天|明日|前天|后天|大后天|Q\s*[1-4]\s*(?:19|20)\d{2}|(?:19|20)\d{2}\s*年?\s*[Qq第]?[1-4]|(?:19|20)\d{2}\s*年第?[1-4]季度?|(?:19|20)\d{2}\s*年?)/i,
  },
];

const YEAR_RE = /^\s*((?:19|20)\d{2})\s*年?\s*$/;
const MONTH_RE = /^\s*((?:19|20)\d{2})\s*(?:年[-/]?\s*|[-/])\s*(\d{1,2})\s*月?\s*$/;

/** 季度规约 → {year, quarter} | null（Q1/第一季度/Q1 2022 等确定性形式） */
function parseQuarter(p) {
  let m = p.match(/^\s*Q\s*([1-4])\s*((?:19|20)\d{2})\s*$/i);
  if (m) return { year: +m[2], quarter: +m[1] };
  m = p.match(/^\s*((?:19|20)\d{2})\s*年?\s*[Qq]第?\s*([1-4])\s*$/i);
  if (m) return { year: +m[1], quarter: +m[2] };
  m = p.match(/^\s*((?:19|20)\d{2})\s*年?\s*第?\s*([1-4一二三四])\s*季度?\s*$/i);
  if (m) {
    const q = /[一二三四]/.test(m[2]) ? '一二三四'.indexOf(m[2]) + 1 : +m[2];
    if (q >= 1 && q <= 4) return { year: +m[1], quarter: q };
  }
  return null;
}

/** 中文相对词确定性别名（time-parser 未覆盖）→ {start, end} | null */
function resolveAlias(p, now) {
  if (p === '今年' || p === '本年') {
    return { start: new Date(now.getFullYear(), 0, 1), end: new Date(now.getFullYear() + 1, 0, 1) };
  }
  if (p === '去年') {
    return { start: new Date(now.getFullYear() - 1, 0, 1), end: new Date(now.getFullYear(), 0, 1) };
  }
  if (p === '前年') {
    return { start: new Date(now.getFullYear() - 2, 0, 1), end: new Date(now.getFullYear() - 1, 0, 1) };
  }
  if (p === '这个月' || p === '本月' || p === '当月') {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  }
  if (p === '本季度' || p === '本季') {
    const q = Math.floor(now.getMonth() / 3);
    return { start: new Date(now.getFullYear(), q * 3, 1), end: new Date(now.getFullYear(), q * 3 + 3, 1) };
  }
  if (p === '上季度') {
    const q = Math.floor(now.getMonth() / 3);
    return { start: new Date(now.getFullYear(), q * 3 - 3, 1), end: new Date(now.getFullYear(), q * 3, 1) };
  }
  return null;
}

/**
 * 确定性解析短语 → {start: Date, end: Date}|null（end 为区间右端、开区间）。
 * 顺序：季度 → 年 → 年月 → 别名 → 英文月+年 → time-parser（相对/绝对/区间）。
 * 斜杠日期口径固定为 年-月-日 / MM-DD（time-parser 的确定性规则），不猜 DD/MM。
 */
function resolveTemporalPhrase(phrase, now = new Date()) {
  const p = String(phrase).trim();
  if (!p) return null;
  const q = parseQuarter(p);
  if (q) {
    return { start: new Date(q.year, (q.quarter - 1) * 3, 1), end: new Date(q.year, q.quarter * 3, 1) };
  }
  let m = p.match(YEAR_RE);
  if (m) {
    const y = parseInt(m[1], 10);
    return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
  }
  m = p.match(MONTH_RE);
  if (m) {
    return { start: new Date(+m[1], +m[2] - 1, 1), end: new Date(+m[1], +m[2], 1) };
  }
  const alias = resolveAlias(p, now);
  if (alias) return alias;
  m = p.match(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+((?:19|20)\d{2})$/i);
  if (m) {
    const monthIdx = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].findIndex(
      (mo) => p.toLowerCase().startsWith(mo.toLowerCase()));
    const y = +m[1];
    return { start: new Date(y, monthIdx, 1), end: new Date(y, monthIdx + 1, 1) };
  }
  const dt = parseTime(p, now);
  if (!dt) return null;
  if (dt instanceof Date && !Number.isNaN(dt.getTime())) return { start: dt };
  if (dt && dt.start) return { start: dt.start, end: dt.end || null };
  return null;
}

/** 从候选串右端逐步截断直至可解析（处理 "2023-06-01的台风" 粘连文本）；返回最长可解析前缀 */
function snapResolve(candidate, now) {
  const tail = String(candidate).trim();
  for (let i = tail.length; i >= 2; i--) {
    const sub = tail.slice(0, i).trimEnd();
    const r = resolveTemporalPhrase(sub, now);
    if (r) return { window: r, kept: sub };
  }
  return null;
}

/** 兜底：整段文本中提取首个 4 位年份（semantica _resolve_phrase 同款），置信度降档 */
function looseYear(candidate) {
  const s = String(candidate);
  const m = s.match(/((?:19|20)\d{2})\b/);
  if (!m) return null;
  const y = +m[1];
  return { window: { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) }, kept: m[1], offset: m.index };
}

/**
 * 时间意图抽取与查询改写。
 * @param {string} query 原始查询
 * @param {{now?: Date}} [opts] now 仅用于相对时间解析
 * @returns {{matched: boolean, rewrittenQuery: string, intent: string|null,
 *            atTime: number|null, startTime: number|null, endTime: number|null,
 *            confidence: number, phrase: string|null}} 时间戳为 epoch 毫秒
 */
function rewriteTemporal(query, opts = {}) {
  const q = String(query || '').trim();
  const now = opts.now || new Date();
  const result = {
    matched: false, rewrittenQuery: q, intent: null,
    atTime: null, startTime: null, endTime: null,
    confidence: 0, phrase: null,
  };
  if (!q) return result;

  for (const pat of PATTERNS) {
    const m = q.match(pat.re);
    if (!m) continue;

    // between：双短语各自解析，缺一不可
    if (pat.type === 'full') {
      const a = resolveTemporalPhrase(m[1], now);
      const b = resolveTemporalPhrase(m[2], now);
      if (!a || !b) continue;
      result.matched = true;
      result.intent = 'between';
      result.startTime = a.start.getTime();
      result.endTime = b.start.getTime();
      result.atTime = a.start.getTime();
      result.phrase = m[0];
      result.confidence = 0.85;
      result.rewrittenQuery = q.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
      return result;
    }

    const g = m[1];
    const gStart = m[0].length - g.length; // 组在匹配内的偏移（prefix 组在尾部，suffix 组在头部）
    const snap = snapResolve(g, now);
    let win;
    let kept;
    let conf;
    if (snap) {
      win = snap.window;
      kept = snap.kept;
      conf = snap.kept.length === g.trim().length ? (pat.type === 'bare' ? 0.7 : 0.85) : 0.75;
    } else {
      const loose = looseYear(g);
      if (!loose) continue; // 解析不了，绝不猜
      win = loose.window;
      kept = loose.kept;
      conf = 0.5;
    }

    let spanStart;
    let spanEnd;
    if (pat.type === 'suffix') {
      spanStart = m.index;                 // 短语起点
      spanEnd = m.index + m[0].length;     // 连同意图词整体删除
    } else {
      const keptLen = g.indexOf(kept) + kept.length;
      spanStart = m.index;                 // 前缀也好、bare 的前导空格也好，一并删除
      spanEnd = m.index + gStart + keptLen;
    }

    const hasWindow = win.end != null;
    result.matched = true;
    result.intent = (pat.type === 'bare' && hasWindow) ? 'during' : pat.intent;
    result.phrase = kept;
    result.confidence = conf;
    result.startTime = win.start.getTime();
    result.endTime = hasWindow ? win.end.getTime() : null;
    result.atTime = win.start.getTime(); // 边界=区间起点（semantica 约定）
    result.rewrittenQuery = (q.slice(0, spanStart) + ' ' + q.slice(spanEnd)).replace(/\s+/g, ' ').trim();
    return result;
  }

  return result; // 全部未中 → matched:false（不猜）
}

module.exports = { rewriteTemporal, resolveTemporalPhrase };
