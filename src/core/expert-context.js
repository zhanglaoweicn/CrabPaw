/**
 * expert-context — 专家激活上下文（2026-08-26 E1）
 *
 * 背景: 专家的 systemPrompt(人设)/voiceStyle/dataScope 此前从未注入主对话——
 * 前端"召唤专家"只在输入框插入名字, LLM 只见名字当普通文本, 人设零生效。
 * 对齐 WorkBuddy「专家=完整认知框架(知识体系+工作习惯+输出标准)」:
 * 本模块将用户消息按 routingKeywords 路由(复用 experts.routeMessage),
 * 命中即激活专家, 激活态会话级保持(近 N 轮有效), 供 ai.js 注入 systemPrompt。
 *
 * 注入时机: chat-handler.js 在 routeAndActivate 命中后, 用 buildExpertPromptSuffix(active)
 * 把人设/角色/数据源/语音风格拼进用户消息(与 intentHint 同构); system-prompt.js 不感知专家。
 *
 * 会话保持: 用户后续消息未重新命中其他专家时, 维持当前专家(语境连续性,
 * 如"帮我看看这个数字"接在"财务顾问"后仍以财务视角回答); 命中新专家即切换;
 * 命中多专家取最高分; 全部未命中时若距上次误差超 N 轮则回落通用。
 */

let _expertsApi = null;
function getExpertsApi() {
  if (!_expertsApi) {
    const mod = require('./experts');
    _expertsApi = {
      routeMessage: mod.routeMessage,
      getAllExperts: mod.getAllExperts,
      getExpert: mod.getExpert,
      getExpertDataSources: mod.getExpertDataSources,
    };
  }
  return _expertsApi;
}

/** 会话级激活状态: userId -> { expertId, name, score, at, missCount } */
const _activeByUser = new Map();
const DECAY_ROUNDS = 3;      // 未命中新专家时保持 3 轮
// 2026-09-05 修复: routeMessage 输出 0-100 归一化整数(experts/index.js L542), 此前阈值
// 0.15 与分制错配 = 任何 1 个关键词命中即激活人设接管对话。下限应为 15(即 15% 置信)。
const MIN_SCORE = 15;        // 路由命中分下限(0-100 归一化分制), 防关键词过弱误触

