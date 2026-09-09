
const { readJsonBody, sendJson, sendError } = require('./http-utils');
const { DATA_DIR: _DATA_DIR } = require('../core/config');
const { createModelRouter } = require('../core/model-router');

function isAdminAuthorized(req, ADMIN_API_KEY) {
  if (!ADMIN_API_KEY) return true;
  const header = (req.headers['x-api-key'] || req.headers['X-Api-Key'] || req.headers['authorization'] || '').toString();
  if (!header) return false;
  const value = header.startsWith('Bearer ') ? header.slice(7) : header;
  return value === ADMIN_API_KEY;
}

function validateConfig(data) {
  const errors = [];
  if (data.models?.currentProvider && !data.models?.providers?.[data.models.currentProvider]) {
    errors.push('当前模型提供商未配置');
  }
  return errors;
}

function maskSecret(secret) {
  if (!secret || secret.length < 8) return '********';
  return secret.substring(0, 4) + '****' + secret.substring(secret.length - 4);
}

async function handleConfig(req, res, ctx) {
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
  
  if (!isAdminAuthorized(req, ADMIN_API_KEY)) {
    return sendError(res, 401, 'Unauthorized');
  }
  
  if (req.method === 'GET') {
    const redact = (cfg) => {
      const clone = JSON.parse(JSON.stringify(cfg));
      if (clone?.lark?.appSecret) clone.lark.appSecret = maskSecret(clone.lark.appSecret);
      if (clone?.wecom?.secret) clone.wecom.secret = maskSecret(clone.wecom.secret);
      if (clone?.models?.providers) {
        Object.values(clone.models.providers).forEach(p => {
          if (p && p.apiKey) p.apiKey = maskSecret(p.apiKey);
        });
      }
      if (clone?.imageGeneration?.providers) {
        Object.values(clone.imageGeneration.providers).forEach(p => {
          if (p && p.apiKey) p.apiKey = maskSecret(p.apiKey);
        });
      }
      if (clone?.videoGeneration?.providers) {
        Object.values(clone.videoGeneration.providers).forEach(p => {
          if (p && p.apiKey) p.apiKey = maskSecret(p.apiKey);
        });
      }
      if (clone?.providers) {
    // eslint-disable-next-line no-unused-vars
    for (const [k, v] of Object.entries(clone.providers)) {
      if (v && v.apiKey) v.apiKey = maskSecret(v.apiKey);
    }
  }
  if (clone?.visionGeneration?.providers) {
        Object.values(clone.visionGeneration.providers).forEach(p => {
          if (p && p.apiKey) p.apiKey = maskSecret(p.apiKey);
        });
      }
      if (clone?.search?.tavilyApiKey) clone.search.tavilyApiKey = maskSecret(clone.search.tavilyApiKey);
      if (clone?.search?.bingApiKey) clone.search.bingApiKey = maskSecret(clone.search.bingApiKey);
      if (clone?.search?.baiduApiKey) clone.search.baiduApiKey = maskSecret(clone.search.baiduApiKey); // 2026-08-19 百度千帆 AI 搜索
      // 2026-08-19: env 兜底显示——key 只配在 .env(未在配置页保存)时页面仍可见(masked)。
      // 覆盖 baidu/tavily/bing 三个前端可见字段, 其余搜索 key 前端无输入框不暴露。
      const envSearchFallbacks = [['baiduApiKey', 'BAIDU_API_KEY'], ['tavilyApiKey', 'TAVILY_API_KEY'], ['bingApiKey', 'BING_API_KEY']];
      for (const [field, envName] of envSearchFallbacks) {
        if (!clone?.search?.[field] && process.env[envName]) {
          if (!clone.search) clone.search = {};
          clone.search[field] = maskSecret(process.env[envName]);
        }
      }
      // Mask voice credentials (same pattern as other credential fields)
      if (clone?.voice) {
        const voiceKeys = ['doubaoKey','doubaoAccessKey','volcAsrApiKey','volcAsrAppKey','volcAsrAccessKey','volcanoToken','openaiApiKey','qwenApiKey','aliyunApiKey'];
        for (const k of voiceKeys) { if (clone.voice[k]) clone.voice[k] = maskSecret(clone.voice[k]); }
      }
      // Inject authoritative isConfigured flags (uses CredentialManager which resolves
      // secrets from env vars, config.json, and .api_keys.json)
      try {
        const { getCredentialManager } = require('../core/credential-manager');
        const credMgr = getCredentialManager();
        clone._isLarkConfigured = credMgr.isLarkConfigured();
        clone._isWecomConfigured = credMgr.isWecomConfigured();
      } catch (e) {
        /* CredentialManager unavailable, frontend will fall back to field checks */
        console.warn('[config-handler.js] 空 catch 补日志:', e && e.message);
      }

      return clone;
    };
    return sendJson(res, 200, { success: true, data: redact(ctx.appConfig) });
  }

  // Force reload config from disk (used after external config changes e.g. backup restore)
  if (req.method === 'POST' && req.url?.includes('/config/reload')) {
    try {
      const reloadedConfig = ctx.config.loadConfig();
      Object.keys(ctx.appConfig).forEach(key => delete ctx.appConfig[key]);
      Object.assign(ctx.appConfig, reloadedConfig);
      console.log('[config-handler] Config reloaded from disk');
      return sendJson(res, 200, { success: true, message: '配置已重新加载' });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  if (req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const errors = validateConfig(data);
      if (errors.length > 0) {
        return sendError(res, 400, errors.join(', '));
      }
      // Load config from DISK as fallback for preserving credentials (memory may be stale)
      const diskConfig = ctx.config.loadConfig();

      if (data.lark) {
        const incomingSecret = data.lark.appSecret;
        if (!incomingSecret || incomingSecret.includes('***')) {
          data.lark.appSecret = diskConfig.lark?.appSecret || ctx.appConfig.lark?.appSecret;
        }
        if (!data.lark.appId && (diskConfig.lark?.appId || ctx.appConfig.lark?.appId)) {
          data.lark.appId = diskConfig.lark?.appId || ctx.appConfig.lark?.appId;
        }
        ctx.appConfig.lark = { ...ctx.appConfig.lark, ...data.lark };
      }
      if (data.wecom) {
        const incomingSecret = data.wecom.secret;
        if (!incomingSecret || incomingSecret.includes('***')) {
          data.wecom.secret = diskConfig.wecom?.secret || ctx.appConfig.wecom?.secret;
        }
        // PERMANENT SAFETY NET: never accept empty credential fields
        // Preserve from disk, then memory, in that order
        if (!data.wecom.corpId) {
          data.wecom.corpId = diskConfig.wecom?.corpId || ctx.appConfig.wecom?.corpId || '';
        }
        if (!data.wecom.botId) {
          data.wecom.botId = diskConfig.wecom?.botId || ctx.appConfig.wecom?.botId || '';
        }
        ctx.appConfig.wecom = { ...ctx.appConfig.wecom, ...data.wecom };
      }
      if (data.chatChannel) {
        ctx.appConfig.chatChannel = data.chatChannel;
      }
      if (data.providers) {
    for (const [key, p] of Object.entries(data.providers)) {
      if (p && p.apiKey) {
        const ik = p.apiKey;
        if (!ik || ik.includes('***')) {
          p.apiKey = ctx.appConfig.providers?.[key]?.apiKey;
        }
      }
    }
    ctx.appConfig.providers = { ...ctx.appConfig.providers, ...data.providers };
  }
  if (data.modelAssignments) {
    ctx.appConfig.modelAssignments = { ...ctx.appConfig.modelAssignments, ...data.modelAssignments };
  }
      if (data.models) {
        if (data.models.providers) {
          Object.keys(data.models.providers).forEach(key => {
            const incomingApiKey = data.models.providers[key].apiKey;
            if (!incomingApiKey || incomingApiKey.includes('***')) {
              data.models.providers[key].apiKey = ctx.appConfig.models?.providers?.[key]?.apiKey;
            }
            // 2026-09-09 修复(打包版首启实测): 掩码串若无真值可回填, 宁可丢弃也不落盘——
            // 此前向导把 GET 回来的掩码 key 原样存回, 磁盘上出现 "sk-a****xxxx" 假密钥
            const stillMasked = data.models.providers[key].apiKey && String(data.models.providers[key].apiKey).includes('****');
            if (stillMasked) delete data.models.providers[key].apiKey;
          });
        }
        // 2026-09-09 修复(设置页改模型不生效): models.routing 由首启向导写入后被
        // CategoryRouter 原样采用(_buildRouting 见 routing 非空即整体采用)——设置页改
        // providers[...].model 永远不影响实际对话模型(用户症状:改完还是 deepseek-chat)。
        // 凡本次保存改动了主模型/主提供商, 同步 routing 中与旧主模型同源的 chat
        // (及同提供商的 reasoning)条目到新值。
        const prevModels = ctx.appConfig.models || {};
        const newProvider = data.models.currentProvider || prevModels.currentProvider;
        const prevMainModel = prevModels.providers?.[prevModels.currentProvider]?.model;
        const newMainModel = data.models.providers?.[newProvider]?.model;
        const mainModelChanged = !!newMainModel && newMainModel !== prevMainModel;
        const providerChanged = !!data.models.currentProvider && data.models.currentProvider !== prevModels.currentProvider;
        ctx.appConfig.models = { ...prevModels, ...data.models };
        const mergedModels = ctx.appConfig.models;
        if (mergedModels.routing && (mainModelChanged || providerChanged)) {
          const effectiveModel = mergedModels.providers?.[newProvider]?.model || mergedModels.defaultModel || prevMainModel;
          if (mergedModels.routing.chat && (mergedModels.routing.chat.provider === prevModels.currentProvider || providerChanged)) {
            mergedModels.routing.chat = { ...mergedModels.routing.chat, provider: newProvider, model: effectiveModel };
          }
          if (mergedModels.routing.reasoning && mergedModels.routing.reasoning.provider === prevModels.currentProvider) {
            mergedModels.routing.reasoning = { ...mergedModels.routing.reasoning, model: effectiveModel };
          }
        }
      }
      if (data.imageGeneration) {
        if (data.imageGeneration.providers) {
          Object.keys(data.imageGeneration.providers).forEach(key => {
            const incomingApiKey = data.imageGeneration.providers[key].apiKey;
            if (!incomingApiKey || incomingApiKey.includes('***')) {
              data.imageGeneration.providers[key].apiKey = ctx.appConfig.imageGeneration?.providers?.[key]?.apiKey;
            }
          });
        }
        ctx.appConfig.imageGeneration = { ...ctx.appConfig.imageGeneration, ...data.imageGeneration };
      }
      if (data.videoGeneration) {
        if (data.videoGeneration.providers) {
          Object.keys(data.videoGeneration.providers).forEach(key => {
            const incomingApiKey = data.videoGeneration.providers[key].apiKey;
            if (!incomingApiKey || incomingApiKey.includes('***')) {
              data.videoGeneration.providers[key].apiKey = ctx.appConfig.videoGeneration?.providers?.[key]?.apiKey;
            }
          });
        }
        ctx.appConfig.videoGeneration = { ...ctx.appConfig.videoGeneration, ...data.videoGeneration };
      }
      if (data.visionGeneration) {
        if (data.visionGeneration.providers) {
          Object.keys(data.visionGeneration.providers).forEach(key => {
            const incomingApiKey = data.visionGeneration.providers[key].apiKey;
            if (!incomingApiKey || incomingApiKey.includes('***')) {
              data.visionGeneration.providers[key].apiKey = ctx.appConfig.visionGeneration?.providers?.[key]?.apiKey;
            }
          });
        }
        ctx.appConfig.visionGeneration = { ...ctx.appConfig.visionGeneration, ...data.visionGeneration };
      }
      if (data.agent) ctx.appConfig.agent = { ...ctx.appConfig.agent, ...data.agent };
      if (data.user) ctx.appConfig.user = { ...ctx.appConfig.user, ...data.user };
      if (data.voice) {
        // Preserve masked voice credentials (same pattern as models/search/lark/wecom)
        const voiceKeys = ['doubaoKey', 'doubaoAccessKey', 'volcAsrApiKey', 'volcAsrAppKey', 'volcAsrAccessKey', 'volcanoToken', 'openaiApiKey', 'qwenApiKey', 'aliyunApiKey'];
        for (const key of voiceKeys) {
          if (data.voice[key] !== undefined && (!data.voice[key] || String(data.voice[key]).includes('***'))) {
            data.voice[key] = ctx.appConfig.voice?.[key] || diskConfig.voice?.[key] || '';
          }
        }
        ctx.appConfig.voice = { ...ctx.appConfig.voice, ...data.voice };
      }
      if (data.search) {
        const incomingTavily = data.search.tavilyApiKey;
        const incomingBing = data.search.bingApiKey;
        const incomingJina = data.search.jinaApiKey;
        const incomingBrave = data.search.braveApiKey;
        const incomingExa = data.search.exaApiKey;
        const incomingBaidu = data.search.baiduApiKey; // 2026-08-19 百度千帆 AI 搜索
        if (!incomingTavily || incomingTavily.includes('***')) {
          data.search.tavilyApiKey = ctx.appConfig.search?.tavilyApiKey;
        }
        if (!incomingBing || incomingBing.includes('***')) {
          data.search.bingApiKey = ctx.appConfig.search?.bingApiKey;
        }
        if (!incomingJina || incomingJina.includes('***')) {
          data.search.jinaApiKey = ctx.appConfig.search?.jinaApiKey;
        }
        if (!incomingBrave || incomingBrave.includes('***')) {
          data.search.braveApiKey = ctx.appConfig.search?.braveApiKey;
        }
        if (!incomingExa || incomingExa.includes('***')) {
          data.search.exaApiKey = ctx.appConfig.search?.exaApiKey;
        }
        if (!incomingBaidu || incomingBaidu.includes('***')) {
          data.search.baiduApiKey = ctx.appConfig.search?.baiduApiKey;
        }
        ctx.appConfig.search = { ...ctx.appConfig.search, ...data.search };
      }
      if (data.pushTargets) ctx.appConfig.pushTargets = data.pushTargets;
      if (data.setupCompleted !== undefined) ctx.appConfig.setupCompleted = data.setupCompleted;
      // 2026-08-26 审计 A4: update(url/autoCheck)此前无分支——保存即死写,
      // 更新服务器地址永不落盘(electron 自动检查读不到)。合并补丁。
      if (data.update && typeof data.update === 'object') {
        ctx.appConfig.update = { ...(ctx.appConfig.update || {}), ...data.update };
      }
      // 2026-08-27 审计 A4 附带: enableWhitelist/allowedUsers(聊天用户白名单)同样无分支——
      // 前端「仅白名单中的用户可使用机器人」保存后不落盘, chat-handler 恒读默认 false。
      // 与 update 同款的显式合并分支。
      if (data.enableWhitelist !== undefined) ctx.appConfig.enableWhitelist = data.enableWhitelist;
      if (data.allowedUsers !== undefined) ctx.appConfig.allowedUsers = data.allowedUsers;
      // 2026-08-26 审计 A3: security 键此前无磁盘合并分支——安全三开关经双通道并发
      // 保存后丢 disk(实测 /config 无 security 键)。合并进 appConfig 供 saveConfig 持久化。
      if (data.security && typeof data.security === 'object') {
        ctx.appConfig.security = { ...(ctx.appConfig.security || {}), ...data.security };
      }

      ctx.config.saveConfig(ctx.appConfig);

      // Sync search API keys via SearchBackendManager (avoids process.env leak)
      try {
        const { SearchBackendManager, BaiduApiBackend } = require('../core/search');
        const searchCfg = ctx.appConfig.search || {};
        SearchBackendManager.syncCredentials({
          jinaKey: searchCfg.jinaApiKey || process.env.JINA_API_KEY || '',
          braveKey: searchCfg.braveApiKey || process.env.BRAVE_API_KEY || '',
          tavilyKey: searchCfg.tavilyApiKey || process.env.TAVILY_API_KEY || '',
          baiduKey: searchCfg.baiduApiKey || process.env.BAIDU_API_KEY || '',
        });
        // 2026-08-19 百度后端保存即生效(动态注册, 不依赖重启)——Tavily/Bing 保存后
        // 需重启才进 process.env(server.js:117 启动注入), 百度保持与 web-tools 行为一致。
        // register/getBackend 是实例方法, 共享实例经 web-tools.getSearchManager 获取。
        const baiduKey = searchCfg.baiduApiKey || process.env.BAIDU_API_KEY || '';
        if (baiduKey) {
          const { getSearchManager } = require('../tools/web-tools');
          const manager = getSearchManager();
          if (manager && !manager.getBackend('baidu_api')) {
            manager.register(new BaiduApiBackend({ apiKey: baiduKey }));
            console.log('[config-handler] 百度千帆 AI 搜索后端已即时注册');
          }
        }
      } catch (e) {
        /* search backend may not be initialized yet */
        console.warn('[config-handler.js] 空 catch 补日志:', e && e.message);
      }

      
      // Sync security config to runtime SecuritySystem (instant生效, not just on restart)
      if (data.security && ctx.security) {
        try {
          const { SecuritySystem: _SecuritySystem, SECURITY_LEVELS } = require('../core/security');
          const LEVEL_MAP = { low: 'disabled', medium: 'standard', high: 'strict' };
          const backendLevel = LEVEL_MAP[data.security.level] || data.security.level;
          if (SECURITY_LEVELS[backendLevel.toUpperCase()]) {
            ctx.security.setLevel(backendLevel);
          }
          if (data.security.approval) {
            Object.assign(ctx.security.config.approval, data.security.approval);
          }
          if (data.security.userWhitelist) {
            Object.assign(ctx.security.config.userWhitelist, data.security.userWhitelist);
          }
        } catch (e) {
          console.warn('[config-handler] 安全配置即时生效失败:', e.message);
        }
      }

      const reloadedConfig = ctx.config.loadConfig();
      Object.keys(ctx.appConfig).forEach(key => delete ctx.appConfig[key]);
      Object.assign(ctx.appConfig, reloadedConfig);

      createModelRouter(ctx.appConfig);
      
      if (data.agent?.name || data.user?.name) {
        ctx.config.updateWorkspaceFiles(ctx.appConfig);
      }
      
      return sendJson(res, 200, { success: true, message: '配置已保存' });
    } catch (e) {
      return sendError(res, 400, e.message);
    }
  }
  
  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleUserConfig(req, res, ctx) {
  if (req.method === 'GET') {
    try {
      const userData = ctx.appConfig.user || { name: '主人', avatar: '🦀', notes: '' };
      return sendJson(res, 200, { success: true, data: userData });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  if (req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      ctx.appConfig.user = { ...ctx.appConfig.user, ...data };
      ctx.config.saveConfig(ctx.appConfig);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }
  res.writeHead(405);
  res.end('Method Not Allowed');
}

async function handleAssistantConfig(req, res, ctx) {
  if (req.method === 'GET') {
    try {
      const agentData = ctx.appConfig.agent || { name: '小秘', personality: '专业、贴心、高效', systemPrompt: '', avatar: '🤖' };
      return sendJson(res, 200, { success: true, data: agentData });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }

  if (req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      ctx.appConfig.agent = { ...ctx.appConfig.agent, ...data };
      ctx.config.saveConfig(ctx.appConfig);
      return sendJson(res, 200, { success: true });
    } catch (e) {
      return sendError(res, 500, e.message);
    }
  }
  res.writeHead(405);
  res.end('Method Not Allowed');
}

module.exports = {
  handleConfig,
  handleUserConfig,
  handleAssistantConfig,
  isAdminAuthorized,
  validateConfig
};
