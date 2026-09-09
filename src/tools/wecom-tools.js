/**
 * 企业微信增强工具集
 * 
 * 提供完整的企业微信集成能力：
 * 1. 消息管理 - 文本/卡片/Markdown消息
 * 2. 审批管理 - 查询审批
 * 3. 日历管理 - 查询日程
 * 4. 通讯录管理 - 查询部门成员
 * 5. 群聊管理 - 创建群聊
 * 6. 待办管理 - 查询待办
 */

const { registry } = require('./registry');
const config = require('../core/config');
const https = require('https');

// ===== 企业微信 API 客户端 =====
class WeComAPIClient {
  constructor() {
    this._corpId = '';
    this._secret = '';
    this._accessToken = '';
    this._tokenExpireTime = 0;
    this._checkConfig();
  }

  _checkConfig() {
    try {
      const appConfig = config.loadConfig();
      const wecomConfig = appConfig.wecom || {};
      this._corpId = wecomConfig.corpId || process.env.WECOM_CORP_ID || '';
      this._secret = wecomConfig.secret || '';
      this.isConfigured = !!(this._corpId && this._secret);
    } catch {
      this.isConfigured = false;
    }
  }

  async _getAccessToken() {
    if (!this.isConfigured) throw new Error('企业微信未配置');
    // 2026-09-06: 收口到 token-broker 单飞管理（原实现 expires_in 缺失时
    // 用 || 7200 风格不一，且无 in-flight 合并）
    const { getWecomToken } = require('../channels/wecom/token-broker');
    return getWecomToken(this._corpId, this._secret, 'bot');
  }

  async _httpGet(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
  }

  async _httpPost(url, body) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);
      const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async apiGet(path) {
    const token = await this._getAccessToken();
    return this._httpGet(`https://qyapi.weixin.qq.com${path}?access_token=${token}`);
  }

  async apiPost(path, body) {
    const token = await this._getAccessToken();
    return this._httpPost(`https://qyapi.weixin.qq.com${path}?access_token=${token}`, body);
  }
}

let wecomClient = null;
function getWeComClient() {
  if (!wecomClient) wecomClient = new WeComAPIClient();
  return wecomClient;
}

// 缓存：外部联系人专用 access_token
let _customerTokenCache = '';
let _customerTokenExpire = 0;

/**
 * 获取外部联系人（客户联系）API 的 access_token。
 * 如果配置了 customerSecret 则优先使用专用 secret，否则回退到通用 token。
 */
