const fs = require('fs');
const path = require('path');

// 2026-09-06: token 缓存按 appId 分桶（原单变量多 app 互串）+ in-flight 单飞
// （并发过期时只刷一次）+ expires 下限保护
const _tokens = new Map(); // appId -> { token, expire }
const _tokenInflight = new Map(); // appId -> Promise<token>

async function getToken(appId, appSecret) {
  const entry = _tokens.get(appId);
  if (entry && entry.expire > Date.now() + 300000) {
    return entry.token;
  }
  if (_tokenInflight.has(appId)) return _tokenInflight.get(appId);

  const p = (async () => {
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });
    const data = await resp.json();

    if (data.tenant_access_token) {
      const expireSec = Math.max(Number(data.expire) || 7200, 600);
      _tokens.set(appId, { token: data.tenant_access_token, expire: Date.now() + (expireSec - 300) * 1000 });
      return data.tenant_access_token;
    }
    throw new Error(data.msg || '获取token失败');
  })();

  _tokenInflight.set(appId, p);
  try {
    return await p;
  } catch (e) {
    _tokens.delete(appId);
    throw e;
  } finally {
    _tokenInflight.delete(appId);
  }
}

// 2026-09-06: 本地文件上传（im/v1/files）+ 文件消息发送——此前飞书只有文件
// 下载，filegen 生成的本地文档无法递到飞书侧
const LARK_FILE_TYPE_MAP = {
  '.doc': 'doc', '.docx': 'doc',
  '.pdf': 'pdf',
  '.xls': 'xls', '.xlsx': 'xls', '.csv': 'xls',
  '.ppt': 'ppt', '.pptx': 'ppt',
  '.mp4': 'mp4', '.mov': 'mp4', '.avi': 'mp4',
  '.mp3': 'opus', '.m4a': 'opus', '.wav': 'opus', '.amr': 'opus',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.bmp': 'image',
};

function _larkFileType(filePath) {
  return LARK_FILE_TYPE_MAP[path.extname(filePath).toLowerCase()] || 'stream';
}

async function uploadFile(appId, appSecret, filePath) {
  const token = await getToken(appId, appSecret);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);
  const buf = fs.readFileSync(resolved);
  if (buf.length > 30 * 1024 * 1024) throw new Error('文件超过飞书 30MB 上传限制');

  const fileName = path.basename(resolved);
  const form = new FormData();
  form.append('file_type', _larkFileType(resolved));
  form.append('file_name', fileName);
  form.append('file', new Blob([buf]), fileName);

  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: form,
  });
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书文件上传失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return result.data && result.data.file_key;
}

async function sendFileMessage(appId, appSecret, receiveId, fileKey) {
  const token = await getToken(appId, appSecret);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey })
    })
  });
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书文件发送失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

async function sendMessage(appId, appSecret, receiveId, content) {
  const token = await getToken(appId, appSecret);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text: content })
    })
  });

  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书发送失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

async function sendInteractiveCard(appId, appSecret, receiveId, options) {
  // eslint-disable-next-line no-unused-vars
  const { title, content, actions = [] } = options;
  
  const card = {
    "config": {
      "wide_screen_mode": true
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "content": content,
          "tag": "lark_md"
        }
      }
    ]
  };
  
  if (actions.length > 0) {
    card.elements.push({
      "tag": "action",
      "actions": actions.map(action => ({
        "tag": "button",
        "text": {
          "content": action.text,
          "tag": "plain_text"
        },
        "type": action.type || "primary",
        "value": action.value
      }))
    });
  }
  
  const token = await getToken(appId, appSecret);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书卡片发送失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

