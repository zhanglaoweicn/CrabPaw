/**
 * Flow Handler - 技能编排 API 路由
 * 简洁配置、顺利保存、安全执行
 */

const { SkillFlow } = require('../core/skill-flow');
const {
  parseNaturalLanguage,
  findMatchingTemplates,
  getRecommendedNextSkills,
  generateFlowFromTemplate,
  WORKFLOW_TEMPLATES,
  SKILL_PATTERNS
} = require('../core/flow-generator');

let skillFlow = null;

function initFlowHandler() {
  skillFlow = new SkillFlow();
  console.log('🔗 Flow Handler 已初始化');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('无效的 JSON 数据'));
      }
    });
    req.on('error', reject);
  });
}

async function handleFlows(req, res) {
  try {
    if (!skillFlow) {
      initFlowHandler();
    }
    await skillFlow.initialize();
    const flows = await skillFlow.listFlows();
    sendJson(res, 200, { success: true, data: { flows } });
  } catch (e) {
    console.error('❌ 获取工作流列表失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleFlowGet(req, res) {
  try {
    if (!skillFlow) {
      initFlowHandler();
    }
    await skillFlow.initialize();
    const flowId = getFlowId(req);
    if (!flowId) {
      return sendError(res, 400, '缺少 flowId');
    }

    const flow = await skillFlow.loadFlow(flowId);
    if (!flow) {
      return sendError(res, 404, '工作流不存在');
    }

    sendJson(res, 200, { success: true, data: { flow } });
  } catch (e) {
    console.error('❌ 获取工作流详情失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleFlowCreate(req, res) {
  try {
    if (!skillFlow) {
      initFlowHandler();
    }
    await skillFlow.initialize();
    const data = await parseBody(req);

    if (!data.name || !data.name.trim()) {
      return sendError(res, 400, '名称不能为空');
    }

    const flow = skillFlow.createFlow(
      data.name.trim(),
      data.description || '',
      data.steps || [],
      data.keywords || []
    );

    await skillFlow.saveFlow(flow);

    console.log(`✅ 创建工作流: ${flow.name} (${flow.id})`);
    sendJson(res, 200, { success: true, data: { flow } });
  } catch (e) {
    console.error('❌ 创建工作流失败:', e.message);
    sendError(res, 400, e.message);
  }
}

async function handleFlowUpdate(req, res) {
  try {
    if (!skillFlow) {
      initFlowHandler();
    }
    await skillFlow.initialize();
    const flowId = getFlowId(req);
    if (!flowId) {
      return sendError(res, 400, '缺少 flowId');
    }

    const data = await parseBody(req);
    const flow = await skillFlow.loadFlow(flowId);

    if (!flow) {
      return sendError(res, 404, '工作流不存在');
    }

    if (data.name !== undefined) flow.name = data.name.trim().slice(0, 100);
    if (data.description !== undefined) flow.description = data.description.slice(0, 500);
    if (data.keywords !== undefined) flow.keywords = data.keywords.slice(0, 20);
    if (data.steps !== undefined) flow.steps = data.steps;

    const saved = await skillFlow.saveFlow(flow);

    console.log(`💾 保存工作流: ${saved.name}`);
    sendJson(res, 200, { success: true, data: { flow: saved } });
  } catch (e) {
    console.error('❌ 更新工作流失败:', e.message);
    sendError(res, 400, e.message);
  }
}

async function handleFlowDelete(req, res) {
  try {
    const flowId = getFlowId(req);
    if (!flowId) {
      return sendError(res, 400, '缺少 flowId');
    }

    const deleted = await skillFlow.deleteFlow(flowId);

    console.log(`🗑️ 删除工作流: ${flowId}, 结果: ${deleted}`);
    sendJson(res, 200, { success: true, deleted });
  } catch (e) {
    console.error(`❌ 删除失败: ${e.message}`);
    sendError(res, 500, e.message);
  }
}

async function handleFlowExecute(req, res, ctx) {
  try {
    const flowId = getFlowId(req);
    if (!flowId) {
      return sendError(res, 400, '缺少 flowId');
    }

    const data = await parseBody(req);
    const flow = await skillFlow.loadFlow(flowId);

    if (!flow) {
      return sendError(res, 404, '工作流不存在');
    }

    const steps = data.steps || flow.steps;

    if (!steps || steps.length === 0) {
      return sendError(res, 400, '工作流步骤为空');
    }

    console.log(`▶️ 执行工作流: ${flow.name} (${steps.length} 步骤)`);

    const result = await skillFlow.executeFlow(
      { ...flow, steps },
      {},
      async (skillName, params) => {
        if (ctx.skills && ctx.skillsRegistry) {
          try {
            return await ctx.skills.execute(skillName, params, ctx.skillsRegistry);
          } catch (e) {
            console.error(`❌ 技能执行失败 ${skillName}:`, e.message);
            return `技能 ${skillName} 执行失败: ${e.message}`;
          }
        }
        return `技能 ${skillName} 执行完成`;
      },
      ctx.skillsRegistry || null
    );

    console.log(`✅ 工作流执行完成: ${result.success ? '成功' : '部分失败'}`);
    sendJson(res, 200, result);
  } catch (e) {
    console.error(`❌ 工作流执行错误:`, e.message);
    sendError(res, 500, e.message);
  }
}

async function handleFlowDiagram(req, res) {
  try {
    const flowId = getFlowId(req);
    if (!flowId) {
      return sendError(res, 400, '缺少 flowId');
    }

    const flow = await skillFlow.loadFlow(flowId);
    if (!flow) {
      return sendError(res, 404, '工作流不存在');
    }

    const nodes = [
      { id: 'input', type: 'input', label: '输入', x: 0, y: 0 }
    ];
    const edges = [];

    const steps = flow.steps || [];
    steps.forEach((step, i) => {
      nodes.push({
        id: `step_${i}`,
        type: 'skill',
        label: step.skill || 'unknown',
        x: (i + 1) * 150,
        y: 0
      });

      if (i === 0) {
        edges.push({ from: 'input', to: 'step_0' });
      } else {
        edges.push({ from: `step_${i - 1}`, to: `step_${i}` });
      }
    });

    if (steps.length > 0) {
      nodes.push({ id: 'output', type: 'output', label: '输出', x: (steps.length + 1) * 150, y: 0 });
      edges.push({ from: `step_${steps.length - 1}`, to: 'output' });
    }

    sendJson(res, 200, {
      success: true,
      flowId: flow.id,
      flowName: flow.name,
      diagram: { nodes, edges }
    });
  } catch (e) {
    sendError(res, 500, e.message);
  }
}

async function handleFlowValidate(req, res, ctx) {
  try {
    const data = await parseBody(req);
    const steps = data.steps || [];
    const skillsRegistry = ctx.skillsRegistry || {};

    const CONTROL_SKILLS = ['text-input', 'pass-through', 'condition'];

    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      steps: [],
      summary: {
        totalSteps: steps.length,
        validSteps: 0,
        invalidSteps: 0,
        missingExecutors: 0
      }
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepValidation = {
        index: i,
        skill: step.skill,
        valid: true,
        errors: [],
        warnings: []
      };

      if (!step.skill) {
        stepValidation.valid = false;
        stepValidation.errors.push('未指定技能');
        validation.errors.push(`步骤 ${i + 1}: 未指定技能`);
      } else if (!CONTROL_SKILLS.includes(step.skill)) {
        const skillId = step.skill.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const skill = skillsRegistry[skillId] || skillsRegistry[step.skill];

        if (!skill) {
          stepValidation.valid = false;
          stepValidation.errors.push(`技能 "${step.skill}" 未注册`);
          validation.errors.push(`步骤 ${i + 1}: 技能 "${step.skill}" 未注册`);
        } else {
          const fs = require('fs');
          const path = require('path');
          const hasExecutor = skill.baseDir && (
            fs.existsSync(path.join(skill.baseDir, 'executor.js')) ||
            fs.existsSync(path.join(skill.baseDir, 'analyzer.js')) ||
            fs.existsSync(path.join(skill.baseDir, 'summarizer.js')) ||
            fs.existsSync(path.join(skill.baseDir, 'index.js'))
          );

          if (!hasExecutor && skill.source !== 'flow') {
            stepValidation.warnings.push(`技能 "${skill.name}" 没有执行器`);
            validation.warnings.push(`步骤 ${i + 1}: 技能 "${skill.name}" 没有执行器，可能无法正常执行`);
            validation.summary.missingExecutors++;
          }

          stepValidation.skillInfo = {
            name: skill.name,
            description: skill.description?.substring(0, 100),
            source: skill.source,
            hasExecutor: hasExecutor || skill.source === 'flow'
          };
        }
      }

      if (step.type === 'condition' && !step.condition) {
        stepValidation.warnings.push('条件分支未设置条件表达式');
        validation.warnings.push(`步骤 ${i + 1}: 条件分支未设置条件表达式`);
      }

      if (stepValidation.valid) {
        validation.summary.validSteps++;
      } else {
        validation.summary.invalidSteps++;
        validation.valid = false;
      }

      validation.steps.push(stepValidation);
    }

    if (steps.length === 0) {
      validation.warnings.push('工作流没有任何步骤');
    }

    if (steps.length > 50) {
      validation.errors.push(`工作流步骤数(${steps.length})超过上限(50)`);
      validation.valid = false;
    }

    sendJson(res, 200, { success: true, validation });
  } catch (e) {
    console.error('❌ 验证工作流失败:', e.message);
    sendError(res, 500, e.message);
  }
}

function getFlowId(req) {
  const url = new URL(req.url, `http://localhost:3000`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[parts.length - 1] === 'execute') {
    return parts[parts.length - 2];
  }
  if (parts.length >= 3) {
    return parts[parts.length - 1];
  }
  return url.searchParams.get('id');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: message }));
}

