// core.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { sendJson } = require('../http-utils');
const { getDataDir, getApiKey, isLocalSocket } = require('./_shared');
const { verifyApiToken } = require('../../core/http-middleware');

async function handleHealth(req, res, _ctx) {
  // 2026-08-15: 渠道状态文件统一读取(企微/飞书桥各自写 {connected, timestamp})
  const readChannelStatus = (file) => {
    try {
      if (fs.existsSync(file)) {
        const status = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return status.connected === true && (Date.now() - status.timestamp < 120000);
      }
    } catch (e) {
      console.warn('failed to read channel status', file, e.message);
    }
    return false;
  };
  const larkConnected = readChannelStatus(path.join(getDataDir(), 'lark-status.json'));
  const wecomConnected = readChannelStatus(path.join(getDataDir(), 'wecom-status.json'));

  // 2026-08-15: 服务连接状态扩展(右栏多服务状态行消费)——配置来自 config.json
  // (实测结构: models/wecom/lark 在顶层, 部分环境可能包在 appConfig 下, 两级兼容)
  let appConfig = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(getDataDir(), 'config.json'), 'utf-8'));
    appConfig = { ...(cfg.appConfig || {}), ...cfg };
  } catch (e) {

    // 无配置/损坏: 全部视为未配置

    console.warn('[core.js] 空 catch 补日志:', e && e.message);
  }

  const wecomCfg = appConfig.wecom || {};
  const larkCfg = appConfig.lark || {};
  const notPlaceholder = (v) => !!v && typeof v === 'string' && !/占位|placeholder/i.test(v);

  const memoryUsage = process.memoryUsage();
  // 2026-08-31 修复(Bug A): ai.configured 只读 config.json 原文件——8-31 起
  // saveConfig 剥离 provider key(config.json 不再携带, 单一事实源 = .api_keys.json
  // 加密存储), 该判定恒 false → 界面右栏「AI 模型 · 未配置」。加密存储有 key 即
  // 视为已配置(与 loadConfig 运行时取值同源, 兼容遗留明文)。
  const savedApiKeys = (() => {
    try { return require('../../core/config').loadApiKeys(); } catch (e) {
      console.warn('[core.js] loadApiKeys 失败:', e && e.message);
      return {};
    }
  })();
  const healthData = {
    status: 'ok',
    timestamp: Date.now(),
    uptime: process.uptime(),
    // 2026-08-08 fix: npm_package_version 仅 npm 启动时存在——独立部署(node 直接
    // 启动,如打包后的 node.exe)恒显示 1.0.0。改为读 package.json。
    version: (() => { try { return require('../../../package.json').version; } catch { return '1.0.0'; } })(),
    // 2026-08-15: services 块——右栏"服务连接状态"数据源(配置判定 + 桥连接判定)
    services: {
      ai: {
        configured: !!(appConfig.models?.providers?.[appConfig.models?.currentProvider]?.apiKey
          || savedApiKeys[appConfig.models?.currentProvider]),
      },
      wecom: { configured: notPlaceholder(wecomCfg.corpId), connected: wecomConnected },
      lark: { configured: notPlaceholder(larkCfg.appId) && notPlaceholder(larkCfg.appSecret), connected: larkConnected },
    },
    components: {
      lark: {
        status: larkConnected ? 'connected' : 'disconnected',
        lastCheck: larkConnected ? new Date().toISOString() : null
      },
      memory: {
        status: 'ok',
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB'
      },
      database: {
        status: ['tasks.db', 'unified-memory.db'].some(name => fs.existsSync(path.join(getDataDir(), name))) ? 'ok' : 'not_found'
      },
      config: {
        status: fs.existsSync(path.join(getDataDir(), 'config.json')) ? 'ok' : 'not_found'
      }
    },
    environment: process.env.NODE_ENV || 'development'
  };

  sendJson(res, 200, healthData);
}

async function handleMetrics(req, res, _ctx) {
  try {
    const { getMetricsCollector } = require('../../core/observability');
    sendJson(res, 200, { success: true, metrics: getMetricsCollector().getAllMetrics() });
  } catch (e) {
    console.error('[Metrics] 获取指标失败:', e.message);
    sendJson(res, 500, { success: false, error: e.message });
  }
}

