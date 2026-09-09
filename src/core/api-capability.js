'use strict';

/**
 * api-capability.js — API 能力动态槽系统
 *
 * 设计参考 的 capability slot 系统：
 * - 注册表：集中管理所有"能力"（tools/skills/agents/commands）
 * - 槽位（slot）：可动态填充/清空的占位符
 * e.g. "tts" 槽位可被 edge / doubao / qwen / openai 任意填充
 * - 健康检查：能力变更时通知订阅者
 * - 依赖关系：能力可声明依赖其他能力
 *
 * 用途：
 * - 运行时切换 provider（TTS/STT/LLM）
 * - 灰度发布（新能力先注册为 disabled）
 * - 能力依赖检查（启 A 必须先启 B）
 * - 能力检索（按 tag 查找）
 *
 * 公开 API:
 * - getCapabilityRegistry() → 单例
 * - register(slot, impl, options) → 注册能力实现
 * - enable(slot, name) / disable(slot)
 * - getActive(slot) / list(slot)
 * - on('change', fn) / on('enabled', fn)
 */

const { EventEmitter } = require('events');

// ── CapabilityEntry ──────────────────────────────────
class CapabilityEntry {
 constructor(data) {
 this.slot = data.slot; // 槽位名（如 'tts'）
 this.name = data.name; // 实现名（如 'edge-tts'）
 this.implementation = data.implementation; // 实现对象/函数
 this.version = data.version || '1.0.0';
 this.metadata = data.metadata || {};
 this.tags = data.tags || [];
 this.dependencies = data.dependencies || [];
 this.enabled = data.enabled === true;
 this.priority = data.priority || 100; // 数值越小优先级越高
 this.healthCheck = data.healthCheck || null; // async () => { ok, detail }
 this.lastHealth = null;
 this.registeredAt = Date.now();
 }

 toJSON() {
 return {
 slot: this.slot,
 name: this.name,
 version: this.version,
 metadata: this.metadata,
 tags: this.tags,
 dependencies: this.dependencies,
 enabled: this.enabled,
 priority: this.priority,
 lastHealth: this.lastHealth,
 registeredAt: this.registeredAt,
 };
 }
}

// ── CapabilityRegistry ──────────────────────────────
class CapabilityRegistry extends EventEmitter {
 constructor() {
 super();
 this._entries = new Map(); // key = `${slot}:${name}` → CapabilityEntry
 this._slotMap = new Map(); // slot → [CapabilityEntry]
 this._activeMap = new Map(); // slot → active entry name
 this.setMaxListeners(100);
 }

 _key(slot, name) {
 return `${slot}:${name}`;
 }

 /**
 * 注册能力
 * @param {object} options
 * { slot, name, implementation, version?, metadata?, tags?, dependencies?, enabled?, priority?, healthCheck? }
 */
 register(options) {
 if (!options || !options.slot || !options.name) {
 throw new Error('Capability must have slot and name');
 }
 const key = this._key(options.slot, options.name);
 if (this._entries.has(key)) {
 throw new Error(`Capability already registered: ${key}`);
 }
 const entry = new CapabilityEntry(options);
 this._entries.set(key, entry);
 if (!this._slotMap.has(options.slot)) this._slotMap.set(options.slot, []);
 this._slotMap.get(options.slot).push(entry);

 // 如果是第一个 enabled，自动激活
 if (entry.enabled && !this._activeMap.has(entry.slot)) {
 this._activeMap.set(entry.slot, entry.name);
 }

 this.emit('registered', entry);
 this.emit('change', { type: 'registered', slot: entry.slot, name: entry.name });
 return entry;
 }

 /**
 * 注销
 */
 unregister(slot, name) {
 const key = this._key(slot, name);
 const entry = this._entries.get(key);
 if (!entry) return false;
 this._entries.delete(key);
 const list = this._slotMap.get(slot) || [];
 const idx = list.findIndex(e => e.name === name);
 if (idx >= 0) list.splice(idx, 1);
 if (this._activeMap.get(slot) === name) {
 this._activeMap.delete(slot);
 // 自动切换到下一个 enabled
 const next = list.find(e => e.enabled);
 if (next) this._activeMap.set(slot, next.name);
 }
 this.emit('unregistered', entry);
 this.emit('change', { type: 'unregistered', slot, name });
 return true;
 }

