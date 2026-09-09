const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  TASKFLOW_APPROVAL_STATUS
} = require('./taskflow-types');

const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

class ApprovalGate {
  constructor(store) {
    this._store = store;
    this._pendingApprovals = new Map();
    this._cleanupTimer = null;
    this._signingKey = null;
  }

  async initialize() {
    if (this._store && typeof this._store.loadPendingApprovals === 'function') {
      try {
        const pending = await this._store.loadPendingApprovals();
        for (const approval of pending) {
          if (approval.status === TASKFLOW_APPROVAL_STATUS.PENDING) {
            this._pendingApprovals.set(approval.approvalId, approval);
          }
        }
      } catch (e) {
        console.warn('⚠️ 加载待审批记录失败:', e.message);
      }
    }

    this._startCleanup();
    console.log('✅ ApprovalGate 初始化完成');
  }

  async createApproval(flowId, stepId, message, config = {}) {
    const approvalId = this._generateApprovalId();
    const resumeToken = this._generateResumeToken(flowId, stepId, approvalId);

    const approval = {
      approvalId,
      flowId,
      stepId,
      message: message || '需要审批',
      status: TASKFLOW_APPROVAL_STATUS.PENDING,
      resumeToken,
      createdAt: Date.now(),
      expiresAt: Date.now() + (config.expiryMs || APPROVAL_EXPIRY_MS),
      approver: config.approver || null,
      metadata: config.metadata || {},
      result: null,
      resolvedAt: null
    };

    this._pendingApprovals.set(approvalId, approval);

    if (this._store && typeof this._store.saveApproval === 'function') {
      await this._store.saveApproval(approval);
    }

    return {
      approvalId,
      resumeToken,
      message: approval.message,
      expiresAt: approval.expiresAt
    };
  }

  async resolveApproval(approvalId, approved, result = null) {
    const approval = this._pendingApprovals.get(approvalId);

    if (!approval) {
      if (this._store && typeof this._store.getApproval === 'function') {
        const stored = await this._store.getApproval(approvalId);
        if (stored) {
          this._pendingApprovals.set(approvalId, stored);
          return this._resolveFromStored(stored, approved, result);
        }
      }
      throw new Error(`审批记录不存在: ${approvalId}`);
    }

    if (approval.status !== TASKFLOW_APPROVAL_STATUS.PENDING) {
      throw new Error(`审批已处理: ${approvalId}, 当前状态: ${approval.status}`);
    }

    if (Date.now() > approval.expiresAt) {
      approval.status = TASKFLOW_APPROVAL_STATUS.EXPIRED;
      approval.resolvedAt = Date.now();
      this._pendingApprovals.delete(approvalId);
      if (this._store && typeof this._store.saveApproval === 'function') {
        await this._store.saveApproval(approval);
      }
      throw new Error(`审批已过期: ${approvalId}`);
    }

    approval.status = approved
      ? TASKFLOW_APPROVAL_STATUS.APPROVED
      : TASKFLOW_APPROVAL_STATUS.REJECTED;
    approval.result = result || (approved ? 'approved' : 'rejected');
    approval.resolvedAt = Date.now();

    this._pendingApprovals.delete(approvalId);

    if (this._store && typeof this._store.saveApproval === 'function') {
      await this._store.saveApproval(approval);
    }

    return {
      approvalId,
      flowId: approval.flowId,
      stepId: approval.stepId,
      approved,
      result: approval.result
    };
  }

  async resumeWithToken(resumeToken, approved, result = null) {
    const decoded = this._decodeResumeToken(resumeToken);
    if (!decoded) {
      throw new Error('无效的恢复令牌');
    }

    const { flowId, stepId, approvalId } = decoded;

    let approval = this._pendingApprovals.get(approvalId);
    if (!approval) {
      // If _pendingApprovals is empty (initialize may not have loaded yet), try store
      if (this._store && typeof this._store.getApproval === 'function') {
        const stored = await this._store.getApproval(approvalId);
        if (stored) {
          this._pendingApprovals.set(approvalId, stored);
          approval = stored;
        }
      }
      if (!approval) {
        throw new Error(`审批记录不存在或已处理: ${approvalId}`);
      }
    }

    if (approval.flowId !== flowId || approval.stepId !== stepId) {
      throw new Error('恢复令牌与审批记录不匹配');
    }

    return await this.resolveApproval(approvalId, approved, result);
  }

  parseResumeToken(token) {
    return this._decodeResumeToken(token);
  }

  async resolve(approvalId, approved, result = null) {
    return this.resolveApproval(approvalId, approved, result);
  }

  async expireApproval(approvalId) {
    const approval = this._pendingApprovals.get(approvalId);
    if (approval) {
      approval.status = TASKFLOW_APPROVAL_STATUS.EXPIRED;
      approval.resolvedAt = Date.now();
      this._pendingApprovals.delete(approvalId);
      if (this._store && typeof this._store.saveApproval === 'function') {
        await this._store.saveApproval(approval);
      }
    }
  }

