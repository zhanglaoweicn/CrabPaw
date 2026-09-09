/**
 * ExecApproval - 增强命令执行审批系统
 *
 * - 多级安全模式：deny/allowlist/ask/auto/full
 * - 命令分析和风险评级
 * - 安全二进制白名单（safe-bins）
 * - 审批决策持久化和自动审查
 * - 命令解释器（command explainer）
 *
 * 使用方式：
 *   const { getExecApproval } = require('./exec-approval');
 *   const approval = getExecApproval({ mode: 'ask' });
 *   const decision = approval.evaluate('rm -rf /tmp/test');
 *   // decision = { allowed: false, mode: 'ask', risk: 'high', reason: '...' }
 */

// ============================================================================
// 安全模式
// ============================================================================

const EXEC_MODES = {
  DENY: 'deny',           // 禁止所有执行
  ALLOWLIST: 'allowlist', // 仅允许白名单命令
  ASK: 'ask',             // 未知命令需审批
  AUTO: 'auto',           // 低风险自动通过，高风险需审批
  FULL: 'full',           // 允许所有执行
};

// ============================================================================
// 风险评级
// ============================================================================

const RISK_LEVELS = {
  SAFE: 'safe',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

// 高风险命令模式
const HIGH_RISK_PATTERNS = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--force\s+)/i, risk: 'critical', reason: '强制删除文件' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|-R\s+)/i, risk: 'high', reason: '递归删除目录' },
  { pattern: /\b(sudo|doas|run0)\s+/i, risk: 'high', reason: '提权执行' },
  { pattern: /\bchmod\s+[0-7]{3,4}\s+/i, risk: 'medium', reason: '修改文件权限' },
  { pattern: /\bchown\s+/i, risk: 'medium', reason: '修改文件所有者' },
  { pattern: /\b(mkfs|dd\s+if=|fdisk|parted)\s+/i, risk: 'critical', reason: '磁盘操作' },
  { pattern: /\b(reboot|shutdown|poweroff|halt)\b/i, risk: 'critical', reason: '系统关机/重启' },
  { pattern: /\b(kill|killall|pkill)\s+(-9\s+|-KILL\s+)/i, risk: 'high', reason: '强制终止进程' },
  { pattern: /\bcurl\s+.*\|\s*(bash|sh|zsh)/i, risk: 'critical', reason: '远程脚本执行' },
  { pattern: /\bwget\s+.*\|\s*(bash|sh|zsh)/i, risk: 'critical', reason: '远程脚本执行' },
  { pattern: /\b(eval|exec)\s+/i, risk: 'high', reason: '动态代码执行' },
  { pattern: />\s*\/dev\/(sda|hda|nvme)/i, risk: 'critical', reason: '直接写入块设备' },
  { pattern: /\biptables\b/i, risk: 'high', reason: '防火墙规则修改' },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s+/i, risk: 'medium', reason: '停止/禁用系统服务' },
  { pattern: /\bdocker\s+(rm|rmi)\s+/i, risk: 'medium', reason: '删除容器/镜像' },
  { pattern: /\bnpm\s+publish\b/i, risk: 'medium', reason: '发布 npm 包' },
  { pattern: /\bgit\s+push\s+.*--force/i, risk: 'high', reason: '强制推送' },
];

// 安全二进制白名单
const SAFE_BINS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep', 'egrep', 'fgrep',
  'find', 'which', 'whereis', 'file', 'stat', 'du', 'df', 'free', 'uptime',
  'ps', 'top', 'htop', 'whoami', 'id', 'uname', 'hostname', 'date', 'cal',
  'echo', 'printf', 'true', 'false', 'test', 'expr', 'seq', 'yes',
  'pwd', 'basename', 'dirname', 'realpath', 'readlink',
  'git', 'gitk', 'tig',
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'python', 'python3', 'pip', 'pip3',
  'cargo', 'rustc', 'go',
  'make', 'cmake', 'gcc', 'g++',
  'curl', 'wget',  // 允许下载，但管道执行在上面已被标记为高风险
  'tar', 'gzip', 'gunzip', 'zip', 'unzip',
  'diff', 'patch', 'comm', 'cut', 'paste', 'tr', 'sed', 'awk',
  'jq', 'yq',
  'env', 'printenv', 'export',
  'mkdir', 'touch', 'cp', 'mv', 'ln',  // 基本文件操作
  'open', 'xdg-open',
  'code', 'vim', 'nano', 'less', 'more',
]);

