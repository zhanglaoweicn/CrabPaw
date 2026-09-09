const { EventEmitter } = require('events');

const APPROVAL_STATUS = {
  PENDING: 1,
  APPROVED: 2,
  REJECTED: 3,
  CANCELLED: 4,
  REVOKED: 6,
  DELETED: 10,
};

const STATUS_LABELS = {
  [APPROVAL_STATUS.PENDING]: '待审批',
  [APPROVAL_STATUS.APPROVED]: '已通过',
  [APPROVAL_STATUS.REJECTED]: '已拒绝',
  [APPROVAL_STATUS.CANCELLED]: '已撤回',
  [APPROVAL_STATUS.REVOKED]: '已撤销',
  [APPROVAL_STATUS.DELETED]: '已删除',
};

class ApprovalHandler extends EventEmitter {
  constructor(config = {}) {
    super();
    this._corpId = config.corpId || '';
    this._secret = config.approvalSecret || '';
    this._agentId = config.agentId || '';
    this._accessToken = '';
    this._tokenExpireTime = 0;
    this._watchedTemplates = new Set(config.watchedTemplates || []);
    this._pendingApprovals = new Map();
    this._notifyChannel = config.notifyChannel || null;
  }

  setNotifyChannel(channel) {
    this._notifyChannel = channel;
  }

  setWatchedTemplates(templateIds) {
    this._watchedTemplates = new Set(templateIds);
  }

  async _getAccessToken() {
    if (!this._corpId || !this._secret) {
      throw new Error('企业微信审批配置不完整 (corpId/secret)');
    }
    // 2026-09-06: 收口到 token-broker 单飞管理
    const { getWecomToken } = require('./token-broker');
    return getWecomToken(this._corpId, this._secret, 'approval');
  }

  async handleStatusChange(eventData) {
    const {
      ApprovalNo: approvalNo,
      SpName: spName,
      SpStatus: spStatus,
      ApplyTime: applyTime,
      ApplyUserId: applyUserId,
      TemplateId: templateId,
    } = eventData;

    if (this._watchedTemplates.size > 0 && !this._watchedTemplates.has(templateId)) {
      return null;
    }

    const statusLabel = STATUS_LABELS[spStatus] || `未知(${spStatus})`;

    const approval = {
      approvalNo,
      spName,
      spStatus,
      statusLabel,
      applyTime: applyTime ? new Date(applyTime * 1000).toLocaleString('zh-CN') : '',
      applyUserId,
      templateId,
      timestamp: Date.now(),
    };

    if (spStatus === APPROVAL_STATUS.PENDING) {
      this._pendingApprovals.set(approvalNo, approval);
    } else {
      this._pendingApprovals.delete(approvalNo);
    }

    this.emit('status_change', approval);

    if (this._notifyChannel && spStatus !== APPROVAL_STATUS.PENDING) {
      await this._notifyApplicant(approval);
    }

    return approval;
  }

  async _notifyApplicant(approval) {
    if (!this._notifyChannel) return;

    const emoji = approval.spStatus === APPROVAL_STATUS.APPROVED ? '✅' : '❌';
    const message = [
      `${emoji} 审批状态更新`,
      `审批单号: ${approval.approvalNo}`,
      `审批名称: ${approval.spName}`,
      `当前状态: ${approval.statusLabel}`,
      `申请时间: ${approval.applyTime}`,
    ].join('\n');

    try {
      await this._notifyChannel.send(approval.applyUserId, message, 'single');
      this.emit('notify_success', { approvalNo: approval.approvalNo, userId: approval.applyUserId });
    } catch (e) {
      this.emit('notify_error', { approvalNo: approval.approvalNo, error: e.message });
    }
  }

  async getApprovalDetail(approvalNo) {
    const token = await this._getAccessToken();

    const resp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/oa/getapprovalinfo?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sp_no: approvalNo }),
      }
    );

    const data = await resp.json();
    if (data.errcode !== 0) {
      throw new Error(`获取审批详情失败: ${data.errmsg}`);
    }

    return data.info;
  }

  async getPendingApprovals(userId, templateId) {
    const token = await this._getAccessToken();

    const body = {
      cursor: 0,
      template_id: templateId || Array.from(this._watchedTemplates)[0] || '',
      max_result: 100,
    };

    if (userId) {
      body.new_approver = userId;
    }

    const resp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/oa/getapprovalinfo?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    const data = await resp.json();
    if (data.errcode !== 0) {
      throw new Error(`获取待审批列表失败: ${data.errmsg}`);
    }

    return data.sp_list || [];
  }

  getPendingCount() {
    return this._pendingApprovals.size;
  }

  getPendingList() {
    return Array.from(this._pendingApprovals.values());
  }
}

ApprovalHandler.APPROVAL_STATUS = APPROVAL_STATUS;
ApprovalHandler.STATUS_LABELS = STATUS_LABELS;

module.exports = { ApprovalHandler, APPROVAL_STATUS, STATUS_LABELS };
