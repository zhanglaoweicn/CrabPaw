// wecom.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { sendJson } = require('../http-utils');

// 企微发送文件代理端点 - 转发请求到企微服务端口 38769
async function handleWecomSendFileProxy(req, res, ctx) {
  try {
    const http = require('http');

    // 读取请求体
    let body = '';
    for await (const chunk of req) body += chunk;

    let requestBody = {};
    try {
      requestBody = JSON.parse(body);
    } catch (e) {
      console.warn('handleWecomSendFileProxy: failed to parse request body:', e.message);
    }

    // 确定数据目录和配置文件路径
    // 2026-08-31 Task1(数据目录统一): 统一走 config.DATA_DIR(此前 process.cwd() 拼接)
    const DATA_DIR = ctx?.dataDir || process.env.DATA_DIR || require('../../core/config').DATA_DIR;
    const WECOM_SEND_PORT_PATH = path.join(DATA_DIR, '.wecom_send_port');
    const userConfigPath = path.join(DATA_DIR, 'config', 'user.json');
    const appConfigPath = path.join(DATA_DIR, 'config.json');

    // 发布 S-2b 安全(2026-09-07 扩展): file_path 须落在发送白名单（DATA_DIR/uploads
    // 与 data/workspace 产物目录）——config.json/.env 等敏感文件由黑名单双层拦截。
    if (!requestBody.file_path) {
      return sendJson(res, 400, { success: false, error: 'Missing required parameter: file_path' });
    }
    const { isAllowedSendPath } = require('../../core/upload-path');
    if (!isAllowedSendPath(requestBody.file_path, DATA_DIR)) {
      return sendJson(res, 403, { success: false, error: '安全限制：只允许发送 uploads 与 data/workspace 产物目录内的文件（config/密钥类文件一律拒绝）' });
    }

    // 读取 WeCom 发送端口
    let sendPort = parseInt(process.env.WECOM_SEND_PORT || '38769', 10);
    try {
      if (fs.existsSync(WECOM_SEND_PORT_PATH)) {
        sendPort = parseInt(fs.readFileSync(WECOM_SEND_PORT_PATH, 'utf-8').trim(), 10);
      }
    } catch (e) {
      console.warn('failed to read WeCom send port', e.message);
    }

    // 读取 chatId
    let chatId = '';
    try {
      if (fs.existsSync(userConfigPath)) {
        const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
        chatId = userConfig.wecomUserId || '';
      }
    } catch (e) {
      console.warn('读取用户配置失败:', e.message);
    }

    if (!chatId) {
      try {
        if (fs.existsSync(appConfigPath)) {
          const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf-8'));
          chatId = appConfig.wecom?.defaultChatId || appConfig.wecom?.defaultUserId || '';
        }
      } catch (e) {
        console.warn('读取应用配置失败:', e.message);
      }
    }

    if (!chatId) {
      return sendJson(res, 400, { success: false, error: '未配置企微接收人：请在 设置→用户信息 填写"企微用户 ID"并保存后重试' });
    }

    // SP3: 本地发送服务强制鉴权——X-Api-Key 取自 data/.crabpaw/.api_token
    let apiToken = '';
    try {
      const tokenPath = path.join(DATA_DIR, '.api_token');
      if (fs.existsSync(tokenPath)) {
        apiToken = fs.readFileSync(tokenPath, 'utf-8').trim();
      }
    } catch (e) {
      console.warn('failed to read WeCom API token', e.message);
    }

    // 注入 chatId 并代理到桥接服务
    requestBody.chat_id = chatId;
    body = JSON.stringify(requestBody);

    const proxyReq = http.request({
      hostname: 'localhost',
      port: sendPort,
      path: '/wecom/send-file',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiToken ? { 'X-Api-Key': apiToken } : {})
      }
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => data += chunk);
      proxyRes.on('end', () => {
        try {
          const result = JSON.parse(data);
          sendJson(res, result.success ? 200 : 400, result);
        } catch (e) {
          sendJson(res, 500, { success: false, error: '企微服务响应解析失败' });
        }
      });
    });

    proxyReq.on('error', (e) => {
      console.error('WeCom send proxy failed', e.message);
      sendJson(res, 503, { success: false, error: 'WeCom service unavailable, please check WeCom bridge service' });
    });

    proxyReq.write(body);
    proxyReq.end();
  } catch (e) {
    console.error('handleWecomSendFileProxy unhandled error:', e.message);
    sendJson(res, 500, { success: false, error: e.message });
  }
}

module.exports = {
  handleWecomSendFileProxy,
};
