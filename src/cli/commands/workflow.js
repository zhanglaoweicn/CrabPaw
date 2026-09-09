/**
 * CLI 命令 - 工作流管理 v2.0
 * 
 * 支持新的 WorkflowEngine
 */

const { WorkflowEngine } = require('../../core/workflow-engine');
const { SkillFlow } = require('../../core/skill-flow');

const workflowEngine = new WorkflowEngine();
const skillFlow = new SkillFlow();

async function handleWorkflowCommand(args) {
  const subCommand = args[0];
  
  await workflowEngine.initialize();
  await skillFlow.initialize();
  
  switch (subCommand) {
    case 'list':
    case 'ls':
      await listWorkflows();
      break;
    case 'create':
      await createWorkflow(args.slice(1));
      break;
    case 'run':
    case 'execute':
      await runWorkflow(args[1], args.slice(2).join(' '));
      break;
    case 'delete':
    case 'rm':
      await deleteWorkflow(args[1]);
      break;
    case 'show':
    case 'get':
      await showWorkflow(args[1]);
      break;
    case 'schedule':
      await scheduleWorkflow(args.slice(1));
      break;
    case 'roi':
      await showROI(args[1]);
      break;
    case 'stats':
      await showStats();
      break;
    case 'template':
      await createFromTemplate(args[1]);
      break;
    case 'export':
      await exportWorkflow(args[1], args[2]);
      break;
    case 'import':
      await importWorkflow(args[1]);
      break;
    default:
      printWorkflowHelp();
  }
}

async function listWorkflows() {
  const workflows = workflowEngine.listWorkflows();
  const legacyFlows = await skillFlow.listFlows();
  
  if (workflows.length === 0 && legacyFlows.length === 0) {
    console.log('暂无工作流');
    return;
  }
  
  if (workflows.length > 0) {
    console.log('\n🔄 工作流列表 (v2.0):\n');
    for (const wf of workflows) {
      const trigger = wf.trigger?.type || 'manual';
      const stats = wf.stats || {};
      console.log(`  [${wf.id}] ${wf.name}`);
      console.log(`      触发器: ${trigger}`);
      console.log(`      动作数: ${wf.actions?.length || 0}`);
      console.log(`      执行次数: ${stats.totalRuns || 0}`);
      console.log(`      成功率: ${stats.totalRuns > 0 ? ((stats.successRuns / stats.totalRuns) * 100).toFixed(1) : 0}%`);
      console.log('');
    }
  }
  
  if (legacyFlows.length > 0) {
    console.log('\n🔗 旧版工作流:\n');
    for (const flow of legacyFlows) {
      console.log(`  [${flow.id}] ${flow.name}`);
      console.log(`      步骤数: ${flow.steps?.length || 0}`);
      console.log('');
    }
  }
}

async function createWorkflow(args) {
  const name = args[0];
  
  if (!name) {
    console.log('用法: workflow create <name>');
    console.log('提示: 使用 workflow template <type> 从模板创建');
    return;
  }
  
  const workflow = workflowEngine.createWorkflow({
    name,
    description: args[1] || '',
    trigger: { type: 'manual' },
    actions: []
  });
  
  await workflowEngine.saveWorkflow(workflow);
  console.log(`✅ 已创建工作流: ${workflow.id}`);
  console.log(`   使用 'workflow show ${workflow.id}' 查看详情`);
}

