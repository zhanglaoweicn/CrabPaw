'use strict';

/**
 * persistent-shell.js — 持久化 Shell
 *
 * 设计参考 10.3 持久化 Shell 思路:
 * - 在多次调用之间维持 shell 状态（cwd、环境变量、历史命令）
 * - 用 PTY 风格的子进程承载长生命周期 shell
 * - 提供状态查询 / 状态切换
 * - 简化版：基于 child_process.spawn + 状态缓存，不强制 PTY
 * - 可与 command-profiles 配合，限制允许的命令
 *
 * 公开 API:
 * - getPersistentShell({ profile }) → shell 单例
 * - shell.exec(command) → 执行命令，返回 { stdout, stderr, exitCode }
 * - shell.getState() → { cwd, env, history }
 * - shell.reset() → 重置状态
 * - shell.close() → 关闭底层进程
 */

const { spawn } = require('child_process');
const path = require('path');

const { EventEmitter } = require('events');
const { resolveProfile } = require('./command-profiles');

// ---------------------------------------------------------------------------
// PersistentShell
// ---------------------------------------------------------------------------

class PersistentShell extends EventEmitter {
 /**
 * @param {object} options
 * @param {string} [options.cwd] 初始 cwd
 * @param {object} [options.env] 初始 env
 * @param {object} [options.profile] CommandProfile
 * @param {number} [options.timeout=30000] 单命令超时
 * @param {number} [options.historyLimit=100] 历史保留条数
 */
 constructor(options = {}) {
 super();
 this._cwd = options.cwd || process.cwd();
 this._env = { ...process.env, ...(options.env || {}) };
 this._profile = options.profile || null;
 this._timeout = options.timeout || 30000;
 this._historyLimit = options.historyLimit || 100;
 this._history = []; // [{ command, exitCode, ts, durationMs }]
 this._activeProc = null;
 this._closed = false;
 }

 /**
 * 执行命令
 * @param {string} command
 * @returns {Promise<{stdout, stderr, exitCode, durationMs, blocked?}>}
 */
 exec(command) {
 if (this._closed) {
 return Promise.resolve({ stdout: '', stderr: 'shell closed', exitCode: -1 });
 }
 if (typeof command !== 'string' || !command.trim()) {
 return Promise.resolve({ stdout: '', stderr: 'empty command', exitCode: -1 });
 }
 const trimmed = command.trim();

 // profile 校验
 if (this._profile) {
 const verdict = this._profile.check(trimmed);
 if (!verdict.allowed) {
 this._pushHistory({ command: trimmed, exitCode: -1, ts: Date.now(), blocked: true, reason: verdict.reason });
 return Promise.resolve({
 stdout: '',
 stderr: `blocked by profile "${this._profile.id}": ${verdict.reason}`,
 exitCode: 126,
 blocked: true,
 });
 }
 }

 const startTs = Date.now();
 return new Promise((resolve) => {
 // Windows 用 cmd.exe，Unix 用 sh
 const isWin = process.platform === 'win32';
 const shellBin = isWin ? 'cmd.exe' : 'sh';
 const shellArgs = isWin ? ['/d', '/s', '/c', trimmed] : ['-c', trimmed];

 let proc;
 try {
 proc = spawn(shellBin, shellArgs, {
 cwd: this._cwd,
 env: this._env,
 windowsHide: true,
 });
 } catch (e) {
 return resolve({ stdout: '', stderr: e.message, exitCode: -1 });
 }
 this._activeProc = proc;

 let stdout = '';
 let stderr = '';
 let killed = false;

 const timer = setTimeout(() => {
 killed = true;
 try { proc.kill('SIGKILL'); } catch (e) {
   /* ignore */
   console.warn('[persistent-shell.js] 空 catch 补日志:', e && e.message);
 }
 }, this._timeout);

 proc.stdout.on('data', (d) => { stdout += d.toString(); });
 proc.stderr.on('data', (d) => { stderr += d.toString(); });
 proc.on('error', (err) => { stderr += err.message; });
 proc.on('close', (code) => {
 clearTimeout(timer);
 this._activeProc = null;
 const duration = Date.now() - startTs;
 // 更新 cwd（如果上一条是 cd）
 this._maybeUpdateCwd(trimmed);
 this._pushHistory({ command: trimmed, exitCode: code, ts: startTs, durationMs: duration, killed });
 resolve({ stdout, stderr, exitCode: code, durationMs: duration, killed });
 });
 });
 }

 /**
 * 简单状态查询
 */
 getState() {
 return {
 cwd: this._cwd,
 envKeys: Object.keys(this._env).length,
 historyCount: this._history.length,
 lastExitCode: this._history.length > 0 ? this._history[this._history.length - 1].exitCode : null,
 active: !!this._activeProc,
 closed: this._closed,
 profileId: this._profile ? this._profile.id : null,
 };
 }

 getHistory(limit = 20) {
 return this._history.slice(-limit);
 }

 reset() {
 this._cwd = process.cwd();
 this._env = { ...process.env };
 this._history = [];
 this.emit('reset');
 }

 close() {
 if (this._closed) return;
 this._closed = true;
 if (this._activeProc) {
 try { this._activeProc.kill('SIGKILL'); } catch (e) {
   /* ignore */
   console.warn('[persistent-shell.js] 空 catch 补日志:', e && e.message);
 }
 }
 this.emit('close');
 }

 _pushHistory(entry) {
 this._history.push(entry);
 if (this._history.length > this._historyLimit) {
 this._history.shift();
 }
 }

 /**
 * 解析 cd / chdir 维护当前目录
 */
 _maybeUpdateCwd(command) {
 const m = command.match(/^\s*(?:cd|chdir)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
 if (!m) return;
 const target = m[1] || m[2] || m[3];
 if (!target) return;
 const newCwd = path.isAbsolute(target) ? target : path.resolve(this._cwd, target);
 try {
 const fs = require('fs');
 if (fs.existsSync(newCwd) && fs.statSync(newCwd).isDirectory()) {
 this._cwd = newCwd;
 this.emit('cwd', newCwd);
 }
 } catch { /* ignore */ }
 }
}

// ---------------------------------------------------------------------------
// Singleton 管理（按 profile 缓存）
// ---------------------------------------------------------------------------

const _shells = new Map(); // key → PersistentShell

function _keyOf(opts) {
 return `${opts.sessionId || 'default'}:${opts.profile?.id || 'default'}:${opts.cwd || process.cwd()}`;
}

function getPersistentShell(options = {}) {
 const profile = options.profile || resolveProfile(options.profileId || 'default');
 const key = _keyOf({ ...options, profile });
 if (_shells.has(key)) {
 const existing = _shells.get(key);
 if (!existing._closed) return existing;
 }
 const shell = new PersistentShell({ ...options, profile });
 _shells.set(key, shell);
 return shell;
}

function closeAllShells() {
 for (const shell of _shells.values()) {
 shell.close();
 }
 _shells.clear();
}

module.exports = {
 PersistentShell,
 getPersistentShell,
 closeAllShells,
};
