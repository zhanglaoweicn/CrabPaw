const { registry } = require('../tools/registry');

const PLAN_EXIT_SYSTEM_SUFFIX = `

[计划模式已结束]
Agent已提交执行计划。现在切换到执行模式：
1. 严格按照计划中的步骤执行
2. 每完成一步，标记为已完成
3. 如果发现计划有问题，停下来向用户报告
4. 执行完成后，提供最终结果总结
`;

registry.register({
  name: 'PlanExit',
  toolset: 'interaction',
  category: 'interaction',
  schema: {
    description: '提交执行计划并切换到执行模式。在计划阶段完成后调用此工具，将规划好的步骤提交给执行阶段。执行阶段的Agent将严格按照计划逐步执行。注意: 结构化计划创建推荐用 PlanCreate（步骤清单+前端实时进度卡）。',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: '详细的执行计划，包含步骤编号、每步的具体操作和预期结果'
        },
        summary: {
          type: 'string',
          description: '计划的一句话总结'
        },
        estimatedSteps: {
          type: 'number',
          description: '预计需要的执行步骤数'
        },
        risks: {
          type: 'array',
          description: '可能的风险或需要注意的事项',
          items: { type: 'string' }
        }
      },
      required: ['plan', 'summary']
    }
  },
  handler: async (params, context) => {
    const { plan, summary, estimatedSteps, risks } = params;

    if (!plan || !plan.trim()) {
      return { error: '计划不能为空' };
    }

    // 2026-09-03(Plan 实体整合): PlanExit 提交的计划同步写入 plan-store——
    // 模型实测偏好本工具(而非 PlanCreate)提交计划, 两条路必须殊途同归驱动
    // 前端执行计划卡, 否则卡片永不出现。计划文本解析: 优先编号行;
    // 单行分号串联(实测 "1) …；2) …；3) …")按分隔符二次切分。
    try {
      const stripNum = (l) => l.replace(/^\s*\d+\s*[.、)）]\s*/, '').trim()
      let steps = plan.split('\n').map(stripNum).filter(l => l.length > 1)
      if (steps.length < 2) {
        steps = plan.split(/[；;。]/).map(l => stripNum(l)).filter(l => l.length > 2)
      }
      steps = steps.slice(0, 20)
      const runId = context?.runId || null
      if (runId && steps.length >= 2) {
        const { getPlanStore } = require('../core/plan-store');
        const r = getPlanStore().setPlan(runId, { title: summary || '执行计划', steps });
        if (r.ok) console.log('[PlanExit] 计划已同步 plan-store:', r.plan.planId, `(${steps.length} 步)`);
      } else {
        console.warn('[PlanExit] plan-store 同步跳过:', `runId=${runId ? '有' : '无'}, steps=${steps.length}`);
      }
    } catch (e) {
      console.warn('[PlanExit] plan-store 同步失败(不阻塞):', e?.message || e);
    }

    let result = `📋 **执行计划已提交**\n\n`;
    result += `**摘要**: ${summary}\n\n`;
    result += `---\n\n${plan}\n\n---\n\n`;

    if (estimatedSteps) {
      result += `📊 预计步骤: ${estimatedSteps}\n`;
    }

    if (risks && risks.length > 0) {
      result += `\n⚠️ **注意事项**:\n`;
      risks.forEach((r, i) => {
        result += `${i + 1}. ${r}\n`;
      });
    }

    result += `\n✅ 切换到执行模式，开始按计划执行。`;

    return {
      content: result,
      _planExit: true,
      _planData: { plan, summary, estimatedSteps, risks },
      _systemSuffix: PLAN_EXIT_SYSTEM_SUFFIX,
    };
  },
  isReadOnly: true
});

console.log('✅ 计划退出工具已注册: PlanExit');
