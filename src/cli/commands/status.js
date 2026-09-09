/**
 * CLI 命令 - 状态查看
 */

const config = require('../../core/config');
// eslint-disable-next-line no-unused-vars -- require 解构的 listSubAgents 暂未使用（保留核心导出对齐）
const { getSubAgentStats, listSubAgents } = require('../../core');
const state = require('../../core/state');

async function handleStatusCommand(_args) {
  const appConfig = config.loadConfig();

  console.log('\n🦀 CrabPaw 状态\n');
  console.log('─'.repeat(40));
  console.log(`版本: ${require('../../../package.json').version}`);
  console.log(`飞书配置: ${appConfig.lark?.appId ? '✅' : '❌'}`);
  console.log(`AI 配置: ${appConfig.models?.providers?.[appConfig.models.currentProvider]?.apiKey ? '✅' : '❌'}`);
  console.log('─'.repeat(40));

  try {
    const stats = state.getSessionStats();
    console.log('\n会话统计:');
    console.log(JSON.stringify(stats, null, 2));
  } catch (e) {
    console.log('\n会话统计: (未初始化)');
  }

  try {
    const subagentStats = getSubAgentStats();
    console.log('\nSubAgent 统计:');
    console.log(JSON.stringify(subagentStats, null, 2));
  } catch (e) {
    console.log('\nSubAgent 统计: (无活动 SubAgent)');
  }
}

module.exports = {
  handleStatusCommand,
};
