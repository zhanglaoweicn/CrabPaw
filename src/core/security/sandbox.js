const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { WORKSPACE_DIR, DATA_DIR } = require('../config');

// 跨平台敏感路径
const _platformBlockedPaths = process.platform === 'win32' ? [
  'C:\\Windows',
  'C:\\Windows\\System32',
  'C:\\Windows\\SysWOW64',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Credentials'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Credentials'),
  path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Vault'),
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.kube'),
] : [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.gnupg'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), '.kube'),
];

const SANDBOX_PROFILES = {
  restricted: {
    allowRead: true,
    allowWrite: false,
    allowExecute: false,
    allowNetwork: false,
    maxFileSize: 1024 * 1024,
    maxExecutionTime: 5000,
    allowedExtensions: ['.txt', '.md', '.json', '.yaml', '.yml', '.toml'],
    blockedPaths: _platformBlockedPaths,
  },
  standard: {
    allowRead: true,
    allowWrite: true,
    allowExecute: false,
    allowNetwork: false,
    maxFileSize: 10 * 1024 * 1024,
    maxExecutionTime: 30000,
    allowedExtensions: null,
    blockedPaths: process.platform === 'win32' ? [
      'C:\\Windows\\System32\\config',
      'C:\\Windows\\System32\\drivers\\etc',
      path.join(os.homedir(), '.ssh'),
      path.join(os.homedir(), '.aws', 'credentials'),
    ] : ['/etc/passwd', '/etc/shadow', '/etc/sudoers'],
  },
  elevated: {
    allowRead: true,
    allowWrite: true,
    allowExecute: true,
    allowNetwork: true,
    maxFileSize: 100 * 1024 * 1024,
    maxExecutionTime: 120000,
    allowedExtensions: null,
    blockedPaths: [],
  },
  full: {
    allowRead: true,
    allowWrite: true,
    allowExecute: true,
    allowNetwork: true,
    maxFileSize: Infinity,
    maxExecutionTime: Infinity,
    allowedExtensions: null,
    blockedPaths: [],
  },
};

class SandboxPolicy {
  constructor(profile = 'standard', overrides = {}) {
    const base = SANDBOX_PROFILES[profile] || SANDBOX_PROFILES.standard;
    this.allowRead = overrides.allowRead ?? base.allowRead;
    this.allowWrite = overrides.allowWrite ?? base.allowWrite;
    this.allowExecute = overrides.allowExecute ?? base.allowExecute;
    this.allowNetwork = overrides.allowNetwork ?? base.allowNetwork;
    this.maxFileSize = overrides.maxFileSize ?? base.maxFileSize;
    this.maxExecutionTime = overrides.maxExecutionTime ?? base.maxExecutionTime;
    this.allowedExtensions = overrides.allowedExtensions ?? base.allowedExtensions;
    this.blockedPaths = [...(overrides.blockedPaths || base.blockedPaths)];
    this.workspaceRoot = overrides.workspaceRoot || WORKSPACE_DIR;
    this.dataDir = overrides.dataDir || DATA_DIR;
  }

  validateRead(filePath) {
    if (!this.allowRead) return { allowed: false, reason: 'Read access denied' };

    const resolved = path.resolve(filePath);

    for (const blocked of this.blockedPaths) {
      if (resolved.startsWith(blocked)) {
        return { allowed: false, reason: `Path is blocked: ${blocked}` };
      }
    }

    if (this.allowedExtensions) {
      const ext = path.extname(resolved).toLowerCase();
      if (!this.allowedExtensions.includes(ext)) {
        return { allowed: false, reason: `Extension not allowed: ${ext}` };
      }
    }

    return { allowed: true };
  }

  validateWrite(filePath, contentSize = 0) {
    if (!this.allowWrite) return { allowed: false, reason: 'Write access denied' };

    const resolved = path.resolve(filePath);

    for (const blocked of this.blockedPaths) {
      if (resolved.startsWith(blocked)) {
        return { allowed: false, reason: `Path is blocked: ${blocked}` };
      }
    }

    if (contentSize > this.maxFileSize) {
      return { allowed: false, reason: `File size exceeds limit (${this.maxFileSize} bytes)` };
    }

    return { allowed: true };
  }

