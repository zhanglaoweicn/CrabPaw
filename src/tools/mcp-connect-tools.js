/**
 * mcp-connect-tools.js — MCP 连接器对话式配置向导（2026-09-24 M1：金蝶专线）
 *
 * 用户场景：老板贴一个 MCP 文档链接（或说"接金蝶"），智能体读懂→引导补齐
 * 凭证→自动装组件→写配置热连接→当场报出发现的工具。用户不需要知道
 * MCP/Python/pip 是什么。
 *
 * 拆两个工具（审批面分离，对齐"Bash 只读免审批"哲学）：
 * - McpConnect        查询侧：catalog/inspect/probe——只读，不打扰
 * - McpConnectManage  变更侧：install/configure/remove——riskLevel high，
 *   每次调用经 S6 审批闸人工确认（registry.js ask → ApprovalHost）
 *
 * 安全四闸（网页 = 不可信输入）：
 * ① 目录预审制——自由文本只做"识别到哪个 preset"，不解析页面内容当配置；
 * ② 写配置/装组件必过人工审批（本文件变更侧 riskLevel high）；
 * ③ 安装白名单 assertInstallAllowed——只允许 preset 声明的 PyPI 包名；
 * ④ 凭证不回显——configure 返回值经 maskEnv 打码，错误信息不含值。
 */

const fs = require('fs');
const { exec, spawn } = require('child_process');
const { registry } = require('./registry');
const {
  listConnectors,
  getConnector,
  matchConnector,
  validateCredentials,
  assertInstallAllowed,
  buildServerConfig,
  maskEnv,
  getMcpLibDir,
} = require('../core/mcp/connectors');

function _mgr() {
  const { getMCPManager } = require('../core/mcp');
  return getMCPManager();
}

function _toolResult(text, extra) {
  return { success: true, content: text, ...(extra || {}) };
}

// ── 安装（pip --target 到 data/mcp-libs/<id>，随盘/覆盖更新不丢）────────

const PIP_TIMEOUT_MS = 300000;
const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';

function _execPip(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: PIP_TIMEOUT_MS, windowsHide: true, encoding: 'utf-8' }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** import 试探：组件是否已可用（PYTHONPATH 指向 libDir 时能 import 即视为已装） */
function _isImportable(preset, libDir) {
  const { getPythonPath } = require('../core/portable-deps');
  const pythonPath = getPythonPath();
  const moduleName = preset.commandPlan.module.split('.')[0];
  return new Promise((resolve) => {
    const p = spawn(pythonPath, ['-c', `import ${moduleName}`], {
      env: { ...process.env, PYTHONPATH: libDir },
      windowsHide: true,
      stdio: 'ignore',
    });
    let done = false;
    const timer = setTimeout(() => { try { p.kill(); } catch (e) { /* 已退出 */ } finish(false); }, 15000);
    function finish(ok) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, pythonPath });
    }
    p.on('error', () => finish(false));
    p.on('exit', (code) => finish(code === 0));
  });
}

async function _pipInstall(preset, libDir) {
  const { getPythonPath } = require('../core/portable-deps');
  const pythonPath = getPythonPath();
  fs.mkdirSync(libDir, { recursive: true });
  assertInstallAllowed(preset, preset.install.package);

  const base = `"${pythonPath}" -m pip install --target="${libDir}" ${preset.install.package} --quiet --no-warn-script-location`;
  let last = await _execPip(base);
  if (last.err) {
    // 直连失败回退清华镜像（国内网络常见）
    last = await _execPip(`${base} -i ${PYPI_MIRROR}`);
  }
  if (last.err) {
    return {
      ok: false,
      error: `安装失败：${(last.stderr || last.stdout || last.err.message || '').slice(-400)}`,
      hint: `可手动执行: ${base}`,
    };
  }
  const verify = await _isImportable(preset, libDir);
  if (!verify.ok) {
    return { ok: false, error: '安装命令已完成但组件导入失败（可能是网络不完整下载），可重试安装' };
  }
  return { ok: true, pythonPath, libDir };
}

// ── 查询侧动作 ─────────────────────────────────────────────

function _liveStatusMap() {
  try {
    const map = {};
    for (const s of _mgr().getServers()) map[s.name] = s;
    return map;
  } catch (e) {
    return {};
  }
}

function handleCatalog() {
  const live = _liveStatusMap();
  const items = listConnectors().map((c) => {
    const s = live[c.id];
    return {
      ...c,
      status: s ? s.status : 'not_configured',
      toolCount: s ? s.toolCount : 0,
    };
  });
  return _toolResult(
    `可接入的业务系统连接器共 ${items.length} 个：\n` +
      items
        .map((c) => `【${c.name}】(${c.id}) ${c.status === 'connected' ? `已连接，${c.toolCount} 个工具` : c.status === 'not_configured' ? '未配置' : c.status}\n  ${c.vendorNote}\n  ${c.benefits}`)
        .join('\n') +
      `\n\n要接入哪个，直接说"接金蝶"或贴它的介绍页链接。`
  );
}

