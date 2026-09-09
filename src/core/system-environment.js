'use strict';

/**
 * system-environment.js — 本机环境扫描器
 *
 * 设计参考 4.3 systemEnvironment:
 * - 扫描本机环境（OS / 硬件 / 工具 / 网络 / 路径）
 * - 缓存到磁盘，避免重复扫描
 * - 提供 formatForPrompt() 生成可注入 system prompt 的紧凑文本
 * - 提供 detectSpecific() 按需探测
 *
 * 与 awakening.environment 区别:
 * - awakening 只在启动时跑一次，作为"问候语"上下文
 * - systemEnvironment 是持久的"环境知识"，每次 LLM 调用都可以引用
 * - 缓存更激进（带 hash 校验，文件改动才重新扫描）
 */

const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDataDir } = require('./config');

// ---------------------------------------------------------------------------
// 默认探测配置
// ---------------------------------------------------------------------------

const DEFAULT_PROBES = [
 // 工具类
 { name: 'git', bin: 'git.exe', args: ['--version'], category: 'tools', critical: false },
 { name: 'node', bin: 'node.exe', args: ['--version'], category: 'runtimes', critical: true },
 { name: 'npm', bin: 'npm.cmd', args: ['--version'], category: 'runtimes', critical: true },
 { name: 'python', bin: 'python.exe', args: ['--version'], category: 'runtimes', critical: false },
 { name: 'py', bin: 'py.exe', args: ['--version'], category: 'runtimes', critical: false },
 { name: 'pwsh', bin: 'pwsh.exe', args: ['--version'], category: 'tools', critical: false },
 { name: 'dotnet', bin: 'dotnet.exe', args: ['--version'], category: 'runtimes', critical: false },
 { name: 'code', bin: 'code.cmd', args: ['--version'], category: 'editors', critical: false },
 { name: 'docker', bin: 'docker.exe', args: ['--version'], category: 'tools', critical: false },
 { name: 'winget', bin: 'winget.exe', args: ['--version'], category: 'package_managers', critical: false },
 { name: 'choco', bin: 'choco.exe', args: ['--version'], category: 'package_managers', critical: false },
 { name: 'scoop', bin: 'scoop.exe', args: ['--version'], category: 'package_managers', critical: false },
];

const PROBE_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function _execFileSafe(bin, args, timeoutMs = PROBE_TIMEOUT_MS) {
 return new Promise((resolve) => {
 let stdout = '';
 // eslint-disable-next-line no-unused-vars
 let stderr = '';
 let proc;
 try {
 // eslint-disable-next-line no-unused-vars
 proc = execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdoutBuf, stderrBuf) => {
 stdout = (stdoutBuf || '').toString();
 stderr = (stderrBuf || '').toString();
 if (err) return resolve({ ok: false, version: null, error: err.message.split('\n')[0] });
 const firstLine = stdout.trim().split('\n')[0] || '';
 resolve({ ok: true, version: firstLine });
 });
 } catch (e) {
 resolve({ ok: false, version: null, error: e.message });
 }
 });
}

