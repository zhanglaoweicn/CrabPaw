'use strict';

/**
 * system-environment-tool.js — AI 可调用的本机环境工具
 *
 * 设计参考 4.3 systemEnvironment:
 * GetSystemEnvironment — 获取完整环境信息
 * GetEnvironmentSummary — 获取注入到 prompt 的紧凑文本
 * DetectTool — 探测单个工具是否可用
 * InvalidateEnvironment — 失效缓存，强制重新扫描
 */

const { registry } = require('./registry');
const { getSystemEnvironment } = require('../core/system-environment');

async function handleGetSystemEnvironment(params, _context) {
 const force = params.force === true;
 const env = await getSystemEnvironment().get(force);
 return {
 success: true,
 data: env,
 _hint: '本机环境已扫描完成。模型可基于此选择合适的工具（如有 winget 时优先用 InstallSoftware）。',
 };
}

async function handleGetEnvironmentSummary(params, _context) {
 const text = await getSystemEnvironment().formatForPrompt({
 maxLength: params.maxLength || 600,
 });
 return {
 success: true,
 text,
 length: text.length,
 _hint: '这是注入到 system prompt 的环境摘要。',
 };
}

async function handleDetectTool(params, _context) {
 const { bin, args } = params;
 if (!bin) return { success: false, error: 'bin 必填' };
 const result = await getSystemEnvironment().detectSpecific(bin, args || ['--version']);
 return {
 success: true,
 bin,
 ...result,
 };
}

// eslint-disable-next-line no-unused-vars
async function handleInvalidateEnvironment(_params, context) {
 getSystemEnvironment().invalidate();
 return { success: true, message: '环境缓存已失效' };
}

registry.register({
 name: 'GetSystemEnvironment',
 toolset: 'system',
 category: 'environment',
 description: '获取完整本机环境信息（OS/CPU/内存/工具/路径/环境变量）。force=true 忽略缓存。',
 schema: {
 type: 'object',
 properties: {
 force: { type: 'boolean', description: '强制重新扫描，忽略缓存' },
 },
 },
 handler: handleGetSystemEnvironment,
 isReadOnly: true,
 timeout: 15000,
});

registry.register({
 name: 'GetEnvironmentSummary',
 toolset: 'system',
 category: 'environment',
 description: '获取注入到 system prompt 的紧凑环境摘要（<system_environment>...</system_environment> 标签）。',
 schema: {
 type: 'object',
 properties: {
 maxLength: { type: 'number', description: '最大字符数（默认 600）' },
 },
 },
 handler: handleGetEnvironmentSummary,
 isReadOnly: true,
 timeout: 5000,
});

registry.register({
 name: 'DetectTool',
 toolset: 'system',
 category: 'environment',
 description: '探测单个命令行工具是否可用，返回 version 或 error。',
 schema: {
 type: 'object',
 properties: {
 bin: { type: 'string', description: '可执行文件名（如 node.exe）' },
 args: { type: 'array', items: { type: 'string' }, description: '参数（默认 ["--version"]）' },
 },
 required: ['bin'],
 },
 handler: handleDetectTool,
 isReadOnly: true,
 timeout: 5000,
});

registry.register({
 name: 'InvalidateEnvironment',
 toolset: 'system',
 category: 'environment',
 description: '失效环境缓存，下次 GetSystemEnvironment 将重新扫描。',
 schema: { type: 'object', properties: {} },
 handler: handleInvalidateEnvironment,
 timeout: 3000,
});

console.log('🖥️ system-environment 工具已注册 (4 个工具)');

module.exports = {
 handleGetSystemEnvironment,
 handleGetEnvironmentSummary,
 handleDetectTool,
 handleInvalidateEnvironment,
};
