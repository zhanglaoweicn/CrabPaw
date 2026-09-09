/**
 * stock-interpret.js — 股票分析 LLM 解读层（2026-08-16 新增）
 *
 * 消费 analyzeStockFull 的结构化分析 → LLM 生成中文解读（政策面/市场面/技术面/
 * 综合建议+买卖点）。LLM 失败/未配置/超时 → 规则兜底（fallbackInterpret），
 * 兜底路径显式标注，绝不假装 AI 生成。政策面为 LLM 基于公开认知生成，
 * 固定标注"非实时政策"。
 *
 * 依赖注入：opts.chat（默认 getAdapterRegistry().chat），测试注入 fake。
 */

const RATINGS = ['强烈关注', '关注', '中性', '回避'];

const LLM_DISCLAIMER = 'AI 解读基于量化数据生成，不构成投资建议；政策面为公开认知总结，非实时政策。';
const FALLBACK_DISCLAIMER = 'AI 解读暂不可用，以下为量化规则结果。';

const SYSTEM_PROMPT = `你是A股投资分析助手。基于用户提供的量化分析 JSON 生成中文解读，输出严格 JSON。
规则：
1. 只许引用给定数据，禁止编造数字、价位、新闻、公告。
2. policy（政策面）基于该股行业+公司+公开政策认知生成，150 字内，结尾标注"（基于公开认知，非实时政策）"。
3. market（市场面）解读宏观/板块/资金环境，150 字内。
4. technical（技术面）解读均线/动量/支撑压力/形态，150 字内。
5. verdict.rating 只能是：强烈关注、关注、中性、回避 之一。
6. verdict.buyPoint/sellPoint 必须是数字（元）或 null；position 是仓位百分比数字字符串（如 "30"）。
7. 输出 JSON 不要 markdown 围栏。`;

// 占位符模板无法直接内嵌大对象——用函数拼 prompt
function buildUserPrompt(analysis) {
  const q = analysis.quote || {};
  const sr = analysis.supportResistance || {};
  const risk = analysis.risks || {};
  const compact = {
    code: q.code, name: q.name, price: q.price, changePct: q.changePct,
    momentum: analysis.momentum || null,
    supportResistance: sr,
    multiTimeframe: analysis.multiTimeframe || null,
    pattern: analysis.pattern || null,
    volatility: analysis.volatility || null,
    fundamentals: analysis.fundamentals || null,
    quantitative: analysis.quantitative || null,
    overallScore: analysis.overallScore || null,
    risks: risk.risks || [],
    warnings: risk.warnings || [],
    macroEnv: analysis.macroEnv || null,
    industryProspects: analysis.industryProspects || null,
    capitalFlowFactor: analysis.capitalFlowFactor || null,
  };
  return `请基于以下量化分析结果生成解读（严格 JSON，不要 markdown 围栏）：
${JSON.stringify(compact, null, 2)}`;
}

/** 规则兜底：评分 → 评级，支撑/压力 → 买卖点，风险 → 仓位 */
function fallbackInterpret(analysis) {
  const a = analysis || {};
  // 2026-08-17 fix(Task 6 P-3): 实机管线 finalScore 为字符串(如 "-0.15")——
  // typeof number 判断导致 summary 显示"评分 —"(诚实但可优化)。先 Number 强转
  // 再有限性判断；空串/缺位保持 null('—' 行为不变), 不编造 0。
  const raw = a.overallScore?.finalScore;
  let score = raw != null && raw !== '' ? Number(raw) : null;
  if (score !== null && !Number.isFinite(score)) score = null;
  // 2026-08-31 fix: finalScore 量纲为 [-1,1]（calculateOverallScore: Math.max(-1,Math.min(1,score))），
  // 此前误用百分制阈值(70/55/40)——真实分数恒 <40 → 兜底评级永远判「回避」，
  // 击穿兜底设计。阈值对齐 calculateOverallScore 的 BUY/SELL 权威线(±0.3)，强烈关注用更高门槛 0.5。
  let rating = '中性';
  if (score !== null) {
    if (score >= 0.5) rating = '强烈关注';
    else if (score >= 0.3) rating = '关注';
    else if (score < -0.3) rating = '回避';
  }
  const risks = Array.isArray(a.risks?.risks) ? a.risks.risks : [];
  const hasHighRisk = risks.some(r => r && r.level === 'HIGH');
  const hasMedRisk = risks.some(r => r && r.level === 'MEDIUM');
  const position = hasHighRisk ? '20' : hasMedRisk ? '30' : '50';
  const sr = a.supportResistance || {};
  // 空串/空白串/缺位不数值化——Number('')===0 / Number('  ')===0 会编造 0，诚实空须保持 null
  const buyPoint = Array.isArray(sr.support) && sr.support[0] != null && String(sr.support[0]).trim() !== '' ? Number(sr.support[0]) : null;
  const sellPoint = Array.isArray(sr.resistance) && sr.resistance[0] != null && String(sr.resistance[0]).trim() !== '' ? Number(sr.resistance[0]) : null;
  const trend = a.momentum?.trendStatus || '';
  const summary = `量化综合评分 ${score != null ? score : '—'}，趋势${trend || '不明'}，建议仓位 ${position}%。`;
  return {
    policy: '',
    market: '',
    technical: '',
    verdict: {
      rating, buyPoint: Number.isFinite(buyPoint) ? buyPoint : null,
      sellPoint: Number.isFinite(sellPoint) ? sellPoint : null,
      position, riskNote: hasHighRisk ? '存在高风险项，注意控制仓位。' : '',
      summary,
    },
    source: 'fallback',
    disclaimer: FALLBACK_DISCLAIMER,
    generatedAt: new Date().toISOString(),
  };
}