function _formatSize(bytes) {
 if (bytes < 1024) return bytes + 'B';
 if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
 if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
 return (bytes / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

function _hashEnvironment(env) {
 // 用易变字段生成 hash，用于缓存失效
 const fingerprint = JSON.stringify({
 os: env.os,
 cpus: env.cpus,
 totalMem: env.totalMem,
 hostname: env.hostname,
 user: env.user,
 });
 return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// 扫描器
// ---------------------------------------------------------------------------

class SystemEnvironment {
 constructor(options = {}) {
 this._cacheFile = options.cacheFile || path.join(getDataDir(), 'system-environment.json');
 this._cacheTtlMs = options.cacheTtlMs || 60 * 60 * 1000; // 1h
 this._probes = options.probes || DEFAULT_PROBES;
 this._env = null;
 }

 /**
 * 获取环境信息（命中缓存则直接返回）
 */
 async get(force = false) {
 if (this._env && !force) return this._env;
 if (!force) {
 const cached = this._loadCache();
 if (cached) {
 this._env = cached;
 return this._env;
 }
 }
 return this.scan();
 }

 /**
 * 主动扫描
 */
 async scan() {
 const start = Date.now();
 const env = {
 timestamp: Date.now(),
 os: {
 platform: process.platform,
 release: os.release(),
 version: os.version?.() || '',
 arch: process.arch,
 type: os.type(),
 hostname: os.hostname(),
 },
 cpus: os.cpus().length,
 cpuModel: (os.cpus()[0]?.model || '').trim(),
 totalMem: os.totalmem(),
 freeMem: os.freemem(),
 totalMemGB: +(os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
 freeMemGB: +(os.freemem() / 1024 / 1024 / 1024).toFixed(2),
 nodeVersion: process.version,
 nodePath: process.execPath,
 user: os.userInfo().username,
 home: os.homedir(),
 tmpdir: os.tmpdir(),
 cwd: process.cwd(),
 uptime: os.uptime(),
 envVars: this._safeEnvVars(),
 tools: {},
 packageManagers: {},
 runtimes: {},
 editors: {},
 paths: this._getImportantPaths(),
 scanDurationMs: 0,
 };

 // 探测工具
 await Promise.all(this._probes.map(async (p) => {
 const result = await _execFileSafe(p.bin, p.args);
 const target = env[p.category] || (env[p.category] = {});
 if (result.ok) {
 target[p.name] = { version: result.version, available: true };
 } else {
 target[p.name] = { available: false, error: result.error };
 }
 }));

 // 别名：tools 字典（兼容旧代码）
 for (const cat of ['tools', 'runtimes', 'editors', 'package_managers']) {
 for (const [name, info] of Object.entries(env[cat] || {})) {
 if (info.available && !env.tools[name]) {
 env.tools[name] = info.version;
 }
 }
 }

 env.scanDurationMs = Date.now() - start;
 env.fingerprint = _hashEnvironment(env);
 this._env = env;
 this._saveCache(env);
 return env;
 }

 _safeEnvVars() {
 // 只采集安全的环境变量子集
 const keys = ['LANG', 'LC_ALL', 'TZ', 'SHELL', 'TERM', 'PATH', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'USERPROFILE', 'SYSTEMROOT', 'PROGRAMFILES', 'PROGRAMFILES(X86)'];
 const out = {};
 for (const k of keys) {
 if (process.env[k] !== undefined) out[k] = process.env[k];
 }
 return out;
 }

 _getImportantPaths() {
 const home = os.homedir();
 return {
 home,
 documents: path.join(home, 'Documents'),
 downloads: path.join(home, 'Downloads'),
 desktop: path.join(home, 'Desktop'),
 appData: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
 localAppData: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
 programFiles: process.env['PROGRAMFILES'] || 'C:\\Program Files',
 programFilesX86: process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
 temp: os.tmpdir(),
 };
 }

 // ── 缓存 ─────────────────────────────────────────
 _loadCache() {
 try {
 if (!fs.existsSync(this._cacheFile)) return null;
 const raw = fs.readFileSync(this._cacheFile, 'utf-8');
 const data = JSON.parse(raw);
 if (Date.now() - data.timestamp > this._cacheTtlMs) return null;
 return data;
 } catch (e) { return null; }
 }

 _saveCache(env) {
 try {
 fs.mkdirSync(path.dirname(this._cacheFile), { recursive: true });
 fs.writeFileSync(this._cacheFile, JSON.stringify(env, null, 2));
 } catch (e) {
 console.warn('[system-environment] 保存缓存失败:', e.message);
 }
 }

 /**
 * 探测单个工具
 * @returns {Promise<{available: boolean, version?: string, error?: string}>}
 */
 async detectSpecific(bin, args = ['--version']) {
 const result = await _execFileSafe(bin, args);
 return result.ok
 ? { available: true, version: result.version }
 : { available: false, error: result.error };
 }

 /**
 * 格式化为可注入 system prompt 的紧凑文本
 * @param {object} [options]
 * @param {number} [options.maxLength=600] 最大字符数
 * @returns {Promise<string>}
 */
 async formatForPrompt(options = {}) {
 const maxLength = options.maxLength || 600;
 const env = await this.get();
 const lines = [];

 lines.push(`<system_environment>`);
 lines.push(`OS: ${env.os.platform} ${env.os.release} (${env.os.arch})`);
 lines.push(`Host: ${env.os.hostname} | User: ${env.user}`);
 lines.push(`CPU: ${env.cpus} × ${env.cpuModel || 'unknown'}`);
 lines.push(`Memory: ${env.freeMemGB}GB free / ${env.totalMemGB}GB total`);
 lines.push(`Node: ${env.nodeVersion}`);

 // 关键工具
 const toolSummary = [];
 for (const [name, info] of Object.entries(env.tools || {})) {
 if (info && info.available) {
 const v = info.version ? info.version.split(' ').slice(-1)[0] : '';
 toolSummary.push(`${name}${v ? '@' + v : ''}`);
 }
 }
 if (toolSummary.length > 0) {
 lines.push(`Tools: ${toolSummary.join(', ')}`);
 }

 // 包管理器
 const pmSummary = [];
 for (const [name, info] of Object.entries(env.packageManagers || {})) {
 if (info && info.available) pmSummary.push(name);
 }
 if (pmSummary.length > 0) {
 lines.push(`Package managers: ${pmSummary.join(', ')}`);
 }

 // 关键路径
 lines.push(`CWD: ${env.cwd}`);
 lines.push(`Home: ${env.paths.home}`);

 lines.push(`</system_environment>`);

 let text = lines.join('\n');
 if (text.length > maxLength) {
 text = text.slice(0, maxLength - 30) + '\n... (truncated)\n</system_environment>';
 }
 return text;
 }

 /**
 * 失效缓存
 */
 invalidate() {
 try {
 if (fs.existsSync(this._cacheFile)) fs.unlinkSync(this._cacheFile);
 } catch (e) {
   /* ignore */
   console.warn('[system-environment.js] 空 catch 补日志:', e && e.message);
 }
 this._env = null;
 }
}

// ---------------------------------------------------------------------------
// 单例
// ---------------------------------------------------------------------------

let _instance = null;
function getSystemEnvironment() {
 if (!_instance) _instance = new SystemEnvironment();
 return _instance;
}

module.exports = {
 SystemEnvironment,
 getSystemEnvironment,
 DEFAULT_PROBES,
};
