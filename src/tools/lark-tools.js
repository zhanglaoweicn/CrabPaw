/**
 * 飞书增强工具集
 * 
 * 提供完整的飞书集成能力：
 * 1. 消息管理 - 文本/卡片消息
 * 2. 文档管理 - 创建文档
 * 3. 多维表格 - 查询/创建记录
 * 4. 日历管理 - 创建/查询日程
 * 5. 任务管理 - 创建任务
 * 6. 知识库管理 - 查询知识空间
 */

const { registry } = require('./registry');
const config = require('../core/config');
const https = require('https');

// ===== 飞书 API 客户端 =====
class LarkAPIClient {
  constructor() {
    this._appId = '';
    this._appSecret = '';
    this._accessToken = '';
    this._tokenExpireTime = 0;
    this._checkConfig();
  }

  _checkConfig() {
    try {
      const appConfig = config.loadConfig();
      const larkConfig = appConfig.lark || {};
      this._appId = larkConfig.appId || process.env.LARK_APP_ID || '';
      this._appSecret = larkConfig.appSecret || '';
      this.isConfigured = !!(this._appId && this._appSecret);
    } catch (e) {
      console.warn('[LarkTools] Configuration check failed:', e);
      this.isConfigured = false;
    }
  }

  async _getAccessToken() {
    if (this._accessToken && this._tokenExpireTime > Date.now() + 300000) {
      return this._accessToken;
    }
    if (!this.isConfigured) throw new Error('飞书未配置');

    const body = JSON.stringify({ app_id: this._appId, app_secret: this._appSecret });
    const data = await this._httpPost('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', body);
    if (data.code !== 0) throw new Error(`获取access_token失败: ${data.msg}`);
    this._accessToken = data.tenant_access_token;
    this._tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
    return this._accessToken;
  }