function parseWebhookPayload(data) {
  const eventType = data.header?.event_type || data.type;
  
  console.log('🔍 解析 webhook payload, eventType:', eventType);
  console.log('🔍 data.type:', data.type);
  console.log('🔍 data.msg_type:', data.msg_type);
  console.log('🔍 data.content:', typeof data.content, data.content?.substring?.(0, 200));
  
  if (eventType !== 'im.message.receive_v1') {
    return { senderId: '', content: '', messageId: '', msgType: 'text', files: [] };
  }
  
  let senderId, content, messageId, msgType, files;
  
  if (data.type) {
    senderId = data.sender_id || 'unknown';
    messageId = data.message_id || data.id || '';
    msgType = data.msg_type || 'text';
    files = [];
    
    console.log('🔍 解析 compact 格式事件:', { senderId, msgType, messageId });
    
    if (data.content) {
      if (typeof data.content === 'string' && data.content.startsWith('<file')) {
        msgType = 'file';
        const keyMatch = data.content.match(/key="([^"]+)"/);
        const nameMatch = data.content.match(/name="([^"]+)"/);
        const fileKey = keyMatch ? keyMatch[1] : '';
        const fileName = nameMatch ? nameMatch[1] : '未知文件';
        
        content = `[文件] ${fileName}`;
        files = [{
          type: 'file',
          fileKey: fileKey,
          fileName: fileName
        }];
        console.log('📁 收到文件消息 (XML格式):', fileName);
        console.log('📁 file_key:', fileKey);
        
        return { senderId, content, messageId, msgType, files };
      }
      
      if (typeof data.content === 'string' && data.content.startsWith('<image')) {
        msgType = 'image';
        const keyMatch = data.content.match(/key="([^"]+)"/);
        const imageKey = keyMatch ? keyMatch[1] : '';
        
        content = '[图片]';
        files = [{
          type: 'image',
          fileKey: imageKey
        }];
        console.log('🖼️ 收到图片消息 (XML格式)');
        
        return { senderId, content, messageId, msgType, files };
      }
      
      if (typeof data.content === 'string' && data.content.startsWith('<audio')) {
        msgType = 'audio';
        const keyMatch = data.content.match(/key="([^"]+)"/);
        const fileKey = keyMatch ? keyMatch[1] : '';
        
        content = '[语音]';
        files = [{
          type: 'audio',
          fileKey: fileKey
        }];
        console.log('🎤 收到语音消息 (XML格式)');
        
        return { senderId, content, messageId, msgType, files };
      }
      
      if (typeof data.content === 'string' && data.content.startsWith('<media')) {
        msgType = 'media';
        const keyMatch = data.content.match(/key="([^"]+)"/);
        const nameMatch = data.content.match(/name="([^"]+)"/);
        const fileKey = keyMatch ? keyMatch[1] : '';
        const fileName = nameMatch ? nameMatch[1] : '未知媒体';
        
        content = `[媒体文件] ${fileName}`;
        files = [{
          type: 'media',
          fileKey: fileKey,
          fileName: fileName
        }];
        console.log('🎬 收到媒体消息 (XML格式):', fileName);
        
        return { senderId, content, messageId, msgType, files };
      }
      
      try {
        const msgContent = typeof data.content === 'string' ? JSON.parse(data.content) : data.content;
        console.log('🔍 解析后的 msgContent:', JSON.stringify(msgContent).substring(0, 500));
        
        if (msgType === 'text') {
          content = msgContent.text || '';
        } else if (msgType === 'file') {
          content = `[文件] ${msgContent.file_name || '未知文件'}`;
          files = [{
            type: 'file',
            fileKey: msgContent.file_key,
            fileName: msgContent.file_name,
            fileSize: msgContent.file_size
          }];
          console.log('📁 收到文件消息:', msgContent.file_name, `(${Math.round(msgContent.file_size / 1024)}KB)`);
          console.log('📁 file_key:', msgContent.file_key);
        } else if (msgType === 'image') {
          content = '[图片]';
          files = [{
            type: 'image',
            fileKey: msgContent.image_key
          }];
          console.log('[Image] Received image message');
        } else if (msgType === 'audio') {
          content = '[语音]';
          files = [{
            type: 'audio',
            fileKey: msgContent.file_key,
            duration: msgContent.duration
          }];
          console.log('🎤 收到语音消息');
        } else if (msgType === 'media') {
          content = `[媒体文件] ${msgContent.file_name || '未知'}`;
          files = [{
            type: 'media',
            fileKey: msgContent.file_key,
            fileName: msgContent.file_name,
            fileSize: msgContent.file_size
          }];
          console.log('🎬 收到媒体消息:', msgContent.file_name);
        } else if (msgType === 'post') {
          content = msgContent.title || '[富文本消息]';
          console.log('📝 收到富文本消息');
        } else {
          content = typeof data.content === 'string' ? data.content : JSON.stringify(msgContent);
        }
      } catch (e) {
        content = typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
        console.log('⚠️ 解析 compact content 失败:', e.message);
      }
    }
  } else {
    console.log('🔍 解析消息事件:', JSON.stringify(data.event).substring(0, 500));
    
    senderId = data.event?.sender?.sender_id?.open_id || 'unknown';
    messageId = data.event?.message?.message_id || '';
    msgType = data.event?.message?.message_type || 'text';
    files = [];
    
    if (data.event?.message?.content) {
      try {
        const msgContent = JSON.parse(data.event.message.content);
        
        if (msgType === 'text') {
          content = msgContent.text || '';
        } else if (msgType === 'file') {
          content = `[文件] ${msgContent.file_name || '未知文件'}`;
          files = [{
            type: 'file',
            fileKey: msgContent.file_key,
            fileName: msgContent.file_name,
            fileSize: msgContent.file_size
          }];
          console.log('📁 收到文件消息:', msgContent.file_name, `(${Math.round(msgContent.file_size / 1024)}KB)`);
        } else if (msgType === 'image') {
          content = '[图片]';
          files = [{
            type: 'image',
            fileKey: msgContent.image_key
          }];
          console.log('🖼️ 收到图片消息');
        } else if (msgType === 'audio') {
          content = '[语音]';
          files = [{
            type: 'audio',
            fileKey: msgContent.file_key,
            duration: msgContent.duration
          }];
          console.log('🎤 收到语音消息');
        } else if (msgType === 'media') {
          content = `[媒体文件] ${msgContent.file_name || '未知'}`;
          files = [{
            type: 'media',
            fileKey: msgContent.file_key,
            fileName: msgContent.file_name,
            fileSize: msgContent.file_size
          }];
          console.log('🎬 收到媒体消息:', msgContent.file_name);
        } else if (msgType === 'post') {
          content = msgContent.title || '[富文本消息]';
          console.log('📝 收到富文本消息');
        } else {
          content = JSON.stringify(msgContent);
        }
      } catch (e) {
        content = data.event.message.content;
      }
    }
    
    console.log('🔍 提取的 senderId:', senderId, 'messageId:', messageId, 'msgType:', msgType);
  }
  
  return { senderId, content, messageId, msgType, files };
}

