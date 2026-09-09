'use strict';

/**
 * concept-time-tool.js — AI 可调用的概念提取/时间解析工具
 *
 * 工具:
 *   ExtractConcepts   — 从文本提取概念（关键词/实体/工具/指纹）
 *   ParseTime         — 解析自然语言时间（相对/绝对/区间）
 *   TimeDelta         — 计算两个时间的相对差（"X 秒前"/"X 分钟后"）
 *   FormatContext     — 整合概念+时间+自我感知，生成统一的 <context> 块
 */

const { registry } = require('./registry');
const {
  getConceptExtractor,
} = require('../core/concept-extractor');
const {
  getTimeParser, parseTime,
  relativeLabel, formatDate,
} = require('../core/time-parser');

function _unwrap(res) {
  if (!res) return res;
  if (res.data && typeof res.data === 'object') return res.data;
  return res;
}

// ── ExtractConcepts ──────────────────────────────────
registry.register({
  name: 'ExtractConcepts',
  toolset: 'system',
  category: 'understanding',
  description: '从一段文本中提取关键概念：高频关键词、命名实体（URL/邮箱/IP/时间/数字/引文/姓名）、技术工具、概念指纹 hash。用于记忆索引、相似度检索、上下文去重。',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要分析的文本' },
      topN: { type: 'number', description: '返回关键词数量（默认 10）', default: 10 },
      includeFingerprint: { type: 'boolean', description: '是否返回概念指纹 hash', default: true },
      format: { type: 'string', enum: ['json', 'prompt', 'compact'], default: 'json' },
    },
    required: ['text'],
  },
  handler: async (params) => {
    const text = String(params.text || '');
    if (!text) return { success: false, error: 'text 不能为空' };
    const ext = getConceptExtractor();
    const fp = ext.extract(text);
    if (params.format === 'prompt') {
      return { success: true, text: ext.extractForPrompt(text), hash: fp.hash };
    }
    if (params.format === 'compact') {
      return { success: true, summary: fp.summary, hash: fp.hash, topKeywords: fp.keywords.slice(0, 5) };
    }
    return {
      success: true,
      keywords: fp.keywords.slice(0, params.topN || 10),
      entities: fp.entities,
      tools: fp.tools,
      hash: params.includeFingerprint === false ? undefined : fp.hash,
      summary: fp.summary,
    };
  },
  isReadOnly: true,
  timeout: 5000,
});

// ── ParseTime ─────────────────────────────────────
registry.register({
  name: 'ParseTime',
  toolset: 'system',
  category: 'understanding',
  description: '解析自然语言时间表达式为结构化时间戳。支持相对（"今天"/"3天后"/"下周"）、绝对（"2026-07-12 14:30"/"7月15日"）、区间（"今天到明天"）。返回 ISO 字符串和人类可读时间。',
  schema: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '时间表达式（如 "3天后" / "2026-07-15"）' },
      timezone: { type: 'string', description: '时区（默认 Asia/Shanghai）' },
    },
    required: ['expression'],
  },
  handler: async (params) => {
    const expr = String(params.expression || '').trim();
    if (!expr) return { success: false, error: 'expression 不能为空' };
    const tp = getTimeParser();
    const result = tp.parse(expr);
    if (!result) {
      return { success: false, error: `无法解析时间表达式: ${expr}` };
    }
    if (result.start && result.end) {
      return {
        success: true,
        type: 'range',
        startIso: result.start.toISOString(),
        endIso: result.end.toISOString(),
        start: formatDate(result.start),
        end: formatDate(result.end),
        relativeStart: tp.relativeLabel(result.start),
        relativeEnd: tp.relativeLabel(result.end),
      };
    }
    return {
      success: true,
      type: 'point',
      iso: result.toISOString(),
      formatted: formatDate(result),
      relative: tp.relativeLabel(result),
      isPast: tp.isPast(result),
    };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── TimeDelta ────────────────────────────────────
registry.register({
  name: 'TimeDelta',
  toolset: 'system',
  category: 'understanding',
  description: '计算两个时间点之间的差值，返回 "X 秒前"/"X 小时前" 形式的相对标签。',
  schema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: '目标时间（ISO 字符串或自然语言）' },
      reference: { type: 'string', description: '参考时间（默认 now）' },
    },
    required: ['target'],
  },
  handler: async (params) => {
    let target = new Date(params.target);
    if (isNaN(target.getTime())) {
      const parsed = parseTime(params.target);
      if (!parsed || parsed.start) return { success: false, error: '无法解析 target 时间' };
      target = parsed;
    }
    const ref = params.reference ? new Date(params.reference) : new Date();
    const label = relativeLabel(target, ref);
    const diffMs = target.getTime() - ref.getTime();
    return {
      success: true,
      targetIso: target.toISOString(),
      referenceIso: ref.toISOString(),
      diffMs,
      label,
      isPast: diffMs < 0,
    };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── FormatContext ──────────────────────────────
registry.register({
  name: 'FormatContext',
  toolset: 'system',
  category: 'understanding',
  description: '将概念提取 + 时间解析 + 自我感知整合为统一的 <context> 块，适合注入 system prompt 或作为 turn trace。',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要分析的文本' },
      includeAwareness: { type: 'boolean', default: true, description: '是否包含自我感知块' },
    },
    required: ['text'],
  },
  handler: async (params) => {
    const lines = [];
    const ext = getConceptExtractor();
    const fp = ext.extract(params.text);
    lines.push('<context>');
    // 嵌入完整 <concepts>...</concepts> 块
    lines.push(ext.extractForPrompt(params.text));
    if (params.includeAwareness !== false) {
      try {
        const { getSelfAwareness } = require('../core/self-awareness');
        const aw = getSelfAwareness();
        const awText = await aw.perceiveLite();
        if (typeof awText === 'string' && awText) lines.push(awText);
      } catch (e) {
        /* ignore */
        console.warn('[concept-time-tool.js] 空 catch 补日志:', e && e.message);
      }

    }
    lines.push('</context>');
    return { success: true, text: lines.join('\n'), hash: fp.hash };
  },
  isReadOnly: true,
  timeout: 5000,
});

console.log('🧠 concept-time 工具已注册 (ExtractConcepts, ParseTime, TimeDelta, FormatContext)');

module.exports = {
  ExtractConcepts: 'ExtractConcepts',
  ParseTime: 'ParseTime',
  TimeDelta: 'TimeDelta',
  FormatContext: 'FormatContext',
};