async function createFromTemplate(templateType) {
  const templates = {
    'daily-report': {
      name: '每日报告生成',
      description: '每天自动生成并发送报告',
      trigger: { type: 'schedule', config: { cron: '0 9 * * 1-5' } },
      actions: [
        { id: 'research', type: 'skill', skill: 'deep-research', name: '收集数据', outputKey: 'data' },
        { id: 'summarize', type: 'skill', skill: 'summarize-pro', name: '生成摘要', input: '${data}', outputKey: 'summary' },
        { id: 'ppt', type: 'skill', skill: 'pptx-generator', name: '生成PPT', params: { content: '${summary}' }, outputKey: 'ppt' }
      ],
      errorHandling: { strategy: 'retry', retry: { maxRetries: 2 } }
    },
    'customer-service': {
      name: '客户咨询处理',
      description: '自动处理客户咨询并生成回复',
      trigger: { type: 'event', config: { event: 'message.received' } },
      conditions: [
        { type: 'simple', field: 'input.type', operator: 'equals', value: 'inquiry' }
      ],
      actions: [
        { id: 'analyze', type: 'skill', skill: 'summarize-pro', name: '分析意图', outputKey: 'intent' },
        { id: 'search', type: 'skill', skill: 'deep-research', name: '搜索知识', params: { topic: '${intent}' }, outputKey: 'knowledge' },
        { id: 'respond', type: 'skill', skill: 'summarize-pro', name: '生成回复', input: '${knowledge}', outputKey: 'response' }
      ]
    },
    'content-pipeline': {
      name: '内容生产流水线',
      description: '从研究到发布的完整内容生产流程',
      trigger: { type: 'manual' },
      actions: [
        { id: 'research', type: 'skill', skill: 'deep-research', name: '深度研究', outputKey: 'research' },
        { id: 'outline', type: 'skill', skill: 'summarize-pro', name: '生成大纲', input: '${research}', outputKey: 'outline' },
        { id: 'parallel', type: 'parallel', name: '并行生成', actions: [
          { type: 'skill', skill: 'pptx-generator', params: { content: '${outline}', style: 'business' } },
          { type: 'skill', skill: 'pdf-generator', params: { content: '${outline}' } }
        ], outputKey: 'outputs' }
      ]
    }
  };
  
  if (!templateType || !templates[templateType]) {
    console.log('可用模板:');
    Object.keys(templates).forEach(key => {
      console.log(`  - ${key}: ${templates[key].name}`);
    });
    console.log('\n用法: workflow template <type>');
    return;
  }
  
  const template = templates[templateType];
  const workflow = workflowEngine.createWorkflow(template);
  await workflowEngine.saveWorkflow(workflow);
  
  console.log(`✅ 从模板创建工作流: ${workflow.id}`);
  console.log(`   名称: ${workflow.name}`);
  console.log(`   触发器: ${workflow.trigger.type}`);
  console.log(`   动作数: ${workflow.actions.length}`);
}

