/**
 * context-depths.js — 统一分层加载协议（OpenViking L0/L1/L2 精华落地）
 *
 * 问题：记忆、知识库 chunks、工具结果存档三类上下文资产各有一套加载方式
 * （memory-smart-loader / hybrid-retrieval snippet / history-compactor 预览+Read），
 * 模型无法用统一姿势"先扫摘要、再决定取全文"——每类资产都按全文灌进上下文。
 *
 * 协议：每条检索结果都带三级深度 + 可下钻引用（ref）：
 *   - abstract (L0)：≈120 字符一句话摘要——判断"相关不相关"用
 *   - overview (L1)：≈600 字符结构与要点——规划"值不值得读全文"用
 *   - full     (L2)：全文——确认要用才取
 *   - ref：{ source, id, ... }，模型用 ContextDrillDown 工具按 ref 升级深度
 *
 * 本模块是纯函数（无 I/O），解析 ref 取全文的能力在 context-depth-tools.js。
 * 默认深度 abstract：检索结果批量降 token（OpenViking 实测 34%–91%），
 * 全文按需经下钻获取。
 */

const DEPTHS = {
  ABSTRACT: 'abstract',
  OVERVIEW: 'overview',
  FULL: 'full',
};

// 深度别名（模型可能传 L0/L1/L2 或中文）
const DEPTH_ALIASES = {
  abstract: DEPTHS.ABSTRACT, l0: DEPTHS.ABSTRACT, 摘要: DEPTHS.ABSTRACT, 一句话: DEPTHS.ABSTRACT,
  overview: DEPTHS.OVERVIEW, l1: DEPTHS.OVERVIEW, 概览: DEPTHS.OVERVIEW, 要点: DEPTHS.OVERVIEW,
  full: DEPTHS.FULL, full_text: DEPTHS.FULL, l2: DEPTHS.FULL, 全文: DEPTHS.FULL,
};

const ABSTRACT_CHARS = 120;
const OVERVIEW_CHARS = 600;

/** 归一化深度入参；非法值回落 abstract（宁可少给 token 也不灌全文） */
function normalizeDepth(input) {
  if (!input) return DEPTHS.ABSTRACT;
  const key = String(input).trim().toLowerCase();
  return DEPTH_ALIASES[key] || DEPTHS.ABSTRACT;
}

/**
 * 按深度渲染一段内容。
 * @param {string} content 原文
 * @param {string} depth abstract|overview|full
 * @param {object} [opts] { maxChars?: number 覆盖该深度截断长度 }
 * @returns {{ content: string, depth: string, truncated: boolean, originalChars: number }}
 */
function renderAtDepth(content, depth = DEPTHS.ABSTRACT, opts = {}) {
  const text = typeof content === 'string' ? content : (content == null ? '' : String(content));
  const d = normalizeDepth(depth);
  const limit = opts.maxChars || (d === DEPTHS.ABSTRACT ? ABSTRACT_CHARS : d === DEPTHS.OVERVIEW ? OVERVIEW_CHARS : Infinity);

  const oneLine = d === DEPTHS.ABSTRACT;
  let rendered = text;
  if (oneLine) rendered = text.replace(/\s+/g, ' ').trim();
  if (rendered.length > limit) rendered = rendered.slice(0, limit) + '…';

  return {
    content: rendered,
    depth: d,
    truncated: rendered.length < text.length,
    originalChars: text.length,
  };
}

/**
 * 批量整理检索结果：按深度渲染 + 附 ref 与下钻提示。
 * refOf(result) 返回 { source, id, ... }；返回 null 则不加 ref。
 * @returns {Array} 新数组（不改入参）
 */
function shapeResults(results, depth = DEPTHS.ABSTRACT, refOf = null) {
  const d = normalizeDepth(depth);
  return (Array.isArray(results) ? results : []).map((r) => {
    const rendered = renderAtDepth(r.content, d);
    const ref = refOf ? refOf(r) : null;
    const out = {
      ...r,
      content: rendered.content,
      depth: rendered.depth,
      truncated: rendered.truncated,
      originalChars: rendered.originalChars,
    };
    if (ref) {
      out.ref = ref;
      out.escalation = rendered.truncated
        ? `以上为 ${rendered.depth} 层摘要；需要更完整内容请用 ContextDrillDown 工具传 ref={source:"${ref.source}", id:"${ref.id}"}`
        : null;
    }
    return out;
  });
}

module.exports = {
  DEPTHS,
  DEPTH_ALIASES,
  ABSTRACT_CHARS,
  OVERVIEW_CHARS,
  normalizeDepth,
  renderAtDepth,
  shapeResults,
};
