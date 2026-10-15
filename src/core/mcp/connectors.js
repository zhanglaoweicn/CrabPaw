/**
 * connectors.js — MCP 连接器目录与校验（对话式配置向导的数据层）
 *
 * 设计（2026-09-24 M1 金蝶专线）：
 * - 目录预审制：只收录人工核验过的连接器 preset（M2 起逐个上架），
 *   用户贴来的任意 MCP 文档页只做"识别到目录里哪个连接器"，不做自由解析——
 *   网页内容是不可信输入，自由解析配置有提示注入面。
 * - 本文件全部为纯函数（buildServerConfig 显式接收 pythonPath/libDir），
 *   不做 fs/网络操作，可单测。
 * - 命令白名单：安装只允许 preset 声明的 PyPI 包名（格式校验 + 精确匹配），
 *   stdio 启动只允许 python-module 形态——防"页面让我执行什么就执行什么"。
 */

const path = require('path');
const { DATA_DIR } = require('../config');

// 连接组件安装根目录：放 DATA_DIR（随盘迁移、覆盖更新不丢），
// 不放 portable/libs（resources 树，update.bat 解压覆盖会被抹掉）
const MCP_LIBS_DIR = path.join(DATA_DIR, 'mcp-libs');

const CONNECTORS = {
  kingdee: {
    id: 'kingdee',
    name: '金蝶云星空',
    vendorNote: '社区开源连接器（非金蝶官方出品），支持金蝶云星空 K3Cloud 公有云/私有云',
    benefits: '接通后可直接问"本月应收多少/查销售订单/查库存"，应收卡、晨报带、例会自动改用金蝶真实数据',
    docsUrls: [
      'https://wahailong.github.io/KingdeeMCP/',
      'https://github.com/wahailong/KingdeeMCP',
    ],
    // URL/仓库识别（网页贴进来时的主识别路径）
    matchPatterns: [/kingdeemcp/i, /kingdee[-_]?mcp/i, /wahailong/i, /k3cloud/i],
    // 关键词识别须伴随"接入意图"词才命中（见 matchConnector），避免聊到金蝶就误触发
    keywords: ['金蝶', '云星空', 'kingdee'],
    intentPattern: /(连接|接入|配置|安装|对接|装).{0,12}(金蝶|云星空|kingdee)|(金蝶|云星空|kingdee).{0,12}(连接|接入|配置|安装|对接|mcp)/i,
    install: { type: 'pip', package: 'kingdee-mcp' },
    serverName: 'kingdee',
    commandPlan: { kind: 'python-module', module: 'kingdee_mcp.server' },
    envSchema: [
      {
        key: 'KINGDEE_SERVER_URL',
        label: '金蝶服务器地址',
        hint: '浏览器登录金蝶时地址栏的地址，须以 /k3cloud/ 结尾',
        required: true,
        secret: false,
        normalize: (v) => {
          const s = String(v || '').trim();
          if (!s || !/\/k3cloud(\/)?$/i.test(s)) return s;
          return s.endsWith('/') ? s : s + '/';
        },
        validate: (v) => {
          const s = String(v || '').trim();
          if (!/^https?:\/\//i.test(s)) return '地址要以 http:// 或 https:// 开头';
          if (!/\/k3cloud(\/)?$/i.test(s)) return '地址要以 /k3cloud/ 结尾（浏览器登录金蝶时地址栏就是）';
          return null;
        },
      },
      {
        key: 'KINGDEE_ACCT_ID',
        label: '账套 ID',
        hint: '金蝶登录/选账套界面可查，或问管理员',
        required: true,
        secret: false,
        validate: (v) => (String(v || '').trim() ? null : '账套 ID 不能为空'),
      },
      {
        key: 'KINGDEE_USERNAME',
        label: '金蝶账号',
        hint: '建议让管理员建一个专用查询账号，不要用 Administrator',
        required: true,
        secret: false,
        validate: (v) => (String(v || '').trim() ? null : '账号不能为空'),
      },
      {
        key: 'KINGDEE_PASSWORD',
        label: '金蝶账号密码',
        hint: '只保存在本机配置里，对话中不再复述',
        required: true,
        secret: true,
        validate: (v) => (String(v || '').trim() ? null : '密码不能为空'),
      },
    ],
  },
  // 2026-10-09: OpenViking（火山引擎开源的 Agent 上下文数据库）——首个 HTTP 形态
  // 连接器：无需本地装组件，直连已部署的 openviking-server（自托管或火山托管）。
  // 接通后获得 ov_find/ov_read/ov_write 等工具，跨 Agent 共享长期记忆/知识/技能上下文。
  openviking: {
    id: 'openviking',
    name: 'OpenViking 上下文数据库',
    vendorNote: '火山引擎开源（AGPLv3）的 Self-evolving Context Database，支持自托管（uv 装 openviking-server）或火山托管 SaaS',
    benefits: '接通后可检索/读写 OpenViking 里的记忆、知识与技能上下文（ov_find/ov_read/ov_write 等工具），多个 Agent 共享同一份长期上下文',
    docsUrls: [
      'https://github.com/volcengine/OpenViking',
      'https://openviking.ai',
    ],
    matchPatterns: [/openviking/i, /viking:\/\//i, /volcengine[-_ ]?viking/i],
    keywords: ['openviking', 'viking', '上下文数据库'],
    intentPattern: /(连接|接入|配置|安装|对接|装).{0,16}(openviking|viking|上下文数据库)|(openviking|viking|上下文数据库).{0,16}(连接|接入|配置|安装|对接|mcp)/i,
    install: { type: 'none', package: '' },
    serverName: 'openviking',
    commandPlan: { kind: 'http' },
    // HTTP 形态：url 字段 + Bearer 凭证字段
    http: { urlField: 'OPENVIKING_URL', tokenField: 'OPENVIKING_API_KEY' },
    envSchema: [
      {
        key: 'OPENVIKING_URL',
        label: 'OpenViking 服务地址',
        hint: 'openviking-server 的 MCP 端点，自托管如 http://127.0.0.1:8000，或火山托管给你的服务 URL',
        required: true,
        secret: false,
        normalize: (v) => String(v || '').trim().replace(/\/+$/, ''),
        validate: (v) => (/^https?:\/\//i.test(String(v || '').trim()) ? null : '地址要以 http:// 或 https:// 开头'),
      },
      {
        key: 'OPENVIKING_API_KEY',
        label: 'OpenViking 用户 Key',
        hint: '必须是 user key（root key 只读管理面，读不了记忆），在服务端账号页生成',
        required: true,
        secret: true,
        validate: (v) => (String(v || '').trim() ? null : '用户 Key 不能为空'),
      },
    ],
  },
};

/** 连接器目录摘要（实时状态由工具层补充） */
function listConnectors() {
  return Object.values(CONNECTORS).map((c) => ({
    id: c.id,
    name: c.name,
    vendorNote: c.vendorNote,
    benefits: c.benefits,
    docsUrls: c.docsUrls,
  }));
}

function getConnector(id) {
  return CONNECTORS[String(id || '').trim().toLowerCase()] || null;
}

/**
 * 从用户输入（贴的链接/说的关键词）识别目标连接器。
 * 命中规则：① URL/仓库名模式；② 关键词 + 接入意图词同时出现。
 * @returns {string|null} connector id
 */
function matchConnector(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  for (const c of Object.values(CONNECTORS)) {
    if (c.matchPatterns.some((re) => re.test(s))) return c.id;
  }
  for (const c of Object.values(CONNECTORS)) {
    if (c.keywords.some((k) => s.toLowerCase().includes(k.toLowerCase())) && c.intentPattern.test(s)) {
      return c.id;
    }
  }
  return null;
}

/**
 * 校验并规范化用户提供的凭证。
 * @returns {{ ok: boolean, errors: Object<string,string>, normalized: Object<string,string>, missing: string[] }}
 */
function validateCredentials(preset, creds) {
  const src = creds && typeof creds === 'object' ? creds : {};
  const errors = {};
  const normalized = {};
  const missing = [];
  for (const field of preset.envSchema) {
    let v = src[field.key];
    if (v === undefined || v === null || String(v).trim() === '') {
      // 兼容模型用中文标签/大小写变体键传参
      const alt = Object.keys(src).find(
        (k) => k.toLowerCase() === field.key.toLowerCase() || k === field.label
      );
      v = alt !== undefined ? src[alt] : undefined;
    }
    if (v === undefined || v === null || String(v).trim() === '') {
      if (field.required) {
        errors[field.key] = `缺少「${field.label}」：${field.hint}`;
        missing.push(field.key);
      }
      continue;
    }
    const nv = field.normalize ? field.normalize(v) : String(v).trim();
    const err = field.validate ? field.validate(nv) : null;
    if (err) {
      errors[field.key] = `「${field.label}」${err}`;
    } else {
      normalized[field.key] = nv;
    }
  }
  return { ok: Object.keys(errors).length === 0, errors, normalized, missing };
}

/** PyPI 包名合法形态（白名单的格式闸） */
const PYPI_PKG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * 安装白名单：只允许 preset 声明的 PyPI 包名，且包名形态合法。
 * 网页/模型传来的任何其他 install 目标在此拒绝。
 */
function assertInstallAllowed(preset, pkg) {
  if (!pkg || typeof pkg !== 'string' || !PYPI_PKG_RE.test(pkg)) {
    throw new Error(`拒绝安装：包名非法「${pkg}」`);
  }
  if (pkg !== preset.install.package) {
    throw new Error(`拒绝安装：${preset.id} 连接器只允许安装 ${preset.install.package}，收到「${pkg}」`);
  }
}

/**
 * 构建 MCP 服务器配置。显式接收 pythonPath/libDir（纯函数，便于测试）。
 * - python-module 形态：PYTHONPATH 指向 data/mcp-libs/<id>——pip --target 安装位置，
 *   经 StdioTransport 的 config.env 合并进子进程。
 * - http 形态（2026-10-09 OpenViking）：直连远端 MCP 端点，凭证作 Bearer 头，
 *   走 HttpTransport（mcp-manager 按 config.url 自动选择）。
 */
function buildServerConfig(preset, normalizedCreds, { pythonPath, libDir } = {}) {
  if (preset.commandPlan.kind === 'http') {
    const { urlField, tokenField } = preset.http || {};
    // 尾斜杠归一：validateCredentials 已 normalize，但直调本函数也保持一致
    const url = (urlField ? normalizedCreds[urlField] : null)?.replace(/\/+$/, '');
    if (!url) throw new Error(`连接器 ${preset.id} 缺少服务地址字段 ${urlField}`);
    return {
      url,
      headers: tokenField && normalizedCreds[tokenField]
        ? { Authorization: `Bearer ${normalizedCreds[tokenField]}` }
        : {},
      timeout: 60000,
      connectTimeout: 20000,
    };
  }
  if (preset.commandPlan.kind !== 'python-module') {
    throw new Error(`连接器 ${preset.id} 的启动形态不支持: ${preset.commandPlan.kind}`);
  }
  return {
    command: pythonPath,
    args: ['-m', preset.commandPlan.module],
    env: {
      ...normalizedCreds,
      PYTHONPATH: libDir,
    },
    timeout: 60000,
    connectTimeout: 20000,
  };
}

/** 打码：secret 字段值 → ••••，非 secret（如服务器地址）保留用于确认展示 */
function maskEnv(preset, env) {
  const out = {};
  for (const field of preset.envSchema) {
    if (env[field.key] === undefined) continue;
    out[field.key] = field.secret ? '••••••' : String(env[field.key]);
  }
  return out;
}

function getMcpLibDir(connectorId) {
  return path.join(MCP_LIBS_DIR, String(connectorId));
}

module.exports = {
  MCP_LIBS_DIR,
  PYPI_PKG_RE,
  listConnectors,
  getConnector,
  matchConnector,
  validateCredentials,
  assertInstallAllowed,
  buildServerConfig,
  maskEnv,
  getMcpLibDir,
};
