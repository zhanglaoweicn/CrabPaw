/**
 * CLI 命令 - 工作流管理
 */

const { SkillFlow } = require('../../core/skill-flow');

const skillFlow = new SkillFlow();

async function handleFlowCommand(args) {
  const subCommand = args[0];
  
  switch (subCommand) {
    case 'list':
      await listFlows();
      break;
    case 'create':
      await createFlow(args.slice(1));
      break;
    case 'run':
      await runFlow(args[1], args.slice(2).join(' '));
      break;
    case 'delete':
      await deleteFlow(args[1]);
      break;
    case 'show':
      await showFlow(args[1]);
      break;
    default:
      printFlowHelp();
  }
}

async function listFlows() {
  const flows = await skillFlow.listFlows();
  
  if (flows.length === 0) {
    console.log('暂无工作流');
    return;
  }
  
  console.log('\n🔗 工作流列表:\n');
  for (const flow of flows) {
    console.log(`  [${flow.id}] ${flow.name}`);
    console.log(`      步骤数: ${flow.steps?.length || 0}`);
    console.log(`      关键词: ${(flow.keywords || []).join(', ') || '无'}`);
    console.log(`      更新: ${flow.updatedAt}`);
    console.log('');
  }
}

async function createFlow(args) {
  const [name, ...keywords] = args;
  
  if (!name) {
    console.log('用法: flow create <name> [keywords...]');
    return;
  }
  
  const flow = skillFlow.createFlow(name, '', [], keywords);
  await skillFlow.saveFlow(flow);
  console.log(`✅ 已创建工作流: ${flow.id}`);
}

async function runFlow(id, input) {
  const flow = await skillFlow.loadFlow(id);
  
  if (!flow) {
    console.log(`工作流不存在: ${id}`);
    return;
  }
  
  console.log(`▶️ 执行工作流: ${flow.name}`);
  
  const result = await skillFlow.executeFlow(flow, { input });
  
  console.log('\n执行结果:');
  console.log(JSON.stringify(result, null, 2));
}

async function deleteFlow(id) {
  const deleted = await skillFlow.deleteFlow(id);
  if (deleted) {
    console.log(`✅ 已删除工作流: ${id}`);
  } else {
    console.log(`工作流不存在: ${id}`);
  }
}

async function showFlow(id) {
  const flow = await skillFlow.loadFlow(id);
  
  if (!flow) {
    console.log(`工作流不存在: ${id}`);
    return;
  }
  
  console.log(`\n🔗 工作流: ${flow.name}\n`);
  console.log(`ID: ${flow.id}`);
  console.log(`关键词: ${(flow.keywords || []).join(', ') || '无'}`);
  console.log(`\n步骤:`);
  
  for (let i = 0; i < (flow.steps || []).length; i++) {
    const step = flow.steps[i];
    console.log(`  ${i + 1}. ${step.skill}`);
    if (step.input) console.log(`     输入: ${step.input}`);
    console.log(`     输出键: ${step.outputKey}`);
  }
}

function printFlowHelp() {
  console.log(`
工作流命令:
  flow list                  列出所有工作流
  flow create <name> [keywords]  创建工作流
  flow run <id> [input]      执行工作流
  flow show <id>             显示工作流详情
  flow delete <id>           删除工作流
`);
}

module.exports = {
  handleFlowCommand
};
