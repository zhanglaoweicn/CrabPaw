const crypto = require('crypto');
/**
 * ApprovalSystem - 危险命令审批系统
 * 
 * 支持三种模式:
 * - manual: 总是人工确认
 * - smart: LLM 智能评估风险
 * - off: 禁用审批 (YOLO 模式)
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { DATA_DIR } = require('../config');
const { atomicWriteFile, atomicReadJSON } = require('../atomic-write');

const APPROVAL_MODES = {
  MANUAL: 'manual',
  SMART: 'smart',
  OFF: 'off'
};

const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
  AUTO_APPROVED: 'auto_approved',
  AUTO_DENIED: 'auto_denied'
};

const APPROVAL_SCOPE = {
  ONCE: 'once',
  SESSION: 'session',
  ALWAYS: 'always'
};

const CHAT_APPROVAL_KEYWORDS = {
  approve: ['yes', 'y', 'approve', 'ok', 'allow', 'confirm', '同意', '批准', '允许', '确认', '是'],
  deny: ['no', 'n', 'deny', 'reject', 'cancel', 'refuse', '拒绝', '取消', '否', '驳回'],
  scopeSession: ['session', 's', '会话'],
  scopeAlways: ['always', 'a', '永久'],
};

class ApprovalSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      enabled: config.enabled !== false,
      mode: config.mode || APPROVAL_MODES.MANUAL,
      // P2-1: 默认超时 8s → 15s。语音场景老板从听到提示音到说出"批准"可能超过 8s，
      // 8s 会导致语音审批频繁超时自动拒绝（实测失败）。
      timeout: config.timeout || 15,
      autoApproveLowRisk: config.autoApproveLowRisk || false,
      persistDecisions: config.persistDecisions !== false,
      ...config
    };

    this._pendingRequests = new Map();
    this._decisions = new Map();
    this._sessionApprovals = new Map();
    this._stats = {
      total: 0,
      approved: 0,
      denied: 0,
      autoApproved: 0,
      autoDenied: 0,
      timeout: 0
    };

    this._dataPath = null;
    this._decisionFile = 'approval-decisions.json';
    this._pendingFile = 'approval-pending.json';
    this._timeoutTimers = new Map();
    this._chatApprovalEnabled = config.chatApprovalEnabled !== false;
    this._sseBroadcast = config.sseBroadcast || null;
  }

  /**
   * 注入 SSE 广播函数，实现审批事件实时推送到前端
   * @param {Function} broadcastFn - (eventType, data) => void
   */
  setSSEBroadcast(broadcastFn) {
    this._sseBroadcast = broadcastFn;
  }

  /**
   * 通过 SSE 广播审批事件
   */
  _broadcastApprovalEvent(eventType, data) {
    if (this._sseBroadcast) {
      try {
        this._sseBroadcast(eventType, data);
      } catch (e) {
        console.warn('审批事件 SSE 广播失败:', e.message);
      }
    }
  }

  async initialize() {
    this._dataPath = path.join(DATA_DIR, 'security');
    
    if (!fs.existsSync(this._dataPath)) {
      fs.mkdirSync(this._dataPath, { recursive: true });
    }
    
    if (this.config.persistDecisions) {
      await this._loadDecisions();
      await this._loadPendingRequests();
    }
  }

  async _loadDecisions() {
    const filePath = path.join(this._dataPath, this._decisionFile);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        for (const [key, decision] of Object.entries(data.decisions || {})) {
          this._decisions.set(key, decision);
        }
        this._stats = { ...this._stats, ...data.stats };
      } catch (e) {
        console.warn('加载审批决策失败:', e.message);
      }
    }
  }

  async _saveDecisions() {
    if (!this._dataPath) return;
    
    const filePath = path.join(this._dataPath, this._decisionFile);
    const data = {
      decisions: Object.fromEntries(this._decisions),
      stats: this._stats,
      updatedAt: new Date().toISOString()
    };
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  async _loadPendingRequests() {
    const filePath = path.join(this._dataPath, this._pendingFile);
    const data = atomicReadJSON(filePath);
    if (!data || !data.pending) return;

    const now = Date.now();
    for (const req of data.pending || []) {
      if (now > req.expiresAt) continue;
      this._pendingRequests.set(req.id, req);
      this._startTimeoutTimer(req.id, req.expiresAt - now);
    }
  }

  async _savePendingRequests() {
    if (!this._dataPath) return;
    const filePath = path.join(this._dataPath, this._pendingFile);
    const pending = [];
    for (const [, req] of this._pendingRequests) {
      pending.push(req);
    }
    atomicWriteFile(filePath, JSON.stringify({ pending, updatedAt: new Date().toISOString() }, null, 2));
  }

  _startTimeoutTimer(requestId, ms) {
    if (this._timeoutTimers.has(requestId)) {
      clearTimeout(this._timeoutTimers.get(requestId));
    }
    const timer = setTimeout(() => {
      this._handleTimeout(requestId);
    }, ms);
    this._timeoutTimers.set(requestId, timer);
  }

  _handleTimeout(requestId) {
    this._timeoutTimers.delete(requestId);
    const request = this._pendingRequests.get(requestId);
    if (!request) return;

    // 审批超时默认拒绝（安全优先）
    request.status = APPROVAL_STATUS.AUTO_DENIED;
    request.resolvedAt = Date.now();
    request.resolutionReason = 'approval_timeout_auto_deny';
    this._pendingRequests.delete(requestId);
    this._stats.timeout++;
    this._stats.autoDenied++;
    this.emit('timeout', { requestId, command: request.command, autoDenied: true });
    this.emit('denied', { requestId, command: request.command, reason: '审批超时，默认拒绝' });

    // SSE 广播超时事件
    this._broadcastApprovalEvent('approval_resolved', {
      requestId,
      status: APPROVAL_STATUS.AUTO_DENIED,
      scope: null,
      command: request.command,
      reason: '审批超时，默认拒绝'
    });

    this._savePendingRequests().catch(e => console.debug('[approval] Save failed:', e?.message));
  }

  async request(command, context = {}) {
    if (!this.config.enabled || this.config.mode === APPROVAL_MODES.OFF) {
      return {
        status: APPROVAL_STATUS.AUTO_APPROVED,
        reason: '审批系统未启用或 YOLO 模式'
      };
    }
    
    const decisionKey = this._generateDecisionKey(command, context);
    
    const existingDecision = this._checkExistingDecision(decisionKey, context);
    if (existingDecision) {
      return existingDecision;
    }
    
    if (this.config.mode === APPROVAL_MODES.SMART) {
      const smartResult = await this.smartAssess(command, context);
      if (smartResult.autoApproved) {
        this._stats.total++;
        this._stats.autoApproved++;
        return {
          status: APPROVAL_STATUS.AUTO_APPROVED,
          reason: smartResult.reason
        };
      }
      if (smartResult.autoDenied) {
        this._stats.total++;
        this._stats.autoDenied++;
        return {
          status: APPROVAL_STATUS.AUTO_DENIED,
          reason: smartResult.reason
        };
      }
    }
    
    const requestId = `approval_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    const request = {
      id: requestId,
      command,
      context,
      status: APPROVAL_STATUS.PENDING,
      createdAt: Date.now(),
      expiresAt: Date.now() + (this.config.timeout * 1000),
      // 2026-08-14 审计 G3: 归属标识(会话/用户),用于 SSE 配对与 respond 归属校验
      conversationId: (context && (context.conversationId || context.sessionId || context.userId)) || null
    };
    
    this._pendingRequests.set(requestId, request);
    this._stats.total++;
    
    this._startTimeoutTimer(requestId, this.config.timeout * 1000);
    this.emit('requested', { requestId, command, timeout: this.config.timeout });

    // SSE 广播审批请求到前端
    this._broadcastApprovalEvent('approval_requested', {
      requestId,
      command: command.slice(0, 200),
      message: this._formatApprovalMessage(command, context),
      timeout: this.config.timeout,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      // 2026-08-14 审计 G3: 会话归属广播(仅新增字段,前端缺省兼容)
      conversationId: request.conversationId
    });

    await this._savePendingRequests();
    
    return {
      status: APPROVAL_STATUS.PENDING,
      requestId,
      command,
      timeout: this.config.timeout,
      message: this._formatApprovalMessage(command, context)
    };
  }

  _checkExistingDecision(decisionKey, _context) {
    if (this._sessionApprovals.has(decisionKey)) {
      const approval = this._sessionApprovals.get(decisionKey);
      if (approval.scope === APPROVAL_SCOPE.SESSION || approval.scope === APPROVAL_SCOPE.ALWAYS) {
        return {
          status: APPROVAL_STATUS.APPROVED,
          reason: `会话已批准 (${approval.scope})`,
          scope: approval.scope
        };
      }
    }
    
    if (this._decisions.has(decisionKey)) {
      const decision = this._decisions.get(decisionKey);
      if (decision.scope === APPROVAL_SCOPE.ALWAYS && decision.status === APPROVAL_STATUS.APPROVED) {
        return {
          status: APPROVAL_STATUS.APPROVED,
          reason: '永久批准',
          scope: APPROVAL_SCOPE.ALWAYS
        };
      }
    }
    
    return null;
  }

  _generateDecisionKey(command, context) {
    const normalizedCommand = command.trim().toLowerCase();
    const hash = this._simpleHash(normalizedCommand);
    return `cmd_${hash}_${context.userId || 'default'}`;
  }

  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  // eslint-disable-next-line no-unused-vars
  async smartAssess(command, context = {}) {
    const lowerCmd = command.toLowerCase();
    
    const safePatterns = [
      /^ls(\s|$)/,
      /^cat\s+[\w./-]+\.(txt|md|json|log)$/i,
      /^echo\s+/,
      /^pwd$/,
      /^date$/,
      /^whoami$/,
      /^python\s+-c\s+["']print\(/i,
      /^node\s+-e\s+["']console\.log\(/i
    ];
    
    for (const pattern of safePatterns) {
      if (pattern.test(lowerCmd)) {
        return {
          autoApproved: true,
          autoDenied: false,
          reason: '智能评估: 低风险命令'
        };
      }
    }
    
    const definitelyDangerous = [
      /rm\s+-rf\s+\//,
      /mkfs/,
      /dd\s+.*of=\/dev/,
      />\s*\/etc\//,
      /chmod\s+777/
    ];
    
    for (const pattern of definitelyDangerous) {
      if (pattern.test(lowerCmd)) {
        return {
          autoApproved: false,
          autoDenied: true,
          reason: '智能评估: 高风险命令自动拒绝'
        };
      }
    }
    
    return {
      autoApproved: false,
      autoDenied: false,
      reason: '需要人工确认'
    };
  }

  _formatApprovalMessage(command, _context) {
    return `⚠️ 危险操作需要确认

命令: \`${command.slice(0, 100)}${command.length > 100 ? '...' : ''}\`

请选择:
• [o]nce - 本次允许
• [s]ession - 本次会话允许
• [a]lways - 永久允许
• [d]eny - 拒绝`;
  }

  async respond(requestId, response, scope = APPROVAL_SCOPE.ONCE, options = {}) {
    // 2026-08-13 P1-7: approve-with-edits——批准时可携带编辑后的命令;
    // 编辑后强制 once(不参与 session/always 记忆,防提权),命令以 finalCommand 传播给等待方。
    let finalCommand = null;
    let edited = false;
    const rawEdited = typeof options?.editedCommand === 'string' ? options.editedCommand.trim() : '';
    if (rawEdited && rawEdited.length > 0 && rawEdited.length <= 4000) {
      finalCommand = rawEdited;
      edited = true;
      scope = APPROVAL_SCOPE.ONCE;
    }
    const request = this._pendingRequests.get(requestId);
    if (!request) {
      return { success: false, error: '审批请求不存在或已过期' };
    }

    // 2026-08-14 审计 G3: 归属校验——调用方携带 conversationId/userId 时必须与请求归属一致,
    // 防止跨会话误批。旧客户端缺省标识时按兼容模式放行并记录日志。
    const requestOwner = request.conversationId
      || (request.context && (request.context.conversationId || request.context.sessionId || request.context.userId));
    const callerOwner = (options && (options.conversationId || options.userId)) || null;
    if (requestOwner && callerOwner && String(requestOwner) !== String(callerOwner)) {
      console.warn(`[approval] 拒绝跨会话审批: request ${requestId} 归属 ${requestOwner}, 调用方 ${callerOwner}`);
      return { success: false, error: '审批请求不属于当前会话' };
    }
    if (!callerOwner) {
      console.log(`[approval] respond 未携带会话标识(requestId=${requestId}),按兼容模式处理(多会话环境建议前端传 conversationId)`);
    }

    if (Date.now() > request.expiresAt) {
      this._pendingRequests.delete(requestId);
      this._stats.timeout++;
      return { success: false, error: '审批请求已超时' };
    }
    
    const approved = response === true || response === 'approve' || response === 'approved';
    
    request.status = approved ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.DENIED;
    request.respondedAt = Date.now();
    request.scope = scope;
    // 编辑命令只在批准时生效(拒绝时保持原命令传播)
    if (approved && finalCommand) request.finalCommand = finalCommand;
    
    // 发布 P1-2: 定时器清理移出 approved 分支——拒绝决议同样须清,否则残留 timeout 定时器
    // 拖住进程退出(jest 实测)且长会话累积空转定时器。
    if (this._timeoutTimers.has(requestId)) {
      clearTimeout(this._timeoutTimers.get(requestId));
      this._timeoutTimers.delete(requestId);
    }

    if (approved) {
      this._stats.approved++;

      if (scope === APPROVAL_SCOPE.SESSION && !edited) {
        const decisionKey = this._generateDecisionKey(request.command, request.context);
        this._sessionApprovals.set(decisionKey, { scope, timestamp: Date.now() });
      }
      
      if (scope === APPROVAL_SCOPE.ALWAYS && !edited) {
        const decisionKey = this._generateDecisionKey(request.command, request.context);
        this._decisions.set(decisionKey, {
          status: APPROVAL_STATUS.APPROVED,
          scope,
          timestamp: Date.now(),
          command: request.command
        });
        await this._saveDecisions();
      }
    } else {
      this._stats.denied++;
    }
    
    this._pendingRequests.delete(requestId);

    this.emit('responded', { requestId, status: request.status, scope, command: request.finalCommand || request.command, edited });

    // SSE 广播审批决策到前端
 this._broadcastApprovalEvent('approval_resolved', {
   requestId,
   status: request.status,
   scope,
   command: request.finalCommand || request.command,
   edited
 });

 this._savePendingRequests().catch(e => console.debug('[approval] Save failed:', e?.message));
 
 return {
   success: true,
   status: request.status,
   scope,
   command: request.finalCommand || request.command,
   edited
 };
}

  /**
   * 异步等待用户审批结果
   * @param {string} requestId - 审批请求 ID
   * @param {number} timeoutMs - 超时时间（毫秒）
   * @returns {Promise<{approved: boolean, scope: string}>}
   * @throws {Error} 拒绝或超时时抛出
   */
  waitForApproval(requestId, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('responded', onResponse);
        this.removeListener('timeout', onTimeout);
        reject(new Error(`审批超时（${Math.round(timeoutMs / 1000)} 秒未响应，已自动拒绝）`));
      }, timeoutMs);

      const onResponse = ({ requestId: id, status, scope, command }) => {
        if (id !== requestId) return;
        clearTimeout(timer);
        this.removeListener('timeout', onTimeout);
        // 发布 P1-2: 决议后自移除 'responded' 监听——waitForApproval 成为 Bash 审批热路径后,
        // 原实现不清理会在每次调用后残留监听器,长会话积累导致事件广播逐次放大。
        this.removeListener('responded', onResponse);
        if (status === APPROVAL_STATUS.APPROVED) {
          resolve({ approved: true, scope, command });
        } else {
          reject(new Error(`审批被拒绝（${status}）`));
        }
      };

      const onTimeout = ({ requestId: id }) => {
        if (id !== requestId) return;
        clearTimeout(timer);
        this.removeListener('responded', onResponse);
        reject(new Error(`审批超时，已自动拒绝`));
      };

      this.on('responded', onResponse);
      this.on('timeout', onTimeout);
    });
  }

 getPendingRequests() {
   const now = Date.now();
   const pending = [];
    
    for (const [id, request] of this._pendingRequests) {
      if (now <= request.expiresAt) {
        pending.push(request);
      } else {
        this._pendingRequests.delete(id);
        this._stats.timeout++;
      }
    }
    
    return pending;
  }

  clearSessionApprovals() {
    this._sessionApprovals.clear();
  }

  parseChatApproval(message, context = {}) {
    if (!this._chatApprovalEnabled) return null;

    const text = (message || '').trim().toLowerCase();
    if (!text) return null;

    const pending = this.getPendingRequests();
    if (pending.length === 0) return null;

    const targetRequest = context.requestId
      ? pending.find(r => r.id === context.requestId)
      : pending[0];

    if (!targetRequest) return null;

    let isApprove = false;
    let isDeny = false;
    let scope = APPROVAL_SCOPE.ONCE;

    for (const kw of CHAT_APPROVAL_KEYWORDS.approve) {
      if (text === kw || text.startsWith(kw)) {
        isApprove = true;
        break;
      }
    }

    if (!isApprove) {
      for (const kw of CHAT_APPROVAL_KEYWORDS.deny) {
        if (text === kw || text.startsWith(kw)) {
          isDeny = true;
          break;
        }
      }
    }

    if (!isApprove && !isDeny) return null;

    if (isApprove) {
      for (const kw of CHAT_APPROVAL_KEYWORDS.scopeSession) {
        if (text.includes(kw)) { scope = APPROVAL_SCOPE.SESSION; break; }
      }
      for (const kw of CHAT_APPROVAL_KEYWORDS.scopeAlways) {
        if (text.includes(kw)) { scope = APPROVAL_SCOPE.ALWAYS; break; }
      }
    }

    return {
      requestId: targetRequest.id,
      response: isApprove,
      scope,
      command: targetRequest.command,
    };
  }

  async handleChatMessage(message, context = {}) {
    const parsed = this.parseChatApproval(message, context);
    if (!parsed) return null;

    const result = await this.respond(parsed.requestId, parsed.response, parsed.scope);
    return { ...result, command: parsed.command };
  }

  getStats() {
    return {
      ...this._stats,
      pendingCount: this._pendingRequests.size,
      sessionApprovals: this._sessionApprovals.size,
      savedDecisions: this._decisions.size
    };
  }

  setMode(mode) {
    if (!Object.values(APPROVAL_MODES).includes(mode)) {
      throw new Error(`无效的审批模式: ${mode}`);
    }
    this.config.mode = mode;
    console.log(`🔐 审批模式已设置为: ${mode}`);
  }

  enable() {
    this.config.enabled = true;
  }

  disable() {
    this.config.enabled = false;
  }
}

module.exports = {
  ApprovalSystem,
  APPROVAL_MODES,
  APPROVAL_STATUS,
  APPROVAL_SCOPE,
  CHAT_APPROVAL_KEYWORDS,
  getApprovalWaitTimeout,
};

/**
 * C4(Runtime差距分析): 审批等待超时可配置——此前 registry/bash/desktop 各写死
 * 60s/30s/30s,审批挂起远短于生产 HITL 场景(文章基准"十分钟甚至十小时后仍可恢复")。
 * 统一从 APPROVAL_WAIT_MS 读取,默认 10 分钟。
 */
function getApprovalWaitTimeout() {
  const v = Number(process.env.APPROVAL_WAIT_MS);
  return Number.isFinite(v) && v > 0 ? v : 600000;
}
