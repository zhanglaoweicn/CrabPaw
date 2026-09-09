/**
 * WeCom External Contact (客户联系) Client
 *
 * Provides query tools for WeCom external contact management:
 * - List/get external contacts (客户)
 * - List external group chats (客户群)
 *
 * API docs: https://developer.work.weixin.qq.com/document/path/92113
 */

const https = require('https');

class ExternalContactClient {
  constructor(config = {}) {
    this._corpId = config.corpId || '';
    this._secret = config.externalContactSecret || config.secret || '';
    this._accessToken = '';
    this._tokenExpireTime = 0;
  }

  async _getAccessToken() {
    if (!this._corpId || !this._secret) {
      throw new Error('企业微信外部联系人配置不完整 (corpId/secret)');
    }
    // 2026-09-06: 收口到 token-broker 单飞管理
    const { getWecomToken } = require('./token-broker');
    return getWecomToken(this._corpId, this._secret, 'external_contact');
  }

  async _httpGet(path) {
    const token = await this._getAccessToken();
    return new Promise((resolve, reject) => {
      https.get(`https://qyapi.weixin.qq.com${path}&access_token=${token}`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.errcode !== 0) {
              reject(new Error(`外部联系人API失败: ${parsed.errmsg}`));
              return;
            }
            resolve(parsed);
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  async _httpPost(path, body) {
    const token = await this._getAccessToken();
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);
      const req = https.request(`https://qyapi.weixin.qq.com${path}?access_token=${token}`, {
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
              reject(new Error(`外部联系人API失败: ${parsed.errmsg}`));
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
   * Get external contact list for a specific user.
   * @param {string} userId - 企业成员的userid
   * @returns {Promise<{external_userid: string[]}>}
   */
  async listExternalContacts(userId) {
    return this._httpGet(`/cgi-bin/externalcontact/list?userid=${userId}`);
  }

  /**
   * Get external contact details.
   * @param {string} externalUserId - 外部联系人的userid
   * @returns {Promise<Object>} - 客户详情
   */
  async getExternalContact(externalUserId) {
    return this._httpGet(`/cgi-bin/externalcontact/get?external_userid=${externalUserId}`);
  }

  /**
   * List external group chats with optional filters.
   * @param {Object} [filters]
   * @param {string[]} [filters.statusFilter] - 群状态过滤(0=所有,1=离职继承中,2=离职继承完成)
   * @param {number} [filters.limit=50] - 最大返回数
   * @returns {Promise<{group_chat_list: Array}>}
   */
  async listGroupChats(filters = {}) {
    const body = {};
    if (filters.statusFilter) body.status_filter = filters.statusFilter;
    body.offset = filters.offset || 0;
    body.limit = filters.limit || 50;
    return this._httpPost('/cgi-bin/externalcontact/groupchat/list', body);
  }

  /**
   * Get external contact group chat details.
   * @param {string} chatId - 客户群ID
   * @returns {Promise<Object>}
   */
  async getGroupChatDetail(chatId) {
    return this._httpPost('/cgi-bin/externalcontact/groupchat/get', { chat_id: chatId });
  }
}

module.exports = { ExternalContactClient };
