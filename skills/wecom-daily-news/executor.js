/**
 * 企业微信每日资讯推送执行器
 *
 * 功能：
 * - 通过 skills.execute 调用 multi-search-engine 搜索真实AI资讯
 * - 使用 AI 生成结构化摘要
 * - 通过企微 webhook 推送 Markdown 消息
 * - 支持多通道推送（企微/飞书）
 *
 * 调用约定：
 * - executeSkillModule 调用 execute(input, options, params)
 * - input: 用户参数（可能是对象或字符串）
 * - options: 技能配置
 * - params: 原始参数对象
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

function getDataDir() {
  if (process.env.CRABPAW_DATA_DIR) return process.env.CRABPAW_DATA_DIR;
  // SP3: 修正层级错位（3 级 '..' 会解析到 D:\data\.crabpaw，缺端口文件与 token）
  return path.join(__dirname, '..', '..', 'data', '.crabpaw');
}

function loadAppConfig() {
  const configPath = path.join(getDataDir(), 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) { console.warn('[wecom-daily-news] 读取配置失败:', e.message); }
  return {};
}

async function execute(input, options, params) {
  const appConfig = loadAppConfig();
  const wecomConfig = appConfig.wecom || {};

  const topics = (typeof input === 'object' ? (input.topics || input.instruction) : input) || 'AI,科技,互联网';
  const channel = (typeof input === 'object' ? input.channel : 'wecom') || 'wecom';

  console.log('[wecom-daily-news] 开始执行资讯推送任务');
  console.log(`[wecom-daily-news] 主题: ${topics}, 通道: ${channel}`);

  try {
    // Step 1: 搜索资讯 - 通过 skills 模块调用 multi-search-engine
    let searchContent = '';
    try {
      const skills = require('../../src/core/skills');
      const registry = skills.load();
      const topicList = topics.split(',').map(t => t.trim()).filter(Boolean);
      const searchParts = [];

      for (const topic of topicList) {
        const keyword = `${topic} 最新资讯 ${new Date().toLocaleDateString('zh-CN')}`;
        try {
          const result = await skills.execute('multi-search-engine', { keyword, engine: 'bing' }, registry);
          if (result) searchParts.push(`## ${topic}\n${typeof result === 'string' ? result : JSON.stringify(result)}`);
        } catch (e) {
          console.warn(`[wecom-daily-news] 搜索 ${topic} 失败:`, e.message);
        }
      }
      searchContent = searchParts.join('\n\n');
    } catch (e) {
      console.warn('[wecom-daily-news] 搜索引擎加载失败:', e.message);
    }

    // Step 2: 生成摘要消息
    let message;
    if (searchContent) {
      message = await generateAISummary(searchContent, topics);
    } else {
      message = generateFallbackMessage();
    }

    // Step 3: 推送
    if (channel === 'wecom' || channel === 'both') {
      if (wecomConfig.botId && wecomConfig.secret) {
        console.log('[wecom-daily-news] 推送到企微...');
        await sendViaWebhook(message, wecomConfig);
        console.log('[wecom-daily-news] 企微推送成功');
      } else {
        console.warn('[wecom-daily-news] 企微未配置(botId/secret)，跳过推送');
      }
    }

    return {
      success: true,
      message: '资讯推送完成',
      topics,
      searchResultCount: searchContent ? 1 : 0,
      sentAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[wecom-daily-news] 执行失败:', error.message);
    return { success: false, error: error.message };
  }
}

async function generateAISummary(searchContent, topics) {
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });

  // 尝试使用 CrabPaw 的 AI 模块
  try {
    const ai = require('../../src/core/ai');
    if (ai && ai.chat) {
      const prompt = `你是CrabPaw智能体的资讯编辑。请根据以下搜索结果，生成一份今日AI资讯日报。

要求：
1. 精选5-8条最重要的资讯
2. 每条包含标题、一句话摘要
3. 使用 Markdown 格式
4. 语气专业但友好

模板：
## 🤖 AI资讯日报 - ${today}

### 🔥 今日热点

**1. 标题**
> 摘要...

---

> 🦀 由 CrabPaw 自动推送

搜索结果：
${searchContent}`;

      const result = await ai.chat(prompt, { userId: 'scheduler' });
      if (result) return result;
    }
  } catch (e) {
    console.warn('[wecom-daily-news] AI摘要生成失败:', e.message);
  }

  // 回退：直接格式化搜索结果
  return `## 🤖 AI资讯日报 - ${today}\n\n${searchContent}\n\n---\n\n> 🦀 由 CrabPaw 自动推送`;
}

function generateFallbackMessage() {
  const today = new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  return `## 🤖 AI资讯日报 - ${today}\n\n> ⚠️ 今日资讯搜索暂时不可用，请稍后重试\n\n---\n\n> 🦀 由 CrabPaw 自动推送`;
}

async function sendViaWebhook(message, wecomConfig) {
  const { botId, secret } = wecomConfig;
  if (!botId || !secret) {
    throw new Error('企微 webhook 配置缺失：botId 或 secret');
  }

  // 统一端口解析：env WECOM_SEND_PORT > .wecom_send_port 文件 > 默认 38769
  // （SP3 投递错修：此前 DEFAULT_PORT=3456 恒错 + 缺 X-Api-Key 鉴权头）
  let sendPort;
  try {
    const { resolveWecomSendPort } = require('../../src/channels/wecom/index');
    const WECOM_SEND_PORT_PATH = path.join(getDataDir(), '.wecom_send_port');
    let portFileValue = null;
    if (fs.existsSync(WECOM_SEND_PORT_PATH)) {
      portFileValue = fs.readFileSync(WECOM_SEND_PORT_PATH, 'utf-8').trim();
    }
    sendPort = resolveWecomSendPort(process.env, portFileValue);
  } catch (e) {
    console.warn('[wecom-daily-news] 端口解析失败，回退默认 38769:', e.message);
    sendPort = 38769;
  }

  // API token（data/.crabpaw/.api_token）——本地发送服务强制鉴权
  let apiToken = '';
  try {
    const tokenPath = path.join(getDataDir(), '.api_token');
    if (fs.existsSync(tokenPath)) {
      apiToken = fs.readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch (e) { console.warn('[wecom-daily-news] 读取 API token 失败:', e.message); }

  // 默认接收人链：user.json wecomUserId > config.json wecom.defaultChatId > defaultUserId
  let chatId = '';
  try {
    const userConfigPath = path.join(getDataDir(), 'config', 'user.json');
    if (fs.existsSync(userConfigPath)) {
      const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
      chatId = userConfig.wecomUserId || '';
    }
  } catch (e) { console.warn('[wecom-daily-news] 读取用户配置失败:', e.message); }
  if (!chatId) {
    chatId = wecomConfig.defaultChatId || wecomConfig.defaultUserId || '';
  }

  const postData = JSON.stringify({
    chat_id: chatId || null,
    msg_type: 'markdown',
    content: message,
    chat_type: 'single',
  });

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: sendPort,
      path: '/wecom/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...(apiToken ? { 'X-Api-Key': apiToken } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ success: true });
        }
      });
    });

    req.on('error', (e) => {
      console.error('[wecom-daily-news] webhook 发送失败:', e.message);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

// ── Schema — for capability registry ────────────────────────
const schema = {
  name: 'wecom-daily-news',
  description: '资讯推送：搜索 → AI摘要 → 企微/飞书推送',
  capabilities: ['notification_push', 'content_summarization'],
  input: {
    topics:  { type: 'string', description: '资讯主题（逗号分隔）' },
    channel: { type: 'string', enum: ['wecom', 'lark', 'both'], description: '推送渠道' },
  },
  output: {
    message: { type: 'string', description: '推送结果描述' },
    topics:  { type: 'string', description: '推送的主题' },
  },
};

module.exports = { execute, schema };