/** 消息路由 → 激活专家（每个用户每轮调用一次，context 准备阶段） */
function routeAndActivate(userId, message) {
  if (!userId || !message) return null;
  const api = getExpertsApi();
  let results = [];
  try { results = api.routeMessage(message) || [] } catch (e) { console.warn('[expert-context] 路由失败:', e?.message || e); return renderState(userId); }
  const best = (results || []).find(r => r && typeof r.score === 'number') || null;
  // 按分数排序取最高
  const sorted = [...(results || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = sorted[0];
  if (top && top.score >= MIN_SCORE) {
    const prev = _activeByUser.get(userId);
    _activeByUser.set(userId, {
      expertId: top.expertId,
      name: top.name,
      score: top.score,
      at: Date.now(),
      missCount: 0, // 命中清零
    });
    if (prev?.expertId !== top.expertId) {
      console.log(`🎭 [expert-context] 激活专家「${top.name}」 (score=${top.score}, kw=${(top.matchedKeywords || []).slice(0, 3).join('/')})`);
    }
  } else {
    const prev = _activeByUser.get(userId);
    if (prev) {
      const nextMiss = (prev.missCount || 0) + 1;
      if (nextMiss <= DECAY_ROUNDS) {
        prev.missCount = nextMiss;
      } else {
        _activeByUser.delete(userId);
        console.log(`🎭 [expert-context] 专家「${prev.name}」语境回落(超 ${DECAY_ROUNDS} 轮未命中)`);
      }
    }
  }
  return renderState(userId);
}

/**
 * 取当前激活专家（context 准备/gui 状态展示共用）
 * @returns {{id,name,score,voiceStyle,systemPrompt,dataSources}|null}
 */
function getActiveExpert(userId) {
  const st = _activeByUser.get(userId);
  if (!st) return null;
  const api = getExpertsApi();
  let expert = null;
  try { expert = api.getExpert(st.expertId) } catch { /* 专家可能被删 */ }
  if (!expert) {
    _activeByUser.delete(userId);
    return null;
  }
  let dataSources = null;
  try { dataSources = api.getExpertDataSources(st.expertId) } catch { /* 可选 */ }
  return {
    id: st.expertId,
    name: expert.name || st.name,
    title: expert.title || '',
    score: st.score,
    voiceStyle: expert.voiceStyle || '',
    systemPrompt: expert.systemPrompt || '',
    dataSources,
    // P1(2026-09-04): 部门信息——语音播报"已接通财务部·税务专员"与 GUI 角标用
    department: expert.department || null,
    departmentLabel: expert.departmentLabel || null,
    status: expert.status || 'active',
    // P3(2026-09-04): 工具面三元组第二元——enforcement 由 tool-definitions 消费
    allowedToolsets: expert.allowedToolsets || [],
    allowedSkills: expert.allowedSkills || [],
  };
}

/**
 * 直接激活专家（2026-09-04 P1 召唤 API 通道）——绕过关键词路由，按 id 精确生效。
 * 语义：score=100 满分（显式召唤高于任何路由命中），missCount 清零（会话保持重新计时）。
 */
function activateExpert(userId, expertId, { source = 'summon' } = {}) {
  if (!userId || !expertId) return { ok: false };
  const api = getExpertsApi();
  let expert = null;
  try { expert = api.getExpert(expertId); } catch { /* 专家可能被删 */ }
  if (!expert) return { ok: false };
  _activeByUser.set(userId, {
    expertId,
    name: expert.name,
    score: 100,
    at: Date.now(),
    missCount: 0,
  });
  console.log(`🎭 [expert-context] 召唤激活专家「${expert.name}」(source=${source})`);
  return renderState(userId);
}

/**
 * 当前激活专家的工具面（2026-09-04 P3 enforcement 数据源）。
 * 返回 allowedToolsets 数组；无激活专家/专家未声明/已泊车 → null（调用方不收窄）。
 */
function getActiveExpertToolsets(userId) {
  const a = getActiveExpert(userId);
  if (!a || a.status === 'parked') return null;
  const ts = a.allowedToolsets;
  return Array.isArray(ts) && ts.length > 0 ? ts : null;
}

/**
 * 当前激活专家的技能包（2026-09-04 P3 skill-router 偏置数据源）。
 * 语义与工具面一致：无激活/未声明/泊车 → null（不偏置）。
 */
function getActiveExpertSkills(userId) {
  const a = getActiveExpert(userId);
  if (!a || a.status === 'parked') return null;
  const sk = a.allowedSkills;
  return Array.isArray(sk) && sk.length > 0 ? sk : null;
}

/** 重置（专家被删/配置变更时清理） */
function reset(userId) {
  if (userId) _activeByUser.delete(userId);
  else _activeByUser.clear();
}

/**
 * 构建专家激活的提示词注入后缀（2026-08-28 修复: 完整注入 systemPrompt）。
 * 此前 chat-handler 以 String(systemPrompt).slice(0, 200) 截断——11 位专家的
 * 四段结构化人设只有前 200 字符生效。注入点为 chat-handler.js 把本函数返回值
 * 拼进 processedMessage（与 intentHint 同构）；system-prompt.js 不感知专家。
 */
function buildExpertPromptSuffix(active) {
  if (!active || !active.name) return '';
  const styleLine = active.voiceStyle ? `；语气: ${active.voiceStyle}` : '';
  const dsLine = active.dataSources ? `。可用数据源: ${active.dataSources}` : '';
  let s = `\n\n[系统提示: 本对话将根据「${active.name}」专家视角回答。`;
  if (active.title) s += `(角色: ${active.title})`;
  if (active.systemPrompt) s += ` 人设要求: ${String(active.systemPrompt)}`;
  return `${s}${styleLine}${dsLine}]`;
}

function renderState(userId) {
  const a = getActiveExpert(userId);
  return a ? { ok: true, expertId: a.id, name: a.name, score: a.score } : { ok: false };
}

module.exports = {
  routeAndActivate,
  activateExpert,
  getActiveExpert,
  getActiveExpertToolsets,
  getActiveExpertSkills,
  buildExpertPromptSuffix,
  reset,
  MIN_SCORE,
  DECAY_ROUNDS,
};
