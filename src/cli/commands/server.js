/**
 * CLI 命令 - 服务器管理
 */

async function handleStartCommand(args, ctx) {
  const { startServer } = require('../server');
  await startServer(ctx);
}

// eslint-disable-next-line no-unused-vars -- ctx 参数未使用，保留签名以兼容 CLI 调用
async function handleStopCommand(_args, ctx) {
  console.log('🛑 停止服务器...');
  process.exit(0);
}

// eslint-disable-next-line no-unused-vars -- ctx 参数未使用，保留签名以兼容 CLI 调用
async function handleRestartCommand(_args, ctx) {
  console.log('🔄 重启服务器...');
  process.exit(0);
}

module.exports = {
  handleStartCommand,
  handleStopCommand,
  handleRestartCommand
};