  validateExecute(command) {
    if (!this.allowExecute) return { allowed: false, reason: 'Execute access denied' };

    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /format\s+[A-Z]:/,
      /del\s+\/[sq]\s+[A-Z]:/,
      /shutdown/,
      /reboot/,
      /mkfs/,
      /dd\s+if=/,
      />\s*\/dev\/sd/,
      /:(){ :\|:& };:/,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return { allowed: false, reason: `Dangerous command pattern detected` };
      }
    }

    return { allowed: true };
  }

  validateNetwork(url) {
    if (!this.allowNetwork) return { allowed: false, reason: 'Network access denied' };

    const privatePatterns = [
      /^https?:\/\/(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|0\.|localhost|::1)/i,
      /^https?:\/\/169\.254\./i,
      /^https?:\/\/\[?fe80::/i,
      /^https?:\/\/\[?fc00::/i,
      /^https?:\/\/\[?fd00::/i,
    ];

    for (const pattern of privatePatterns) {
      if (pattern.test(url)) {
        return { allowed: false, reason: 'Private network address blocked (SSRF protection)' };
      }
    }

    return { allowed: true };
  }
}

class SandboxManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this._policies = new Map();
    this._activeSandbox = null;
    this._auditLog = [];
   this._maxAuditLog = 5000;
   this._defaultProfile = config.defaultProfile || 'standard';

   this._policies.set('default', new SandboxPolicy(this._defaultProfile));
    this._approvalSystem = null;
  }

  /**
   * 注入审批系统引用，使沙箱拦截后可以走审批流程
   * @param {Object} approvalSystem - 需暴露 request() 和 waitForApproval() 方法
   */
  setApprovalSystem(approvalSystem) {
    this._approvalSystem = approvalSystem;
  }

  /**
   * 沙箱拦截后通过审批系统向用户请求授权
   * 先做同步验证，被拒后发起审批请求并等待用户回应
   * @param {string} operation - 操作类型: read/write/execute/network
   * @param {string} target - 操作目标（文件路径 / 命令 / URL）
   * @param {Object} [context] - 审批上下文
   * @param {string} [sandboxId] - 沙箱 ID
   * @returns {Promise<{allowed: boolean, approved: boolean, requestId?: string, reason?: string, scope?: string}>}
   */
  async requestApprovalFor(operation, target, context = {}, sandboxId) {
    // 先做同步策略检查
    const policy = sandboxId ? this._policies.get(sandboxId) : this.getActiveSandbox();
    let result;
    switch (operation) {
      case 'read':
        result = policy.validateRead(target);
        break;
      case 'write':
        result = policy.validateWrite(target);
        break;
      case 'execute':
        result = policy.validateExecute(target);
        break;
      case 'network':
        result = policy.validateNetwork(target);
        break;
      default:
        return { allowed: false, approved: false, reason: `Unknown operation: ${operation}` };
    }

    this._audit(operation, target, result.allowed, sandboxId);

    // 沙箱允许，直接返回
    if (result.allowed) {
      return { allowed: true, approved: true, reason: result.reason || 'Sandbox allowed' };
    }

    // 沙箱拒绝，但没有审批系统——返回拒绝
    if (!this._approvalSystem) {
      return { allowed: false, approved: false, reason: result.reason || 'Sandbox denied' };
    }

    // 沙箱拒绝，发起审批请求
    const label = operation === 'execute' ? target : `[${operation}] ${target}`;
    const approvalRequest = await this._approvalSystem.request(label, {
      operation,
      target,
      sandboxId,
      ...context,
    });

    // 自动审批结果
    if (!approvalRequest.requestId) {
      const autoApproved = approvalRequest.status === 'auto_approved' || approvalRequest.status === 'approved';
      return {
        allowed: autoApproved,
        approved: autoApproved,
        requestId: approvalRequest.requestId,
        reason: approvalRequest.reason || 'Auto decision',
      };
    }

    // 等待用户回应
    try {
      const userDecision = await this._approvalSystem.waitForApproval(
        approvalRequest.requestId,
        (approvalRequest.timeout || 60) * 1000
      );

      return {
        allowed: userDecision.approved,
        approved: userDecision.approved,
        requestId: approvalRequest.requestId,
        scope: userDecision.scope,
        reason: userDecision.approved ? 'User approved' : 'User denied',
      };
    } catch (err) {
      return {
        allowed: false,
        approved: false,
        requestId: approvalRequest.requestId,
        reason: err.message,
      };
    }
  }

 createSandbox(id, profile = 'standard', overrides = {}) {
    const policy = new SandboxPolicy(profile, overrides);
    this._policies.set(id, policy);
    this.emit('sandbox:created', { id, profile });
    return policy;
  }

  getSandbox(id) {
    return this._policies.get(id) || this._policies.get('default');
  }

  removeSandbox(id) {
    if (id === 'default') return false;
    this._policies.delete(id);
    this.emit('sandbox:removed', { id });
    return true;
  }

  setActiveSandbox(id) {
    if (!this._policies.has(id)) {
      throw new Error(`Sandbox "${id}" does not exist`);
    }
    this._activeSandbox = id;
    this.emit('sandbox:activated', { id });
  }

  getActiveSandbox() {
    return this._activeSandbox ? this._policies.get(this._activeSandbox) : this._policies.get('default');
  }

  validateRead(filePath, sandboxId) {
    const policy = sandboxId ? this._policies.get(sandboxId) : this.getActiveSandbox();
    const result = policy.validateRead(filePath);
    this._audit('read', filePath, result.allowed, sandboxId);
    return result;
  }

  validateWrite(filePath, contentSize = 0, sandboxId) {
    const policy = sandboxId ? this._policies.get(sandboxId) : this.getActiveSandbox();
    const result = policy.validateWrite(filePath, contentSize);
    this._audit('write', filePath, result.allowed, sandboxId);
    return result;
  }

  validateExecute(command, sandboxId) {
    const policy = sandboxId ? this._policies.get(sandboxId) : this.getActiveSandbox();
    const result = policy.validateExecute(command);
    this._audit('execute', command.slice(0, 200), result.allowed, sandboxId);
    return result;
  }

  validateNetwork(url, sandboxId) {
    const policy = sandboxId ? this._policies.get(sandboxId) : this.getActiveSandbox();
    const result = policy.validateNetwork(url);
    this._audit('network', url.slice(0, 200), result.allowed, sandboxId);
    return result;
  }

  _audit(operation, target, allowed, sandboxId) {
    this._auditLog.push({
      timestamp: Date.now(),
      operation,
      target: target.slice(0, 500),
      allowed,
      sandboxId: sandboxId || this._activeSandbox || 'default',
    });

    if (this._auditLog.length > this._maxAuditLog) {
      this._auditLog = this._auditLog.slice(-this._maxAuditLog);
    }

    if (!allowed) {
      this.emit('sandbox:denied', { operation, target: target.slice(0, 100), sandboxId });
    }
  }

  getAuditLog(opts = {}) {
    const limit = opts.limit || 100;
    const operation = opts.operation;
    const allowed = opts.allowed;

    let log = this._auditLog;
    if (operation) log = log.filter(e => e.operation === operation);
    if (allowed !== undefined) log = log.filter(e => e.allowed === allowed);

    return log.slice(-limit);
  }

  getStats() {
    const total = this._auditLog.length;
    const denied = this._auditLog.filter(e => !e.allowed).length;
    return {
      sandboxCount: this._policies.size,
      activeSandbox: this._activeSandbox || 'default',
      totalOperations: total,
      deniedOperations: denied,
      denialRate: total > 0 ? (denied / total * 100).toFixed(1) + '%' : '0%',
    };
  }
}

