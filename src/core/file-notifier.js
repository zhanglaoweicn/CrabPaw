const fs = require('fs');
const path = require('path');

const getDataDir = () => {
  if (process.env.CRABPAW_DATA_DIR) return process.env.CRABPAW_DATA_DIR;
  return path.join(__dirname, '..', '..', 'data', '.crabpaw');
};

function getUserConfig() {
  try {
    const userConfigPath = path.join(getDataDir(), 'config', 'user.json');
    if (fs.existsSync(userConfigPath)) {
      return JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
    }
  } catch (e) {
    /* 读取失败，忽略 */
    console.warn('[file-notifier.js] 空 catch 补日志:', e && e.message);
  }

  return {};
}

function getAppConfig() {
  try {
    const configPath = path.join(getDataDir(), 'config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) {
    /* 读取失败，忽略 */
    console.warn('[file-notifier.js] 空 catch 补日志:', e && e.message);
  }

  return {};
}

const MEDIA_TYPE_METHOD_MAP = {
  image: 'sendImage',
  video: 'sendVideo',
  docx: 'sendFile',
  xlsx: 'sendFile',
  pptx: 'sendFile',
  pdf: 'sendFile',
  html: 'sendFile',
  file: 'sendFile',
};

class MediaNotifier {
  constructor() {
    this._ctx = null;
    this._sseBroadcast = null;
  }

  init(ctx, sseBroadcast) {
    this._ctx = ctx;
    this._sseBroadcast = sseBroadcast;
  }

  async notify(mediaInfo) {
    const { mediaType, filePath, name, size } = mediaInfo;
    const results = [];

    if (this._sseBroadcast) {
      try {
        const sseData = {
          type: mediaType || 'file',
          path: filePath,
          name: name || path.basename(filePath),
          size: size || 0,
        };
        if (mediaType === 'docx' || mediaType === 'pdf') {
          const mdPath = filePath.replace(/\.docx$/i, '.md').replace(/\.pdf$/i, '.md');
          if (require('fs').existsSync(mdPath)) {
            sseData.mdSourcePath = mdPath;
          }
        }
        this._sseBroadcast('file_generated', sseData);
      } catch (e) {
        console.warn('⚠️ [MediaNotifier] SSE广播失败:', e.message);
      }
    }

    const userConfig = getUserConfig();
    const appConfig = getAppConfig();

    await this._sendToChannel('wecom', mediaInfo, userConfig, appConfig, results);
    await this._sendToChannel('lark', mediaInfo, userConfig, appConfig, results);

    return results;
  }

  async _sendToChannel(channel, mediaInfo, userConfig, appConfig, results) {
    try {
      const channelCtx = this._ctx?.[channel];
      if (!channelCtx || !channelCtx.isConfigured || !channelCtx.isConfigured()) {
        return;
      }

      let chatId = '';
      if (channel === 'wecom') {
        // SP3: 会话发起人定向投递优先，其次默认用户链
        chatId = mediaInfo.chatId || userConfig.wecomUserId || appConfig.wecom?.defaultChatId || appConfig.wecom?.defaultUserId || '';
      } else if (channel === 'lark') {
        chatId = mediaInfo.chatId || userConfig.larkUserId || appConfig.lark?.defaultChatId || '';
      }

      if (!chatId) {
        return;
      }

      const { mediaType, filePath } = mediaInfo;

      if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ [MediaNotifier] 文件不存在: ${filePath}`);
        results.push({ channel, success: false, error: '文件不存在' });
        return;
      }

      const methodName = MEDIA_TYPE_METHOD_MAP[mediaType] || 'sendFile';

      if (channelCtx[methodName]) {
        let result;
        if (methodName === 'sendImage') {
          result = await channelCtx.sendImage(chatId, filePath);
        } else if (methodName === 'sendVideo') {
          result = await channelCtx.sendVideo(chatId, filePath);
        } else {
          result = await channelCtx.sendFile(chatId, filePath);
        }
        const success = result?.success !== false;
        console.log(success ? `📤 [MediaNotifier] ${mediaType}已发送到${channel}: ${filePath}` : `⚠️ [MediaNotifier] ${channel}发送${mediaType}失败: ${result?.error || 'unknown'}`);
        results.push({ channel, success, error: success ? null : (result?.error || 'unknown') });
      } else {
        console.warn(`⚠️ [MediaNotifier] ${channel} 不支持 ${methodName}`);
      }
    } catch (e) {
      console.warn(`⚠️ [MediaNotifier] ${channel} 发送异常:`, e.message);
      results.push({ channel, success: false, error: e.message });
    }
  }
}

let _instance = null;

function getMediaNotifier() {
  if (!_instance) {
    _instance = new MediaNotifier();
  }
  return _instance;
}

function getFileNotifier() {
  return getMediaNotifier();
}

module.exports = { MediaNotifier, getMediaNotifier, getFileNotifier };
