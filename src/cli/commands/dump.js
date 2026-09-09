/**
 * CLI 命令 - 配置摘要导出 (dump)
 *
 * 系统诊断信息导出命令。
 * 输出可复制粘贴的设置摘要，用于支持/调试
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../../core/config');
const { _maskToken } = require('../../core/secret-redactor');

function redactKey(key) {
  if (!key || typeof key !== 'string') return '(not set)';
  if (key.length <= 8) return '****';
  return _maskToken(key);
}

async function handleDumpCommand(args) {
  const showKeys = args.includes('--show-keys');
  const appConfig = config.loadConfig();

  const lines = [];
  lines.push('--- crabpaw dump ---');
  lines.push('');

  // 版本
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf-8'));
    lines.push(`version: ${pkg.version}`);
  } catch {
    lines.push('version: unknown');
  }

  // 环境
  lines.push(`os: ${os.type()} ${os.release()} ${os.arch()}`);
  lines.push(`node: ${process.version}`);
  lines.push(`hostname: ${os.hostname()}`);
  lines.push('');

  // 模型
  const currentProvider = appConfig.models?.currentProvider || '(none)';
  const providers = appConfig.models?.providers || {};
  const currentModel = providers[currentProvider]?.model || '(none)';
  lines.push(`provider: ${currentProvider}`);
  lines.push(`model: ${currentModel}`);
  lines.push('');

  // API 密钥
  lines.push('api_keys:');
  for (const [name, prov] of Object.entries(providers)) {
    if (prov.apiKey) {
      lines.push(`  ${name}: ${showKeys ? redactKey(prov.apiKey) : 'set'}`);
    } else {
      lines.push(`  ${name}: not set`);
    }
  }
  // 其他常见 API 密钥
  const envKeys = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY',
    'OPENROUTER_API_KEY', 'FIRECRAWL_API_KEY', 'BRAVE_API_KEY',
    'SERPAPI_KEY', 'TAVILY_API_KEY'
  ];
  for (const key of envKeys) {
    const val = process.env[key];
    if (val) {
      lines.push(`  ${key}: ${showKeys ? redactKey(val) : 'set'}`);
    }
  }
  lines.push('');

  // 飞书
  lines.push('lark:');
  if (appConfig.lark?.appId) {
    lines.push(`  app_id: ${showKeys ? redactKey(appConfig.lark.appId) : 'set'}`);
  } else {
    lines.push('  app_id: not set');
  }
  lines.push('');

  // 功能
  lines.push('features:');
  lines.push(`  port: ${appConfig.port || 38767}`);
  lines.push(`  evolution: ${appConfig.evolution?.enabled !== false ? 'on' : 'off'}`);
  lines.push(`  plugins: ${appConfig.plugins?.enabled !== false ? 'on' : 'off'}`);
  lines.push('');

  // 配置覆盖
  const overrides = [];
  const defaults = { port: 38767 };
  for (const [key, defaultVal] of Object.entries(defaults)) {
    if (appConfig[key] !== undefined && appConfig[key] !== defaultVal) {
      overrides.push(`${key}: ${appConfig[key]}`);
    }
  }
  if (appConfig.models?.maxIterations) {
    overrides.push(`agent.max_iterations: ${appConfig.models.maxIterations}`);
  }
  if (appConfig.compression?.threshold) {
    overrides.push(`compression.threshold: ${appConfig.compression.threshold}`);
  }
  if (overrides.length > 0) {
    lines.push('config_overrides:');
    for (const o of overrides) {
      lines.push(`  ${o}`);
    }
  } else {
    lines.push('config_overrides: (none)');
  }

  lines.push('');
  lines.push('--- end dump ---');

  console.log(lines.join('\n'));
}

module.exports = { handleDumpCommand };