// ============================================================================
// 命令分析
// ============================================================================

function parseCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) return { binary: '', args: [], raw: command };

  // 简单解析：提取第一个词作为二进制名
  const parts = trimmed.split(/\s+/);
  const binary = parts[0].split('/').pop(); // 取最后一部分作为二进制名
  const args = parts.slice(1);

  return { binary, args, raw: command };
}

function assessRisk(command) {
  const parsed = parseCommand(command);

  // 检查高风险模式
  for (const { pattern, risk, reason } of HIGH_RISK_PATTERNS) {
    if (pattern.test(command)) {
      return { risk, reason, binary: parsed.binary };
    }
  }

  // 检查安全二进制
  if (SAFE_BINS.has(parsed.binary)) {
    return { risk: 'safe', reason: 'Known safe binary', binary: parsed.binary };
  }

  // 未知二进制
  return { risk: 'medium', reason: 'Unknown binary', binary: parsed.binary };
}

// ============================================================================
// ExecApproval 类
// ============================================================================

class ExecApproval {
  constructor(config = {}) {
    this.mode = config.mode || EXEC_MODES.ASK;
    this.allowlist = new Set(config.allowlist || []);
    this.denylist = new Set(config.denylist || []);
   this.autoApproveSafe = config.autoApproveSafe !== false;
   this._decisionLog = [];
   this._persistPath = config.persistPath || null;
    this._approvalSystem = config.approvalSystem || null;

    // 加载持久化的审批决策
    if (this._persistPath) {
      this._loadFromDisk();
   }
 }

  /**
   * 注入审批系统引用
   * @param {Object} approvalSystem - 需暴露 request() 和 waitForApproval() 方法
   */
  setApprovalSystem(approvalSystem) {
    this._approvalSystem = approvalSystem;
  }

  /**
   * 评估命令是否允许执行
   * @param {string} command - 要执行的命令
   * @param {Object} context - 执行上下文
   * @returns {Object} { allowed, mode, risk, reason, requiresApproval }
   */
  // eslint-disable-next-line no-unused-vars
  evaluate(command, context = {}) {
    const riskAssessment = assessRisk(command);
    const parsed = parseCommand(command);

    // 拒绝列表检查
    if (this.denylist.has(parsed.binary)) {
      return {
        allowed: false,
        mode: this.mode,
        risk: riskAssessment.risk,
        reason: `Binary "${parsed.binary}" is in deny list`,
        requiresApproval: false,
      };
    }

    // 根据模式决策
    switch (this.mode) {
      case EXEC_MODES.DENY:
        return {
          allowed: false,
          mode: this.mode,
          risk: riskAssessment.risk,
          reason: 'Exec mode is set to deny',
          requiresApproval: false,
        };

      case EXEC_MODES.FULL:
        return {
          allowed: true,
          mode: this.mode,
          risk: riskAssessment.risk,
          reason: 'Exec mode is set to full',
          requiresApproval: false,
        };

      case EXEC_MODES.ALLOWLIST:
        if (this.allowlist.has(parsed.binary) || SAFE_BINS.has(parsed.binary)) {
          return {
            allowed: true,
            mode: this.mode,
            risk: riskAssessment.risk,
            reason: 'Binary is in allow list',
            requiresApproval: false,
          };
        }
        return {
          allowed: false,
          mode: this.mode,
          risk: riskAssessment.risk,
          reason: `Binary "${parsed.binary}" is not in allow list`,
          requiresApproval: true,
        };

      case EXEC_MODES.AUTO:
        // 安全命令自动通过
        if (riskAssessment.risk === 'safe' && this.autoApproveSafe) {
          return {
            allowed: true,
            mode: this.mode,
            risk: riskAssessment.risk,
            reason: 'Auto-approved: safe command',
            requiresApproval: false,
          };
        }
        // 低风险自动通过
        if (riskAssessment.risk === 'low') {
          return {
            allowed: true,
            mode: this.mode,
            risk: riskAssessment.risk,
            reason: 'Auto-approved: low risk',
            requiresApproval: false,
          };
        }
        // 中等及以上需要审批
        return {
          allowed: false,
          mode: this.mode,
          risk: riskAssessment.risk,
          reason: riskAssessment.reason,
          requiresApproval: true,
        };

      case EXEC_MODES.ASK:
      default:
        // 安全命令自动通过（可配置）
        if (riskAssessment.risk === 'safe' && this.autoApproveSafe) {
          return {
            allowed: true,
            mode: this.mode,
            risk: riskAssessment.risk,
            reason: 'Auto-approved: safe command',
            requiresApproval: false,
          };
        }
        // 其他都需要审批
        return {
          allowed: false,
          mode: this.mode,
          risk: riskAssessment.risk,
          reason: riskAssessment.reason,
          requiresApproval: true,
        };
   }
 }

