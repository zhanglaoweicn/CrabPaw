/**
 * CLI 命令 - 配置管理
 */

// eslint-disable-next-line no-unused-vars
const config = require('../../core/config');
const { configManager } = require('../../core');

async function handleConfigCommand(args) {
  const subCommand = args[0];
  
  switch (subCommand) {
    case 'get':
      await getConfig(args[1]);
      break;
    case 'set':
      await setConfig(args[1], args[2]);
      break;
    case 'list':
      await listConfig();
      break;
    case 'init':
      await initConfig();
      break;
    default:
      printConfigHelp();
  }
}

async function getConfig(key) {
  const value = configManager.get(key);
  if (value !== undefined) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(`配置项不存在: ${key}`);
  }
}

async function setConfig(key, value) {
  try {
    const parsed = JSON.parse(value);
    configManager.set(key, parsed);
  } catch {
    configManager.set(key, value);
  }
  console.log(`✅ 已设置 ${key}`);
}

async function listConfig() {
  const all = configManager.getAll();
  console.log(JSON.stringify(all, null, 2));
}

async function initConfig() {
  configManager.init();
  console.log('✅ 配置已初始化');
}

function printConfigHelp() {
  console.log(`
配置管理命令:
  config get <key>     获取配置值
  config set <key> <value>  设置配置值
  config list          列出所有配置
  config init          初始化配置
`);
}

module.exports = {
  handleConfigCommand
};