  async _httpGet(url, options = {}) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('GET request timeout')); });
      req.on('error', reject);
    });
  }

  async _httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const postData = typeof body === 'string' ? body : JSON.stringify(body);
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...headers }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('POST request timeout')); });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  async apiGet(path) {
    const token = await this._getAccessToken();
    return this._httpGet(`https://open.feishu.cn${path}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  }

  async apiPost(path, body) {
    const token = await this._getAccessToken();
    return this._httpPost(`https://open.feishu.cn${path}`, body, {
      'Authorization': `Bearer ${token}`
    });
  }

  async apiPatch(path, body) {
    const token = await this._getAccessToken();
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(body);
      const req = https.request(`https://open.feishu.cn${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'Authorization': `Bearer ${token}` }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }
}

let larkClient = null;
function getLarkClient() {
  if (!larkClient) larkClient = new LarkAPIClient();
  return larkClient;
}

// ===== 注册工具 =====

// 发送文本消息
registry.register({
  name: 'LarkSendText',
  toolset: 'lark',
  category: 'lark/message',
  description: '通过飞书发送文本消息给指定用户',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        receiveId: { type: 'string', description: '接收者open_id' },
        content: { type: 'string', description: '消息内容' }
      },
      required: ['receiveId', 'content']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    return client.apiPost('/open-apis/im/v1/messages?receive_id_type=open_id', {
      receive_id: params.receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: params.content })
    });
  }
});

// 发送卡片消息
registry.register({
  name: 'LarkSendCard',
  toolset: 'lark',
  category: 'lark/message',
  description: '通过飞书发送交互式卡片消息',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        receiveId: { type: 'string', description: '接收者open_id' },
        title: { type: 'string', description: '卡片标题' },
        content: { type: 'string', description: '卡片内容（支持Markdown）' }
      },
      required: ['receiveId', 'title', 'content']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: params.title } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: params.content } }]
    };
    return client.apiPost('/open-apis/im/v1/messages?receive_id_type=open_id', {
      receive_id: params.receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    });
  }
});

// ── 流式卡片 (DeerFlow 启发) ────────────────────────────────
registry.register({
  name: 'LarkStreamCard',
  toolset: 'lark',
  category: 'lark/message',
  description: '飞书流式卡片 — 创建一张可实时更新的卡片，支持打字机效果。分步更新：创建→更新进度→最终结果。messageId 在创建时返回，后续用 messageId 更新同一张卡片。',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'finalize'], description: 'create: 创建卡片并返回 messageId。update: 更新卡片内容。finalize: 标记完成并可选添加按钮' },
        receiveId: { type: 'string', description: '接收者open_id (create时必填)' },
        messageId: { type: 'string', description: '要更新的卡片ID (update/finalize时必填)' },
        title: { type: 'string', description: '卡片标题' },
        content: { type: 'string', description: '卡片内容 (支持飞书Markdown)' },
        status: { type: 'string', description: '进度状态文本，如"正在搜索…" / "搜索完成" / "正在生成回复…"' },
        buttonText: { type: 'string', description: 'finalize时的按钮文字' },
        buttonUrl: { type: 'string', description: 'finalize时的按钮链接' },
      },
      required: ['action']
    }
  },
  async handler(params) {
    const client = getLarkClient();

    if (params.action === 'create') {
      if (!params.receiveId) throw new Error('create 需要 receiveId');
      const statusText = params.status || '处理中…';
      const card = {
        config: { wide_screen_mode: true, update_multi: true },
        header: { title: { tag: 'plain_text', content: params.title || 'CrabPaw' }, template: 'blue' },
        elements: [
          { tag: 'hr' },
          { tag: 'div', text: { tag: 'lark_md', content: `⏳ **${statusText}**\n\n${params.content || '请稍候…'}` } },
          { tag: 'hr' },
          { tag: 'note', elements: [{ tag: 'plain_text', content: 'CrabPaw · 流式卡片' }] },
        ],
      };
      const res = await client.apiPost('/open-apis/im/v1/messages?receive_id_type=open_id', {
        receive_id: params.receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      });
      return { action: 'create', messageId: res.data?.message_id, status: statusText, _hint: `卡片已创建，messageId: ${res.data?.message_id}。用此 ID 调用 update 更新内容。` };
    }

    if (params.action === 'update') {
      if (!params.messageId) throw new Error('update 需要 messageId');
      const statusText = params.status || '处理中…';
      const card = {
        config: { wide_screen_mode: true, update_multi: true },
        header: { title: { tag: 'plain_text', content: params.title || 'CrabPaw' }, template: 'blue' },
        elements: [
          { tag: 'hr' },
          { tag: 'div', text: { tag: 'lark_md', content: `${statusText.includes('完成') || statusText.includes('✅') ? '✅' : '⏳'} **${statusText}**\n\n${params.content || ''}` } },
          { tag: 'hr' },
          { tag: 'note', elements: [{ tag: 'plain_text', content: 'CrabPaw · 流式更新中' }] },
        ],
      };
      await client.apiPatch(`/open-apis/im/v1/messages/${params.messageId}`, {
        content: JSON.stringify(card),
      });
      return { action: 'update', messageId: params.messageId, status: statusText };
    }

    if (params.action === 'finalize') {
      if (!params.messageId) throw new Error('finalize 需要 messageId');
      const elements = [
        { tag: 'hr' },
        { tag: 'div', text: { tag: 'lark_md', content: `✅ **完成**\n\n${params.content || ''}` } },
      ];
      if (params.buttonText && params.buttonUrl) {
        elements.push({ tag: 'hr' });
        elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: params.buttonText }, url: params.buttonUrl, type: 'primary' }] });
      }
      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: params.title || 'CrabPaw' }, template: 'green' },
        elements,
      };
      await client.apiPatch(`/open-apis/im/v1/messages/${params.messageId}`, {
        content: JSON.stringify(card),
      });
      return { action: 'finalize', messageId: params.messageId, _hint: '流式卡片已标记为完成。' };
    }

    throw new Error(`未知 action: ${params.action}`);
  }
});

// 创建文档
registry.register({
  name: 'LarkCreateDocument',
  toolset: 'lark',
  category: 'lark/document',
  description: '创建飞书云文档',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        folderToken: { type: 'string', description: '文件夹token（可选）' }
      },
      required: ['title']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    return client.apiPost('/open-apis/docx/v1/documents', {
      title: params.title,
      folder_token: params.folderToken || ''
    });
  }
});

// 查询多维表格记录
registry.register({
  name: 'LarkQueryBitable',
  toolset: 'lark',
  category: 'lark/bitable',
  description: '查询飞书多维表格记录',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        appToken: { type: 'string', description: '多维表格appToken' },
        tableId: { type: 'string', description: '数据表ID' },
        filter: { type: 'string', description: '过滤条件（可选）' },
        pageSize: { type: 'number', description: '每页记录数，默认20' }
      },
      required: ['appToken', 'tableId']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    let path = `/open-apis/bitable/v1/apps/${params.appToken}/tables/${params.tableId}/records?page_size=${params.pageSize || 20}`;
    if (params.filter) path += `&filter=${encodeURIComponent(params.filter)}`;
    return client.apiGet(path);
  }
});

// 创建多维表格记录
registry.register({
  name: 'LarkCreateBitableRecord',
  toolset: 'lark',
  category: 'lark/bitable',
  description: '在飞书多维表格中创建记录',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        appToken: { type: 'string', description: '多维表格appToken' },
        tableId: { type: 'string', description: '数据表ID' },
        fields: { type: 'object', description: '字段键值对' }
      },
      required: ['appToken', 'tableId', 'fields']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    return client.apiPost(`/open-apis/bitable/v1/apps/${params.appToken}/tables/${params.tableId}/records`, {
      fields: params.fields
    });
  }
});

// 查询日历日程
registry.register({
  name: 'LarkQueryCalendarEvents',
  toolset: 'lark',
  category: 'lark/calendar',
  description: '查询飞书日历日程',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: '日历ID' },
        startTime: { type: 'string', description: '开始时间（Unix时间戳，秒）' },
        endTime: { type: 'string', description: '结束时间（Unix时间戳，秒）' }
      },
      required: ['calendarId', 'startTime', 'endTime']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    return client.apiGet(`/open-apis/calendar/v4/calendars/${params.calendarId}/events?start_time=${params.startTime}&end_time=${params.endTime}`);
  }
});

// 创建日历日程
registry.register({
  name: 'LarkCreateCalendarEvent',
  toolset: 'lark',
  category: 'lark/calendar',
  description: '创建飞书日历日程',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: '日历ID' },
        summary: { type: 'string', description: '日程标题' },
        description: { type: 'string', description: '日程描述' },
        startTime: { type: 'string', description: '开始时间（Unix时间戳，秒）' },
        endTime: { type: 'string', description: '结束时间（Unix时间戳，秒）' }
      },
      required: ['calendarId', 'summary', 'startTime', 'endTime']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    return client.apiPost(`/open-apis/calendar/v4/calendars/${params.calendarId}/events`, {
      summary: params.summary,
      description: params.description || '',
      start_time: { timestamp: params.startTime },
      end_time: { timestamp: params.endTime }
    });
  }
});

// 创建任务
registry.register({
  name: 'LarkCreateTask',
  toolset: 'lark',
  category: 'lark/task',
  description: '创建飞书任务',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '任务标题' },
        description: { type: 'string', description: '任务描述' },
        dueTime: { type: 'string', description: '截止时间（Unix时间戳，秒）' }
      },
      required: ['summary']
    }
  },
  async handler(params) {
    const client = getLarkClient();
    const body = { summary: params.summary, description: params.description || '' };
    if (params.dueTime) body.due = { timestamp: params.dueTime };
    return client.apiPost('/open-apis/task/v2/tasks', body);
  }
});

// 查询知识库
registry.register({
  name: 'LarkQueryWiki',
  toolset: 'lark',
  category: 'lark/wiki',
  description: '查询飞书知识空间列表',
  schema: {
    parameters: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: '每页数量，默认20' }
      }
    }
  },
  async handler(params) {
    const client = getLarkClient();
    return client.apiGet(`/open-apis/wiki/v2/spaces?page_size=${params.pageSize || 20}`);
  }
});

console.log('🐦 飞书增强工具集已注册: LarkSendText, LarkSendCard, LarkCreateDocument, LarkQueryBitable, LarkCreateBitableRecord, LarkQueryCalendarEvents, LarkCreateCalendarEvent, LarkCreateTask, LarkQueryWiki');

// ── lark-bitable 数据源自注册（tools→core 方向合法；core 侧 installBuiltinSources
//    不能 require 本文件——层契约 R1 禁 core→upper 反向依赖）──
try {
  const { registerSource } = require('../core/data-sources/registry');
  registerSource({
    name: 'lark-bitable',
    description: 'Lark Bitable 多维表格记录查询(需飞书鉴权已配置 + appToken/tableId 参数)',
    fetch: (p = {}) => {
      const client = getLarkClient();
      if (!client.isConfigured) return Promise.reject(new Error('飞书未配置(需真实 appId/appSecret)'));
      if (!p.appToken || !p.tableId) return Promise.reject(new Error('缺少 appToken/tableId 参数'));
      let bitablePath = `/open-apis/bitable/v1/apps/${p.appToken}/tables/${p.tableId}/records?page_size=${p.pageSize || 20}`;
      if (p.filter) bitablePath += `&filter=${encodeURIComponent(p.filter)}`;
      return client.apiGet(bitablePath);
    },
    health: () => Promise.resolve(getLarkClient().isConfigured ? 'ok' : 'degraded'),
  });
  console.log('🔵 数据源已注册: lark-bitable (Lark Bitable 记录查询)');
} catch (e) {
  console.warn('[lark-tools] lark-bitable 数据源注册失败(不阻塞):', e.message || e);
}

module.exports = { LarkAPIClient, getLarkClient };