function handleInspect(params) {
  let preset = params.connector ? getConnector(params.connector) : null;
  if (!preset && params.url) {
    const id = matchConnector(params.url);
    preset = id ? getConnector(id) : null;
  }
  if (!preset) {
    return _toolResult(
      `链接或名称未匹配到已收录的连接器。当前目录：${listConnectors().map((c) => c.name).join('、')}。` +
        `未收录的 MCP 组件暂不支持自动接入（预审目录制，防止来路不明的配置），已记录需求。`
    );
  }
  const info = preset.envSchema
    .map((f) => `- ${f.label}${f.required ? '（必填）' : ''}：${f.hint}`)
    .join('\n');
  return _toolResult(
    `【${preset.name}】接入计划\n` +
      `${preset.vendorNote}\n接通后效果：${preset.benefits}\n\n` +
      `我将做三件事：① 联网安装组件 ${preset.install.package}（一次性，经你确认）② 写入连接配置（经你确认）③ 连接并报出发现的工具。\n\n` +
      `需要你提供：\n${info}\n\n` +
      `准备好后直接把这几项发我（一次发齐或分条都行），密码只在写入配置时使用，不会复述。`,
    { connectorId: preset.id }
  );
}

function handleProbe(params) {
  const preset = params.connector ? getConnector(params.connector) : null;
  if (!preset) return { success: false, content: `未知连接器「${params.connector}」，可用: ${listConnectors().map((c) => c.id).join('、')}` };
  const server = _mgr().getServer(preset.serverName);
  if (!server) {
    return _toolResult(`${preset.name} 尚未接入。按 inspect 的引导补齐信息并 configure 后即可查询。`);
  }
  if (server.status !== 'connected') {
    return { success: false, content: `${preset.name} 当前状态 ${server.status}${server.error ? `（${server.error}）` : ''}。可移除后重新 configure。` };
  }
  const tools = (server.tools || []).map((t) => ({ name: t.name, description: (t.description || '').split(/[.\n\r]/)[0].slice(0, 80) }));
  return _toolResult(
    `【${preset.name}】已连接，发现 ${tools.length} 个工具：\n` +
      tools.map((t) => `- ${t.name}：${t.description || '（无描述）'}`).join('\n') +
      `\n可直接自然语言提问（如"本月应收多少"），我会调用对应工具。`,
    { toolCount: tools.length }
  );
}

// ── 变更侧动作 ─────────────────────────────────────────────

/** 确保组件已安装（configure 前置），失败时返回可读诊断 */
async function _ensureInstalled(preset) {
  const libDir = getMcpLibDir(preset.id);
  const importable = await _isImportable(preset, libDir);
  if (importable.ok) return { ok: true, pythonPath: importable.pythonPath, libDir, reused: true };
  return _pipInstall(preset, libDir);
}

async function handleConfigure(params) {
  const preset = params.connector ? getConnector(params.connector) : null;
  if (!preset) {
    return { success: false, content: `未知连接器「${params.connector}」，可用: ${listConnectors().map((c) => c.id).join('、')}` };
  }
  const { ok, errors, normalized, missing } = validateCredentials(preset, params.credentials);
  if (!ok) {
    // 凭证缺失/非法：返回结构化缺口，绝不代填、不猜
    return {
      success: false,
      content:
        `${preset.name} 信息不完整，还差 ${missing.length} 项：\n` +
        Object.values(errors).map((e) => `- ${e}`).join('\n'),
      missingFields: missing,
      fieldErrors: errors,
    };
  }

  // ① 组件就位（已装则复用）
  const inst = await _ensureInstalled(preset);
  if (!inst.ok) {
    return { success: false, content: `${preset.name} 组件安装未完成：${inst.error}${inst.hint ? `\n${inst.hint}` : ''}` };
  }

  // ② 构建配置并热连接；连不上不落盘
  const libDir = getMcpLibDir(preset.id);
  const serverConfig = buildServerConfig(preset, normalized, { pythonPath: inst.pythonPath, libDir });
  const mgr = _mgr();
  try {
    await mgr.addServer(preset.serverName, serverConfig);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return {
      success: false,
      content:
        `${preset.name} 组件装好了，但连接金蝶失败：${msg}\n` +
        `常见原因：① 服务器地址不对（要浏览器能打开且以 /k3cloud/ 结尾）② 账套 ID/账号/密码有误 ③ 金蝶服务器不在同一网络。` +
        `修正后重新发我即可。`,
    };
  }
  await mgr.saveServerConfig(preset.serverName, serverConfig);

  // ③ 验货：报出发现的工具（tools/list 成功 = 连接可用）
  const server = mgr.getServer(preset.serverName);
  const tools = ((server && server.tools) || []).map((t) => t.name);
  return {
    success: true,
    content:
      `【${preset.name}】接入完成 ✓\n` +
      `组件: ${preset.install.package}${inst.reused ? '（此前已装，复用）' : ''}\n` +
      `连接: 已建立，发现 ${tools.length} 个工具\n` +
      tools.map((n) => `- ${n}`).join('\n') +
      `\n配置已保存（重启自动重连）。现在可以直接问业务问题，比如"本月应收多少"。`,
    serverName: preset.serverName,
    toolCount: tools.length,
    // 打码后的配置快照（secret 为 ••••，凭证值绝不出现在对话）
    configMasked: {
      command: serverConfig.command,
      args: serverConfig.args,
      env: maskEnv(preset, serverConfig.env),
    },
  };
}

