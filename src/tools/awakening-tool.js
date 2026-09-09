'use strict';

/**
 * awakening-tool.js — AI 可调用的觉醒阶段工具
 *
 * 设计参考 觉醒阶段:
 * GetAwakeningStatus — 查询当前觉醒状态
 * TriggerAwakening — 强制重新觉醒（不命中缓存）
 * InvalidateAwakening — 失效缓存
 *
 * 通常不需要 LLM 主动调用，初始化流程会自动跑。
 */

const { registry } = require('./registry');
const { getAwakening, AWAKENING_PHASES } = require('../core/awakening');

function _safeState() {
 try {
 return getAwakening().getState();
 } catch (e) {
 return { status: 'unavailable', error: e.message };
 }
}

// eslint-disable-next-line no-unused-vars
async function handleGetAwakeningStatus(_params, context) {
 const state = _safeState();
 return {
 success: true,
 data: state,
 _hint: state.status === AWAKENING_PHASES.DONE
 ? '系统已觉醒，所有子系统就绪。'
 : state.status === AWAKENING_PHASES.FAILED
 ? `觉醒失败: ${state.error}`
 : '觉醒尚未完成或未触发。',
 };
}

async function handleTriggerAwakening(params, _context) {
 const options = {
 force: params.force === true,
 skipSceneCard: params.skipSceneCard === true,
 timeoutMs: params.timeoutMs || 5000,
 };
 try {
 const aw = getAwakening();
 if (options.force) aw.invalidate();
 const state = await aw.run(options);
 return {
 success: state.status !== AWAKENING_PHASES.FAILED,
 data: state,
 };
 } catch (e) {
 return { success: false, error: e.message };
 }
}

// eslint-disable-next-line no-unused-vars
async function handleInvalidateAwakening(_params, context) {
 try {
 getAwakening().invalidate();
 return { success: true, message: '觉醒缓存已失效，下次 run() 将重新扫描' };
 } catch (e) {
 return { success: false, error: e.message };
 }
}

registry.register({
 name: 'GetAwakeningStatus',
 toolset: 'system',
 category: 'lifecycle',
 description: '查询当前觉醒状态。返回 status (idle/scan_env/load_user/preload_memory/greeting/done/failed), phases (各阶段耗时), environment (OS/工具探测结果), userName, memory (记忆预热统计)。',
 schema: { type: 'object', properties: {} },
 handler: handleGetAwakeningStatus,
 isReadOnly: true,
 timeout: 3000,
});

registry.register({
 name: 'TriggerAwakening',
 toolset: 'system',
 category: 'lifecycle',
 description: '触发一次觉醒。force=true 忽略缓存重新扫描。返回最新状态。',
 schema: {
 type: 'object',
 properties: {
 force: { type: 'boolean', description: '忽略缓存强制重新觉醒' },
 skipSceneCard: { type: 'boolean', description: '不推送 scene 卡片' },
 timeoutMs: { type: 'number', description: '超时毫秒 (默认 5000)' },
 },
 },
 handler: handleTriggerAwakening,
 isDangerous: false,
 timeout: 10000,
});

registry.register({
 name: 'InvalidateAwakening',
 toolset: 'system',
 category: 'lifecycle',
 description: '失效觉醒缓存。',
 schema: { type: 'object', properties: {} },
 handler: handleInvalidateAwakening,
 timeout: 3000,
});

console.log('🌅 awakening 工具已注册 (3 个工具)');

module.exports = {
 handleGetAwakeningStatus,
 handleTriggerAwakening,
 handleInvalidateAwakening,
};
