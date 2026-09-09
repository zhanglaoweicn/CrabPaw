/**
 * agent-delegation-tools.js — 本地 Agent 委托工具集
 *
 * 设计参考 10.10:
 * - delegate_to_agent: 把子任务委托给本机已发现的其他 Agent
 * - grant_agent_delegation: 记录用户是否允许 CrabPaw 指挥其他本地 Agent
 * - list_known_agents: 列出本机已发现的所有 Agent
 *
 * 与 SpawnSubagent 区别:
 * SpawnSubagent: 调用 CrabPaw 内部的 7 种 sub-agent (planner/researcher/...)
 * DelegateToAgent: 调用本机其他 CLI 工具 (Claude Code / Codex / Gemini CLI / Aider)
 */

const { registry } = require('./registry');
const {
 // eslint-disable-next-line no-unused-vars -- scanKnownAgents 从 require 解构但未使用
 scanKnownAgents,
 listAvailableAgents,
 delegateToAgent,
 grantAgentDelegation,
 listGrantedAgents,
} = require('../core/agent/known-agents');

// ─── ListKnownAgents ───
registry.register({
 name: 'ListKnownAgents',
 toolset: 'agent',
 category: 'delegation',
 description: '列出本机已安装的其他 Agent CLI（Claude Code / Codex / Gemini / Hermes / Aider），返回每个 agent 的 ID、名称、版本和可用状态。',
 schema: {
 type: 'object',
 properties: {
 forceRescan: {
 type: 'boolean',
 description: '强制重新扫描（默认 false 用缓存）',
 default: false,
 },
 },
 },
 isReadOnly: true,
 isDangerous: false,
 timeout: 15000,
 handler: async (params) => {
 const agents = await listAvailableAgents({ force: !!params?.forceRescan });
 const granted = listGrantedAgents();
 return {
 success: true,
 count: agents.length,
 agents: agents.map(a => ({
 id: a.id,
 name: a.name,
 description: a.description,
 capabilities: a.capabilities,
 version: a.version,
 execPath: a.execPath,
 granted: granted.includes(a.id),
 })),
 message: agents.length > 0
 ? `本机共发现 ${agents.length} 个 Agent CLI。已授权: ${granted.join(', ') || '(none)'}`
 : '本机未发现任何 Agent CLI。请安装 Claude Code / Codex / Gemini CLI / Aider 等。',
 };
 },
});

// ─── GrantAgentDelegation ───
registry.register({
 name: 'GrantAgentDelegation',
 toolset: 'agent',
 category: 'delegation',
 description: '授权/取消授权 CrabPaw 指挥某个本地 Agent CLI。必须先调用此工具并获得用户明确同意，才能调用 DelegateToAgent。',
 schema: {
 type: 'object',
 properties: {
 agentId: {
 type: 'string',
 description: 'Agent ID，如 claude_code / codex / gemini / aider / hermes',
 },
 grant: {
 type: 'boolean',
 description: 'true=授权, false=取消授权',
 default: true,
 },
 },
 required: ['agentId'],
 },
 isReadOnly: false,
 isDangerous: false,
 timeout: 5000,
 handler: async (params) => {
 const { agentId, grant = true } = params;
 const result = grantAgentDelegation(agentId, grant);
 return {
 success: true,
 ...result,
 message: grant
 ? `已授权 CrabPaw 指挥 ${agentId}`
 : `已撤销对 ${agentId} 的授权`,
 };
 },
});

// ─── DelegateToAgent ───
registry.register({
 name: 'DelegateToAgent',
 toolset: 'agent',
 category: 'delegation',
 description: `把子任务委托给本机已授权的另一个 Agent CLI 执行。
典型场景:
 - "让 Claude Code 帮我重构这个文件"
 - "让 Codex 写一个 Python 脚本"
 - "让 Gemini 分析这个代码"

要求:
 1. 目标 agent 必须已通过 ListKnownAgents 扫描
 2. 必须先调用 GrantAgentDelegation 获得用户授权
 3. 工作目录可选，默认当前目录

返回: agent 的输出文本 + 耗时`,
 schema: {
 type: 'object',
 properties: {
 agentId: {
 type: 'string',
 description: '目标 agent ID',
 enum: ['claude_code', 'codex', 'gemini', 'hermes', 'aider'],
 },
 task: {
 type: 'string',
 minLength: 5,
 description: '任务描述（自然语言）',
 },
 workdir: {
 type: 'string',
 description: '工作目录（可选）',
 },
 },
 required: ['agentId', 'task'],
 },
 isReadOnly: false,
 isDangerous: true, // 委派给外部 agent 是危险操作
 timeout: 130000,
 handler: async (params, _context) => {
 const { agentId, task, workdir } = params;
 const result = await delegateToAgent({ agentId, task, workdir });
 if (!result.success) {
 return {
 success: false,
 error: result.error,
 hint: result.needGrant
 ? '请先调用 GrantAgentDelegation 工具获得用户授权'
 : '请先调用 ListKnownAgents 查看本机可用的 agent',
 };
 }
 return {
 success: true,
 data: {
 agentId: result.agentId,
 agentName: result.agentName,
 output: result.output,
 duration: result.duration,
 exitCode: result.exitCode,
 _hint: `${result.agentName} 已完成委托任务 (${(result.duration / 1000).toFixed(1)}s)。请将结果整合到回复中。`,
 },
 };
 },
});

module.exports = {};
