/**
 * date-normalize — 业务表日期单元格规范化
 *
 * 导入管线在入库前把日期列的单元格统一转 ISO（YYYY-MM-DD[ HH:MM]）。
 * 动机：SQLite 的 date() 只认 ISO 前缀，`2024/01/15`、`1月15日` 等格式
 * 经 date() 返回 NULL——risk-alert 巡检与 NL2SQL 的日期过滤会静默丢行。
 *
 * 设计约束：批量单元格场景，不用面向交互文本的 parseNaturalDateTime
 * （依赖"现在"做参照）；纯确定性正则，解析失败一律返回 null 由调用方
 * 保留原值并计数，绝不猜。
 */

const PATTERNS = [
  // ISO 变体：2024-01-15 / 2024/1/15 / 2024.1.15（可带时间部分）
  {
    re: /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
    build: (m) => buildIso(m[1], m[2], m[3], m[4], m[5], m[6]),
  },
  // 紧凑数字：20240115
  {
    re: /^(\d{4})(\d{2})(\d{2})$/,
    build: (m) => buildIso(m[1], m[2], m[3]),
  },
  // 缺年：1月15日 / 1月15号（年份由调用方上下文补齐）
  {
    re: /^(\d{1,2})月(\d{1,2})[日号]$/,
    build: (m, year) => buildIso(year, m[1], m[2]),
  },
];

function buildIso(y, mo, d, h, mi, s) {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const datePart = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (h === undefined) return datePart;
  const hh = String(Number(h)).padStart(2, '0');
  const mm = String(Number(mi)).padStart(2, '0');
  const ss = s !== undefined ? String(Number(s)).padStart(2, '0') : '00';
  if (Number(h) > 23 || Number(mi) > 59 || Number(s || 0) > 59) return null;
  return `${datePart} ${hh}:${mm}:${ss}`;
}

/**
 * 规范化单个日期单元格
 * @param {string} raw 原始值
 * @param {{ defaultYear?: number }} opts 缺年格式（1月15日）补的年份，
 *   通常取导入文件上下文年份（文件修改时间或列内众数年份）
 * @returns {string|null} ISO 字符串；无法解析返回 null（不抛错）
 */
function normalizeDateValue(raw, opts = {}) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      const out = p.build(m, opts.defaultYear);
      if (out) return out;
    }
  }
  return null;
}

/**
 * 判定一列是否日期列并推断缺年补齐用的上下文年份。
 * 采样值中 ISO 可解析比例 ≥ 阈值判定为日期列（与非日期 TEXT 列区分：
 * 普通 TEXT 列几乎不可能大面积命中日期正则）。
 * @param {string[]} values 列采样值（非空）
 * @returns {{ isDateColumn: boolean, defaultYear: number|null, parseFailed: number }}
 */
function detectDateColumn(values, { threshold = 0.6 } = {}) {
  const sample = values.filter((v) => v !== undefined && v !== null && String(v).trim() !== '').slice(0, 200);
  if (sample.length === 0) return { isDateColumn: false, defaultYear: null, parseFailed: 0 };
  let hits = 0;
  const years = {};
  let parseFailed = 0;
  for (const v of sample) {
    const text = String(v).trim();
    const out = normalizeDateValue(text, { defaultYear: null });
    if (out) {
      hits += 1;
      years[out.slice(0, 4)] = (years[out.slice(0, 4)] || 0) + 1;
    } else {
      // 命中缺年形态但无年份上下文也算命中（由 defaultYear 补）
      if (/^\d{1,2}月\d{1,2}[日号]$/.test(text)) hits += 1;
      else parseFailed += 1;
    }
  }
  let defaultYear = null;
  let best = 0;
  for (const [y, n] of Object.entries(years)) {
    if (n > best) { best = n; defaultYear = Number(y); }
  }
  if (defaultYear === null) {
    defaultYear = new Date().getFullYear();
  }
  return { isDateColumn: hits / sample.length >= threshold, defaultYear, parseFailed };
}

module.exports = { normalizeDateValue, detectDateColumn };
