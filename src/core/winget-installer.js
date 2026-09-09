'use strict';

/**
 * winget-installer.js — winget 安装执行器
 *
 * 设计参考 10.5 install_software:
 * - 通过 winget 安装/卸载/搜索 Windows 软件
 * - 后台 job 模式，stream stdout/stderr
 * - 解析 winget 输出估计进度
 * - 静默安装（--silent --accept-package-agreements --accept-source-agreements）
 *
 * 支持的 manager:
 * - winget (Windows 默认)
 * - choco (Chocolatey，可选)
 * - scoop (Scoop，可选)
 *
 * 失败兜底: winget 不可用时给出明确错误
 */

const { spawn } = require('child_process');

const os = require('os');

// ---------------------------------------------------------------------------
// Manager 探测
// ---------------------------------------------------------------------------

const MANAGER_BIN = {
 winget: 'winget.exe',
 choco: 'choco.exe',
 scoop: 'scoop.exe',
};

const MANAGER_CHECK = {
 winget: ['--version'],
 choco: ['--version'],
 scoop: ['--version'],
};

/**
 * 检查 manager 是否可用
 * @returns {Promise<{available: boolean, version?: string}>}
 */
async function checkManager(manager) {
 const bin = MANAGER_BIN[manager];
 const args = MANAGER_CHECK[manager] || ['--version'];
 if (!bin) return { available: false, error: `未知 manager: ${manager}` };

 return new Promise((resolve) => {
 let stdout = '';
 let stderr = '';
 const proc = spawn(bin, args, {
 shell: false,
 windowsHide: true,
 timeout: 10000,
 });
 proc.stdout.on('data', (d) => { stdout += d.toString(); });
 proc.stderr.on('data', (d) => { stderr += d.toString(); });
 proc.on('error', (e) => resolve({ available: false, error: e.message }));
 proc.on('close', (code) => {
 if (code === 0) {
 const version = (stdout.trim().split('\n')[0] || '').trim();
 resolve({ available: true, version });
 } else {
 resolve({ available: false, error: stderr.trim() || `exit code ${code}` });
 }
 });
 });
}

/**
 * 探测所有 manager 状态
 */
async function detectManagers() {
 const results = {};
 for (const m of Object.keys(MANAGER_BIN)) {
 results[m] = await checkManager(m);
 }
 return results;
}

// ---------------------------------------------------------------------------
// winget search
// ---------------------------------------------------------------------------

/**
 * 搜索软件
 * @param {string} query
 * @param {object} [options]
 * @param {string} [options.manager='winget']
 * @param {number} [options.limit=10]
 * @returns {Promise<Array<{id, name, version, source}>>}
 */