async function sendTypingStatus(appId, appSecret, receiveId, message) {
  console.log('🔄 sendTypingStatus 调用:', { receiveId, message: message?.substring(0, 30) });
  
  const card = {
    "config": {
      "wide_screen_mode": true
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "content": message || "🦀 正在思考中...",
          "tag": "lark_md"
        }
      }
    ]
  };
  
  try {
    const token = await getToken(appId, appSecret);
    console.log('🔑 获取 token 成功');
    
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(card)
      })
    });
    
    const result = await response.json();
    console.log('📤 飞书响应:', JSON.stringify(result).substring(0, 200));
    
    if (result.code === 0) {
      console.log('✅ 状态提示发送成功, msgId:', result.data?.message_id);
      return result.data?.message_id;
    } else {
      console.error('❌ 飞书返回错误:', result.msg);
      return null;
    }
  } catch (e) {
    console.error('❌ sendTypingStatus 异常:', e.message);
    return null;
  }
}

async function updateCard(appId, appSecret, messageId, card) {
  const token = await getToken(appId, appSecret);
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书 API 调用失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

async function addReaction(appId, appSecret, messageId, emoji) {
  try {
    const token = await getToken(appId, appSecret);
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reaction_type: {
          emoji_type: emoji
        }
      })
    });
    
    const result = await response.json();
    console.log('⌨️ 添加表情反应结果:', JSON.stringify(result));
    if (result.code === 0 && result.data && result.data.reaction_id) {
      return { success: true, reactionId: result.data.reaction_id };
    }
    return { success: false, reactionId: null };
  } catch (e) {
    console.error('⌨️ 添加表情反应错误:', e.message);
    return { success: false, reactionId: null };
  }
}

