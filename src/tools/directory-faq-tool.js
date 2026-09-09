'use strict';

/**
 * directory-faq-tool.js — AI 可调用的目录索引 + 配置 FAQ 工具
 *
 * 工具:
 *   DirectoryQuery    — 询问项目目录（"语音识别在哪？" / "记忆相关的文件"）
 *   DirectoryList     — 列出某类目的所有条目
 *   DirectoryCard     — 生成 prompt 友好的目录摘要
 *   DirectoryTools    — 列出所有注册过的工具
 *   ConfigAsk         — 询问配置相关问题（"如何切换 LLM？" / "TTS 默认什么？"）
 *   ConfigSearch      — 按关键词搜索配置 FAQ
 *   ConfigList        — 列出 FAQ 全部或某分类
 */

const { registry } = require('./registry');
const { getAutoDirectory } = require('../core/auto-directory');
const { getConfigFAQ } = require('../core/config-faq');

function _unwrap(res) {
  if (!res) return res;
  if (res.data && typeof res.data === 'object') return res.data;
  return res;
}

// ── DirectoryQuery ──────────────────────────────────
registry.register({
  name: 'DirectoryQuery',
  toolset: 'system',
  category: 'navigation',
  description: '用自然语言查询 CrabPaw 项目结构：问某个功能在哪里、某个类在哪、某个工具怎么调用。返回 top 命中条目（含路径、描述、相关工具/类）。',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '查询问题（自然语言）' },
      limit: { type: 'number', description: '返回条数（默认 5）', default: 5 },
      category: { type: 'string', description: '限定类目（memory/voice/tools/...）' },
    },
    required: ['question'],
  },
  handler: async (params) => {
    const question = String(params.question || '').trim();
    if (!question) return { success: false, error: 'question 不能为空' };
    const dir = getAutoDirectory();
    if (dir.size === 0) dir.scan();
    const results = dir.query(question, { limit: params.limit || 5, category: params.category });
    return { success: true, question, count: results.length, results };
  },
  isReadOnly: true,
  timeout: 10000,
});

// ── DirectoryList ──────────────────────────────────
registry.register({
  name: 'DirectoryList',
  toolset: 'system',
  category: 'navigation',
  description: '列出指定类目下的所有目录条目。可选类目：core/memory/voice/tools/channel/agent/evolution/security/observability/...',
  schema: {
    type: 'object',
    properties: {
      category: { type: 'string', description: '类目名称（不传则返回所有类目统计）' },
      limit: { type: 'number', description: '返回条数上限', default: 50 },
    },
  },
  handler: async (params) => {
    const dir = getAutoDirectory();
    if (dir.size === 0) dir.scan();
    if (!params.category) {
      const stats = {};
      for (const cat of dir.categories) {
        stats[cat] = dir._byCategory.get(cat).length;
      }
      return { success: true, total: dir.size, byCategory: stats, categories: dir.categories };
    }
    const entries = (dir._byCategory.get(params.category) || []).slice(0, params.limit || 50).map(e => ({
      path: e.path,
      scope: e.scope,
      description: e.description,
      tools: e.tools.slice(0, 5),
    }));
    return { success: true, category: params.category, count: entries.length, entries };
  },
  isReadOnly: true,
  timeout: 10000,
});

// ── DirectoryCard ──────────────────────────────────
registry.register({
  name: 'DirectoryCard',
  toolset: 'system',
  category: 'navigation',
  description: '生成 prompt 友好的目录摘要卡片，适合注入 system prompt。',
  schema: {
    type: 'object',
    properties: {
      scope: { type: 'string', description: '限定 scope (core/tools/channels/...)，不传则概览' },
    },
  },
  handler: async (params) => {
    const dir = getAutoDirectory();
    if (dir.size === 0) dir.scan();
    const text = dir.card(params.scope || null);
    return { success: true, text, total: dir.size, scannedAt: dir.scannedAt };
  },
  isReadOnly: true,
  timeout: 10000,
});

// ── DirectoryTools ──────────────────────────────────
registry.register({
  name: 'DirectoryTools',
  toolset: 'system',
  category: 'navigation',
  description: '列出所有在 CrabPaw 项目源码中注册过的工具（含工具名和所在文件路径）。',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '按名称过滤（子串匹配）' },
    },
  },
  handler: async (params) => {
    const dir = getAutoDirectory();
    if (dir.size === 0) dir.scan();
    let tools = dir.listTools();
    if (params.pattern) {
      const p = params.pattern.toLowerCase();
      tools = tools.filter(t => t.name.toLowerCase().includes(p));
    }
    return { success: true, count: tools.length, tools };
  },
  isReadOnly: true,
  timeout: 10000,
});

// ── ConfigAsk ──────────────────────────────────
registry.register({
  name: 'ConfigAsk',
  toolset: 'system',
  category: 'config',
  description: '询问 CrabPaw 配置相关问题（"如何切换 LLM provider？" / "TTS 默认使用什么？" / "数据存放在哪里？"）。返回最佳答案、相关问题、相关配置路径。',
  schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '配置相关问题' },
    },
    required: ['question'],
  },
  handler: async (params) => {
    const question = String(params.question || '').trim();
    if (!question) return { success: false, error: 'question 不能为空' };
    const faq = getConfigFAQ();
    const result = faq.ask(question);
    return { success: true, question, ...result };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── ConfigSearch ──────────────────────────────────
registry.register({
  name: 'ConfigSearch',
  toolset: 'system',
  category: 'config',
  description: '按关键词搜索配置 FAQ 条目（问题/关键词/配置路径匹配）。',
  schema: {
    type: 'object',
    properties: {
      keyword: { type: 'string', description: '搜索关键词' },
    },
    required: ['keyword'],
  },
  handler: async (params) => {
    const keyword = String(params.keyword || '').trim();
    if (!keyword) return { success: false, error: 'keyword 不能为空' };
    const faq = getConfigFAQ();
    const results = faq.search(keyword);
    return { success: true, keyword, count: results.length, results };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── ConfigList ──────────────────────────────────
registry.register({
  name: 'ConfigList',
  toolset: 'system',
  category: 'config',
  description: '列出所有配置 FAQ 条目，可按 category 过滤（startup/storage/llm/voice/channel/security/performance/tools/memory/testing）。',
  schema: {
    type: 'object',
    properties: {
      category: { type: 'string', description: '分类（不传返回所有）' },
    },
  },
  handler: async (params) => {
    const faq = getConfigFAQ();
    const entries = faq.list(params.category || null);
    return {
      success: true,
      total: entries.length,
      category: params.category || 'all',
      categories: faq.categories,
      entries: entries.map(e => ({ q: e.q, cfg: e.cfg, default: e.default, category: e.category })),
    };
  },
  isReadOnly: true,
  timeout: 3000,
});

console.log('📂 directory-faq 工具已注册 (DirectoryQuery/List/Card/Tools, ConfigAsk/Search/List)');

module.exports = {
  DirectoryQuery: 'DirectoryQuery',
  DirectoryList: 'DirectoryList',
  DirectoryCard: 'DirectoryCard',
  DirectoryTools: 'DirectoryTools',
  ConfigAsk: 'ConfigAsk',
  ConfigSearch: 'ConfigSearch',
  ConfigList: 'ConfigList',
};
