/**
 * CLI 命令 - 通道管理
 *
 * 2026-08-18 重写：list 输出改真实字段（label/description/isEnabled）；
 * enable/disable/test 走 ChannelRegistry 返回值（result.message/result.error），
 * 不再输出恒为 undefined 的 channel.name/type/enabled。
 */

const { channelRegistry } = require('../../core');

async function handleChannelCommand(args) {
  const subCommand = args[0];

  switch (subCommand) {
    case 'list':
      await listChannels();
      break;
    case 'enable':
      await enableChannel(args[1]);
      break;
    case 'disable':
      await disableChannel(args[1]);
      break;
    case 'test':
      await testChannel(args[1]);
      break;
    default:
      printChannelHelp();
  }
}

async function listChannels() {
  const channels = channelRegistry.list();

  console.log('\n📡 通道列表:\n');
  if (channels.length === 0) {
    console.log('  （无已注册通道）');
  }
  for (const channel of channels) {
    const enabled = channelRegistry.isEnabled(channel.id);
    console.log(`  [${channel.id}] ${channel.label}`);
    console.log(`      描述: ${channel.description || '—'}`);
    console.log(`      状态: ${enabled ? '✅ 启用' : '⏸️ 禁用'}`);
    console.log('');
  }
}

async function enableChannel(id) {
  if (!id) {
    console.log('❌ 用法: channel enable <id>');
    return;
  }
  const result = channelRegistry.enable(id);
  if (result.success) {
    console.log(`✅ ${result.message}`);
  } else {
    console.log(`❌ ${result.error}`);
  }
}

async function disableChannel(id) {
  if (!id) {
    console.log('❌ 用法: channel disable <id>');
    return;
  }
  const result = channelRegistry.disable(id);
  if (result.success) {
    console.log(`✅ ${result.message}`);
  } else {
    console.log(`❌ ${result.error}`);
  }
}

async function testChannel(id) {
  if (!id) {
    console.log('❌ 用法: channel test <id>');
    return;
  }
  console.log(`测试通道: ${id}...`);
  const result = await channelRegistry.test(id);
  if (result.success) {
    console.log(`✅ ${result.message}`);
  } else {
    console.log(`❌ ${result.error}`);
  }
}

function printChannelHelp() {
  console.log(`
通道管理命令:
  channel list               列出所有通道
  channel enable <id>        启用通道
  channel disable <id>       禁用通道
  channel test <id>          测试通道
`);
}

module.exports = {
  handleChannelCommand
};
