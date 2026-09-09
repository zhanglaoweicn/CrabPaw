/**
 * CLI 命令 - SubAgent 管理
 */

const { createSubAgent, listSubAgents, getSubAgentStats, cleanupCompletedSubAgents } = require('../../core');

async function handleSubAgentCommand(args) {
  const subCommand = args[0];
  
  switch (subCommand) {
    case 'list':
      await listSubAgentsCmd();
      break;
    case 'create':
      await createSubAgentCmd(args.slice(1));
      break;
    case 'stats':
      await statsSubAgent();
      break;
    case 'cleanup':
      await cleanupSubAgent();
      break;
    default:
      printSubAgentHelp();
  }
}

async function listSubAgentsCmd() {
  const agents = listSubAgents();
  
  if (agents.length === 0) {
    console.log('暂无活跃的 SubAgent');
    return;
  }
  
  console.log('\n🤖 SubAgent 列表:\n');
  for (const agent of agents) {
    console.log(`  [${agent.id}] ${agent.name || '未命名'}`);
    console.log(`      状态: ${agent.status}`);
    console.log(`      创建时间: ${agent.createdAt}`);
    console.log(`      任务: ${agent.task || '无'}`);
    console.log('');
  }
}

async function createSubAgentCmd(args) {
  const [name, ...taskParts] = args;
  const task = taskParts.join(' ');
  
  if (!name || !task) {
    console.log('用法: subagent create <name> <task>');
    return;
  }
  
  const agent = await createSubAgent({ name, task });
  console.log(`✅ 已创建 SubAgent: ${agent.id}`);
}

async function statsSubAgent() {
  const stats = getSubAgentStats();
  console.log('\n📊 SubAgent 统计:\n');
  console.log(`  总数: ${stats.total}`);
  console.log(`  活跃: ${stats.active}`);
  console.log(`  完成: ${stats.completed}`);
  console.log(`  失败: ${stats.failed}`);
  console.log('');
}

async function cleanupSubAgent() {
  const count = cleanupCompletedSubAgents();
  console.log(`✅ 已清理 ${count} 个已完成的 SubAgent`);
}

function printSubAgentHelp() {
  console.log(`
SubAgent 命令:
  subagent list              列出所有 SubAgent
  subagent create <name> <task>  创建 SubAgent
  subagent stats             查看统计
  subagent cleanup           清理已完成的 SubAgent
`);
}

module.exports = {
  handleSubAgentCommand
};
