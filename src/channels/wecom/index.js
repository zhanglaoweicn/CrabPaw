const http = require('http');
const fs = require('fs');
const path = require('path');
const { GroupRouter, GROUP_MESSAGE_POLICIES } = require('./group-router');
const { MessageDeduplicator } = require('./message-dedup');
const { ApprovalHandler, APPROVAL_STATUS, STATUS_LABELS } = require('./approval-handler');
const { ContactsSync } = require('./contacts-sync');

/**
 * 企微回调签名校验（S1）——官方算法：
 * msg_signature = sha1( sort([token, timestamp, nonce, encrypt]).join('') )
 * @param {object} query - 回调 URL 查询参数（msg_signature / timestamp / nonce）
 * @param {string} encryptText - 密文（POST 回调体 encrypt 字段；URL 验证为 echostr）
 * @param {string} token - 企微后台配置的 Token（缺失时视为无法验签 → false）
 */
function verifyCallbackSignature(query, encryptText, token) {
  const crypto = require('crypto');
  // 兼容 URLSearchParams（ctx.url.searchParams）与普通对象两种形态
  const get = (k) => (query && typeof query.get === 'function') ? query.get(k) : (query ? query[k] : '');
  const msgSignature = String(get('msg_signature') || '').toLowerCase();
  const timestamp = String(get('timestamp') || '');
  const nonce = String(get('nonce') || '');
  if (!msgSignature || !timestamp || !nonce || !encryptText || !token) return false;
  const raw = [token, timestamp, nonce, String(encryptText)].sort().join('');
  const signature = crypto.createHash('sha1').update(raw).digest('hex');
  if (signature.length !== msgSignature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(msgSignature));
}