async function handleShutdown(req, res, _ctx) {
  // 2026-08-07 (M12 安全): 此前仅凭 X-Electron: true 即可停机——任意本机进程
  // 或经本地转发的远端连接都能杀死服务。现要求：本机回环来源 + 合法 API token
  // （Electron 主进程停机调用同时携带 X-Api-Key(.api_token) 与 X-Electron，不受影响；
  // token 比较走 verifyApiToken，兼容 env ADMIN_API_KEY 与 .api_token 文件两种来源）。
  if (!isLocalSocket(req) || !verifyApiToken(req, getApiKey())) {
    console.warn('⛔ /shutdown 未授权请求已拒绝');
    sendJson(res, 403, { success: false, error: 'Forbidden' });
    return;
  }

  console.log('shutting down gracefully..');
  sendJson(res, 200, { success: true, message: 'Shutting down' });

  // 2026-08-07 (S4 冒烟验证): 此前 process.kill(pid, 'SIGTERM') 在 Windows 上是强制终止
  // (TerminateProcess)，不会触发 process.on('exit') → server.js 的单实例锁文件永不清理。
  // 改用 process.exit(0)：exit 事件同步执行 cleanupLockFile，锁可靠释放。
  // 2026-08-12: 优雅排空——置 draining 拒绝新连接,关闭活动 WS(触发 ASR 会话关闭),
  // 1.5s 宽限后退出(双保险:server.js 的 onExit 链仍会执行 destroyVoiceCloudWS)
  try {
    const { setDraining, destroyVoiceCloudWS } = require('../../handlers/voice-cloud-ws');
    setDraining(true);
    destroyVoiceCloudWS();
  } catch (e) {
    console.warn('[shutdown] Voice drain 失败:', e.message);
  }
  setTimeout(() => {
    process.exit(0);
  }, 1500);
}