async function searchPackages(query, options = {}) {
 const manager = options.manager || 'winget';
 if (manager !== 'winget') {
 throw new Error(`search 仅支持 winget (当前: ${manager})`);
 }
 const args = ['search', query, '--accept-source-agreements', '--output', 'json'];
 return new Promise((resolve, reject) => {
 let stdout = '';
 let stderr = '';
 const proc = spawn('winget.exe', args, {
 shell: false,
 windowsHide: true,
 timeout: 30000,
 });
 proc.stdout.on('data', (d) => { stdout += d.toString(); });
 proc.stderr.on('data', (d) => { stderr += d.toString(); });
 proc.on('error', (e) => reject(new Error(`winget 启动失败: ${e.message}`)));
 proc.on('close', (code) => {
 if (code !== 0 && !stdout.trim()) {
 return reject(new Error(`winget 退出码 ${code}: ${stderr.trim() || '无输出'}`));
 }
 try {
 const json = JSON.parse(stdout);
 const arr = Array.isArray(json) ? json : (json.Resources || json.Packages || []);
 const limit = options.limit || 10;
 const results = arr.slice(0, limit).map(p => ({
 id: p.Id || p.PackageIdentifier || p.id,
 name: p.Name || p.PackageName || p.name,
 version: p.Version || p.PackageVersion || p.version || '',
 source: p.Source || '',
 publisher: p.Publisher || '',
 })).filter(p => p.id);
 resolve(results);
 } catch (e) {
 // 部分 winget 版本不支持 --output json，回退文本解析
 const lines = stdout.split('\n');
 const results = [];
 for (const line of lines) {
 const m = line.match(/^(\S+)\s+(\S+)\s+(.+?)\s+(\S+)$/);
 if (m && m[1] !== 'Name' && !m[1].startsWith('-')) {
 results.push({ id: m[1], version: m[2], name: m[3].trim(), source: m[4] });
 }
 }
 resolve(results.slice(0, options.limit || 10));
 }
 });
 });
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

/**
 * 执行安装/卸载，带进度回调
 * @param {object} job
 * @param {(eventType: string, payload: object) => void} onEvent
 * @returns {Promise<{stdout, stderr, exitCode}>}
 */
function runInstall(job, onEvent) {
 return new Promise((resolve, reject) => {
 let args;
 if (job.manager === 'winget') {
 if (job.action === 'install') {
 args = [
 'install', '--id', job.packageId,
 '--silent',
 '--accept-package-agreements',
 '--accept-source-agreements',
 ];
 } else if (job.action === 'uninstall') {
 args = [
 'uninstall', '--id', job.packageId,
 '--silent',
 '--accept-source-agreements',
 ];
 } else {
 return reject(new Error(`不支持的 action: ${job.action}`));
 }
 } else if (job.manager === 'choco') {
 args = job.action === 'install'
 ? ['install', job.packageId, '-y', '--no-progress']
 : ['uninstall', job.packageId, '-y', '--no-progress'];
 } else if (job.manager === 'scoop') {
 args = job.action === 'install'
 ? ['install', job.packageId]
 : ['uninstall', job.packageId];
 } else {
 return reject(new Error(`不支持的 manager: ${job.manager}`));
 }

 const bin = MANAGER_BIN[job.manager];
 onEvent('message', { message: `开始执行: ${bin} ${args.join(' ')}` });
 onEvent('progress', { progress: 10, message: '正在下载包...' });

 let stdout = '';
 let stderr = '';
 let proc;
 try {
 proc = spawn(bin, args, {
 shell: false,
 windowsHide: true,
 cwd: os.homedir(),
 env: process.env,
 });
 } catch (e) {
 return reject(new Error(`启动 ${bin} 失败: ${e.message}`));
 }

 proc.stdout.on('data', (d) => {
 const s = d.toString();
 stdout += s;
 onEvent('log', { stream: 'stdout', data: s });
 _estimateProgress(s, onEvent);
 });

 proc.stderr.on('data', (d) => {
 const s = d.toString();
 stderr += s;
 onEvent('log', { stream: 'stderr', data: s });
 });

 proc.on('error', (e) => {
 reject(Object.assign(new Error(`${bin} 启动失败: ${e.message}`), { exitCode: 1 }));
 });

 proc.on('close', (code) => {
 if (code === 0) {
 onEvent('progress', { progress: 100, message: '执行成功' });
 resolve({ stdout, stderr, exitCode: code });
 } else {
 reject(Object.assign(
 new Error(`${bin} ${job.action} 失败，退出码 ${code}: ${(stderr || stdout).slice(-300)}`),
 { exitCode: code, stdout, stderr }
 ));
 }
 });

 // 保存 proc 引用以便取消
 job._proc = proc;
 });
}

/**
 * 根据 winget 输出文本估计进度
 */
function _estimateProgress(text, onEvent) {
 const t = text.toLowerCase();
 let p = null;
 let msg = null;

 if (/found\s+/.test(t) || t.includes('正在查找')) {
 p = 15; msg = '正在查找包...';
 } else if (/downloading|正在下载|progress:\s*\d+/i.test(t)) {
 const m = t.match(/(\d{1,3})\s*%/);
 if (m) p = Math.min(80, 20 + parseInt(m[1], 10) * 0.6);
 else p = 40;
 msg = '正在下载...';
 } else if (/installing|正在安装|verifying hash|verifying signature/i.test(t)) {
 p = 85; msg = '正在安装...';
 } else if (/successfully installed|installed successfully|已成功安装/i.test(t)) {
 p = 95; msg = '安装完成，等待最终确认...';
 } else if (/already installed|already present/i.test(t)) {
 p = 100; msg = '已安装';
 }

 if (p !== null) onEvent('progress', { progress: p, message: msg });
}

// ---------------------------------------------------------------------------
// 终止运行中的 job
// ---------------------------------------------------------------------------

function cancelJob(job) {
 if (job._proc && !job._proc.killed) {
 try {
 job._proc.kill('SIGTERM');
 return true;
 } catch (e) {
 console.error('[winget-installer] kill 失败:', e.message);
 }
 }
 return false;
}

module.exports = {
 checkManager,
 detectManagers,
 searchPackages,
 runInstall,
 cancelJob,
};
