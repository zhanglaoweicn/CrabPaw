'use strict';

/**
 * self-awareness-tool.js — AI 可调用的自我感知工具
 *
 * 工具:
 *   GetSelfProfile   — 完整自我画像（knowledge + perception + evolution）
 *   GetSelfSummary   — 轻量摘要（适合注入 prompt）
 *   RefreshSelf      — 强制刷新画像
 */

const { registry } = require('./registry');
const { getSelfAwareness, formatForPrompt: _formatForPrompt } = require('../core/self-awareness');

function _unwrap(res) {
  if (!res) return res;
  if (res.data && typeof res.data === 'object') return res.data;
  return res;
}

async function handleGetSelfProfile(params, _context) {
  const aw = getSelfAwareness();
  const profile = await aw.perceive({ force: params.force === true });
  return { success: true, data: profile };
}

async function handleGetSelfSummary(params, _context) {
  const aw = getSelfAwareness();
  if (params.force) aw.invalidate();
  const text = await aw.perceiveLite();
  return { success: true, text, length: text.length };
}

// eslint-disable-next-line no-unused-vars
async function handleRefreshSelf(_params, context) {
  getSelfAwareness().invalidate();
  return { success: true, message: '自我画像已失效' };
}

registry.register({
  name: 'GetSelfProfile',
  toolset: 'system',
  category: 'self',
  description: '获取完整自我画像：knowledge (身份/版本/能力/限制) + perception (当前可用资源) + evolution (学习轨迹)。',
  schema: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: '强制重新感知' },
    },
  },
  handler: handleGetSelfProfile,
  isReadOnly: true,
  timeout: 10000,
});

registry.register({
  name: 'GetSelfSummary',
  toolset: 'system',
  category: 'self',
  description: '获取自我画像的紧凑文本（<self_awareness>...</self_awareness>），适合注入 prompt。',
  schema: {
    type: 'object',
    properties: {
      force: { type: 'boolean' },
    },
  },
  handler: handleGetSelfSummary,
  isReadOnly: true,
  timeout: 5000,
});

registry.register({
  name: 'RefreshSelf',
  toolset: 'system',
  category: 'self',
  description: '失效自我画像缓存，下次 Get* 时重新感知。',
  schema: { type: 'object', properties: {} },
  handler: handleRefreshSelf,
  timeout: 2000,
});

console.log('🪞 self-awareness 工具已注册 (3 个工具)');

module.exports = {
  handleGetSelfProfile,
  handleGetSelfSummary,
  handleRefreshSelf,
};
