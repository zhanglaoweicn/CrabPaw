/**
 * entity-extractor.js — 零依赖 pattern 实体抽取器（semantica NERExtractor 的轻量移植）
 * 优先级：LLM fn（若注入）> 引号/书名号/专名模式 > 热词表。
 */
const QUOTED_RE = /[「『《“"']([^「」『』《》"'\n]{2,20})/g;
const LIMIT = 20;

let _llmExtractFn = null;

function setLLMExtractFn(fn) { _llmExtractFn = fn || null; }
function getLLMExtractFn() { return _llmExtractFn; }

function extractEntities(text, hotwords = []) {
  if (!text || typeof text !== 'string') return [];
  if (_llmExtractFn) {
    const result = _llmExtractFn(text);
    if (result && typeof result.then === 'function') {
      // 异步：调用方 await（本函数同步版本只处理同步结果）
      return result.then((arr) => dedupe(Array.isArray(arr) ? arr : []).slice(0, LIMIT));
    }
    return dedupe(Array.isArray(result) ? result : []).slice(0, LIMIT);
  }
  const out = [];
  const push = (name) => {
    const n = String(name || '').trim();
    if (n.length >= 2 && n.length <= 30 && !out.includes(n)) out.push(n);
  };
  let m;
  QUOTED_RE.lastIndex = 0;
  while ((m = QUOTED_RE.exec(text)) !== null) push(m[1]);
  for (const h of hotwords) {
    if (text.includes(h)) push(h);
  }
  return out.slice(0, LIMIT);
}

function dedupe(arr) {
  return arr.filter((v, i) => v !== undefined && v !== null && arr.indexOf(v) === i);
}

module.exports = { extractEntities, setLLMExtractFn, getLLMExtractFn };