async function runWorkflow(id, input) {
  const workflow = workflowEngine.getWorkflow(id);
  
  if (!workflow) {
    const legacyFlow = await skillFlow.loadFlow(id);
    if (!legacyFlow) {
      console.log(`工作流不存在: ${id}`);
      return;
    }
    
    console.log(`▶️ 执行旧版工作流: ${legacyFlow.name}`);
    const result = await skillFlow.executeFlow(legacyFlow, { input });
    console.log('\n执行结果:');
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  
  console.log(`▶️ 执行工作流: ${workflow.name}`);
  
  const execution = await workflowEngine.execute(id, { input });
  
  console.log('\n执行结果:');
  console.log(`  状态: ${execution.status}`);
  console.log(`  耗时: ${execution.endTime - execution.startTime}ms`);
  console.log(`  步骤数: ${execution.results.length}`);
  
  if (execution.errors.length > 0) {
    console.log('\n错误:');
    execution.errors.forEach(e => {
      console.log(`  - ${e.actionId}: ${e.error}`);
    });
  }
}

async function deleteWorkflow(id) {
  const workflow = workflowEngine.getWorkflow(id);
  
  if (workflow) {
    await workflowEngine.deleteWorkflow(id);
    console.log(`✅ 已删除工作流: ${id}`);
  } else {
    const deleted = await skillFlow.deleteFlow(id);
    if (deleted) {
      console.log(`✅ 已删除旧版工作流: ${id}`);
    } else {
      console.log(`工作流不存在: ${id}`);
    }
  }
}

async function showWorkflow(id) {
  const workflow = workflowEngine.getWorkflow(id);
  
  if (!workflow) {
    const legacyFlow = await skillFlow.loadFlow(id);
    if (!legacyFlow) {
      console.log(`工作流不存在: ${id}`);
      return;
    }
    showLegacyFlow(legacyFlow);
    return;
  }
  
  console.log(`\n🔄 工作流: ${workflow.name}\n`);
  console.log(`ID: ${workflow.id}`);
  console.log(`描述: ${workflow.description || '无'}`);
  console.log(`版本: ${workflow.version}`);
  
  console.log(`\n🎯 触发器:`);
  console.log(`  类型: ${workflow.trigger?.type || 'manual'}`);
  if (workflow.trigger?.config) {
    console.log(`  配置: ${JSON.stringify(workflow.trigger.config)}`);
  }
  
  if (workflow.conditions && workflow.conditions.length > 0) {
    console.log(`\n🔍 条件:`);
    workflow.conditions.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.type}: ${c.field || ''} ${c.operator || ''} ${c.value || ''}`);
    });
  }
  
  console.log(`\n⚡ 动作序列:`);
  workflow.actions.forEach((action, i) => {
    console.log(`  ${i + 1}. [${action.type}] ${action.name || action.skill || action.tool || ''}`);
    if (action.input) console.log(`     输入: ${action.input}`);
    if (action.skill) console.log(`     技能: ${action.skill}`);
    if (action.tool) console.log(`     工具: ${action.tool}`);
    console.log(`     输出键: ${action.outputKey}`);
  });
  
  console.log(`\n🛡️ 错误处理:`);
  console.log(`  策略: ${workflow.errorHandling?.strategy || 'stop'}`);
  console.log(`  重试次数: ${workflow.errorHandling?.retry?.maxRetries || 0}`);
  
  const stats = workflow.stats || {};
  console.log(`\n📊 统计:`);
  console.log(`  总执行次数: ${stats.totalRuns || 0}`);
  console.log(`  成功次数: ${stats.successRuns || 0}`);
  console.log(`  失败次数: ${stats.failedRuns || 0}`);
}

function showLegacyFlow(flow) {
  console.log(`\n🔗 旧版工作流: ${flow.name}\n`);
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

async function scheduleWorkflow(args) {
  const [id, cron] = args;
  
  if (!id || !cron) {
    console.log('用法: workflow schedule <id> <cron>');
    console.log('示例: workflow schedule daily_report "0 9 * * 1-5"');
    return;
  }
  
  const workflow = workflowEngine.getWorkflow(id);
  if (!workflow) {
    console.log(`工作流不存在: ${id}`);
    return;
  }
  
  workflow.trigger = { type: 'schedule', config: { cron }, enabled: true };
  await workflowEngine.saveWorkflow(workflow);
  
  console.log(`⏰ 已调度工作流: ${workflow.name}`);
  console.log(`   Cron: ${cron}`);
}

async function showROI(id) {
  if (!id) {
    console.log('用法: workflow roi <id>');
    return;
  }
  
  const roi = workflowEngine.calculateROI(id);
  if (!roi) {
    console.log(`工作流不存在: ${id}`);
    return;
  }
  
  console.log(`\n📊 ROI 分析: ${roi.name}\n`);
  console.log(`  总执行次数: ${roi.totalRuns}`);
  console.log(`  成功率: ${roi.successRate}`);
  console.log(`  平均耗时: ${roi.avgDuration}`);
  console.log(`  月节省时间: ${roi.monthlyTimeSaved}`);
  console.log(`  估算价值: ${roi.estimatedValue}`);
}

async function showStats() {
  const stats = workflowEngine.getStats();
  
  console.log('\n📊 工作流统计:\n');
  console.log(`  总工作流数: ${stats.totalWorkflows}`);
  console.log(`  活跃执行数: ${stats.activeExecutions}`);
  console.log(`  总执行记录: ${stats.totalExecutions}`);
}

async function exportWorkflow(id, outputPath) {
  const workflow = workflowEngine.getWorkflow(id);
  
  if (!workflow) {
    console.log(`工作流不存在: ${id}`);
    return;
  }
  
  const fs = require('fs');

  
  const filePath = outputPath || `${workflow.name}.workflow.json`;
  
  fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2));
  console.log(`✅ 已导出工作流到: ${filePath}`);
}

async function importWorkflow(filePath) {
  const fs = require('fs');

  
  if (!fs.existsSync(filePath)) {
    console.log(`文件不存在: ${filePath}`);
    return;
  }
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const workflow = workflowEngine.createWorkflow(data);
  await workflowEngine.saveWorkflow(workflow);
  
  console.log(`✅ 已导入工作流: ${workflow.id}`);
}

function printWorkflowHelp() {
  console.log(`
工作流命令 v2.0:
  workflow list              列出所有工作流
  workflow create <name>     创建空工作流
  workflow template <type>   从模板创建工作流
  workflow run <id> [input]  执行工作流
  workflow show <id>         显示工作流详情
  workflow delete <id>       删除工作流
  workflow schedule <id> <cron>  设置定时触发
  workflow roi <id>          显示 ROI 分析
  workflow stats             显示统计信息
  workflow export <id> [file]    导出工作流
  workflow import <file>     导入工作流

模板类型:
  daily-report       每日报告生成
  customer-service   客户咨询处理
  content-pipeline   内容生产流水线

示例:
  workflow template daily-report
  workflow run daily_report "今日任务"
  workflow schedule daily_report "0 9 * * 1-5"
`);
}

module.exports = {
  handleWorkflowCommand
};