async function _getCustomerAccessToken() {
  if (_customerTokenCache && _customerTokenExpire > Date.now() + 300000) {
    return _customerTokenCache;
  }

  const { getCredentialManager } = require('../core/credential-manager');
  const creds = getCredentialManager().getWecomCredentials();
  const client = getWeComClient();
  const corpId = creds.corpId || client._corpId;

  if (creds.customerSecret) {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${creds.customerSecret}`;
    const data = await client._httpGet(url);
    if (data.errcode !== 0) throw new Error(`获取客户联系 access_token 失败: ${data.errmsg}`);
    _customerTokenCache = data.access_token;
    _customerTokenExpire = Date.now() + (data.expires_in || 7200) * 1000;
    return _customerTokenCache;
  }

  // 无专用 secret 时回退到通用 token
  return client._getAccessToken();
}

// ===== 注册工具 =====

// 发送文本消息
registry.register({
  name: 'WeComSendText',
  toolset: 'wecom',
  category: 'wecom/message',
  description: '通过企业微信发送文本消息',
  schema: {
    type: 'object',
    properties: {
      chatId: { type: 'string', description: '会话ID（用户ID或群聊ID）' },
      content: { type: 'string', description: '消息内容' },
      mentionedList: { type: 'array', items: { type: 'string' }, description: '@的用户ID列表' }
    },
    required: ['chatId', 'content']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/message/send', {
      touser: params.chatId,
      msgtype: 'text',
      agentid: config.loadConfig().wecom?.agentId,
      text: { content: params.content, mentioned_list: params.mentionedList || [] }
    });
  }
});

// 发送卡片消息
registry.register({
  name: 'WeComSendCard',
  toolset: 'wecom',
  category: 'wecom/message',
  description: '通过企业微信发送文本卡片消息',
  schema: {
    type: 'object',
    properties: {
      chatId: { type: 'string', description: '会话ID' },
      title: { type: 'string', description: '卡片标题' },
      description: { type: 'string', description: '卡片描述' },
      url: { type: 'string', description: '卡片跳转链接' },
      btntxt: { type: 'string', description: '按钮文字，默认"详情"' }
    },
    required: ['chatId', 'title', 'description']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/message/send', {
      touser: params.chatId,
      msgtype: 'textcard',
      agentid: config.loadConfig().wecom?.agentId,
      textcard: { title: params.title, description: params.description, url: params.url || '', btntxt: params.btntxt || '详情' }
    });
  }
});

// ── 企微卡片更新 (DeerFlow 启发) ─────────────────────────────
registry.register({
  name: 'WeComUpdateCard',
  toolset: 'wecom',
  category: 'wecom/message',
  description: '更新企业微信已发送的卡片 — 替换为新的标题/描述/状态。用于展示任务进度变化，如"正在搜索…"→"搜索完成"→"正在生成回复…"。需要先通过 WeComSendCard 获取 msgId。',
  schema: {
    type: 'object',
    properties: {
      chatId: { type: 'string', description: '会话ID或用户ID' },
      title: { type: 'string', description: '新卡片标题' },
      description: { type: 'string', description: '新卡片描述（支持\\n换行，显示进度信息）' },
      url: { type: 'string', description: '卡片跳转链接（可选）' },
      btntxt: { type: 'string', description: '按钮文字（可选）' },
      statusEmoji: { type: 'string', description: '状态表情：⏳ 🔄 ✅ ❌（可选）' },
    },
    required: ['chatId', 'title', 'description']
  },
  async handler(params) {
    const client = getWeComClient();
    const emoji = params.statusEmoji || '';
    const desc = emoji ? `${emoji} ${params.description}` : params.description;
    return client.apiPost('/cgi-bin/message/send', {
      touser: params.chatId,
      msgtype: 'textcard',
      agentid: config.loadConfig().wecom?.agentId,
      textcard: {
        title: params.title,
        description: desc,
        url: params.url || '',
        btntxt: params.btntxt || '详情',
      },
    });
  }
});

// 发送Markdown消息
registry.register({
  name: 'WeComSendMarkdown',
  toolset: 'wecom',
  category: 'wecom/message',
  description: '通过企业微信发送Markdown格式消息',
  schema: {
    type: 'object',
    properties: {
      chatId: { type: 'string', description: '会话ID' },
      content: { type: 'string', description: 'Markdown内容' }
    },
    required: ['chatId', 'content']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/message/send', {
      touser: params.chatId,
      msgtype: 'markdown',
      agentid: config.loadConfig().wecom?.agentId,
      markdown: { content: params.content }
    });
  }
});

// 查询审批
registry.register({
  name: 'WeComQueryApproval',
  toolset: 'wecom',
  category: 'wecom/approval',
  description: '查询企业微信审批单详情',
  schema: {
    type: 'object',
    properties: {
      spNo: { type: 'string', description: '审批单号' }
    },
    required: ['spNo']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/oa/getapprovalinfo', { sp_no: params.spNo });
  }
});

// 查询日历
registry.register({
  name: 'WeComQueryCalendar',
  toolset: 'wecom',
  category: 'wecom/calendar',
  description: '查询企业微信日历日程',
  schema: {
    type: 'object',
    properties: {
      startTime: { type: 'number', description: '开始时间戳（秒）' },
      endTime: { type: 'number', description: '结束时间戳（秒）' }
    },
    required: ['startTime', 'endTime']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/oa/schedule/get_by_calendar', {
      starttime: params.startTime,
      endtime: params.endTime
    });
  }
});

// 查询通讯录
registry.register({
  name: 'WeComQueryContacts',
  toolset: 'wecom',
  category: 'wecom/contacts',
  description: '查询企业微信通讯录（部门成员列表）',
  schema: {
    type: 'object',
    properties: {
      departmentId: { type: 'number', description: '部门ID，根部门为1' },
      fetchChild: { type: 'boolean', description: '是否递归获取子部门' }
    },
    required: ['departmentId']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiGet(`/cgi-bin/user/list?department_id=${params.departmentId}&fetch_child=${params.fetchChild ? 1 : 0}`);
  }
});

// 创建群聊
registry.register({
  name: 'WeComCreateChat',
  toolset: 'wecom',
  category: 'wecom/chat',
  description: '创建企业微信群聊',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '群聊名称' },
      owner: { type: 'string', description: '群主ID' },
      userList: { type: 'array', items: { type: 'string' }, description: '群成员ID列表（2-500人）' }
    },
    required: ['name', 'owner', 'userList']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/appchat/create', {
      name: params.name,
      owner: params.owner,
      userlist: params.userList
    });
  }
});

// ── OA审批提交 ─────────────────────────────────────────────
registry.register({
  name: 'WeComSubmitApproval',
  toolset: 'wecom',
  category: 'wecom/approval',
  description: '提交企业微信审批申请，返回审批单号 sp_no 供后续查询',
  schema: {
    type: 'object',
    properties: {
      creator_userid: { type: 'string', description: '申请人 userid' },
      template_id: { type: 'string', description: '审批模板 ID' },
      approver: {
        type: 'array', items: { type: 'object', properties: { userid: { type: 'string' } } },
        description: '审批人列表，如 [{userid: "user1"}, {userid: "user2"}]'
      },
      apply_data: {
        type: 'array', items: { type: 'object' },
        description: '申请内容数据，格式 [{control: "Text", id: "...", title: ["标题"], value: {text: "内容"}}]'
      },
      summary: { type: 'string', description: '审批摘要（显示在审批列表）' },
      notifyer: {
        type: 'array', items: { type: 'object', properties: { userid: { type: 'string' } } },
        description: '抄送人列表，如 [{userid: "user1"}]'
      },
      use_template_approver: { type: 'boolean', description: '是否使用模板默认审批流程，为 true 时忽略 approver' }
    },
    required: ['creator_userid', 'template_id']
  },
  async handler(params) {
    const client = getWeComClient();
    const body = {
      creator_userid: params.creator_userid,
      template_id: params.template_id,
      use_template_approver: params.use_template_approver ? 1 : 0,
    };

    if (params.approver && params.approver.length > 0) {
      body.approver = params.approver.map(a => ({ attr: 2, userid: [a.userid] }));
    }
    if (params.notifyer && params.notifyer.length > 0) {
      body.notifyer = params.notifyer.map(n => ({ attr: 2, userid: [n.userid] }));
    }
    if (params.apply_data && params.apply_data.length > 0) {
      body.apply_data = { contents: params.apply_data };
    }
    if (params.summary) {
      body.summary_list = [{ summary_info: { text: params.summary, lang: 'zh_CN' } }];
    }

    return client.apiPost('/cgi-bin/oa/applyevent', body);
  }
});

// ── 外部联系人（客户）管理 ──────────────────────────────────
registry.register({
  name: 'WeComExternalContactList',
  toolset: 'wecom',
  category: 'wecom/contacts',
  description: '获取企业微信外部联系人（客户）列表，根据跟进成员 userid 查询',
  schema: {
    type: 'object',
    properties: {
      userid: { type: 'string', description: '跟进成员的 userid' }
    },
    required: ['userid']
  },
  async handler(params) {
    const client = getWeComClient();
    const token = await _getCustomerAccessToken();
    return client._httpGet(
      `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/list?access_token=${token}&userid=${encodeURIComponent(params.userid)}`
    );
  }
});

registry.register({
  name: 'WeComExternalContactGet',
  toolset: 'wecom',
  category: 'wecom/contacts',
  description: '获取单个企业微信外部联系人详细信息',
  schema: {
    type: 'object',
    properties: {
      external_userid: { type: 'string', description: '外部联系人 userid' }
    },
    required: ['external_userid']
  },
  async handler(params) {
    const client = getWeComClient();
    const token = await _getCustomerAccessToken();
    return client._httpGet(
      `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/get?access_token=${token}&external_userid=${encodeURIComponent(params.external_userid)}`
    );
  }
});

registry.register({
  name: 'WeComExternalContactGroupChatList',
  toolset: 'wecom',
  category: 'wecom/contacts',
  description: '获取企业微信客户群列表',
  schema: {
    type: 'object',
    properties: {
      status_filter: { type: 'integer', description: '群状态过滤：0-所有群 1-群主离职 2-群异常' },
      offset: { type: 'integer', description: '分页偏移，从 0 开始' },
      limit: { type: 'integer', description: '分页大小，最大 200' }
    },
    required: []
  },
  async handler(params) {
    const client = getWeComClient();
    const token = await _getCustomerAccessToken();
    return client._httpPost(
      `https://qyapi.weixin.qq.com/cgi-bin/externalcontact/groupchat/list?access_token=${token}`,
      {
        status_filter: params.status_filter || 0,
        offset: params.offset || 0,
        limit: params.limit || 100,
      }
    );
  }
});