 /**
 * 启用
 */
 enable(slot, name) {
 const key = this._key(slot, name);
 const entry = this._entries.get(key);
 if (!entry) throw new Error(`Capability not found: ${key}`);
 // 检查依赖
 for (const dep of entry.dependencies) {
 if (!this._activeMap.has(dep) && !this._slotMap.get(dep)?.some(e => e.enabled && e.name)) {
 throw new Error(`Dependency not satisfied: ${dep}`);
 }
 }
 entry.enabled = true;
 // 如果当前 slot 没有 active，激活这个
 if (!this._activeMap.has(slot)) {
 this._activeMap.set(slot, name);
 }
 this.emit('enabled', entry);
 this.emit('change', { type: 'enabled', slot, name });
 return entry;
 }

 /**
 * 禁用
 */
 disable(slot, name) {
 const key = this._key(slot, name);
 const entry = this._entries.get(key);
 if (!entry) return false;
 entry.enabled = false;
 if (this._activeMap.get(slot) === name) {
 this._activeMap.delete(slot);
 // 自动切换到下一个 enabled (按 priority)
 const list = this._slotMap.get(slot) || [];
 const next = list.filter(e => e.enabled).sort((a, b) => a.priority - b.priority)[0];
 if (next) this._activeMap.set(slot, next.name);
 }
 this.emit('disabled', entry);
 this.emit('change', { type: 'disabled', slot, name });
 return true;
 }

 /**
 * 切换 active
 */
 setActive(slot, name) {
 const key = this._key(slot, name);
 const entry = this._entries.get(key);
 if (!entry) throw new Error(`Capability not found: ${key}`);
 if (!entry.enabled) throw new Error(`Capability not enabled: ${key}`);
 this._activeMap.set(slot, name);
 this.emit('active-changed', entry);
 this.emit('change', { type: 'active-changed', slot, name });
 return entry;
 }

 /**
 * 获取 active entry
 */
 getActive(slot) {
 const name = this._activeMap.get(slot);
 if (!name) return null;
 return this._entries.get(this._key(slot, name));
 }

 /**
 * 获取 active implementation
 */
 getActiveImpl(slot) {
 const entry = this.getActive(slot);
 return entry ? entry.implementation : null;
 }

 /**
 * 列出某 slot 所有 entries
 */
 list(slot) {
 const list = this._slotMap.get(slot) || [];
 return list.map(e => e.toJSON());
 }

 /**
 * 按 tag 查找
 */
 findByTag(tag) {
 const results = [];
 for (const e of this._entries.values()) {
 if (e.tags.includes(tag)) results.push(e.toJSON());
 }
 return results;
 }

 /**
 * 列出所有 slot
 */
 slots() {
 return Array.from(this._slotMap.keys());
 }

 /**
 * 全局统计
 */
 getStats() {
 const stats = {
 total: this._entries.size,
 bySlot: {},
 enabledTotal: 0,
 activeCount: 0,
 };
 for (const [slot, list] of this._slotMap) {
 stats.bySlot[slot] = {
 total: list.length,
 enabled: list.filter(e => e.enabled).length,
 active: this._activeMap.get(slot) || null,
 };
 stats.enabledTotal += stats.bySlot[slot].enabled;
 }
 stats.activeCount = this._activeMap.size;
 return stats;
 }

 /**
 * 健康检查
 */
 async runHealthChecks(filter = {}) {
 const results = [];
 for (const e of this._entries.values()) {
 if (filter.slot && e.slot !== filter.slot) continue;
 if (filter.enabledOnly && !e.enabled) continue;
 if (typeof e.healthCheck !== 'function') continue;
 try {
 const r = await e.healthCheck();
 e.lastHealth = { at: Date.now(), ok: r?.ok !== false, detail: r?.detail || '' };
 } catch (err) {
 e.lastHealth = { at: Date.now(), ok: false, detail: err.message };
 }
 results.push({ slot: e.slot, name: e.name, ...e.lastHealth });
 }
 return results;
 }
}

let _instance = null;
function getCapabilityRegistry() {
 if (!_instance) _instance = new CapabilityRegistry();
 return _instance;
}

module.exports = {
 CapabilityEntry,
 CapabilityRegistry,
 getCapabilityRegistry,
};
