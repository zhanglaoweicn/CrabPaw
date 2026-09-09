/**
 * CrabPaw Security System - 统一安全模块
 * 
 * 安全层级:
 * 1. 用户授权 - 飞书用户白名单
 * 2. 危险命令审批 - 人工确认危险操作
 * 3. 文件系统边界 - 限制访问范围
 * 4. 提示注入检测 - 检测恶意输入
 * 5. 跨会话隔离 - 用户数据隔离
 */

const UserWhitelist = require('./user-whitelist');
const DangerousPatterns = require('./dangerous-patterns');
const { ApprovalSystem } = require('./approval');
const FilesystemGuard = require('./filesystem-guard');
const { PromptInjectionDetector } = require('./prompt-injection-detector');
const SessionIsolation = require('./session-isolation');
const { CronPromptInjectionScanner, CronPromptInjectionBlocked } = require('./cron-injection-scanner');
const { ContextFileThreatScanner } = require('./context-threat-scanner');
const { StreamingContextScrubber } = require('./streaming-context-scrubber');
const { getSandboxManager } = require('./sandbox');
const { getExecApproval } = require('../exec-approval');
const { ApprovalSystem: ApprovalSystemClass } = require('./approval');

const SECURITY_LEVELS = {
  DISABLED: 'disabled',
  BASIC: 'basic',
  STANDARD: 'standard',
  STRICT: 'strict',
  PARANOID: 'paranoid'
};

const SECURITY_DEFAULTS = {
  level: SECURITY_LEVELS.STANDARD,
  
  userWhitelist: {
    enabled: true,
    allowAll: false,
    users: [],
    platforms: ['lark', 'feishu', 'telegram', 'discord', 'gui']
  },
  
  approval: {
    enabled: true,
    mode: 'manual',
    timeout: 15, // P2-1: 默认审批超时 8s → 15s（语音响应慢，与 approval.js 默认对齐）
    autoApproveLowRisk: false
  },
  
  filesystem: {
    enabled: true,
    allowedPaths: [],
    blockedPaths: [],
    maxFileSize: 10 * 1024 * 1024
  },
  
  promptInjection: {
    enabled: true,
    blockOnDetection: false,
    warnLevel: 'high',
  },
  
  sessionIsolation: {
    enabled: true,
    strictMode: false
  },
  
  cronInjection: {
    enabled: true,
    strictMode: true
  },
  
  contextThreatScan: {
    enabled: true,
    strictMode: true,
    blockOnCritical: true,
    blockOnHigh: false
  },
  
  streamingScrub: {
    enabled: true,
    customTags: []
  }
};

// ============================================================================
// 全局 ApprovalSystem 单例（供 bash-tools 等工具层使用）
// ============================================================================
let _globalApprovalSystem = null;

/**
 * 获取或创建全局 ApprovalSystem 单例，并自动挂接到 sandbox 和 exec-approval
 * @returns {ApprovalSystem}
 */
function getApprovalSystem() {
  if (_globalApprovalSystem) return _globalApprovalSystem;

  const approval = new ApprovalSystemClass({
    mode: 'manual',
    enabled: true,
    autoApproveLowRisk: false,
  });

  // 挂接到 sandbox
  try {
    const sandbox = getSandboxManager();
    sandbox.setApprovalSystem(approval);
    console.log('  ✓ 沙箱已关联审批系统');
  } catch (e) {
    console.warn('  ⚠️ 沙箱关联审批系统失败:', e.message);
  }

  // 挂接到 exec-approval
  try {
    const exec = getExecApproval();
    exec.setApprovalSystem(approval);
    console.log('  ✓ 命令审批已关联审批系统');
  } catch (e) {
    console.warn('  ⚠️ 命令审批关联失败:', e.message);
  }

  _globalApprovalSystem = approval;
  return approval;
}

