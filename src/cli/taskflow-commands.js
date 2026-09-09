/**
 * TaskFlow CLI 命令
 */

const taskflow = require('../taskflow');

const STATUS_COLORS = {
  queued: '\x1b[36m',
  running: '\x1b[33m',
  waiting: '\x1b[35m',
  blocked: '\x1b[31m',
  succeeded: '\x1b[32m',
  failed: '\x1b[31m',
  cancelled: '\x1b[90m',
  lost: '\x1b[90m'
};

const RESET_COLOR = '\x1b[0m';

function colorStatus(status) {
  const color = STATUS_COLORS[status] || RESET_COLOR;
  return `${color}${status}${RESET_COLOR}`;
}

function truncate(str, maxLen) {
  if (!str) return 'n/a';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function pad(str, len) {
  return (str || '').toString().padEnd(len);
}

async function taskflowListCommand(args) {
  const filter = {};
  
  if (args.status) {
    filter.status = args.status;
  }
  
  if (args.owner) {
    filter.ownerKey = args.owner;
  }
  
  if (args.limit) {
    filter.limit = parseInt(args.limit, 10);
  }

  const flows = await taskflow.listFlows(filter);

  if (args.json) {
    console.log(JSON.stringify(flows, null, 2));
    return;
  }

  if (flows.length === 0) {
    console.log('No TaskFlows found.');
    console.log('\n提示: 使用 "crabpaw taskflow create --goal <goal>" 创建新的 TaskFlow');
    return;
  }

  console.log(`\nTaskFlows: ${flows.length}\n`);

  const header = [
    pad('TaskFlow', 20),
    pad('Status', 12),
    pad('Mode', 14),
    pad('Rev', 6),
    'Goal'
  ].join(' ');

  console.log('\x1b[1m' + header + '\x1b[0m');
  console.log('─'.repeat(80));

  for (const flow of flows) {
    const line = [
      pad(truncate(flow.flowId, 20), 20),
      pad(colorStatus(flow.status), 20),
      pad(flow.syncMode, 14),
      pad(flow.revision.toString(), 6),
      truncate(flow.goal, 50)
    ].join(' ');

    console.log(line);
  }

  console.log(`\n总计: ${flows.length} 个 TaskFlow`);
}

async function taskflowShowCommand(args) {
  if (!args.flowId) {
    console.error('错误: 需要指定 flowId');
    console.log('用法: crabpaw taskflow show <flowId>');
    return;
  }

  const flow = await taskflow.getFlow(args.flowId);

  if (!flow) {
    console.error(`错误: TaskFlow 未找到: ${args.flowId}`);
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(flow, null, 2));
    return;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`TaskFlow: ${flow.flowId}`);
  console.log('═'.repeat(60));

  console.log(`\n状态: ${colorStatus(flow.status)}`);
  console.log(`模式: ${flow.syncMode}`);
  console.log(`目标: ${flow.goal}`);
  console.log(`版本: ${flow.revision}`);
  console.log(`所有者: ${flow.ownerKey}`);

  if (flow.controllerId) {
    console.log(`控制器: ${flow.controllerId}`);
  }

  console.log(`\n创建时间: ${new Date(flow.createdAt).toLocaleString()}`);
  console.log(`更新时间: ${new Date(flow.updatedAt).toLocaleString()}`);

  if (flow.endedAt) {
    console.log(`结束时间: ${new Date(flow.endedAt).toLocaleString()}`);
  }

  if (flow.currentStep) {
    console.log(`\n当前步骤: ${flow.currentStep}`);
  }

  if (flow.blockedTaskId) {
    console.log(`\n阻塞任务: ${flow.blockedTaskId}`);
    if (flow.blockedSummary) {
      console.log(`阻塞原因: ${flow.blockedSummary}`);
    }
  }

  if (flow.stateJson) {
    console.log(`\n状态数据:`);
    console.log(JSON.stringify(flow.stateJson, null, 2));
  }

  if (flow.waitJson) {
    console.log(`\n等待数据:`);
    console.log(JSON.stringify(flow.waitJson, null, 2));
  }

  console.log('');
}

async function taskflowCreateCommand(args) {
  if (!args.goal) {
    console.error('错误: 需要指定 goal');
    console.log('用法: crabpaw taskflow create --goal <goal>');
    return;
  }

  const params = {
    goal: args.goal,
    ownerKey: args.owner || 'cli',
    controllerId: args.controller,
    syncMode: args.mode || 'managed',
    notifyPolicy: args.notify || 'on_failure'
  };

  const flow = await taskflow.createFlow(params);

  console.log(`\n✅ TaskFlow 创建成功: ${flow.flowId}`);
  console.log(`   目标: ${flow.goal}`);
  console.log(`   状态: ${flow.status}`);

  if (args.execute) {
    console.log('\n正在执行 TaskFlow...');
    try {
      const result = await taskflow.executeFlow(flow.flowId);
      console.log(`\n✅ TaskFlow 执行完成`);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(`\n❌ TaskFlow 执行失败: ${error.message}`);
      return;
    }
  }
}

async function taskflowExecuteCommand(args) {
  if (!args.flowId) {
    console.error('错误: 需要指定 flowId');
    console.log('用法: crabpaw taskflow execute <flowId>');
    return;
  }

  const flow = await taskflow.getFlow(args.flowId);
  if (!flow) {
    console.error(`错误: TaskFlow 未找到: ${args.flowId}`);
    return;
  }

  console.log(`\n执行 TaskFlow: ${flow.flowId}`);
  console.log(`目标: ${flow.goal}\n`);

  try {
    const result = await taskflow.executeFlow(flow.flowId);
    console.log(`\n✅ TaskFlow 执行成功`);
    
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n执行结果:');
      console.log(JSON.stringify(result.results, null, 2));
    }
  } catch (error) {
    console.error(`\n❌ TaskFlow 执行失败: ${error.message}`);
    return;
  }
}