async function removeReaction(appId, appSecret, messageId, reactionId) {
  if (!reactionId) {
    console.log('⌨️ 没有 reactionId，跳过移除');
    return false;
  }
  try {
    const token = await getToken(appId, appSecret);
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    });
    
    const result = await response.json();
    console.log('⌨️ 移除表情反应结果:', JSON.stringify(result));
    if (result.code !== 0) {
      throw new Error(`飞书移除表情失败: [${result.code}] ${result.msg || '未知错误'}`);
    }
    return true;
  } catch (e) {
    console.error('⌨️ 移除表情反应错误:', e.message);
    return false;
  }
}

async function sendMarkdownCard(appId, appSecret, receiveId, options) {
  const { title, content, color = 'blue' } = options;
  
  const card = {
    "config": {
      "wide_screen_mode": true
    },
    "header": title ? {
      "title": {
        "tag": "plain_text",
        "content": title
      },
      "template": color
    } : undefined,
    "elements": [
      {
        "tag": "markdown",
        "content": content
      }
    ]
  };
  
  const token = await getToken(appId, appSecret);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书 API 调用失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

async function sendDocCard(appId, appSecret, receiveId, options) {
  const { title, docUrl, docType = 'docx', description } = options;
  
  const typeIcons = {
    'docx': '📄',
    'sheet': '📊',
    'bitable': '📋',
    'mindnote': '🧠',
    'file': '📁'
  };
  
  const typeNames = {
    'docx': '文档',
    'sheet': '电子表格',
    'bitable': '多维表格',
    'mindnote': '思维导图',
    'file': '文件'
  };
  
  const icon = typeIcons[docType] || '📄';
  const typeName = typeNames[docType] || '文档';
  
  const card = {
    "config": {
      "wide_screen_mode": true
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": `${icon} ${title || `飞书${typeName}`}`
      },
      "template": "blue"
    },
    "elements": [
      {
        "tag": "div",
        "text": {
          "content": description || `已创建飞书${typeName}，点击下方按钮查看`,
          "tag": "lark_md"
        }
      },
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": {
              "content": "查看文档",
              "tag": "plain_text"
            },
            "type": "primary",
            "url": docUrl
          }
        ]
      }
    ]
  };
  
  const token = await getToken(appId, appSecret);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书 API 调用失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

async function sendCalendarCard(appId, appSecret, receiveId, options) {
  // eslint-disable-next-line no-unused-vars
  const { summary, startTime, endTime, location, description, eventId } = options;
  
  const formatTime = (timestamp) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  
  const card = {
    "config": {
      "wide_screen_mode": true
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": `📅 ${summary || '日程邀请'}`
      },
      "template": "green"
    },
    "elements": [
      {
        "tag": "div",
        "fields": [
          {
            "is_short": true,
            "text": {
              "content": `**开始时间**\n${formatTime(startTime)}`,
              "tag": "lark_md"
            }
          },
          {
            "is_short": true,
            "text": {
              "content": `**结束时间**\n${formatTime(endTime)}`,
              "tag": "lark_md"
            }
          }
        ]
      }
    ]
  };
  
  if (location) {
    card.elements.push({
      "tag": "div",
      "text": {
        "content": `📍 地点：${location}`,
        "tag": "lark_md"
      }
    });
  }
  
  if (description) {
    card.elements.push({
      "tag": "div",
      "text": {
        "content": `📝 ${description}`,
        "tag": "lark_md"
      }
    });
  }
  
  const token = await getToken(appId, appSecret);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书 API 调用失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

