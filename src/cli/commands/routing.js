/**
 * CLI 命令 - 路由管理
 */

const { routeResolver } = require('../../core');

async function handleRoutingCommand(args) {
  const subCmd = args[0] || 'stats';

  switch (subCmd) {
    case 'stats': {
      const stats = routeResolver.getCacheStats();
      console.log('\n🔀 路由缓存统计\n');
      console.log('─'.repeat(40));
      console.log(`缓存大小: ${stats.size}`);
      console.log(`最大容量: ${stats.maxSize}`);
      console.log(`命中次数: ${stats.hits}`);
      console.log(`未命中次数: ${stats.misses}`);
      console.log(`命中率: ${stats.hits + stats.misses > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) : 0}%`);
      console.log('─'.repeat(40));
      break;
    }
    case 'resolve': {
      if (args.length < 2) {
        console.log('用法: crabpaw routing resolve <channel>');
        return;
      }
      const route = routeResolver.resolveAgentRoute({ channel: args[1] });
      console.log('\n解析结果:');
      console.log(JSON.stringify(route, null, 2));
      break;
    }

    case 'clear':
      routeResolver.cache.clear();
      console.log('✅ 路由缓存已清除');
      break;

    default:
      console.log('用法: crabpaw routing [stats|resolve|clear]');
  }
}

module.exports = {
  handleRoutingCommand,
};