/** 读取主 API token（.api_token），用于本地发送服务的鉴权头 */
function _getApiToken() {
  const tokenPath = path.join(getDataDir(), '.api_token');
  try {
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch (e) { console.warn('[wecom] 读取 API token 失败:', e.message); }
  return '';
}

function parseCallbackPayload(data) {
  const files = [];
  if (data.filePath && data.fileName) {
    files.push({
      fileName: data.fileName,
      fileKey: data.filePath,
      type: data.msgType === 'image' ? 'image' : 'file',
      fileSize: 0
    });
  }

  return {
    fromUserId: data.fromUserId || data.from_user_id || '',
    fromUserName: data.fromUserName || data.from_user_name || '',
    content: data.content || '',
    msgType: data.msgType || data.msg_type || 'text',
    chatId: data.chatId || data.chat_id || '',
    chatType: data.chatType || data.chat_type || 'single',
    msgId: data.msgId || data.msg_id || '',
    timestamp: data.timestamp || Date.now(),
    rawBody: data.rawBody || data,
    files: files
  };
}

function getDataDir() {
  if (process.env.CRABPAW_DATA_DIR) return process.env.CRABPAW_DATA_DIR;
  return path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
}

// 统一的企微发送端口解析：env > 端口文件 > 默认 38769
// 注意：不能回退到 API_PORT，因为 sendServer (event-bridge.js) 监听在独立的 SEND_PORT
// 纯函数：env.WECOM_SEND_PORT > portFileValue > 38769（非法值自动下坠）
function resolveWecomSendPort(env = {}, portFileValue = null) {
  if (env && env.WECOM_SEND_PORT) {
    const envPort = parseInt(env.WECOM_SEND_PORT, 10);
    if (Number.isFinite(envPort) && envPort > 0) return envPort;
  }
  if (portFileValue !== null && portFileValue !== undefined && String(portFileValue).trim() !== '') {
    const filePort = parseInt(String(portFileValue).trim(), 10);
    if (Number.isFinite(filePort) && filePort > 0) return filePort;
  }
  return 38769;
}

function _getWecomSendPort() {
  const WECOM_SEND_PORT_PATH = path.join(getDataDir(), '.wecom_send_port');
  let portFileValue = null;
  try {
    if (fs.existsSync(WECOM_SEND_PORT_PATH)) {
      portFileValue = fs.readFileSync(WECOM_SEND_PORT_PATH, 'utf-8').trim();
    }
  } catch (e) { console.warn('[企微发送] 读取端口文件失败:', e.message); }
  return resolveWecomSendPort(process.env, portFileValue);
}

function sendViaWebhook(chatId, contentType, content, chatType) {
  const sendPort = _getWecomSendPort();

  const postData = JSON.stringify({
    chat_id: chatId,
    msg_type: contentType,
    content: content,
    chat_type: chatType || 'single'
  });

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  };
  // 2026-08-07 (S2): 本地发送服务已加鉴权——发送请求必须携带 API token
  const token = _getApiToken();
  if (token) headers['X-Api-Key'] = token;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: sendPort,
      path: '/wecom/send',
      method: 'POST',
      headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success === false) {
            console.error('❌ 企业微信发送服务返回失败:', result.error || result.errcode || '未知错误');
            reject(new Error(result.error || '企业微信发送失败'));
          } else {
            resolve(result);
          }
        } catch (e) {
          console.warn('[wecom] sendViaWebhook response parse failed:', e.message);
          resolve({ success: true });
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ 发送企业微信消息失败:', e.message);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

async function uploadImageToWecom(imagePath, config) {
  const wecomConfig = config.wecom || {};
  const corpId = wecomConfig.corpId;
  const secret = wecomConfig.secret;
  const agentId = wecomConfig.botId;

  if (!corpId || !secret || !agentId) {
    return { success: false, error: '企业微信配置不完整' };
  }

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const fileName = path.basename(imagePath);

    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`;
    const tokenResp = await fetch(tokenUrl);
    const tokenData = await tokenResp.json();

    if (tokenData.errcode !== 0) {
      return { success: false, error: `获取 access_token 失败: ${tokenData.errmsg}` };
    }

    const accessToken = tokenData.access_token;

    const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=image`;
    const boundary = `----WebKitFormBoundary${require('crypto').randomBytes(8).toString('hex')}`;
    const header = Buffer.from([
      `--${boundary}`,
      `Content-Disposition: form-data; name="media"; filename="${fileName}"`,
      `Content-Type: image/png`,
      '',
      ''
    ].join('\r\n'), 'utf-8');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const multipartBuffer = Buffer.concat([header, imageBuffer, footer]);

    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBuffer
    });
    const uploadData = await uploadResp.json();

    if (uploadData.errcode) {
      return { success: false, error: `上传图片失败: ${uploadData.errmsg}` };
    }

    return { success: true, mediaId: uploadData.media_id, accessToken };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function createChannel(config) {
  const { botId, secret, corpId, contactsSecret, approvalSecret, botUserId, botName, groupPolicy, watchedTemplates } = config.wecom || {};

  // Read credentials fresh every call — bypass CredentialManager cache.
  // CredentialManager singleton caches config, so we read disk + env directly.
  function _getCreds() {
    try {
      const dataDir = getDataDir();
      const configPath = path.join(dataDir, 'config.json');
      const apiKeysPath = path.join(dataDir, '.api_keys.json');
      let cfg = {};
      if (fs.existsSync(configPath)) {
        try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) { console.warn('[wecom] failed to parse config.json:', e.message); }
      }
      const wecom = cfg.wecom || {};
      // Resolve secret: env > config.json > .api_keys.json decrypted
      let secret = process.env.WECOM_SECRET || wecom.secret || null;
      // Masked value (contains ***) or too short to be real — treat as missing, fall back to .api_keys.json
      if (secret && (secret.includes('***') || secret.length < 10)) secret = null;
      if (!secret && fs.existsSync(apiKeysPath)) {
        try {
          const apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
          if (apiKeys.wecom_secret) {
            const { decryptApiKey } = require('../../core/secure-storage');
            secret = decryptApiKey(apiKeys.wecom_secret) || null;
          }
        } catch (e) { console.warn('[wecom] failed to parse .api_keys.json:', e.message); }
      }
      return {
        botId: process.env.WECOM_BOT_ID || wecom.botId || null,
        secret: secret,
      };
    } catch (e) { console.warn('[wecom] _getCreds failed:', e.message); return { botId: botId || null, secret: secret || null }; }
  }

  const groupRouter = new GroupRouter({
    botUserId: botUserId || '',
    botName: botName || '',
    groupPolicy: groupPolicy || GROUP_MESSAGE_POLICIES.MENTION_ONLY,
  });

  const deduplicator = new MessageDeduplicator({
    ttl: 5 * 60 * 1000,
    maxEntries: 10000,
  });
  deduplicator.start();

  const approvalHandler = new ApprovalHandler({
    corpId: corpId || '',
    approvalSecret: approvalSecret || '',
    agentId: botId || '',
    watchedTemplates: watchedTemplates || [],
  });

  const contactsSync = new ContactsSync({
    corpId: corpId || '',
    contactsSecret: contactsSecret || '',
    dataDir: getDataDir(),
  });

  const channel = {
    name: 'wecom',
    type: 'channel',

    groupRouter,
    deduplicator,
    approvalHandler,
    contactsSync,

    async send(chatId, content, chatType) {
      const c = _getCreds();
      if (!c.botId || !c.secret) {
        throw new Error('企业微信未配置');
      }
      return sendViaWebhook(chatId, 'markdown', content, chatType);
    },

    async sendMarkdown(chatId, content, chatType) {
      const c = _getCreds();
      if (!c.botId || !c.secret) {
        throw new Error('企业微信未配置');
      }
      return sendViaWebhook(chatId, 'markdown', content, chatType);
    },

    async sendImage(chatId, imagePath, chatType) {
      const c = _getCreds();
      if (!c.botId || !c.secret) {
        throw new Error('企业微信未配置');
      }

      const resolvedPath = path.resolve(imagePath);
      if (!fs.existsSync(resolvedPath)) {
        console.warn('⚠️ 图片文件不存在:', resolvedPath);
        throw new Error(`图片文件不存在: ${resolvedPath}`);
      }

      const sendPort = _getWecomSendPort();

      const postData = JSON.stringify({
        chat_id: chatId,
        file_path: resolvedPath,
        chat_type: chatType || 'single'
      });

      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: sendPort,
          path: '/wecom/send-image',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            // 2026-08-07 (S2): 本地发送服务已加鉴权，必须携带 API token
            ...(_getApiToken() ? { 'X-Api-Key': _getApiToken() } : {})
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.success === false) {
                console.error('❌ 企业微信图片发送失败:', result.error);
                reject(new Error(result.error || '图片发送失败'));
              } else {
                console.log('✅ 图片已通过企业微信 SDK 发送, media_id:', result.media_id);
                resolve(result);
              }
            } catch (e) {
              console.warn('[wecom] send response parse failed:', e.message);
              resolve({ success: true });
            }
          });
        });

        req.on('error', (e) => {
          console.error('❌ 发送图片到企业微信失败:', e.message);
          reject(e);
        });

        req.write(postData);
        req.end();
      });
    },

    async sendVideo(chatId, videoPath, chatType, options = {}) {
      const _c = _getCreds(); if (!_c.botId || !_c.secret) {
        throw new Error('企业微信未配置');
      }

      const resolvedPath = path.resolve(videoPath);
      if (!fs.existsSync(resolvedPath)) {
        console.warn('⚠️ 视频文件不存在:', resolvedPath);
        throw new Error(`视频文件不存在: ${resolvedPath}`);
      }

      const sendPort = _getWecomSendPort();

      const postData = JSON.stringify({
        chat_id: chatId,
        file_path: resolvedPath,
        chat_type: chatType || 'single',
        title: options.title || '',
        description: options.description || ''
      });

      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: sendPort,
          path: '/wecom/send-video',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            // 2026-08-07 (S2): 本地发送服务已加鉴权，必须携带 API token
            ...(_getApiToken() ? { 'X-Api-Key': _getApiToken() } : {})
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.success === false) {
                console.error('❌ 企业微信视频发送失败:', result.error);
                reject(new Error(result.error || '视频发送失败'));
              } else {
                console.log('✅ 视频已通过企业微信 SDK 发送, media_id:', result.media_id);
                resolve(result);
              }
            } catch (e) {
              console.warn('[wecom] send response parse failed:', e.message);
              resolve({ success: true });
            }
          });
        });

        req.on('error', (e) => {
          console.error('❌ 发送视频到企业微信失败:', e.message);
          reject(e);
        });

        req.write(postData);
        req.end();
      });
    },

    async sendFile(chatId, filePath, chatType) {
      const _c = _getCreds(); if (!_c.botId || !_c.secret) {
        throw new Error('企业微信未配置');
      }

      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        console.warn('⚠️ 文件不存在:', resolvedPath);
        throw new Error(`文件不存在: ${resolvedPath}`);
      }

      const sendPort = _getWecomSendPort();

      const postData = JSON.stringify({
        chat_id: chatId,
        file_path: resolvedPath,
        chat_type: chatType || 'single'
      });

      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: 'localhost',
          port: sendPort,
          path: '/wecom/send-file',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
            // 2026-08-07 (S2): 本地发送服务已加鉴权，必须携带 API token
            ...(_getApiToken() ? { 'X-Api-Key': _getApiToken() } : {})
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.success === false) {
                console.error('❌ 企业微信文件发送失败:', result.error);
                reject(new Error(result.error || '文件发送失败'));
              } else {
                console.log('✅ 文件已通过企业微信 SDK 发送, media_id:', result.media_id);
                resolve(result);
              }
            } catch (e) {
              console.warn('[wecom] send response parse failed:', e.message);
              resolve({ success: true });
            }
          });
        });

        req.on('error', (e) => {
          console.error('❌ 发送文件到企业微信失败:', e.message);
          reject(e);
        });

        req.write(postData);
        req.end();
      });
    },

    async sendSmart(chatId, content, chatType, options = {}) {
      const _c = _getCreds(); if (!_c.botId || !_c.secret) {
        throw new Error('企业微信未配置');
      }

      if (options.videoPath) {
        return this.sendVideo(chatId, options.videoPath, chatType, options);
      }

      if (options.imagePath) {
        return this.sendImage(chatId, options.imagePath, chatType);
      }

      if (options.filePath) {
        return this.sendFile(chatId, options.filePath, chatType);
      }

      return sendViaWebhook(chatId, 'markdown', content, chatType);
    },

    routeGroupMessage(event) {
      return groupRouter.route(event);
    },

    checkDuplicate(event) {
      return deduplicator.check(event);
    },

    async handleApprovalStatusChange(eventData) {
      return approvalHandler.handleStatusChange(eventData);
    },

    getUserName(userId) {
      return contactsSync.getUserName(userId);
    },

    getUserInfo(userId) {
      return contactsSync.getUser(userId);
    },

    searchContacts(query) {
      return contactsSync.searchUsers(query);
    },

    async syncContacts() {
      return contactsSync.fullSync();
    },

    startContactsAutoSync() {
      return contactsSync.startAutoSync();
    },

    stopContactsAutoSync() {
      contactsSync.stopAutoSync();
    },

    getContactsStats() {
      return contactsSync.getStats();
    },

    getGroupRouterStats() {
      return groupRouter.getStats();
    },

    getDedupStats() {
      return deduplicator.getStats();
    },

    getApprovalPending() {
      return approvalHandler.getPendingList();
    },

    parsePayload(data) {
      return parseCallbackPayload(data);
    },

    isConfigured() {
      const c = _getCreds();
      return !!(c.botId && c.secret);
    },

    destroy() {
      deduplicator.stop();
      contactsSync.stopAutoSync();
    },
  };

  approvalHandler.setNotifyChannel(channel);

  return channel;
}

module.exports = {
  createChannel,
  resolveWecomSendPort,
  api: { parseCallbackPayload, sendViaWebhook, uploadImageToWecom, verifyCallbackSignature },
  GroupRouter,
  GROUP_MESSAGE_POLICIES,
  MessageDeduplicator,
  ApprovalHandler,
  APPROVAL_STATUS,
  STATUS_LABELS,
  ContactsSync,
};