class PathJail {
  constructor(rootDir) {
    this._root = this._resolveRealPath(rootDir);
  }

  _resolveRealPath(dirPath) {
    try {
      return fs.realpathSync(path.resolve(dirPath)).toLowerCase();
    } catch {
      return path.resolve(dirPath).toLowerCase();
    }
  }

  resolve(relativePath) {
    const resolved = path.resolve(this._root, relativePath);
    let realResolved;
    try {
      realResolved = fs.realpathSync(resolved).toLowerCase();
    } catch {
      realResolved = resolved.toLowerCase();
    }

    if (!realResolved.startsWith(this._root)) {
      return { valid: false, resolved: realResolved, reason: 'Path escapes jail root' };
    }

    return { valid: true, resolved: realResolved };
  }

  isWithinJail(filePath) {
    let realPath;
    try {
      realPath = fs.realpathSync(path.resolve(filePath)).toLowerCase();
    } catch {
      realPath = path.resolve(filePath).toLowerCase();
    }
    return realPath.startsWith(this._root);
  }

  get root() {
    return this._root;
  }
}

let _sandboxInstance = null;

function getSandboxManager(config) {
  if (!_sandboxInstance) {
    _sandboxInstance = new SandboxManager(config);
  }
  return _sandboxInstance;
}

module.exports = {
  SandboxPolicy,
  SandboxManager,
  PathJail,
  SANDBOX_PROFILES,
  getSandboxManager,
};
