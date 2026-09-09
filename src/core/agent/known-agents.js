/**
 * known-agents.js — 本机 Agent 发现与委托
 *
 * 设计参考 10.10:
 * 启动时扫描本地 CLI Agent (Claude Code / Codex / Gemini CLI / Aider 等)
 * 持久化到 known_agents 表，支持委托执行子任务。
 *
 * 与 CrabPaw SubAgent 系统的区别:
 * SubAgent = 内部 7 种 worker (planner/researcher/critic/...)
 * DelegateToAgent = 调用本机其他 CLI 工具
 */



const { spawn } = require('child_process');

// ── 已知 Agent 探测列表 ──
const AGENT_PROBES = [
 { id: 'claude-code', name: 'Claude Code', bin: 'claude', args: ['--version'], versionRe: /Claude Code.*?(\d+\.\d+\.\d+)/i },
 { id: 'codex', name: 'Codex', bin: 'codex', args: ['--version'], versionRe: /(\d+\.\d+\.\d+)/ },
 { id: 'gemini-cli', name: 'Gemini CLI', bin: 'gemini', args: ['--version'], versionRe: /(\d+\.\d+\.\d+)/ },
 { id: 'aider', name: 'Aider', bin: 'aider', args: ['--version'], versionRe: /(\d+\.\d+\.\d+)/ },
 { id: 'hermes', name: 'Hermes', bin: 'hermes', args: ['--version'], versionRe: /(\d+\.\d+\.\d+)/ },
 { id: 'openclaw', name: 'OpenClaw', bin: 'openclaw', args: ['--version'], versionRe: /(\d+\.\d+\.\d+)/ },
];

// ── 运行时缓存 ──
let _cachedAgents = null;
let _lastScan = 0;
const CACHE_TTL_MS = 60000; // 1 分钟缓存
let _delegationGrants = new Set(); // 已授权的 agent ID

function runDetect(bin, args, timeoutMs = 8000) {
 return new Promise((resolve) => {
 const child = spawn(bin, args, {
 windowsHide: true,
 stdio: ['ignore', 'pipe', 'pipe'],
 env: { ...process.env },
 });
 const stdout = [];
 const stderr = [];
 let timer = setTimeout(() => {
 try { child.kill(); } catch (e) { console.warn('[known-agents] kill child process failed:', e.message); }
 resolve(null);
 }, timeoutMs);
 child.stdout.on('data', (d) => stdout.push(d.toString()));
 child.stderr.on('data', (d) => stderr.push(d.toString()));
 child.on('close', (code) => {
 clearTimeout(timer);
 const out = stdout.join('').trim() || stderr.join('').trim();
 if (code === 0 && out) resolve(out);
 else resolve(null);
 });
 child.on('error', () => { clearTimeout(timer); resolve(null); });
 });
}

/**
 * 扫描本机已安装的 Agent CLI，返回 agent 列表
 */
async function scanKnownAgents({ forceRescan = false } = {}) {
 if (!forceRescan && _cachedAgents && Date.now() - _lastScan < CACHE_TTL_MS) {
 return _cachedAgents;
 }

 const results = [];
 for (const probe of AGENT_PROBES) {
 const out = await runDetect(probe.bin, probe.args);
 if (out) {
 const versionMatch = out.match(probe.versionRe);
 results.push({
 id: probe.id,
 name: probe.name,
 bin: probe.bin,
 version: versionMatch ? versionMatch[1] : 'unknown',
 detectedAt: Date.now(),
 available: true,
 });
 }
 }

 _cachedAgents = results;
 _lastScan = Date.now();
 return results;
}

/**
 * 列出可用的 Agent（只返回已检测到且可委托的）
 */
function listAvailableAgents() {
 const agents = _cachedAgents || [];
 return agents.filter(a => a.available);
}

/**
 * 委托任务给指定 Agent
 */
async function delegateToAgent(agentId, task, options = {}) {
 const agents = _cachedAgents || [];
 const agent = agents.find(a => a.id === agentId);
 if (!agent) {
 throw new Error(`Agent "${agentId}" 未找到或不可用`);
 }

 if (!_delegationGrants.has(agentId)) {
 throw new Error(`Agent "${agentId}" 未授权委托，请先调用 grantAgentDelegation`);
 }

 const timeoutMs = options.timeout || 120000;
 const cmd = agent.bin;
 const cmdArgs = [task];

 return new Promise((resolve, reject) => {
 const child = spawn(cmd, cmdArgs, {
 windowsHide: true,
 stdio: ['ignore', 'pipe', 'pipe'],
 env: { ...process.env },
 });
 const stdout = [];
 const stderr = [];
 let timer = setTimeout(() => {
 try { child.kill(); } catch (e) { console.warn('[known-agents] kill agent process failed:', e.message); }
 reject(new Error(`Agent ${agentId} 执行超时 (${timeoutMs}ms)`));
 }, timeoutMs);
 child.stdout.on('data', (d) => stdout.push(d.toString()));
 child.stderr.on('data', (d) => stderr.push(d.toString()));
 child.on('close', (code) => {
 clearTimeout(timer);
 resolve({
 agentId,
 exitCode: code,
 stdout: stdout.join('').trim(),
 stderr: stderr.join('').trim(),
 });
 });
 child.on('error', (err) => { clearTimeout(timer); reject(err); });
 });
}

/**
 * 授权委托给指定 Agent
 */
function grantAgentDelegation(agentId, grant = true) {
 if (grant) {
 _delegationGrants.add(agentId);
 } else {
 _delegationGrants.delete(agentId);
 }
 return { agentId, granted: grant };
}

/**
 * 列出已授权的 Agent
 */
function listGrantedAgents() {
 return [..._delegationGrants];
}

console.log('🤖 known-agents 模块已加载');

module.exports = {
 scanKnownAgents,
 listAvailableAgents,
 delegateToAgent,
 grantAgentDelegation,
 listGrantedAgents,
};