// ── 会议管理 ─────────────────────────────────────────────────
registry.register({
  name: 'WeComCreateMeeting',
  toolset: 'wecom',
  category: 'wecom/meeting',
  description: '创建企业微信会议，返回 meeting_id 和会议链接',
  schema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '会议主题' },
      start_time: { type: 'integer', description: '开始时间（Unix 时间戳，秒）' },
      end_time: { type: 'integer', description: '结束时间（Unix 时间戳，秒）' },
      participants: {
        type: 'array', items: { type: 'object', properties: { userid: { type: 'string' } } },
        description: '参会人列表，如 [{userid: "user1"}]'
      },
      meeting_type: { type: 'integer', description: '会议类型：1-即时会议 2-预约会议（默认 2）' },
      password: { type: 'string', description: '会议密码（可选）' },
      description: { type: 'string', description: '会议描述（可选）' },
      location: { type: 'string', description: '会议地点（可选）' },
      remind_time: { type: 'integer', description: '提前提醒分钟数（可选）' }
    },
    required: ['topic', 'start_time', 'end_time']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/meeting/create', {
      topic: params.topic,
      type: params.meeting_type || 2,
      start_time: params.start_time,
      end_time: params.end_time,
      participants: (params.participants || []).map(p => ({ userid: p.userid })),
      password: params.password || '',
      description: params.description || '',
      location: params.location || '',
      remind_time: params.remind_time || 0,
    });
  }
});

registry.register({
  name: 'WeComGetMeetingInfo',
  toolset: 'wecom',
  category: 'wecom/meeting',
  description: '获取企业微信会议详细信息（参会人、状态等）',
  schema: {
    type: 'object',
    properties: {
      meeting_id: { type: 'string', description: '会议 ID' }
    },
    required: ['meeting_id']
  },
  async handler(params) {
    const client = getWeComClient();
    return client.apiPost('/cgi-bin/meeting/get_info_list', {
      meeting_id: params.meeting_id,
    });
  }
});

console.log('💼 企业微信增强工具集已注册: WeComSendText, WeComSendCard, WeComSendMarkdown, WeComUpdateCard, WeComQueryApproval, WeComQueryCalendar, WeComQueryContacts, WeComCreateChat, WeComSubmitApproval, WeComExternalContactList, WeComExternalContactGet, WeComExternalContactGroupChatList, WeComCreateMeeting, WeComGetMeetingInfo');

module.exports = { WeComAPIClient, getWeComClient };
