// models.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');

async function handleModelDetect(req, res, ctx) {
  try {
    // eslint-disable-next-line no-unused-vars
    const { provider, model } = ctx.params || {};
    if (!provider) return sendJson(res, 400, { success: false, message: 'provider required' });
    const config = ctx.appConfig?.models?.providers?.[provider];
    if (!config) return sendJson(res, 404, { success: false, message: 'provider not found: ' + provider });
    if (!['ollama', 'custom'].includes(provider)) {
      return sendJson(res, 400, { success: false, message: provider + ' does not support model detection' });
    }
    const baseUrl = config.baseUrl || '';
    if (!baseUrl) return sendJson(res, 400, { success: false, message: 'base URL not configured' });
    let models = [];
    if (provider === 'ollama') {
      try {
        const resp = await fetch(baseUrl.replace(/\/$/, '') + '/api/tags');
        const data = await resp.json();
        models = (data.models || []).map(m => m.name);
      } catch (e) {
        return sendJson(res, 500, { success: false, message: 'ollama query failed: ' + e.message });
      }
    } else if (provider === 'custom') {
      try {
        const resp = await fetch(baseUrl.replace(/\/$/, '') + '/v1/models', {
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (config.apiKey || '') }
        });
        const data = await resp.json();
        models = (data.data || []).map(m => m.id);
      } catch (e) {
        return sendJson(res, 500, { success: false, message: 'custom provider query failed: ' + e.message });
      }
    }
    return sendJson(res, 200, { success: true, data: { provider, models } });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleApiServerStatus(req, res, _ctx) {
  try {
    const { getOpenAICompatProxy, getApiServerConfig } = require('../../core/openai-compat-proxy');
    const config = getApiServerConfig();
    const proxy = getOpenAICompatProxy();

    return sendJson(res, 200, {
      success: true,
      data: {
        enabled: config.enabled,
        running: proxy.isRunning,
        host: config.host,
        port: config.port,
        modelName: config.modelName,
        hasApiKey: !!config.apiKey,
      },
    });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleApiServerConfig(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    const fs = require('fs');
    const path = require('path');
    const CONFIG_DIR = process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
    const envPath = path.join(CONFIG_DIR, '.env');

    // 读取现有 .env
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
    }

    // 更新环境变量
    const envVars = {
      API_SERVER_ENABLED: body.enabled ? 'true' : 'false',
      API_SERVER_HOST: body.host || '127.0.0.1',
      API_SERVER_PORT: String(body.port || 9876),
      API_SERVER_KEY: body.apiKey || '',
      API_SERVER_MODEL_NAME: body.modelName || 'crabpaw-agent',
      API_SERVER_CORS_ORIGINS: body.corsOrigins || '',
    };

    for (const [key, value] of Object.entries(envVars)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, line);
      } else {
        envContent += `\n${line}`;
      }
    }

    fs.writeFileSync(envPath, envContent.trim() + '\n');

    // 更新当前进程环境变量
    for (const [key, value] of Object.entries(envVars)) {
      process.env[key] = value;
    }

    return sendJson(res, 200, {
      success: true,
      message: 'ok',
    });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleFallbackStatus(req, res, _ctx) {
  try {
    const { getFallbackProviderManager } = require('../../core/fallback-provider');
    const { getModelRouter } = require('../../core/model-router');
    const manager = getFallbackProviderManager();
    const router = getModelRouter();

    const stats = manager ? manager.getStats() : {};
    const health = router ? router.getHealthStatus() : {};

    return sendJson(res, 200, {
      stats,
      health,
      providers: router ? router.listProviders() : [],
    });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

async function handleFallbackConfig(req, res, ctx) {
  try {
    const body = await readJsonBody(req);
    const fs = require('fs');
    const path = require('path');
    const CONFIG_DIR = process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
    const envPath = path.join(CONFIG_DIR, '.env');

    // 读取现有 .env
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
    }

    // 更新 fallback 环境变量
    const envVars = {
      FALLBACK_PROVIDER: body.fallbackModel?.provider || '',
      FALLBACK_MODEL: body.fallbackModel?.model || '',
      FALLBACK_BASE_URL: body.fallbackModel?.baseUrl || '',
      AUX_VISION_PROVIDER: body.auxiliary?.vision?.provider || 'auto',
      AUX_VISION_MODEL: body.auxiliary?.vision?.model || '',
      AUX_COMPRESSION_PROVIDER: body.auxiliary?.compression?.provider || 'auto',
      AUX_COMPRESSION_MODEL: body.auxiliary?.compression?.model || '',
    };

    for (const [key, value] of Object.entries(envVars)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${value}`;
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, line);
      } else {
        envContent += `\n${line}`;
      }
    }

    fs.writeFileSync(envPath, envContent.trim() + '\n');

    // 更新当前进程环境变量
    for (const [key, value] of Object.entries(envVars)) {
      process.env[key] = value;
    }

    // update runtime config
    try {
      const { getFallbackProviderManager } = require('../../core/fallback-provider');
      const manager = getFallbackProviderManager();
      if (manager) {
        if (body.fallbackModel) {
          manager.setFallbackConfig(body.fallbackModel);
        }
        if (body.auxiliary) {
          for (const [taskType, config] of Object.entries(body.auxiliary)) {
            manager.setAuxiliaryConfig(taskType, config);
          }
        }
      }
    } catch (e) { console.warn('[request-handler] webhook verification exception:', e.message); }

    // 2026-09-09 修复(备用模型重启丢失): 此前只写 .env + 进程环境变量——打包版启动时
    // 加载的是 resources/.env(不存在, 跳过), DATA_DIR/.env 无人读取 → 备用模型重启即失效。
    // 同步持久化到 config.json(models.fallbackModel/auxiliary), 启动时 server.js 从
    // appConfig 装配 FallbackProviderManager, 跨重启生效
    if (ctx?.appConfig && ctx?.config) {
      try {
        ctx.appConfig.models = ctx.appConfig.models || {};
        if (body.fallbackModel) {
          ctx.appConfig.models.fallbackModel = {
            provider: body.fallbackModel.provider || '',
            model: body.fallbackModel.model || '',
            baseUrl: body.fallbackModel.baseUrl || '',
          };
        }
        if (body.auxiliary && typeof body.auxiliary === 'object') {
          ctx.appConfig.models.auxiliary = { ...(ctx.appConfig.models.auxiliary || {}), ...body.auxiliary };
        }
        ctx.config.saveConfig(ctx.appConfig);
      } catch (persistErr) { console.warn('[models.js] fallback 持久化失败:', persistErr.message); }
    }

    return sendJson(res, 200, {
      success: true,
      message: '备用提供者配置已保存',
    });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleModelTest(req, res, _ctx) {
  try {
    const body = await readJsonBody(req);
    // eslint-disable-next-line no-unused-vars
    const { provider, baseUrl = body.apiUrl, apiKey, model } = body;
    const startedAt = Date.now();

    if (!baseUrl || !model) {
      return sendJson(res, 400, { success: false, message: 'Invalid request' });
    }

    const https = require('https');
    const http = require('http');
    const url = new URL('/chat/completions', baseUrl);

    const testPayload = {
      model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
      stream: false,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false, error: '连接超时 (10s)' }), 10000);

      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(url, {
        method: 'POST',
        headers,
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const modelUsed = json.model || model;
              resolve({ ok: true, model: modelUsed, status: res.statusCode });
            } catch {
              resolve({ ok: true, status: res.statusCode });
            }
          } else {
            let errorMsg = `HTTP ${res.statusCode}`;
            try {
              const json = JSON.parse(data);
              errorMsg = json.error?.message || json.message || errorMsg;
            } catch (e) { console.warn('[request-handler] JSON parse failed, using default error message:', e.message); }
            resolve({ ok: false, error: errorMsg, status: res.statusCode });
          }
        });
      });

      req.on('error', (e) => {
        clearTimeout(timeout);
        resolve({ ok: false, error: e.message });
      });

      req.on('timeout', () => {
        clearTimeout(timeout);
        req.destroy();
        resolve({ ok: false, error: '连接超时' });
      });

      req.write(JSON.stringify(testPayload));
      req.end();
    });

    sendJson(res, 200, {
      success: result.ok,
      ...result,
      latency: Date.now() - startedAt,
      message: result.ok ? 'Connection OK' : (result.error || 'Connection failed'),
    });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

// ─── Model ecosystem / security / identity local handlers ───
const MODEL_ECOSYSTEM_META = {
  deepseek:            { name: 'DeepSeek', icon: 'DS', docs: 'https://platform.deepseek.com/api-docs', apiUrl: 'https://api.deepseek.com/v1' },
  minimax:             { name: 'MiniMax', icon: 'MX', docs: 'https://platform.minimaxi.com/document/', apiUrl: 'https://api.minimax.chat/v1' },
  zhipu:               { name: 'Zhipu GLM', icon: 'GLM', docs: 'https://open.bigmodel.cn/dev/api', apiUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  aliyun_standard:     { name: 'Aliyun Bailian', icon: 'AL', docs: 'https://help.aliyun.com/zh/model-studio/', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  aliyun_coding:       { name: 'Aliyun Coding', icon: 'AC', docs: 'https://help.aliyun.com/zh/model-studio/', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  volcengine_standard: { name: 'Volcengine Ark', icon: 'VA', docs: 'https://www.volcengine.com/docs/82379', apiUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  volcengine_coding:   { name: 'Volcengine Coding', icon: 'VC', docs: 'https://www.volcengine.com/docs/82379', apiUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  ollama:              { name: 'Ollama', icon: 'OL', docs: 'https://ollama.com/library', apiUrl: 'http://localhost:11434/v1' },
  custom:              { name: 'OpenAI Compatible', icon: 'API', docs: '', apiUrl: 'http://localhost:8000/v1' },
};

async function handleModelEcosystem(req, res, ctx) {
  try {
    if (req.method === 'GET') {
      const { PROVIDER_MODEL_DEFS } = require('../../core/llm/provider-registry');
      const providers = Object.keys(PROVIDER_MODEL_DEFS).map((id) => {
        const meta = MODEL_ECOSYSTEM_META[id] || { name: id, icon: 'AI', docs: '', apiUrl: '' };
        const configured = ctx.appConfig?.models?.providers?.[id];
        const models = (PROVIDER_MODEL_DEFS[id] || []).map((m) => ({
          id: m.id,
          name: m.name,
          context: m.contextWindow,
        }));
        return {
          id,
          name: meta.name,
          icon: meta.icon,
          apiUrl: configured?.baseUrl || meta.apiUrl,
          docs: meta.docs,
          models,
        };
      });
      return sendJson(res, 200, { success: true, providers });
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.apiUrl || !body.model || !body.providerId) {
        return sendJson(res, 400, { success: false, message: 'Missing apiUrl/model/providerId' });
      }
      req.body = {
        provider: body.providerId,
        baseUrl: body.apiUrl,
        apiKey: body.apiKey || '',
        model: body.model,
      };
      return handleModelTest(req, res, ctx);
    }

    return sendJson(res, 405, { success: false, message: 'Method Not Allowed' });
  } catch (e) {
    return sendJson(res, 500, { success: false, message: e.message });
  }
}

module.exports = {
  handleModelDetect,
  handleApiServerStatus,
  handleApiServerConfig,
  handleFallbackStatus,
  handleFallbackConfig,
  handleModelTest,
  handleModelEcosystem,
};