  /**
   * 异步评估：先同步检查 evaluate()，需要审批时自动走审批流程
   * @param {string} command - 要执行的命令
   * @param {Object} context - 执行上下文
   * @returns {Promise<{allowed: boolean, approved: boolean, reason: string, requestId?: string, scope?: string}>}
   */
  async evaluateWithApproval(command, context = {}) {
    const decision = this.evaluate(command, context);

    // 不需要审批或已允许
    if (decision.allowed || !decision.requiresApproval) {
      return {
        allowed: decision.allowed,
        approved: decision.allowed,
        reason: decision.reason || 'Sync decision',
        mode: this.mode,
        risk: decision.risk,
      };
    }

    // 需要审批但未集成审批系统
    if (!this._approvalSystem) {
      return {
        allowed: false,
        approved: false,
        reason: decision.reason || 'Requires approval, but no approval system configured',
        mode: this.mode,
        risk: decision.risk,
        requiresApproval: true,
      };
    }

    const explanation = this.explainCommand(command);
    const summary = context.message || explanation.summary;

    // 发起审批请求
    const approvalRequest = await this._approvalSystem.request(command, {
      risk: decision.risk,
      source: 'exec-approval',
      summary,
      ...context,
    });

    // 自动审批（auto_approved / auto_denied）
    if (!approvalRequest.requestId) {
      const autoApproved = approvalRequest.status === 'auto_approved' || approvalRequest.status === 'approved';
      const reason = approvalRequest.reason || 'Auto decision';
      this.recordDecision(command, autoApproved, 'once');
      return {
        allowed: autoApproved,
        approved: autoApproved,
        reason,
        mode: this.mode,
        risk: decision.risk,
      };
    }

    // 等待用户回应
    try {
      const userDecision = await this._approvalSystem.waitForApproval(
        approvalRequest.requestId,
        (approvalRequest.timeout || 60) * 1000
      );

      // 2026-08-13 P1-7: approve-with-edits——批准时可携带编辑后的命令;
      // 编辑后命令必须重新安全检查(fail closed:未通过则不执行、不二次弹卡;
      // denylist 等场景 requiresApproval=false 但 allowed=false,同样拦截)
      const finalCommand = userDecision.command || command;
      if (userDecision.approved && finalCommand !== command) {
        const recheck = this.evaluate(finalCommand, context);
        if (!recheck.allowed) {
          this.recordDecision(command, false, 'once');
          return {
            allowed: false,
            approved: false,
            requestId: approvalRequest.requestId,
            reason: '编辑后的命令未通过安全检查',
            mode: this.mode,
            risk: recheck.risk,
            edited: true,
          };
        }
      }

      this.recordDecision(finalCommand, userDecision.approved, userDecision.scope);

      return {
        allowed: userDecision.approved,
        approved: userDecision.approved,
        scope: userDecision.scope,
        requestId: approvalRequest.requestId,
        reason: userDecision.approved ? '用户已授权' : '用户已拒绝',
        mode: this.mode,
        risk: decision.risk,
        command: finalCommand,
        edited: finalCommand !== command,
      };
    } catch (err) {
      this.recordDecision(command, false, 'once');
      return {
        allowed: false,
        approved: false,
        requestId: approvalRequest.requestId,
        reason: err.message,
        mode: this.mode,
        risk: decision.risk,
      };
    }
  }