  getApproval(approvalId) {
    return this._pendingApprovals.get(approvalId) || null;
  }

  listPendingApprovals(flowId) {
    const approvals = [];
    for (const approval of this._pendingApprovals.values()) {
      if (approval.status === TASKFLOW_APPROVAL_STATUS.PENDING) {
        if (!flowId || approval.flowId === flowId) {
          approvals.push(approval);
        }
      }
    }
    return approvals;
  }

  async expireStaleApprovals() {
    const now = Date.now();
    const expired = [];

    for (const [approvalId, approval] of this._pendingApprovals) {
      if (approval.status === TASKFLOW_APPROVAL_STATUS.PENDING && now > approval.expiresAt) {
        approval.status = TASKFLOW_APPROVAL_STATUS.EXPIRED;
        approval.resolvedAt = now;
        this._pendingApprovals.delete(approvalId);

        if (this._store && typeof this._store.saveApproval === 'function') {
          await this._store.saveApproval(approval);
        }

        expired.push(approvalId);
      }
    }

    if (expired.length > 0) {
      console.log(`🕐 已过期 ${expired.length} 个审批记录`);
    }

    return expired;
  }

  _generateApprovalId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `apr_${timestamp}_${random}`;
  }

  _generateResumeToken(flowId, stepId, approvalId) {
    const payload = JSON.stringify({ flowId, stepId, approvalId, ts: Date.now() });
    const encoded = Buffer.from(payload, 'utf-8').toString('base64url');
    const signature = crypto
      .createHmac('sha256', this._getSigningKey())
      .update(encoded)
      .digest('base64url');
    return `${encoded}.${signature}`;
  }

  _decodeResumeToken(token) {
    try {
      const [encoded, signature] = token.split('.');
      if (!encoded || !signature) return null;

      const expectedSig = crypto
        .createHmac('sha256', this._getSigningKey())
        .update(encoded)
        .digest('base64url');

      if (signature !== expectedSig) return null;

      const payload = Buffer.from(encoded, 'base64url').toString('utf-8');
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  _getSigningKey() {
    if (this._signingKey) return this._signingKey;

    if (process.env.CRABPAW_APPROVAL_KEY) {
      this._signingKey = process.env.CRABPAW_APPROVAL_KEY;
      return this._signingKey;
    }

    const keyDir = require('../core/path-utils').CRABPAW_HOME;
    const keyFile = path.join(keyDir, 'approval.key');

    try {
      if (fs.existsSync(keyFile)) {
        this._signingKey = fs.readFileSync(keyFile, 'utf-8').trim();
      } else {
        this._signingKey = crypto.randomBytes(64).toString('hex');

        if (!fs.existsSync(keyDir)) {
          fs.mkdirSync(keyDir, { recursive: true });
        }
        fs.writeFileSync(keyFile, this._signingKey, { mode: 0o600 });
        console.log('🔑 审批签名密钥已自动生成并持久化');
      }
    } catch (e) {
      console.warn('⚠️ 无法持久化审批签名密钥，使用内存临时密钥:', e.message);
      this._signingKey = crypto.randomBytes(64).toString('hex');
    }

    return this._signingKey;
  }

  async _resolveFromStored(stored, approved, result) {
    if (stored.status !== TASKFLOW_APPROVAL_STATUS.PENDING) {
      throw new Error(`审批已处理: ${stored.approvalId}, 当前状态: ${stored.status}`);
    }

    stored.status = approved
      ? TASKFLOW_APPROVAL_STATUS.APPROVED
      : TASKFLOW_APPROVAL_STATUS.REJECTED;
    stored.result = result || (approved ? 'approved' : 'rejected');
    stored.resolvedAt = Date.now();

    this._pendingApprovals.delete(stored.approvalId);

    if (this._store && typeof this._store.saveApproval === 'function') {
      await this._store.saveApproval(stored);
    }

    return {
      approvalId: stored.approvalId,
      flowId: stored.flowId,
      stepId: stored.stepId,
      approved,
      result: stored.result
    };
  }

  _startCleanup() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => {
      this.expireStaleApprovals().catch(e => {
        console.warn('⚠️ 审批过期清理失败:', e.message);
      });
    }, CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

let approvalGateInstance = null;
let approvalGateStore = null;

function getApprovalGate(store) {
  if (!approvalGateInstance) {
    approvalGateInstance = new ApprovalGate(store);
    approvalGateStore = store || null;
  } else if (store && approvalGateStore !== store) {
    console.warn('⚠️ ApprovalGate 单例已初始化，忽略新的 store 参数。如需更换 store，请先重置实例。');
  }
  return approvalGateInstance;
}

module.exports = {
  ApprovalGate,
  getApprovalGate
};