async function handleRemove(params) {
  const preset = params.connector ? getConnector(params.connector) : null;
  if (!preset) {
    return { success: false, content: `未知连接器「${params.connector}」` };
  }
  const mgr = _mgr();
  await mgr.removeServer(preset.serverName).catch(() => {});
  await mgr.deleteServerConfig(preset.serverName).catch(() => {});
  return _toolResult(`【${preset.name}】已移除（组件文件保留在 data/mcp-libs，重接无需重下）。`);
}

// ── 注册 ───────────────────────────────────────────────────

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['catalog', 'inspect', 'probe'], description: 'catalog=连接器目录; inspect=接入手册与所需信息; probe=已接入状态与工具清单' },
    connector: { type: 'string', description: '连接器 id，如 kingdee' },
    url: { type: 'string', description: '用户贴的 MCP 文档/仓库链接（inspect 时用于识别连接器）' },
  },
  required: ['action'],
  additionalProperties: false,
};

const MANAGE_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['install', 'configure', 'remove'], description: 'install=安装组件; configure=校验凭证+写配置+热连接; remove=移除' },
    connector: { type: 'string', description: '连接器 id，如 kingdee' },
    credentials: {
      type: 'object',
      description: '连接器要求的信息（inspect 会列出字段名），如 {"KINGDEE_SERVER_URL":"...","KINGDEE_ACCT_ID":"...","KINGDEE_USERNAME":"...","KINGDEE_PASSWORD":"..."}',
      additionalProperties: true,
    },
  },
  required: ['action', 'connector'],
  additionalProperties: false,
};

async function handleQuery(params) {
  try {
    if (params.action === 'catalog') return handleCatalog();
    if (params.action === 'inspect') return handleInspect(params);
    if (params.action === 'probe') return handleProbe(params);
    return { success: false, content: `未知动作 ${params.action}` };
  } catch (e) {
    console.error('[mcp-connect] 查询失败:', e && e.message);
    return { success: false, content: `查询失败: ${e && e.message}` };
  }
}

async function handleManage(params) {
  try {
    if (params.action === 'install') {
      const preset = getConnector(params.connector);
      if (!preset) return { success: false, content: `未知连接器「${params.connector}」` };
      const r = await _ensureInstalled(preset);
      return r.ok
        ? _toolResult(`组件 ${preset.install.package} ${r.reused ? '此前已装，复用' : '安装完成'}。`)
        : { success: false, content: `安装失败: ${r.error}${r.hint ? `\n${r.hint}` : ''}` };
    }
    if (params.action === 'configure') return await handleConfigure(params);
    if (params.action === 'remove') return await handleRemove(params);
    return { success: false, content: `未知动作 ${params.action}` };
  } catch (e) {
    console.error('[mcp-connect] 变更失败:', e && e.message);
    return { success: false, content: `操作失败: ${e && e.message}` };
  }
}

registry.register({
  name: 'McpConnect',
  toolset: 'mcp',
  category: 'mcp',
  description:
    'MCP 连接器向导·查询侧。catalog=看可接入哪些业务系统; inspect=看某连接器的接入手册与需要用户提供的信息（用户说"接金蝶/连金蝶/装MCP"或贴 MCP 文档链接时，先 inspect 再照它引导收集信息）; probe=看已接入服务器的连接状态与工具清单。',
  schema: QUERY_SCHEMA,
  handler: handleQuery,
  isReadOnly: true,
  riskLevel: 'medium',
  whenNotToUse: '只查询不变更; 实际安装/写配置/移除用 McpConnectManage',
  source: 'mcp-connect-wizard',
});

registry.register({
  name: 'McpConnectManage',
  toolset: 'mcp',
  category: 'mcp',
  description:
    'MCP 连接器向导·变更侧（每次调用请求用户确认）。install=联网安装连接器组件; configure=校验凭证→自动装组件→写配置→热连接→报出发现的工具（凭证不全时返回缺哪几项，绝不代填）; remove=移除连接器。用户按 inspect 引导补齐信息后调用。',
  schema: MANAGE_SCHEMA,
  handler: handleManage,
  isReadOnly: false,
  riskLevel: 'high',
  // pip 安装(直连+镜像重试)最长 300s——默认 60000 会中途掐死安装
  timeout: 360000,
  whenNotToUse: '查询类动作用 McpConnect; 用户未确认或凭证缺失时不要调用 configure',
  source: 'mcp-connect-wizard',
});

module.exports = { handleQuery, handleManage };