  /**
   * 记录审批决策
   */
  recordDecision(command, approved, scope = 'once') {
    const parsed = parseCommand(command);
    const decision = {
      command: command.slice(0, 200),
      binary: parsed.binary,
      approved,
      scope,
      timestamp: Date.now(),
    };

    this._decisionLog.push(decision);

    // 如果是永久允许，加入白名单
    if (approved && scope === 'always') {
      this.allowlist.add(parsed.binary);
    }

    // 限制日志大小
    if (this._decisionLog.length > 1000) {
      this._decisionLog = this._decisionLog.slice(-500);
    }

    if (this._persistPath) {
      this._persistToDisk();
    }

    return decision;
  }

  /**
   * 解释命令（生成人类可读的描述）
   */
  explainCommand(command) {
    const risk = assessRisk(command);
    const parsed = parseCommand(command);

    const riskEmoji = {
      safe: '✅',
      low: '🟢',
      medium: '🟡',
      high: '🟠',
      critical: '🔴',
    };

    return {
      binary: parsed.binary,
      args: parsed.args,
      riskLevel: risk.risk,
      riskEmoji: riskEmoji[risk.risk] || '⚪',
      riskReason: risk.reason,
      isKnownSafe: SAFE_BINS.has(parsed.binary),
      summary: `${riskEmoji[risk.risk]} ${parsed.binary} — ${risk.reason}`,
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {

    const byApproved = { approved: 0, denied: 0 };
    for (const d of this._decisionLog) {
      byApproved[d.approved ? 'approved' : 'denied']++;
    }
    return {
      mode: this.mode,
      totalDecisions: this._decisionLog.length,
      byApproved,
      allowlistSize: this.allowlist.size,
      denylistSize: this.denylist.size,
    };
  }

  // 内部方法

  _persistToDisk() {
    if (!this._persistPath) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(this._persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._persistPath, JSON.stringify({
        version: 1,
        mode: this.mode,
        allowlist: [...this.allowlist],
        denylist: [...this.denylist],
        decisionLog: this._decisionLog.slice(-200),
      }, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[ExecApproval] 持久化失败:', e.message);
    }
  }

  _loadFromDisk() {
    if (!this._persistPath) return;
    try {
      const fs = require('fs');
      if (!fs.existsSync(this._persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this._persistPath, 'utf-8'));
      if (data.version === 1) {
        if (data.allowlist) {
          for (const bin of data.allowlist) this.allowlist.add(bin);
        }
        if (data.denylist) {
          for (const bin of data.denylist) this.denylist.add(bin);
        }
        if (data.decisionLog) {
          this._decisionLog = data.decisionLog;
        }
      }
    } catch (e) {
      console.warn('[ExecApproval] 加载失败:', e.message);
    }
  }
}

// ============================================================================
// 全局单例
// ============================================================================

let _globalApproval = null;

function getExecApproval(config) {
  if (!_globalApproval) {
    const path = require('path');
    const defaultPath = path.join(
      process.env.CONFIG_DIR || require('./path-utils').CRABPAW_HOME,
      'exec-approvals.json'
    );
    _globalApproval = new ExecApproval({
      persistPath: defaultPath,
      ...config,
    });
  }
  return _globalApproval;
}

function resetExecApproval() {
  _globalApproval = null;
}

module.exports = {
  ExecApproval,
  EXEC_MODES,
  RISK_LEVELS,
  SAFE_BINS,
  HIGH_RISK_PATTERNS,
  assessRisk,
  parseCommand,
  getExecApproval,
  resetExecApproval,
};