class SecuritySystem {
  constructor(config = {}) {
    this.config = { ...SECURITY_DEFAULTS, ...config };
    
    this.userWhitelist = new UserWhitelist(this.config.userWhitelist);
    this.dangerousPatterns = new DangerousPatterns();
    this.approval = new ApprovalSystem(this.config.approval);
    this.filesystemGuard = new FilesystemGuard(this.config.filesystem);
    this.promptInjectionDetector = new PromptInjectionDetector(this.config.promptInjection);
    this.sessionIsolation = new SessionIsolation(this.config.sessionIsolation);
    this.cronInjectionScanner = new CronPromptInjectionScanner(this.config.cronInjection);
    this.contextThreatScanner = new ContextFileThreatScanner(this.config.contextThreatScan);
    this.streamingScrubber = new StreamingContextScrubber(this.config.streamingScrub);
    
    this._auditLog = [];
    this._maxAuditLog = 10000;
  }

  /**
   * 2026-08-31 修复(Bug C): setLevel 调用了不存在的 this._audit →
   * GUI 保存(含安全配置即时生效)恒 500 "this._audit is not a function"。
   * 补上方法定义(getStats.auditLogSize 早已配套消费 _auditLog, 方法却缺失)。
   */
  _audit(eventName, payload) {
    if (!Array.isArray(this._auditLog)) this._auditLog = [];
    this._auditLog.push({ event: eventName, ts: Date.now(), payload });
    if (this._auditLog.length > this._maxAuditLog) {
      this._auditLog = this._auditLog.slice(-this._maxAuditLog);
    }
  }

  async initialize() {
    console.log('🔒 安全系统初始化中...');
    
    if (this.config.userWhitelist.enabled) {
      await this.userWhitelist.load();
      console.log('  ✅ 用户白名单已加载');
    }
    
   if (this.config.approval.enabled) {
     await this.approval.initialize();
     console.log('  ✅ 审批系统已初始化');

      // 将审批系统注入 sandbox 和 exec-approval，使拦截自动走审批流程
      try {
        const sandbox = getSandboxManager();
        sandbox.setApprovalSystem(this.approval);
        console.log('  ✅ 沙箱已关联审批系统');
      } catch (e) {
        console.warn('  ⚠️ 沙箱关联审批系统失败:', e.message);
      }

      try {
        const exec = getExecApproval();
        exec.setApprovalSystem(this.approval);
        console.log('  ✅ 命令审批已关联审批系统');
      } catch (e) {
        console.warn('  ⚠️ 命令审批关联失败:', e.message);
      }
   }
   
   if (this.config.filesystem.enabled) {
      await this.filesystemGuard.initialize();
      console.log('  ✅ 文件系统守卫已初始化');
    }
    
    console.log('🔒 安全系统初始化完成');
  }

  async checkUserAuthorization(userId, platform = 'lark') {
    if (!this.config.userWhitelist.enabled) {
      return { authorized: true, reason: '用户授权未启用' };
    }
    
    const result = await this.userWhitelist.check(userId, platform);
    this._logAudit('user_auth', { userId, platform, result });
    return result;
  }

  async checkCommand(command, context = {}) {
    const results = {
      allowed: true,
      requiresApproval: false,
      blocked: false,
      reasons: [],
      riskLevel: 'low'
    };
    
    if (!this.config.approval.enabled) {
      return results;
    }
    
    const patternCheck = this.dangerousPatterns.check(command);
    if (patternCheck.hasMatches) {
      results.riskLevel = patternCheck.maxSeverity;
      results.reasons.push(...patternCheck.matches.map(m => m.description));
      
      if (patternCheck.maxSeverity === 'critical') {
        results.blocked = true;
        results.allowed = false;
        this._logAudit('command_blocked', { command, matches: patternCheck.matches });
        return results;
      }
      
      if (['high', 'medium'].includes(patternCheck.maxSeverity)) {
        results.requiresApproval = true;
        
        if (this.config.approval.mode === 'smart') {
          const smartResult = await this.approval.smartAssess(command, context);
          if (smartResult.autoApproved) {
            results.requiresApproval = false;
            results.reasons.push('智能审批: 自动批准');
          } else if (smartResult.autoDenied) {
            results.blocked = true;
            results.allowed = false;
            results.reasons.push('智能审批: 自动拒绝');
          }
        }
      }
    }
    
    this._logAudit('command_check', { command, results });
    return results;
  }