async function taskflowCancelCommand(args) {
  if (!args.flowId) {
    console.error('错误: 需要指定 flowId');
    console.log('用法: crabpaw taskflow cancel <flowId>');
    return;
  }

  const flow = await taskflow.getFlow(args.flowId);
  if (!flow) {
    console.error(`错误: TaskFlow 未找到: ${args.flowId}`);
    return;
  }

  await taskflow.cancelFlow(args.flowId);

  console.log(`\n✅ TaskFlow 已取消: ${args.flowId}`);
}

async function taskflowDeleteCommand(args) {
  if (!args.flowId) {
    console.error('错误: 需要指定 flowId');
    console.log('用法: crabpaw taskflow delete <flowId>');
    return;
  }

  const flow = await taskflow.getFlow(args.flowId);
  if (!flow) {
    console.error(`错误: TaskFlow 未找到: ${args.flowId}`);
    return;
  }

  if (!args.force) {
    console.log(`\n即将删除 TaskFlow: ${flow.flowId}`);
    console.log(`目标: ${flow.goal}`);
    console.log(`状态: ${flow.status}`);
    console.log('\n使用 --force 确认删除');
    return;
  }

  await taskflow.deleteFlow(args.flowId);

  console.log(`\n✅ TaskFlow 已删除: ${args.flowId}`);
}

async function taskflowStatsCommand(args) {
  const stats = await taskflow.getStats();

  if (args.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('\n' + '═'.repeat(40));
  console.log('TaskFlow 统计信息');
  console.log('═'.repeat(40));

  console.log(`\n总流程数: ${stats.totalFlows}`);
  console.log(`活跃流程: ${stats.activeFlows}`);
  console.log(`阻塞流程: ${stats.blockedFlows}`);
  console.log(`总任务数: ${stats.totalTasks}`);

  console.log('');
}

async function taskflowHistoryCommand(args) {
  if (!args.flowId) {
    console.error('错误: 需要指定 flowId');
    console.log('用法: crabpaw taskflow history <flowId>');
    return;
  }

  const registry = taskflow.getTaskFlowRegistry();
  const limit = args.limit ? parseInt(args.limit, 10) : 100;
  const history = await registry.getFlowHistory(args.flowId, limit);

  if (args.json) {
    console.log(JSON.stringify(history, null, 2));
    return;
  }

  if (history.length === 0) {
    console.log(`\nTaskFlow ${args.flowId} 没有历史记录`);
    return;
  }

  console.log(`\nTaskFlow ${args.flowId} 历史记录:\n`);

  for (const event of history) {
    const time = new Date(event.createdAt).toLocaleString();
    console.log(`[${time}] ${event.eventType}`);
    
    if (event.eventData) {
      console.log(`  数据: ${JSON.stringify(event.eventData)}`);
    }
  }

  console.log(`\n总计: ${history.length} 条记录`);
}

function printHelp() {
  console.log(`
TaskFlow 命令行工具

用法:
  crabpaw taskflow <command> [options]

命令:
  list       列出所有 TaskFlow
  show       显示 TaskFlow 详情
  create     创建新的 TaskFlow
  execute    执行 TaskFlow
  cancel     取消 TaskFlow
  delete     删除 TaskFlow
  stats      显示统计信息
  history    显示历史记录

选项:
  --json           JSON 格式输出
  --status <name>  按状态过滤
  --owner <key>    按所有者过滤
  --limit <n>      限制结果数量
  --goal <goal>    TaskFlow 目标
  --execute        创建后立即执行
  --force          强制执行（如删除）
  --help           显示帮助信息

示例:
  crabpaw taskflow list
  crabpaw taskflow list --status running
  crabpaw taskflow show flow_abc123
  crabpaw taskflow create --goal "skill:send_message(to=user, message=hello)"
  crabpaw taskflow execute flow_abc123
  crabpaw taskflow cancel flow_abc123
  crabpaw taskflow delete flow_abc123 --force
  crabpaw taskflow stats
  crabpaw taskflow history flow_abc123
`);
}

async function handleTaskFlowCommand(args) {
  const command = args._[1];

  try {
    switch (command) {
      case 'list':
        await taskflowListCommand(args);
        break;

      case 'show':
        args.flowId = args._[2];
        await taskflowShowCommand(args);
        break;

      case 'create':
        await taskflowCreateCommand(args);
        break;

      case 'execute':
        args.flowId = args._[2];
        await taskflowExecuteCommand(args);
        break;

      case 'cancel':
        args.flowId = args._[2];
        await taskflowCancelCommand(args);
        break;

      case 'delete':
        args.flowId = args._[2];
        await taskflowDeleteCommand(args);
        break;

      case 'stats':
        await taskflowStatsCommand(args);
        break;

      case 'history':
        args.flowId = args._[2];
        await taskflowHistoryCommand(args);
        break;

      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;

      default:
        if (command) {
          console.error(`错误: 未知命令 '${command}'`);
        }
        printHelp();
        process.exit(command ? 1 : 0);
    }
  } catch (error) {
    console.error('\n❌ 错误:', error.message);
    if (process.env.DEBUG) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

module.exports = {
  handleTaskFlowCommand
};
