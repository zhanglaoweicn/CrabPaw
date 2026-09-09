/**
 * Platform API Tools - 第三方平台 API 对接工具
 *
 * 支持：
 *   - 微信公众号草稿/发布
 *   - Lark/飞书文档操作
 *   更多平台持续添加
 *
 * 凭证从 data/platform-keys.json 读取，格式：
 * {
 *   "wechat_mp": { "appId": "", "appSecret": "" },
 *   "lark": { "appId": "", "appSecret": "" }
 * }
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { registry } = require('./registry');

const PLATFORM_KEYS_FILE = path.join(require('../core/config').DATA_DIR, 'platform-keys.json');

function loadPlatformKeys() {
  try {
    if (fs.existsSync(PLATFORM_KEYS_FILE)) {
      return JSON.parse(fs.readFileSync(PLATFORM_KEYS_FILE, 'utf-8'));
    }
  } catch (_) { console.warn('Failed to load platform keys from ' + PLATFORM_KEYS_FILE); }
  return {};
}

async function _httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout: 20000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (_) { resolve({ raw: d }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function _httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: { 'User-Agent': 'CrabPaw/1.0', ...headers },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (_) { resolve({ raw: d }); }
      });
    }).on('error', reject);
  });
}

// ============================================================
// 微信公众号 API
// ============================================================

let _wechatToken = null;
let _wechatTokenExpiry = 0;

async function getWechatAccessToken() {
  if (_wechatToken && Date.now() < _wechatTokenExpiry) return _wechatToken;

  const keys = loadPlatformKeys();
  const mp = keys.wechat_mp;
  if (!mp?.appId || !mp?.appSecret) {
    throw new Error('未配置微信公众号凭证。请在 data/platform-keys.json 中配置 wechat_mp.appId 和 wechat_mp.appSecret');
  }

  const result = await _httpsGet(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${mp.appId}&secret=${mp.appSecret}`
  );

  if (result.access_token) {
    _wechatToken = result.access_token;
    _wechatTokenExpiry = Date.now() + (result.expires_in - 300) * 1000;
    return _wechatToken;
  }

  throw new Error(`获取微信 access_token 失败: ${JSON.stringify(result)}`);
}

// ============================================================
// 工具注册
// ============================================================

registry.register({
  name: 'wechat_mp_draft',
  toolset: 'platform',
  category: 'platform',
  description: '微信公众号草稿操作：创建草稿、查询草稿列表。需要先配置微信公众号凭证。',
  whenNotToUse: ["未配置微信公众号凭证时不要使用","不要用于非微信公众号平台的内容发布"],

  riskLevel: 'medium',

  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'list'], description: '操作类型' },
      title: { type: 'string', description: '文章标题（create 时必填）' },
      content: { type: 'string', description: '文章内容，支持 HTML（create 时必填）' },
      digest: { type: 'string', description: '文章摘要' },
      coverUrl: { type: 'string', description: '封面图 URL' },
      offset: { type: 'number', description: '列表偏移量（list 时使用）' },
      count: { type: 'number', description: '列表数量（list 时使用，默认20）' },
    },
    required: ['action'],
  },
  async handler(params) {
    try {
      const token = await getWechatAccessToken();

      if (params.action === 'list') {
        const data = await _httpsPost(
          `https://api.weixin.qq.com/cgi-bin/draft/batchget?access_token=${token}`,
          { offset: params.offset || 0, count: params.count || 20, no_content: 1 }
        );
        return { success: true, action: 'list', ...data };
      }

      if (params.action === 'create') {
        if (!params.title || !params.content) {
          return { success: false, error: 'title 和 content 为必填项' };
        }
        const articles = [{
          title: params.title,
          content: params.content,
          digest: params.digest || '',
          thumb_media_id: params.coverUrl || '',
          need_open_comment: 0,
        }];
        const data = await _httpsPost(
          `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${token}`,
          { articles }
        );
        return { success: true, action: 'create', ...data };
      }

      return { success: false, error: `不支持的操作: ${params.action}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
});

registry.register({
  name: 'wechat_mp_publish',
  toolset: 'platform',
  category: 'platform',
  description: '发布微信公众号草稿。',
  whenNotToUse: ['未确认草稿内容时不要发布（发布后公开可见）', '不要用于草稿创建，先用 wechat_mp_draft create'],
  riskLevel: 'high',
  schema: {
    type: 'object',
    properties: {
      mediaId: { type: 'string', description: '草稿的 media_id（从 wechat_mp_draft list 获取）' },
    },
    required: ['mediaId'],
  },
  async handler(params) {
    try {
      const token = await getWechatAccessToken();
      const data = await _httpsPost(
        `https://api.weixin.qq.com/cgi-bin/freepublish/submit?access_token=${token}`,
        { media_id: params.mediaId }
      );
      return { success: true, ...data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
});

registry.register({
  name: 'platform_keys_status',
  toolset: 'platform',
  category: 'platform',
  description: '查看已配置的平台 API 凭证状态。',
  whenNotToUse: ["不要用于修改凭证，本工具仅查询状态"],

  riskLevel: 'low',

  schema: { type: 'object', properties: {} },
  async handler() {
    const keys = loadPlatformKeys();
    const status = {};
    if (keys.wechat_mp) status.wechat_mp = { configured: !!(keys.wechat_mp.appId && keys.wechat_mp.appSecret) };
    if (keys.lark) status.lark = { configured: !!(keys.lark.appId && keys.lark.appSecret) };
    return { success: true, platforms: status };
  }
});

module.exports = { loadPlatformKeys, getWechatAccessToken };
