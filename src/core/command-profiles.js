'use strict';

/**
 * command-profiles.js — 命令配置文件
 *
 * 设计参考 10.3 command-profiles:
 * - 不同场景的"白名单/黑名单"命令集
 * - 内置几组默认 profile
 * - 注册自定义 profile
 *
 * 用途:
 * const profile = resolveProfile('fs-readonly');
 * if (!profile.check('rm -rf /').allowed) { ... }
 */




// ---------------------------------------------------------------------------
// 内置 profiles
// ---------------------------------------------------------------------------

const BUILTIN_PROFILES = {
 // 默认：完全无限制
 default: {
 id: 'default',
 name: '默认（无限制）',
 description: '所有命令都允许',
 allow: ['*'],
 deny: [],
 },

 // 只读：只允许查看类命令
 readonly: {
 id: 'readonly',
 name: '只读模式',
 description: '仅允许查看、搜索类命令，禁止写操作',
 allow: [
 'ls', 'dir', 'cat', 'type', 'head', 'tail', 'more', 'less',
 'pwd', 'echo', 'find', 'grep', 'rg', 'wc', 'tree', 'stat',
 'which', 'where', 'whoami', 'hostname', 'uname', 'date',
 'git status', 'git log', 'git diff', 'git show', 'git branch',
 'git remote', 'git rev-parse', 'npm list', 'npm ls',
 'node --version', 'npm --version',
 ],
 deny: [
 'rm', 'del', 'rmdir', 'rd', // 删除
 'mv', 'move', 'cp', 'copy', 'xcopy', // 改文件
 '>', '>>', 'tee', // 重定向写入
 'curl', 'wget', // 网络
 'chmod', 'chown', 'icacls', // 改权限
 'mkfs', 'format', // 格式化
 'shutdown', 'reboot', 'restart', // 系统
 ':(){:|:&};:', // fork bomb
 ],
 // 危险关键字（任何命令中出现即拒绝）
 dangerKeywords: [
 'rm -rf /', 'rm -rf /*', 'format c:',
 'del /f /s /q', 'rmdir /s /q',
 ],
 },

 // 文件系统只读：扩展 readonly 加上更多只读工具
 'fs-readonly': {
 id: 'fs-readonly',
 name: '文件系统只读',
 description: 'readonly + 文件信息查询',
 allow: '*', // allow 所有命令
 deny: [ // 但禁止写操作
 'rm', 'rmdir', 'del', 'rd',
 'mv', 'move', 'cp', 'copy', 'xcopy', 'robocopy',
 '>', '>>', 'tee',
 'chmod', 'chown', 'icacls', 'attrib',
 'mkfs', 'format', 'diskpart',
 'shutdown', 'reboot', 'restart', 'logoff',
 ],
 dangerKeywords: [
 'rm -rf /', 'rm -rf /*', 'format c:',
 'del /f /s /q', 'rmdir /s /q',
 ],
 },

 // 网络：禁用网络相关命令
 'no-network': {
 id: 'no-network',
 name: '无网络模式',
 description: '禁止所有外发网络命令（curl/wget/ssh 等）',
 allow: '*',
 deny: [
 'curl', 'wget', 'ssh', 'scp', 'rsync', 'ftp', 'sftp',
 'telnet', 'nc', 'ncat', 'netcat', 'nslookup', 'dig',
 'ping', 'tracert', 'traceroute',
 ],
 },

 // 开发：允许 npm/yarn/git/node
 dev: {
 id: 'dev',
 name: '开发模式',
 description: '允许常见开发工具命令（npm/yarn/git/node）',
 allow: '*',
 deny: [
 'rm -rf /', 'format c:',
 'shutdown', 'reboot', 'restart',
 ],
 },
};

// ---------------------------------------------------------------------------
// CommandProfile class
// ---------------------------------------------------------------------------

class CommandProfile {
 constructor(config) {
 this.id = config.id;
 this.name = config.name || config.id;
 this.description = config.description || '';
 this.allow = Array.isArray(config.allow) ? config.allow : (config.allow === '*' ? ['*'] : []);
 this.deny = Array.isArray(config.deny) ? config.deny : [];
 this.dangerKeywords = Array.isArray(config.dangerKeywords) ? config.dangerKeywords : [];
 }

 /**
 * 校验命令
 * @param {string} command
 * @returns {{ allowed: boolean, reason?: string }}
 */
 check(command) {
 if (typeof command !== 'string') return { allowed: false, reason: 'invalid command' };
 const cmd = command.trim();
 if (!cmd) return { allowed: false, reason: 'empty command' };

 // 1. 危险关键字（最高优先级）
 const lower = cmd.toLowerCase();
 for (const kw of this.dangerKeywords) {
 if (lower.includes(kw.toLowerCase())) {
 return { allowed: false, reason: `dangerous keyword: ${kw}` };
 }
 }

 // 2. deny 列表：任何 deny 命令以命令开头就拒绝
 const firstToken = cmd.split(/\s+/)[0].toLowerCase();
 for (const d of this.deny) {
 if (firstToken === d.toLowerCase()) {
 return { allowed: false, reason: `command denied: ${d}` };
 }
 // 也支持 deny 整行匹配
 if (lower === d.toLowerCase()) {
 return { allowed: false, reason: `command denied: ${d}` };
 }
 }

 // 3. allow 列表
 if (this.allow.includes('*')) return { allowed: true };

 for (const a of this.allow) {
 const aLower = a.toLowerCase();
 // 完全相等
 if (lower === aLower) return { allowed: true };
 // 开头匹配（允许带参数）
 if (lower.startsWith(aLower + ' ') || lower.startsWith(aLower + '\t')) {
 return { allowed: true };
 }
 }

 return { allowed: false, reason: `not in allow list of profile "${this.id}"` };
 }
}

// ---------------------------------------------------------------------------
// 解析与注册
// ---------------------------------------------------------------------------

function resolveProfile(id) {
 if (typeof id === 'object' && id !== null) return id;
 const config = BUILTIN_PROFILES[id || 'default'];
 if (!config) {
 console.warn(`[command-profiles] unknown profile "${id}", falling back to default`);
 return new CommandProfile(BUILTIN_PROFILES.default);
 }
 return new CommandProfile(config);
}

function registerProfile(config) {
 if (!config || !config.id) {
 throw new Error('registerProfile: profile.id is required');
 }
 BUILTIN_PROFILES[config.id] = config;
}

function listProfiles() {
 return Object.values(BUILTIN_PROFILES).map(p => ({
 id: p.id,
 name: p.name,
 description: p.description,
 allowCount: Array.isArray(p.allow) ? p.allow.length : (p.allow === '*' ? -1 : 0),
 denyCount: p.deny.length,
 }));
}

module.exports = {
 CommandProfile,
 resolveProfile,
 registerProfile,
 listProfiles,
 BUILTIN_PROFILES,
};