async function sendTaskCard(appId, appSecret, receiveId, options) {
  const { summary, dueTime, description, collaborators } = options;
  
  const formatTime = (timestamp) => {
    if (!timestamp) return '无截止时间';
    const date = new Date(timestamp * 1000);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };
  
  const card = {
    "config": {
      "wide_screen_mode": true
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": `✅ ${summary || '新任务'}`
      },
      "template": "orange"
    },
    "elements": [
      {
        "tag": "div",
        "fields": [
          {
            "is_short": true,
            "text": {
              "content": `**截止时间**\n${formatTime(dueTime)}`,
              "tag": "lark_md"
            }
          },
          {
            "is_short": true,
            "text": {
              "content": `**协作人**\n${collaborators && collaborators.length > 0 ? collaborators.length + '人' : '无'}`,
              "tag": "lark_md"
            }
          }
        ]
      }
    ]
  };
  
  if (description) {
    card.elements.push({
      "tag": "div",
      "text": {
        "content": `📝 ${description}`,
        "tag": "lark_md"
      }
    });
  }
  
  const token = await getToken(appId, appSecret);
  const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card)
    })
  });
  
  const result = await response.json();
  if (result.code !== 0) {
    throw new Error(`飞书 API 调用失败: [${result.code}] ${result.msg || '未知错误'}`);
  }
  return true;
}

async function downloadFile(appId, appSecret, fileKey, savePath, messageId) {
  console.log('⬇️ 开始下载文件:', fileKey, '->', savePath, 'messageId:', messageId);
  
  const token = await getToken(appId, appSecret);
  const fs = require('fs');
  const path = require('path');
  
  let url;
  if (messageId) {
    url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;
    console.log('📥 使用消息资源 API 下载用户文件');
  } else {
    url = `https://open.feishu.cn/open-apis/im/v1/files/${fileKey}/download`;
    console.log('📥 使用文件 API 下载机器人文件');
  }
  console.log('📥 下载 URL:', url);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token
    }
  });
  
  console.log('📥 响应状态:', response.status, response.statusText);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ 下载失败:', errorText);
    throw new Error(`下载文件失败: ${response.status} ${errorText}`);
  }
  
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(savePath, Buffer.from(buffer));
  
  console.log('✅ 文件已保存:', savePath, `(${Math.round(buffer.byteLength / 1024)}KB)`);
  
  return {
    success: true,
    path: savePath,
    size: buffer.byteLength
  };
}

async function downloadImage(appId, appSecret, imageKey, savePath, messageId) {
  console.log('⬇️ 开始下载图片:', imageKey, '->', savePath, 'messageId:', messageId);
  
  const token = await getToken(appId, appSecret);
  const fs = require('fs');
  const path = require('path');
  
  let url;
  if (messageId) {
    url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`;
    console.log('📥 使用消息资源 API 下载用户图片');
  } else {
    url = `https://open.feishu.cn/open-apis/im/v1/images/${imageKey}/download`;
    console.log('📥 使用图片 API 下载机器人图片');
  }
  console.log('📥 下载 URL:', url);
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + token
    }
  });
  
  console.log('📥 响应状态:', response.status, response.statusText);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ 下载失败:', errorText);
    throw new Error(`下载图片失败: ${response.status} ${errorText}`);
  }
  
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(savePath, Buffer.from(buffer));
  
  console.log('✅ 图片已保存:', savePath, `(${Math.round(buffer.byteLength / 1024)}KB)`);
  
  return {
    success: true,
    path: savePath,
    size: buffer.byteLength
  };
}

module.exports = {
  getToken,
  sendMessage,
  sendInteractiveCard,
  parseWebhookPayload,
  sendTypingStatus,
  updateCard,
  addReaction,
  removeReaction,
  sendMarkdownCard,
  sendDocCard,
  sendCalendarCard,
  sendTaskCard,
  downloadFile,
  downloadImage,
  uploadFile,
  sendFileMessage
};
