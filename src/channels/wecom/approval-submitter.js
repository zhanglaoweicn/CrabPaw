/**
 * WeCom OA Approval Submitter
 *
 * Submits approval applications via the WeCom OA API (POST /cgi-bin/oa/applyevent).
 * Supports template-driven approvals with dynamic form data.
 */

const https = require('https');

class ApprovalSubmitter {
  constructor(config = {}) {
    this._corpId = config.corpId || '';
    this._secret = config.approvalSecret || config.secret || '';
    this._agentId = config.agentId || '';
    this._accessToken = '';
    this._tokenExpireTime = 0;
  }

  async _getAccessToken() {
    if (!this._corpId || !this._secret) {
      throw new Error('企业微信审批配置不完整 (corpId/secret)');
    }
    // 2026-09-06: 收口到 token-broker 单飞管理
    const { getWecomToken } = require('./token-broker');
    return getWecomToken(this._corpId, this._secret, 'approval');
  }

  async _httpPost(path, body) {
    const token = await this._getAccessToken();
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);
      const url = `https://qyapi.weixin.qq.com${path}?access_token=${token}`;
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errcode !== 0) {
              reject(new Error(`提交审批失败: ${parsed.errmsg}`));
              return;
            }
            resolve(parsed);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Submit an approval application.
   *
   * @param {Object} params
   * @param {string} params.creatorUserid - 申请人userid
   * @param {string} params.templateId - 审批模板ID
   * @param {number} [params.useTemplateApprover=1] - 是否使用模板默认审批流程(1=是,0=否)
   * @param {Array} [params.approver] - 自定义审批人 [{attr:0, user_id:["userid"]}]
   * @param {Array} [params.notifyType] - 通知方式 ["APP","SMS"]
   * @param {string[]} [params.notifyList] - 抄送人userid列表
   * @param {Array} params.applyData - 审批表单数据 [{control:"Text", id:"Field-xxx", value:{text:"..."}}]
   * @param {string} [params.summary] - 审批摘要（展示在列表页）
   * @returns {Promise<{spNo: string, errcode: number}>}
   */
  async submitApproval(params) {
    const body = {
      creator_userid: params.creatorUserid,
      template_id: params.templateId,
      use_template_approver: params.useTemplateApprover !== undefined ? params.useTemplateApprover : 1,
      apply_data: {
        contents: params.applyData || [],
      },
    };

    if (params.approver && params.approver.length > 0) {
      body.approver = params.approver;
    }

    if (params.notifyType && params.notifyType.length > 0) {
      body.notify_type = params.notifyType;
    }

    if (params.notifyList && params.notifyList.length > 0) {
      body.notify_list = params.notifyList;
    }

    if (params.summary) {
      body.summary = params.summary;
    }

    return this._httpPost('/cgi-bin/oa/applyevent', body);
  }
}

module.exports = { ApprovalSubmitter };