/** 剥 markdown 围栏 + JSON.parse；失败返回 null */
function parseInterpretJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  try {
    const obj = JSON.parse(t);
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
  } catch (e) {
    console.error('[stock-interpret] LLM JSON.parse 失败:', e.message || e);
    return null;
  }
}

/** 归一 verdict：非法 rating → 按评分兜底映射；数字字段 Number 化 */
function normalizeVerdict(verdict, fallback) {
  const fb = fallback.verdict;
  const v = (verdict && typeof verdict === 'object') ? verdict : {};
  const rating = RATINGS.includes(v.rating) ? v.rating : fb.rating;
  // 诚实数据：null/undefined/''/'   ' 一律不数值化——Number(null)===0 与
  // Number('  ')===0 会把 LLM 显式"无买卖点"(SYSTEM_PROMPT 规则 6) 编造成 0 元；
  // 仅真实数值才 Number 化
  const num = (x) => {
    if (x === null || x === undefined || (typeof x === 'string' && x.trim() === '')) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  return {
    rating,
    // LLM 显式 null = "无该点"，连兜底值也不覆盖；字段缺失(undefined)才回退兜底
    buyPoint: v.buyPoint === null ? null : (num(v.buyPoint) ?? fb.buyPoint),
    sellPoint: v.sellPoint === null ? null : (num(v.sellPoint) ?? fb.sellPoint),
    position: String(v.position ?? fb.position),
    riskNote: typeof v.riskNote === 'string' && v.riskNote ? v.riskNote : fb.riskNote,
    summary: typeof v.summary === 'string' && v.summary ? v.summary : fb.summary,
  };
}

/**
 * 生成解读。opts.chat 测试注入；默认懒加载 adapter-registry。
 * @param {object} analysis analyzeStockFull 结构化结果
 * @param {object} [opts] { chat?, model?, timeoutMs? }
 */
async function generateStockInterpret(analysis, opts = {}) {
  const timeoutMs = opts.timeoutMs || 10000;
  const fallback = fallbackInterpret(analysis);
  let _timer = null;
  try {
    const chat = opts.chat || (() => {
      const { getAdapterRegistry } = require('../llm');
      const reg = getAdapterRegistry();
      return reg.chat.bind(reg);
    })();
    const model = opts.model || 'deepseek-chat';
    // 2026-08-16: prompt 走 prompt-loader（prompts/stock-interpret.md 缺失时回退内置模板）
    const { loadPrompt } = require('../prompt-loader');
    const systemPrompt = loadPrompt('stock-interpret') || SYSTEM_PROMPT;
    const result = await Promise.race([
      chat({
        model,
        systemPrompt,
        messages: [{ role: 'user', content: buildUserPrompt(analysis) }],
        temperature: 0.3,
        maxTokens: 800,
      }),
      new Promise((_, reject) => {
        _timer = setTimeout(() => reject(new Error('LLM 解读超时')), timeoutMs);
      }),
    ]);
    const parsed = parseInterpretJson(result && result.content);
    if (!parsed) throw new Error('LLM 解读返回非 JSON');
    const verdict = normalizeVerdict(parsed.verdict, fallback);
    return {
      policy: typeof parsed.policy === 'string' ? parsed.policy : '',
      market: typeof parsed.market === 'string' ? parsed.market : '',
      technical: typeof parsed.technical === 'string' ? parsed.technical : '',
      verdict,
      source: 'llm',
      disclaimer: LLM_DISCLAIMER,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[stock-interpret] LLM 解读失败, 走规则兜底:', e.message || e);
    return fallback;
  } finally {
    clearTimeout(_timer);  // race 已定, 清理超时定时器(防挂起进程/测试 worker 泄漏)
  }
}

module.exports = {
  generateStockInterpret, fallbackInterpret, parseInterpretJson,
  RATINGS, LLM_DISCLAIMER, FALLBACK_DISCLAIMER,
};
