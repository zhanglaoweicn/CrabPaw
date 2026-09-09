/**
 * CLI 命令 - 定时任务管理
 */

const { scheduler } = require('../../core');

async function handleScheduleCommand(args) {
  const subCommand = args[0];
  
  switch (subCommand) {
    case 'list':
      await listSchedules();
      break;
    case 'add':
      await addSchedule(args.slice(1));
      break;
    case 'remove':
      await removeSchedule(args[1]);
      break;
    case 'run':
      await runSchedule(args[1]);
      break;
    default:
      printScheduleHelp();
  }
}

async function listSchedules() {
  const schedules = scheduler.list();
  
  if (schedules.length === 0) {
    console.log('暂无定时任务');
    return;
  }
  
  console.log('\n📅 定时任务列表:\n');
  for (const task of schedules) {
    console.log(`  [${task.id}] ${task.name}`);
    console.log(`      Cron: ${task.cron}`);
    console.log(`      状态: ${task.enabled ? '✅ 启用' : '⏸️ 禁用'}`);
    console.log(`      下次执行: ${task.nextRun || '未知'}`);
    console.log('');
  }
}

async function addSchedule(args) {
  const [name, cron, action] = args;
  
  if (!name || !cron || !action) {
    console.log('用法: schedule add <name> <cron> <action>');
    return;
  }
  
  await scheduler.add({ name, cron, action });
  console.log(`✅ 已添加定时任务: ${name}`);
}

async function removeSchedule(id) {
  await scheduler.remove(id);
  console.log(`✅ 已删除定时任务: ${id}`);
}

async function runSchedule(id) {
  await scheduler.runNow(id);
  console.log(`✅ 已执行定时任务: ${id}`);
}

function printScheduleHelp() {
  console.log(`
定时任务命令:
  schedule list              列出所有任务
  schedule add <name> <cron> <action>  添加任务
  schedule remove <id>       删除任务
  schedule run <id>          立即执行任务
`);
}

module.exports = {
  handleScheduleCommand
};
