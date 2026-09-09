/**
 * CLI 命令 - 历史记录管理
 */

const { history } = require('../../core');

async function handleHistoryCommand(args) {
  const subCommand = args[0];
  
  switch (subCommand) {
    case 'list':
      await listHistory(args[1] ? parseInt(args[1]) : 10);
      break;
    case 'search':
      await searchHistory(args.slice(1).join(' '));
      break;
    case 'clear':
      await clearHistory();
      break;
    case 'export':
      await exportHistory(args[1]);
      break;
    default:
      printHistoryHelp();
  }
}

async function listHistory(limit = 10) {
  const sessions = await history.list({ limit });
  
  if (sessions.length === 0) {
    console.log('暂无历史记录');
    return;
  }
  
  console.log(`\n📜 最近 ${sessions.length} 条历史:\n`);
  for (const session of sessions) {
    console.log(`  [${session.id}] ${session.title || '无标题'}`);
    console.log(`      时间: ${session.createdAt}`);
    console.log(`      消息数: ${session.messageCount || 0}`);
    console.log('');
  }
}

async function searchHistory(query) {
  if (!query) {
    console.log('请提供搜索关键词');
    return;
  }
  
  const results = await history.search(query);
  
  console.log(`\n🔍 搜索 "${query}" 结果:\n`);
  for (const result of results.slice(0, 10)) {
    console.log(`  [${result.id}] ${result.title || '无标题'}`);
    console.log(`      匹配: ${result.match || ''}`);
    console.log('');
  }
}

async function clearHistory() {
  await history.clear();
  console.log('✅ 历史记录已清空');
}

async function exportHistory(outputPath) {
  const path = outputPath || `history_${Date.now()}.json`;
  await history.export(path);
  console.log(`✅ 历史记录已导出到: ${path}`);
}

function printHistoryHelp() {
  console.log(`
历史记录命令:
  history list [limit]       列出历史记录
  history search <query>     搜索历史
  history clear              清空历史
  history export [path]      导出历史
`);
}

module.exports = {
  handleHistoryCommand
};
