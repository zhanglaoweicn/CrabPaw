/**
 * 环境变量别名系统
 *
 * - 同一 API Key 可通过多个环境变量名设置
 * - 工具 API 密钥标准化
 * - 终端后端配置
 *
 * 用法：在 config.js 的 loadEnv() 之后调用 resolveAliases()
 */

// ─── 别名映射表 ───
// 格式：canonicalName → [alias1, alias2, ...]
// 如果 canonicalName 未设置，按顺序检查别名
const ENV_ALIASES = {
  // AI 提供者 API Key 别名
  'OPENAI_API_KEY': ['OPENAI_KEY', 'OAI_API_KEY'],
  'ANTHROPIC_API_KEY': ['ANTHROPIC_KEY', 'CLAUDE_API_KEY', 'CLAUDE_KEY'],
  'DEEPSEEK_API_KEY': ['DEEPSEEK_KEY', 'DS_API_KEY'],
  'GLM_API_KEY': ['GLM_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY', 'ZHIPU_API_KEY'],
  'OPENROUTER_API_KEY': ['OPENROUTER_KEY', 'OR_API_KEY'],
  'MOONSHOT_API_KEY': ['MOONSHOT_KEY', 'MOONSHOT_API_SECRET', 'KIMI_API_KEY'],
  'QWEN_API_KEY': ['QWEN_KEY', 'DASHSCOPE_API_KEY', 'ALIBABA_API_KEY'],
  'GROQ_API_KEY': ['GROQ_KEY'],
  'MISTRAL_API_KEY': ['MISTRAL_KEY'],
  'TOGETHER_API_KEY': ['TOGETHER_KEY', 'TOGETHER_AI_KEY'],
  'FIREWORKS_API_KEY': ['FIREWORKS_KEY'],

  // 工具 API Key 别名
  'FIRECRAWL_API_KEY': ['FIRECRAWL_KEY', 'FC_API_KEY'],
  'TAVILY_API_KEY': ['TAVILY_KEY'],
  'EXA_API_KEY': ['EXA_KEY', 'EXASEARCH_API_KEY'],
  'BRAVE_API_KEY': ['BRAVE_SEARCH_KEY', 'BRAVE_SEARCH_API_KEY'],
  'SERPAPI_KEY': ['SERPAPI_API_KEY', 'SERP_API_KEY'],
  'JINA_API_KEY': ['JINA_KEY', 'JINA_READER_KEY'],
  'SCREENSHOTONE_API_KEY': ['SCREENSHOTONE_KEY'],

  // CrabPaw 专用环境变量别名
  'CRABPAW_DATA_DIR': ['CRABPAW_DIR', 'CRAB_DIR'],
  'CRABPAW_PORT': ['CRAB_PORT', 'PORT'],
  'CRABPAW_API_SERVER_KEY': ['API_SERVER_KEY', 'CRAB_API_KEY'],
  'CRABPAW_API_SERVER_HOST': ['API_SERVER_HOST'],
  'CRABPAW_API_SERVER_PORT': ['API_SERVER_PORT'],
};

// ─── 终端后端配置 ───
const TERMINAL_BACKENDS = {
  local: {
    description: '本地终端（默认）',
    check: () => true,
  },
  docker: {
    description: 'Docker 容器终端',
    envKey: 'DOCKER_CONTAINER',
  },
  ssh: {
    description: 'SSH 远程终端',
    envKeys: ['SSH_HOST', 'SSH_USER'],
  },
  singularity: {
    description: 'Singularity 容器终端',
    envKey: 'SINGULARITY_IMAGE',
  },
  modal: {
    description: 'Modal 云终端',
    envKey: 'MODAL_APP_NAME',
  },
  daytona: {
    description: 'Daytona 开发环境',
    envKey: 'DAYTONA_WORKSPACE_ID',
  },
};

/**
 * 解析环境变量别名
 * 如果 canonical name 未设置，按顺序检查别名，找到的第一个赋值给 canonical name
 */
function resolveAliases() {
  let resolved = 0;

  for (const [canonical, aliases] of Object.entries(ENV_ALIASES)) {
    // 已设置则跳过
    if (process.env[canonical]) continue;

    // 按顺序检查别名
    for (const alias of aliases) {
      if (process.env[alias]) {
        process.env[canonical] = process.env[alias];
        resolved++;
        break;
      }
    }
  }

  if (resolved > 0) {
    console.log(`🔑 环境变量别名解析: ${resolved} 个别名已映射`);
  }

  return resolved;
}

/**
 * 获取环境变量值（支持别名查找）
 */
function getEnvWithAliases(canonicalName) {
  if (process.env[canonicalName]) {
    return process.env[canonicalName];
  }

  const aliases = ENV_ALIASES[canonicalName];
  if (aliases) {
    for (const alias of aliases) {
      if (process.env[alias]) {
        return process.env[alias];
      }
    }
  }

  return undefined;
}

/**
 * 检测当前终端后端
 */
function detectTerminalBackend() {
  const configured = process.env.TERMINAL_ENV || process.env.CRABPAW_TERMINAL || 'local';
  const backend = TERMINAL_BACKENDS[configured];
  if (!backend) {
    console.warn(`⚠️ 未知终端后端: ${configured}，回退到 local`);
    return 'local';
  }
  return configured;
}

/**
 * 获取终端后端配置
 */
function getTerminalBackendConfig(backend) {
  const name = backend || detectTerminalBackend();
  return TERMINAL_BACKENDS[name] || TERMINAL_BACKENDS.local;
}

/**
 * 列出所有环境变量别名
 */
function listAliases() {
  const result = [];
  for (const [canonical, aliases] of Object.entries(ENV_ALIASES)) {
    const activeAlias = aliases.find(a => process.env[a]);
    result.push({
      canonical,
      aliases,
      isSet: !!process.env[canonical] || !!activeAlias,
      resolvedFrom: activeAlias || null,
    });
  }
  return result;
}

/**
 * 生成环境变量摘要（用于 /env 命令或 dump）
 */
function getEnvSummary() {
  const lines = ['🔑 环境变量别名状态\n'];

  for (const [canonical, aliases] of Object.entries(ENV_ALIASES)) {
    const value = process.env[canonical];
    const aliasSource = aliases.find(a => process.env[a] && !process.env[canonical]);
    if (value) {
      lines.push(`  ✅ ${canonical} = ${redact(value)}`);
    } else if (aliasSource) {
      lines.push(`  ✅ ${canonical} ← ${aliasSource} = ${redact(process.env[aliasSource])}`);
    } else {
      lines.push(`  ⬜ ${canonical} (别名: ${aliases.join(', ')})`);
    }
  }

  lines.push(`\n终端后端: ${detectTerminalBackend()}`);
  return lines.join('\n');
}

function redact(val) {
  if (!val || val.length <= 8) return '****';
  const { _maskToken } = require('./secret-redactor');
  return _maskToken(val);
}

module.exports = {
  resolveAliases,
  getEnvWithAliases,
  detectTerminalBackend,
  getTerminalBackendConfig,
  listAliases,
  getEnvSummary,
  ENV_ALIASES,
  TERMINAL_BACKENDS,
};
