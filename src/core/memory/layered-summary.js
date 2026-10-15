/**
 * Layered Summary — 分层摘要（abstract / overview 两级上下文压缩）
 *
 * 思想来源：OpenViking（volcengine）的 .abstract.md / .overview.md 分层文件机制移植：
 *   同一份内容维护两级压缩视图——
 *     abstract（一级）：单条内容的极短抽取式摘要（~200 字），供列表/导航层注入；
 *     overview（二级）：由子项 abstract 聚合而成的层级概览（~500 字），供"只讲结构不讲全文"的场景。
 *   注入上下文时按预算/深度选层：能全文就全文，超预算先降 overview，再降 abstract，
 *   全文仍以引用形式可下钻（对应 hybrid-retrieval 既有 ContextDrillDown 语义）。
 *
 * （仅移植设计思想，零代码复制，规避 AGPL —— 2026-10-15 技术债治理轮）
 *
 * 实现取向：确定性抽取式（切句 + 截断），零 LLM 依赖、零网络调用、可单测可回归；
 * LLM 生成式摘要属上层职责（memory/llm-updater.js 已有先例），本模块只做"选层与压缩"。
 */

const DEFAULT_ABSTRACT_CHARS = 200;
const DEFAULT_OVERVIEW_CHARS = 500;

/** 轻量切句：中英文终止符 + 换行分段；保留终止符在句尾 */
function splitSentences(text) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  return src
    .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z\u4e-\u9fa5])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 一级摘要（abstract）：按句累加至字符预算内，至少保留一句（超预算单句则硬截断加省略号）。
 * @param {string} content
 * @param {{maxChars?:number}} [opts]
 * @returns {string}
 */
function buildAbstract(content, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_ABSTRACT_CHARS;
  const text = String(content || '');
  if (text.length <= maxChars) return text;

  const sentences = splitSentences(text);
  let out = '';
  for (const s of sentences) {
    if (out && out.length + s.length > maxChars) break;
    out += (out ? '' : '') + s;
    if (out.length >= maxChars) break;
  }
  if (!out) out = text.slice(0, maxChars); // 无切分点（长 token 串）兜底
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + '…';
  return out;
}

/**
 * 二级概览（overview）：由多个子项 abstract 聚合（去重 + 字符预算）。
 * 子项缺失时回退为对 content 本身做 abstract。
 * @param {string} content       本级原文（回退用）
 * @param {string[]} childAbstracts 子项一级摘要列表
 * @param {{maxChars?:number, separator?:string}} [opts]
 * @returns {string}
 */
function buildOverview(content, childAbstracts, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_OVERVIEW_CHARS;
  const sep = opts.separator ?? '；';
  const seen = new Set();
  const parts = [];
  for (const raw of childAbstracts || []) {
    const a = String(raw || '').trim();
    if (!a) continue;
    const key = a.slice(0, 40); // 归并键：前 40 字相同视为重复
    if (seen.has(key)) continue;
    seen.add(key);
    if (parts.join(sep).length + a.length > maxChars) break;
    parts.push(a);
  }
  if (parts.length === 0) return buildAbstract(content, { maxChars });
  return parts.join(sep);
}

/**
 * 选层：决定一条结果以哪一层注入上下文。
 * @param {{content?:string, abstract?:string, overview?:string}} item
 * @param {{budgetChars?:number}} [opts]  budgetChars 缺省 = 不限（返回全文）
 * @returns {{layer:'full'|'overview'|'abstract', text:string}}
 */
function pickLayer(item, opts = {}) {
  const budget = opts.budgetChars ?? Infinity;
  const content = String(item?.content || '');
  if (content.length <= budget) return { layer: 'full', text: content };

  const overview = String(item?.overview || '');
  if (overview && overview.length <= budget) return { layer: 'overview', text: overview };

  const abstract = String(item?.abstract || '');
  if (abstract && abstract.length <= budget) return { layer: 'abstract', text: abstract };

  return { layer: 'abstract', text: buildAbstract(content, { maxChars: Math.max(40, Math.min(budget || DEFAULT_ABSTRACT_CHARS, DEFAULT_ABSTRACT_CHARS)) }) };
}

/**
 * 批量应用分层摘要到检索结果（原地改写 item.summaryLayer，必要时替换 item.injectedText）。
 * 不改写 item.content 本身——原文保留供下钻，注入层放独立字段，消费方按需取用。
 *
 * @param {Array} results
 * @param {{depth?:'full'|'auto'|'abstract'|'overview', budgetChars?:number,
 *          abstractChars?:number, overviewChars?:number}} [opts]
 *   depth=full（默认）：不动；auto：按 budgetChars 逐条选层；
 *   abstract/overview：强制统一层（overview 无现成值时退化为 abstract）
 * @returns {Array} 同一 results 引用
 */
function applyLayeredSummary(results, opts = {}) {
  const depth = opts.depth || 'full';
  if (!Array.isArray(results) || results.length === 0 || depth === 'full') return results;

  const budget = opts.budgetChars ?? Infinity;
  for (const item of results) {
    if (!item) continue;
    let picked;
    if (depth === 'auto') {
      picked = pickLayer(item, { budgetChars: budget });
    } else if (depth === 'overview' && item.overview) {
      picked = { layer: 'overview', text: item.overview };
    } else if (depth === 'abstract' && item.abstract) {
      picked = { layer: 'abstract', text: item.abstract };
    } else {
      // 强制 abstract / overview 缺层退化：从原文现算 abstract
      const maxChars = depth === 'overview' ? (opts.overviewChars ?? DEFAULT_OVERVIEW_CHARS) : (opts.abstractChars ?? DEFAULT_ABSTRACT_CHARS);
      picked = { layer: 'abstract', text: buildAbstract(item.content, { maxChars }) };
    }
    item.summaryLayer = picked.layer;
    item.injectedText = picked.text;
  }
  return results;
}

module.exports = {
  splitSentences,
  buildAbstract,
  buildOverview,
  pickLayer,
  applyLayeredSummary,
  DEFAULT_ABSTRACT_CHARS,
  DEFAULT_OVERVIEW_CHARS,
};
