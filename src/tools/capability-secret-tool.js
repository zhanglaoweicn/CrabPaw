'use strict';

/**
 * capability-secret-tool.js — 能力/密钥管理工具
 *
 * 工具:
 *   RegisterCapability  — 注册能力到指定槽位
 *   EnableCapability    — 启用某个实现
 *   DisableCapability   — 禁用某个实现
 *   SetActiveCapability — 切换槽位的 active 实现
 *   ListCapabilities    — 列出能力
 *   GetActiveCapability — 查询当前 active
 *   SetSecret           — 写入密钥
 *   GetSecret           — 读取密钥
 *   DeleteSecret        — 删除密钥
 *   ListSecrets         — 列出所有密钥（仅元数据）
 *   CapabilityHealthCheck — 异步健康检查
 */

const { registry } = require('./registry');
const { getCapabilityRegistry } = require('../core/api-capability');
const { getSecretStore } = require('../core/secret-store');

function _unwrap(res) {
  if (!res) return res;
  if (res.data && typeof res.data === 'object') return res.data;
  return res;
}

// ── RegisterCapability ──────────────────────────────
registry.register({
  name: 'RegisterCapability',
  toolset: 'system',
  category: 'capability',
  description: '注册一个能力实现到指定槽位。槽位如 tts/stt/llm/image-gen/search 等。',
  schema: {
    type: 'object',
    properties: {
      slot: { type: 'string' },
      name: { type: 'string' },
      version: { type: 'string' },
      metadata: { type: 'object' },
      tags: { type: 'array', items: { type: 'string' } },
      dependencies: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean', default: false },
      priority: { type: 'number', default: 100 },
    },
    required: ['slot', 'name'],
  },
  handler: async (params) => {
    const reg = getCapabilityRegistry();
    try {
      const entry = reg.register(params);
      return { success: true, capability: entry.toJSON() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── EnableCapability ─────────────────────────────
registry.register({
  name: 'EnableCapability',
  toolset: 'system',
  category: 'capability',
  description: '启用指定槽位下的某个实现。',
  schema: {
    type: 'object',
    properties: {
      slot: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['slot', 'name'],
  },
  handler: async (params) => {
    try {
      const entry = getCapabilityRegistry().enable(params.slot, params.name);
      return { success: true, capability: entry.toJSON() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── DisableCapability ────────────────────────────
registry.register({
  name: 'DisableCapability',
  toolset: 'system',
  category: 'capability',
  description: '禁用某个能力。会自动切换到下一个可用的实现。',
  schema: {
    type: 'object',
    properties: {
      slot: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['slot', 'name'],
  },
  handler: async (params) => {
    const ok = getCapabilityRegistry().disable(params.slot, params.name);
    return { success: ok, slot: params.slot, name: params.name };
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── SetActiveCapability ──────────────────────────
registry.register({
  name: 'SetActiveCapability',
  toolset: 'system',
  category: 'capability',
  description: '主动切换槽位的 active 实现。',
  schema: {
    type: 'object',
    properties: {
      slot: { type: 'string' },
      name: { type: 'string' },
    },
    required: ['slot', 'name'],
  },
  handler: async (params) => {
    try {
      const entry = getCapabilityRegistry().setActive(params.slot, params.name);
      return { success: true, capability: entry.toJSON() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── ListCapabilities ────────────────────────────
registry.register({
  name: 'ListCapabilities',
  toolset: 'system',
  category: 'capability',
  description: '列出能力（可按 slot 过滤）。',
  schema: {
    type: 'object',
    properties: {
      slot: { type: 'string' },
      tag: { type: 'string' },
    },
  },
  handler: async (params) => {
    const reg = getCapabilityRegistry();
    if (params.tag) {
      return { success: true, capabilities: reg.findByTag(params.tag) };
    }
    if (params.slot) {
      return { success: true, slot: params.slot, capabilities: reg.list(params.slot), active: reg.getActive(params.slot)?.name || null };
    }
    const slots = reg.slots();
    const result = {};
    for (const s of slots) {
      result[s] = { list: reg.list(s), active: reg.getActive(s)?.name || null };
    }
    return { success: true, slots: result, stats: reg.getStats() };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── GetActiveCapability ─────────────────────────
registry.register({
  name: 'GetActiveCapability',
  toolset: 'system',
  category: 'capability',
  description: '查询指定槽位的 active 实现。',
  schema: {
    type: 'object',
    properties: {
      slot: { type: 'string' },
    },
    required: ['slot'],
  },
  handler: async (params) => {
    const entry = getCapabilityRegistry().getActive(params.slot);
    return { success: !!entry, capability: entry ? entry.toJSON() : null };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── CapabilityHealthCheck ──────────────────────
registry.register({
  name: 'CapabilityHealthCheck',
  toolset: 'system',
  category: 'capability',
  description: '异步执行能力健康检查。',
  schema: {
    type: 'object',
    properties: {
      slot: { type: 'string' },
      enabledOnly: { type: 'boolean', default: true },
    },
  },
  handler: async (params) => {
    const reg = getCapabilityRegistry();
    const results = await reg.runHealthChecks({ slot: params.slot, enabledOnly: params.enabledOnly });
    return { success: true, results };
  },
  isReadOnly: true,
  timeout: 10000,
});

// ── SetSecret ─────────────────────────────────
registry.register({
  name: 'SetSecret',
  toolset: 'system',
  category: 'secret',
  description: '安全地存储一个密钥。value 会被加密后写入数据目录 secrets/（随盘便携，v2 盘内主密钥）。',
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
      metadata: { type: 'object' },
      ttlMs: { type: 'number', description: '过期时间（毫秒）' },
    },
    required: ['key', 'value'],
  },
  handler: async (params) => {
    try {
      const store = getSecretStore();
      const r = store.set(params.key, params.value, { metadata: params.metadata, ttlMs: params.ttlMs });
      return { success: true, key: r.key, metadata: r.metadata, expiresAt: r.expiresAt };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── GetSecret ────────────────────────────────
registry.register({
  name: 'GetSecret',
  toolset: 'system',
  category: 'secret',
  description: '读取密钥明文。',
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string' },
    },
    required: ['key'],
  },
  handler: async (params) => {
    const value = getSecretStore().get(params.key);
    if (value === null) return { success: false, error: 'Secret not found or expired' };
    return { success: true, key: params.key, value };
  },
  isReadOnly: true,
  timeout: 3000,
});

// ── DeleteSecret ───────────────────────────
registry.register({
  name: 'DeleteSecret',
  toolset: 'system',
  category: 'secret',
  description: '删除密钥。',
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string' },
    },
    required: ['key'],
  },
  handler: async (params) => {
    const ok = getSecretStore().delete(params.key);
    return { success: ok, key: params.key };
  },
  isReadOnly: false,
  timeout: 3000,
});

// ── ListSecrets ──────────────────────────
registry.register({
  name: 'ListSecrets',
  toolset: 'system',
  category: 'secret',
  description: '列出所有密钥（仅元数据，不含明文）。',
  schema: { type: 'object', properties: {} },
  handler: async () => {
    const list = getSecretStore().list();
    return { success: true, count: list.length, secrets: list };
  },
  isReadOnly: true,
  timeout: 3000,
});

console.log('🔐 capability + secret-store 工具已注册 (10 个工具)');

module.exports = {
  RegisterCapability: 'RegisterCapability',
  EnableCapability: 'EnableCapability',
  DisableCapability: 'DisableCapability',
  SetActiveCapability: 'SetActiveCapability',
  ListCapabilities: 'ListCapabilities',
  GetActiveCapability: 'GetActiveCapability',
  CapabilityHealthCheck: 'CapabilityHealthCheck',
  SetSecret: 'SetSecret',
  GetSecret: 'GetSecret',
  DeleteSecret: 'DeleteSecret',
  ListSecrets: 'ListSecrets',
};