  async requestApproval(command, context = {}) {
    return this.approval.request(command, context);
  }

  async checkFileAccess(path, operation = 'read') {
    if (!this.config.filesystem.enabled) {
      return { allowed: true, reason: '文件系统守卫未启用' };
    }
    
    const result = this.filesystemGuard.check(path, operation);
    this._logAudit('file_access', { path, operation, result });
   return result;
 }

  /**
   * 检查操作是否被拦截，被拦截时自动发起审批请求并等待用户授权
   * 支持的操作类型：execute（命令）、read/write/network（沙箱）
   * @param {string} type - 操作类型
   * @param {string} target - 操作目标
   * @param {Object} [context] - 上下文
   * @returns {Promise<{allowed: boolean, approved: boolean, reason: string, requestId?: string, scope?: string}>}
   */
  async checkAndRequestApproval(type, target, context = {}) {
    if (type === 'execute') {
      // 走 exec-approval 的命令审批链路
      const exec = getExecApproval();
      return await exec.evaluateWithApproval(target, {
        userId: context.userId,
        sessionId: context.sessionId,
        message: context.message,
        ...context,
      });
    }

    // 走沙箱的文件/网络操作审批链路
    const sandbox = getSandboxManager();
    return await sandbox.requestApprovalFor(type, target, {
      userId: context.userId,
      sessionId: context.sessionId,
      message: context.message,
      ...context,
    });
  }

 // eslint-disable-next-line no-unused-vars -- 函数签名参数 context 未用（不改签名）
 async detectPromptInjection(input, context = {}) {
    if (!this.config.promptInjection.enabled) {
      return { detected: false, reason: '提示注入检测未启用' };
    }
    
    const result = this.promptInjectionDetector.detect(input);
    this._logAudit('prompt_injection', { input: input.slice(0, 100), result });
    return result;
  }

  async checkSessionAccess(userId, sessionId) {
    if (!this.config.sessionIsolation.enabled) {
      return { allowed: true, reason: '会话隔离未启用' };
    }
    
    const result = this.sessionIsolation.checkAccess(userId, sessionId);
    this._logAudit('session_access', { userId, sessionId, result });
    return result;
  }

  scanContextContent(content, source = 'unknown') {
    if (!this.config.contextThreatScan.enabled) {
      return { safe: true, threats: [], sanitized: content };
    }
    const result = this.contextThreatScanner.scanContent(content, source);
    this._logAudit('context_threat_scan', { source, safe: result.safe, threatCount: result.threatCount });
    return result;
  }

  scanContextFile(filePath) {
    if (!this.config.contextThreatScan.enabled) {
      return { safe: true, threats: [], sanitized: null };
    }
    const result = this.contextThreatScanner.scanFile(filePath);
    this._logAudit('context_file_scan', { filePath, safe: result.safe, threatCount: result.threatCount });
    return result;
  }

  scanWorkspaceContext(baseDir) {
    if (!this.config.contextThreatScan.enabled) {
      return [];
    }
    const results = this.contextThreatScanner.scanWorkspace(baseDir);
    this._logAudit('workspace_context_scan', { baseDir, fileCount: results.length });
    return results;
  }

  scrubStreamText(text) {
    if (!this.config.streamingScrub.enabled) {
      return text;
    }
    return this.streamingScrubber.scrub(text);
  }

  createStreamScrubber() {
    if (!this.config.streamingScrub.enabled) {
      return null;
    }
    return this.streamingScrubber.createStreamScrubber();
  }

  getUserDataPath(userId) {
    return this.sessionIsolation.getUserDataPath(userId);
  }