async function handleRoot(req, res, ctx) {
  const apiKey = req.headers['x-api-key'];
  const hasToken = process.env.ADMIN_API_KEY && apiKey === process.env.ADMIN_API_KEY;
  
  if (hasToken) {
    const electronHint = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CrabPaw</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.container { text-align: center; padding: 40px; }
.icon { font-size: 64px; margin-bottom: 20px; }
h1 { color: #ff6b35; font-size: 2em; margin-bottom: 16px; }
p { color: #888; font-size: 1.1em; margin-bottom: 24px; }
.hint { color: #666; font-size: 0.9em; }
</style>
</head>
<body>
<div class="container">
<div class="icon">🦀</div>
<h1>CrabPaw</h1>
<p>请使用 Electron 客户端进行配置</p>
<p class="hint">Web 配置页面已迁移至 Electron 客户端</p>
</div>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(electronHint);
    return;
  }
  
  const htmlPath = ctx.path.join(ctx.PUBLIC_DIR, 'config.html');
  if (ctx.fs.existsSync(htmlPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(ctx.fs.readFileSync(htmlPath, 'utf-8'));
    return;
  }
  res.writeHead(404);
  res.end('Config page not found');
}

async function handleStatus(req, res, ctx) {
  // Read from disk to avoid stale memory config
  const diskConfig = ctx.config?.loadConfig?.() || {};
  const wecomConfig = diskConfig.wecom || ctx.appConfig?.wecom || {};
  // 2026-08-01: 有效渠道凭证判断——排除占位符/示例值（cli_xxxxxxxx、模板），
  // 防止"未配置却显示已配置"假阳性。appSecret 脱敏为 '***' 视为已配置。
  const isRealAppId = (v) => typeof v === 'string' && v.trim() !== '' && !/xxxx/i.test(v) && !/^cli_\{/.test(v);
  const hasSecret = (v) => typeof v === 'string' && v.trim() !== '';
  // Use CredentialManager for authoritative check: botId+secret (corpId is optional, needed only for REST API features)
  const hasWecom = ctx.wecom?.isConfigured?.() ?? (isRealAppId(wecomConfig.botId) && hasSecret(wecomConfig.secret));
  const larkConfig = diskConfig.lark || ctx.appConfig?.lark || {};
  const hasLark = isRealAppId(larkConfig.appId) && hasSecret(larkConfig.appSecret);
  const hasAI = !!(diskConfig.models?.currentProvider || ctx.appConfig?.models?.currentProvider);
  const memUsage = process.memoryUsage();
const larkRunning = ctx.lark?.isRunning?.() ?? false;

  let wecomRunning = false;
  try {
    const pidPath = path.join(getDataDir(), '.wecom_bridge.pid');
    if (fs.existsSync(pidPath)) {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (pid) {
        try {
          process.kill(pid, 0);
          wecomRunning = true;
        } catch (e) {
          // process.kill(pid,0) 在某些 Windows 环境下可能失败，尝试 tasklist
          try {
            const { safeExec } = require('../../core/safe-exec');
            const { stdout } = await safeExec(`tasklist /FI "PID eq ${pid}" /NH`, { timeout: 3000, windowsHide: true });
            wecomRunning = stdout.includes(String(pid));
          } catch (e) { console.warn('[request-handler] process check failed:', e.message); }
        }
      }
    }
  } catch (e) { console.warn('[request-handler] process status check failed:', e.message); }

  sendJson(res, 200, {
    success: true,
    hasLark: hasLark || (ctx.lark?.isConfigured?.() ?? false),
    hasWecom,
    hasAI: hasAI || !!ctx.appConfig.models?.providers?.[ctx.appConfig.models.currentProvider]?.apiKey,
    larkRunning,
    wecomRunning,
    pid: process.pid,
    nodeVersion: process.version,
    uptime: Math.floor(process.uptime()),
    memoryUsage: Math.round(memUsage.heapUsed / 1024 / 1024),
  });
}

// ─── P3 社区集成：二维码入口（微信群/Discord/文档）───
// Community integration: QR codes and links
async function handleCommunity(req, res, _ctx) {
  const community = {
    links: [
      { id: 'wechat-group', name: 'WeChat Group', icon: 'Q', qr: 'https://placeholder/crabpaw-wechat-qr.png', desc: 'Scan to join community' },
      { id: 'discord', name: 'Discord Server', icon: 'D', url: 'https://discord.gg/crabpaw', desc: 'International community' },
      { id: 'github', name: 'GitHub Repo', icon: 'G', url: 'https://github.com/crabpaw/crabpaw', desc: 'View source, submit issues' },
      { id: 'docs', name: 'Documentation', icon: 'B', url: 'https://crabpaw.dev/docs', desc: 'User manual and API docs' },
      { id: 'feedback', name: 'Feedback', icon: 'F', url: 'https://github.com/crabpaw/crabpaw/discussions', desc: 'Submit feature requests' },
      { id: 'blog', name: 'Blog', icon: 'P', url: 'https://crabpaw.dev/blog', desc: 'Changelog and articles' },
    ]
  };
  return sendJson(res, 200, { success: true, data: community });
}

// ─── P3 Diagnostic report: generate zip package ───
async function handleDiagnose(req, res, ctx) {
  const result = {
    success: true,
    timestamp: Date.now(),
    layers: [],
    summary: { healthy: 0, total: 6, status: 'unknown' },
  };

  // Layer 1: Gateway
  const larkRunning = ctx.lark?.isRunning?.() ?? false;
  const larkConfigured = ctx.lark?.isConfigured?.() ?? false;
  const wecomConfig = ctx.appConfig?.wecom || {};
  // Use CredentialManager.isConfigured() pattern: botId+secret (corpId is optional)
  const wecomConfigured = ctx.wecom?.isConfigured?.() ?? !!(wecomConfig.botId && wecomConfig.secret);
  let wecomRunning = false;
  try {
    const pidPath = path.join(getDataDir(), '.wecom_bridge.pid');
    if (fs.existsSync(pidPath)) {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (pid) {
        try { process.kill(pid, 0); wecomRunning = true; } catch (e) {
          try {
            const { safeExec } = require('../../core/safe-exec');
            const { stdout } = await safeExec('tasklist /FI "PID eq ' + pid + '" /NH', { timeout: 3000, windowsHide: true });
            wecomRunning = stdout.includes(String(pid));
          } catch (e) { console.warn('[request-handler] tasklist check failed:', e.message); }
        }
      }
    }
  } catch (e) { console.warn('[request-handler] pid file check failed:', e.message); }

  const anyConfigured = larkConfigured || wecomConfigured;
  const anyRunning = larkRunning || wecomRunning;
  let gatewayMsg = 'not configured';
  if (anyRunning) gatewayMsg = 'running';
  else if (anyConfigured) gatewayMsg = 'configured but not running';
  result.layers.push({
    id: 'gateway', name: 'Gateway', ok: anyRunning, message: gatewayMsg,
    suggestion: !anyConfigured ? 'configure Lark/WeCom in settings' : (!anyRunning ? 'start bridge service' : null),
  });

  // Layer 2: HTTP
  const httpOk = ctx.httpServer?.listening ?? false;
  result.layers.push({
    id: 'http', name: 'HTTP Server', ok: httpOk,
    message: httpOk ? 'running' : 'not running',
    suggestion: httpOk ? null : 'restart server',
  });

  // Layer 3: Chat readiness
  let chatReady = false;
  let chatMsg = 'not configured';
  const providers = ctx.appConfig?.models?.providers || {};
  const currentProvider = ctx.appConfig?.models?.currentProvider;
  if (currentProvider && providers[currentProvider]?.apiKey) {
    chatReady = true;
    chatMsg = currentProvider + ' available';
  } else if (Object.keys(providers).length > 0) {
    chatMsg = 'provider configured but no API key';
  }
  result.layers.push({
    id: 'chat-readiness', name: 'Chat Readiness', ok: chatReady, message: chatMsg,
    suggestion: chatReady ? null : 'configure AI model in settings',
  });

  // Layer 4: Model match
  const currentModel = ctx.appConfig?.models?.currentModel;
  const modelList = providers[currentProvider]?.models || [];
  const modelMatch = !currentModel || modelList.length === 0 || modelList.includes(currentModel);
  result.layers.push({
    id: 'model-match', name: 'Model Match', ok: modelMatch,
    message: modelMatch ? 'matched' : currentModel + ' not in available list',
    suggestion: modelMatch ? null : 're-select model in settings',
  });

  // Layer 5: Process health
  result.layers.push({
    id: 'process', name: 'Process', ok: true,
    message: 'pid ' + process.pid + ', uptime ' + Math.floor(process.uptime()) + 's',
  });

  // Layer 6: DB —— 应用实际使用的 SQLite 文件（tasks.db + unified-memory.db），任一存在即视为已初始化
  const dataDir = getDataDir();
  const dbCandidates = ['tasks.db', 'unified-memory.db', 'fts-memory.db', 'skill-quality.db', 'skill-versions.db'];
  const presentDbs = dbCandidates.filter(name => fs.existsSync(path.join(dataDir, name)));
  const dbOk = presentDbs.length > 0;
  result.layers.push({
    id: 'db', name: 'Database', ok: dbOk,
    message: dbOk ? `${presentDbs.length} 个 DB 就绪` : 'not found',
    suggestion: dbOk ? null : 'initialize database',
  });

  result.summary.healthy = result.layers.filter(l => l.ok).length;
  result.summary.status = result.summary.healthy === 6 ? 'healthy' : (result.summary.healthy >= 4 ? 'degraded' : 'unhealthy');

  return sendJson(res, 200, result);
}

async function handleServiceStart(req, res, ctx) {
  const service = ctx.url.pathname.match(/\/api\/services\/([^/]+)\/start/)?.[1];
  try {
    if (service === 'lark' || service === 'gateway') {
      if (typeof ctx.lark?.startEventServer === 'function') {
        ctx.lark.startEventServer();
        return sendJson(res, 200, { success: true, service, action: 'started', method: 'startEventServer' });
      }
      return sendJson(res, 503, { success: false, service, message: '飞书通道无 startEventServer 方法（通道未正确初始化）' });
    }
    if (service === 'wecom') {
      if (typeof ctx.wecomBridge?.start === 'function') {
        const bridge = ctx.wecomBridge.start();
        if (bridge) {
          return sendJson(res, 200, { success: true, service, action: 'started', method: 'wecomBridge.start' });
        }
        return sendJson(res, 503, { success: false, service, message: '企业微信桥接启动失败（凭证未配置或不完整）' });
      }
      return sendJson(res, 503, { success: false, service, message: '企业微信桥接不可用（非桥接模式或未初始化）' });
    }
    if (service === 'ai') {
      return sendJson(res, 200, { success: true, service, action: 'started', message: 'AI 模型无需单独启动' });
    }
    sendJson(res, 400, { success: false, message: `不支持的服务: ${service}` });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleServiceStop(req, res, ctx) {
  const service = ctx.url.pathname.match(/\/api\/services\/([^/]+)\/stop/)?.[1];
  try {
    if (service === 'lark' || service === 'gateway') {
      if (typeof ctx.lark?.stopEventServer === 'function') {
        ctx.lark.stopEventServer();
        return sendJson(res, 200, { success: true, service, action: 'stopped', method: 'stopEventServer' });
      }
      return sendJson(res, 503, { success: false, service, message: '飞书通道无 stopEventServer 方法（通道未正确初始化）' });
    }
    if (service === 'wecom') {
      if (typeof ctx.wecomBridge?.stop === 'function') {
        ctx.wecomBridge.stop();
        return sendJson(res, 200, { success: true, service, action: 'stopped', method: 'wecomBridge.stop' });
      }
      return sendJson(res, 503, { success: false, service, message: '企业微信桥接不可用（非桥接模式或未初始化）' });
    }
    if (service === 'ai') {
      return sendJson(res, 200, { success: true, service, action: 'stopped', message: 'AI 模型无法停止' });
    }
    sendJson(res, 400, { success: false, message: `不支持的服务: ${service}` });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

// ─── Gateway 启停（薄封装，桥接层包含 Lark + WeCom 两个通道）───
async function handleGatewayStart(req, res, ctx) {
  const results = { lark: null, wecom: null };
  try {
    // Lark — use startEventServer (in-process event server)
    if (ctx.lark) {
      try {
        if (typeof ctx.lark.startEventServer === 'function') {
          ctx.lark.startEventServer();
          results.lark = 'started (startEventServer)';
        } else {
          results.lark = 'no startEventServer method';
        }
      } catch (e) {
        results.lark = `error: ${e.message}`;
      }
    } else {
      results.lark = 'not available';
    }

    // WeCom — use ctx.wecomBridge (exposed by server.js)
    if (ctx.wecomBridge) {
      try {
        if (typeof ctx.wecomBridge.start === 'function') {
          const bridge = ctx.wecomBridge.start();
          results.wecom = bridge ? 'started (wecomBridge.start)' : 'not configured (no credentials)';
        } else {
          results.wecom = 'no start method';
        }
      } catch (e) {
        results.wecom = `error: ${e.message}`;
      }
    } else {
      results.wecom = 'not available (electron mode or not initialized)';
    }

    const anyStarted = typeof results.lark === 'string' && results.lark.startsWith('started')
      || typeof results.wecom === 'string' && results.wecom.startsWith('started');
    return sendJson(res, anyStarted ? 200 : 503, { success: anyStarted, action: 'start', results });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleGatewayStop(req, res, ctx) {
  const results = { lark: null, wecom: null };
  try {
    // Lark — use stopEventServer (in-process event server)
    if (ctx.lark) {
      try {
        if (typeof ctx.lark.stopEventServer === 'function') {
          ctx.lark.stopEventServer();
          results.lark = 'stopped (stopEventServer)';
        } else {
          results.lark = 'no stopEventServer method';
        }
      } catch (e) {
        results.lark = `error: ${e.message}`;
      }
    } else {
      results.lark = 'not available';
    }

    // WeCom — use ctx.wecomBridge (exposed by server.js)
    if (ctx.wecomBridge) {
      try {
        if (typeof ctx.wecomBridge.stop === 'function') {
          ctx.wecomBridge.stop();
          results.wecom = 'stopped (wecomBridge.stop)';
        } else {
          results.wecom = 'no stop method';
        }
      } catch (e) {
        results.wecom = `error: ${e.message}`;
      }
    } else {
      results.wecom = 'not available (electron mode or not initialized)';
    }

    const anyStopped = typeof results.lark === 'string' && results.lark.startsWith('stopped')
      || typeof results.wecom === 'string' && results.wecom.startsWith('stopped');
    return sendJson(res, anyStopped ? 200 : 503, { success: anyStopped, action: 'stop', results });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

// ─── 会话管理 API（已拆分到 handlers/session-handlers.js）───

// ─── 日志查看 API ───

async function handleLogs(req, res, ctx) {
  const file = ctx.url.searchParams.get('file') || '';
  const level = ctx.url.searchParams.get('level') || '';
  const keyword = ctx.url.searchParams.get('keyword') || '';
  const limit = parseInt(ctx.url.searchParams.get('limit') || '200', 10);
  const offset = parseInt(ctx.url.searchParams.get('offset') || '0', 10);

  try {
    const logsDir = path.join(getDataDir(), 'logs');
    const dataDir = getDataDir();
    let logPath;
    if (file) {
      // 兼容 logs/ 目录和 data/ 根目录下的日志文件
      const inLogsDir = path.join(logsDir, path.basename(file));
      const inDataDir = path.join(dataDir, path.basename(file));
      logPath = fs.existsSync(inLogsDir) ? inLogsDir : inDataDir;
    } else {
      // 默认读取最新的 crabpaw 日志文件（优先日期格式，回退到 crabpaw.log）
      const todayLog = path.join(dataDir, `crabpaw-${new Date().toISOString().slice(0, 10)}.log`);
      const legacyLog = path.join(dataDir, 'crabpaw.log');
      const rootLegacyLog = path.join(dataDir, 'crabpaw.log');
      logPath = fs.existsSync(todayLog) ? todayLog
        : fs.existsSync(rootLegacyLog) ? rootLegacyLog
        : legacyLog;
    }

    if (!fs.existsSync(logPath)) {
      return sendJson(res, 200, { success: true, logs: [], total: 0, file: path.basename(logPath) });
    }

    // 只读取文件末尾部分，避免大文件导致内存溢出
    const stat = fs.statSync(logPath);
    const MAX_READ = 2 * 1024 * 1024; // 最多读 2MB
    let content;
    if (stat.size > MAX_READ) {
      const fd = fs.openSync(logPath, 'r');
      const buf = Buffer.alloc(MAX_READ);
      fs.readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ);
      fs.closeSync(fd);
      content = buf.toString('utf-8');
      // 丢弃第一行（可能不完整）
      const firstNewline = content.indexOf('\n');
      if (firstNewline > 0) content = content.slice(firstNewline + 1);
    } else {
      content = fs.readFileSync(logPath, 'utf-8');
    }

    const lines = content.split('\n').filter(l => l.trim());

    let filtered = lines;
    if (level) {
      const levelUpper = level.toUpperCase();
      filtered = filtered.filter(l => l.includes(`[${levelUpper}]`));
    }
    if (keyword) {
      const kw = keyword.toLowerCase();
      filtered = filtered.filter(l => l.toLowerCase().includes(kw));
    }

    // 从最新的日志开始取（倒序后取前limit条，再恢复顺序）
    const reversed = filtered.reverse();
    const paginated = reversed.slice(offset, offset + limit).reverse();

    const parsed = paginated.map(line => {
      const tsMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
      const levelMatch = line.match(/\[(ERROR|WARN|INFO|DEBUG|VERBOSE)\]/);
      return {
        timestamp: tsMatch ? tsMatch[1] : '',
        level: levelMatch ? levelMatch[1] : 'INFO',
        content: line,
      };
    });

    sendJson(res, 200, { success: true, logs: parsed, total: filtered.length, file: path.basename(logPath) });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

async function handleLogFiles(req, res, _ctx) {
  try {
    const logsDir = path.join(getDataDir(), 'logs');
    const files = [];

    if (fs.existsSync(logsDir)) {
      const entries = fs.readdirSync(logsDir);
      for (const entry of entries) {
        if (entry.endsWith('.log')) {
          const stat = fs.statSync(path.join(logsDir, entry));
          files.push({
            name: entry,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      }
    }

    // 检查主日志文件（兼容旧 crabpaw.log 和新按日期命名的 crabpaw-YYYY-MM-DD.log）
    const dataDir = getDataDir();
    const dataEntries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
    for (const entry of dataEntries) {
      if (/^crabpaw.*\.log$/.test(entry)) {
        const fullPath = path.join(dataDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          files.push({
            name: entry,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            isMain: entry === 'crabpaw.log',
          });
        } catch (e) { console.warn('[request-handler] failed to stat log file:', e.message); }
      }
    }

    files.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

    sendJson(res, 200, { success: true, files });
  } catch (e) {
    sendJson(res, 500, { success: false, message: e.message });
  }
}

module.exports = {
  handleHealth,
  handleMetrics,
  handleShutdown,
  handleRoot,
  handleStatus,
  handleCommunity,
  handleDiagnose,
  handleServiceStart,
  handleServiceStop,
  handleGatewayStart,
  handleGatewayStop,
  handleLogs,
  handleLogFiles,
};