async function handleFlowGenerate(req, res, ctx) {
  try {
    const data = await parseBody(req);
    const text = data.text || data.prompt || '';

    if (!text.trim()) {
      return sendError(res, 400, '请输入工作流描述');
    }

    const result = parseNaturalLanguage(text, ctx.skillsRegistry || {});

    const templates = findMatchingTemplates(text);
    if (templates.length > 0) {
      result.matchedTemplates = templates.slice(0, 3);
    }

    sendJson(res, 200, {
      success: result.success,
      generation: result,
      message: result.success 
        ? `已识别 ${result.detectedSkills.length} 个技能，生成 ${result.steps.length} 个步骤`
        : '未能识别到相关技能'
    });
  } catch (e) {
    console.error('❌ 生成工作流失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleFlowTemplates(req, res) {
  try {
    const templates = WORKFLOW_TEMPLATES.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      keywords: t.keywords,
      stepCount: t.steps.length,
      steps: t.steps.map((s, i) => ({
        index: i,
        skill: s.skill,
        displayName: SKILL_PATTERNS[s.skill]?.displayName || s.skill,
        description: SKILL_PATTERNS[s.skill]?.description || ''
      }))
    }));

    sendJson(res, 200, { success: true, templates });
  } catch (e) {
    console.error('❌ 获取模板列表失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleFlowTemplateApply(req, res) {
  try {
    const data = await parseBody(req);
    const templateId = data.templateId;

    if (!templateId) {
      return sendError(res, 400, '请指定模板 ID');
    }

    const flow = generateFlowFromTemplate(templateId);
    if (!flow) {
      return sendError(res, 404, '模板不存在');
    }

    sendJson(res, 200, { success: true, flow });
  } catch (e) {
    console.error('❌ 应用模板失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleFlowRecommendations(req, res) {
  try {
    const url = new URL(req.url, `http://localhost:3000`);
    const skillId = url.searchParams.get('skillId');

    if (!skillId) {
      const allRecommendations = {};
      for (const skillId of Object.keys(SKILL_PATTERNS)) {
        const recs = getRecommendedNextSkills(skillId);
        if (recs.length > 0) {
          allRecommendations[skillId] = recs;
        }
      }
      return sendJson(res, 200, { success: true, recommendations: allRecommendations });
    }

    const recommendations = getRecommendedNextSkills(skillId);
    sendJson(res, 200, { success: true, skillId, recommendations });
  } catch (e) {
    console.error('❌ 获取推荐失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleFlowSkillsInfo(req, res) {
  try {
    const skills = Object.entries(SKILL_PATTERNS).map(([id, info]) => ({
      id,
      displayName: info.displayName,
      description: info.description,
      category: info.category,
      keywords: info.keywords.slice(0, 5)
    }));

    sendJson(res, 200, { success: true, skills });
  } catch (e) {
    console.error('❌ 获取技能信息失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleSkillGenerate(req, res, ctx) {
  try {
    const data = await parseBody(req);
    // eslint-disable-next-line no-unused-vars
    const { prompt, autoCreate = false } = data;
    
    if (!prompt || !prompt.trim()) {
      return sendError(res, 400, '请输入技能需求描述');
    }
    
    const { analyzeAndGenerateSkill } = require('../core/skill-generator');
    
    const result = await analyzeAndGenerateSkill(prompt, {
      ai: ctx.ai,
      tools: ctx.tools
    });
    
    if (result.success) {
      sendJson(res, 200, {
        success: true,
        skillId: result.skillId,
        displayName: result.displayName,
        message: result.message,
        analysis: result.analysis
      });
    } else {
      sendJson(res, 200, {
        success: false,
        reason: result.reason || result.error,
        suggestions: result.suggestions || []
      });
    }
  } catch (e) {
    console.error('❌ 生成技能失败:', e.message);
    sendError(res, 500, e.message);
  }
}

async function handleSkillUpdate(req, res, ctx) {
  try {
    const data = await parseBody(req);
    const { skillId, feedback } = data;
    
    if (!skillId || !feedback) {
      return sendError(res, 400, '缺少 skillId 或 feedback 参数');
    }
    
    const { updateSkillFromFeedback } = require('../core/skill-generator');
    
    const result = await updateSkillFromFeedback(skillId, feedback, {
      ai: ctx.ai
    });
    
    sendJson(res, 200, result);
  } catch (e) {
    console.error('❌ 更新技能失败:', e.message);
    sendError(res, 500, e.message);
  }
}

module.exports = {
  initFlowHandler,
  handleFlows,
  handleFlowGet,
  handleFlowCreate,
  handleFlowUpdate,
  handleFlowDelete,
  handleFlowExecute,
  handleFlowDiagram,
  handleFlowValidate,
  handleFlowGenerate,
  handleFlowTemplates,
  handleFlowTemplateApply,
  handleFlowRecommendations,
  handleFlowSkillsInfo,
  handleSkillGenerate,
  handleSkillUpdate
};