  _logAudit(type, data) {
    this._auditLog.push({
      timestamp: Date.now(),
      type,
      data
    });
    
    if (this._auditLog.length > this._maxAuditLog) {
      this._auditLog.shift();
    }
  }

  getAuditLog(filter = {}) {
    let logs = [...this._auditLog];
    
    if (filter.type) {
      logs = logs.filter(l => l.type === filter.type);
    }
    if (filter.since) {
      logs = logs.filter(l => l.timestamp >= filter.since);
    }
    if (filter.userId) {
      logs = logs.filter(l => l.data.userId === filter.userId);
    }
    
    return logs;
  }

  getStats() {
    return {
      userWhitelist: this.userWhitelist.getStats(),
      approval: this.approval.getStats(),
      filesystem: this.filesystemGuard.getStats(),
      promptInjection: this.promptInjectionDetector.getStats(),
      sessionIsolation: this.sessionIsolation.getStats(),
      cronInjection: this.cronInjectionScanner.getStats(),
      contextThreatScan: this.contextThreatScanner.getStats(),
      streamingScrub: this.streamingScrubber.getStats(),
      auditLogSize: this._auditLog.length
    };
  }

  setLevel(level, { authorized = false, reason = '' } = {}) {
    if (!Object.values(SECURITY_LEVELS).includes(level)) {
      throw new Error(`无效的安全级别: ${level}`);
    }

    if (level === SECURITY_LEVELS.DISABLED && !authorized) {
      throw new Error('禁用安全系统需要显式授权: setLevel(level, { authorized: true, reason: "..." })');
    }

    this._audit('security_level_change', { from: this.config.level, to: level, authorized, reason });

    this.config.level = level;
    
    switch (level) {
      case SECURITY_LEVELS.DISABLED:
        this.config.userWhitelist.enabled = false;
        this.config.approval.enabled = false;
        this.config.filesystem.enabled = false;
        this.config.promptInjection.enabled = false;
        this.config.sessionIsolation.enabled = false;
        break;
        
      case SECURITY_LEVELS.BASIC:
        this.config.userWhitelist.enabled = false;
        this.config.approval.enabled = true;
        this.config.approval.mode = 'smart';
        this.config.filesystem.enabled = true;
        this.config.promptInjection.enabled = false;
        this.config.sessionIsolation.enabled = false;
        break;
        
      case SECURITY_LEVELS.STANDARD:
        Object.assign(this.config, SECURITY_DEFAULTS);
        break;
        
      case SECURITY_LEVELS.STRICT:
        this.config.userWhitelist.enabled = true;
        this.config.userWhitelist.allowAll = false;
        this.config.approval.enabled = true;
        this.config.approval.mode = 'manual';
        this.config.filesystem.enabled = true;
        this.config.promptInjection.enabled = true;
        this.config.promptInjection.blockOnDetection = true;
        this.config.sessionIsolation.enabled = true;
        break;
        
      case SECURITY_LEVELS.PARANOID:
        this.config.userWhitelist.enabled = true;
        this.config.userWhitelist.allowAll = false;
        this.config.approval.enabled = true;
        this.config.approval.mode = 'manual';
        this.config.approval.autoApproveLowRisk = false;
        this.config.filesystem.enabled = true;
        this.config.filesystem.strictMode = true;
        this.config.promptInjection.enabled = true;
        this.config.promptInjection.blockOnDetection = true;
        this.config.sessionIsolation.enabled = true;
        this.config.sessionIsolation.strictMode = true;
        break;
    }
    
    console.log(`🔒 安全级别已设置为: ${level}`);
  }
}

module.exports = {
  SecuritySystem,
  SECURITY_LEVELS,
  SECURITY_DEFAULTS,
  getApprovalSystem,
  UserWhitelist,
  DangerousPatterns,
 ApprovalSystem,
  FilesystemGuard,
  PromptInjectionDetector,
  SessionIsolation,
  CronPromptInjectionScanner,
  CronPromptInjectionBlocked,
  ContextFileThreatScanner,
  StreamingContextScrubber
};
