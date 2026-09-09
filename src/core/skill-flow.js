const crypto = require('crypto');
/**
 * Skill Flow - 技能编排引擎
 * 动态技能发现、条件分支、结构化数据传递
 */

const path = require('path');
const fs = require('fs');
const { safeEvaluate } = require('./security/safe-expression');
const { getCrabPawSubDir } = require('./path-utils');

const CONTROL_NODES = ['text-input', 'pass-through', 'condition'];
const MAX_STEPS = 50;

class SkillFlow {
  constructor() {
    this.flowsDir = getCrabPawSubDir('flows');
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    if (!fs.existsSync(this.flowsDir)) {
      fs.mkdirSync(this.flowsDir, { recursive: true });
    }

    this.initialized = true;
    console.log(`📁 Flow 工作流目录: ${this.flowsDir}`);
  }

  createFlow(name, description = '', steps = [], keywords = []) {
    return {
      id: `flow_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`,
      name: name || '未命名工作流',
      description,
      keywords: keywords || [],
      steps: steps.map((step, index) => ({
        id: step.id || `step_${index}`,
        type: step.type || 'skill',
        skill: step.skill || 'text-input',
        input: step.input || '',
        outputKey: step.outputKey || `result_${index}`,
        ...(step.type === 'condition' ? {
          condition: step.condition || '',
          trueStep: step.trueStep != null ? step.trueStep : null,
          falseStep: step.falseStep != null ? step.falseStep : null
        } : {})
      })),
      version: '2.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  async saveFlow(flow) {
    await this.initialize();

    if (!flow || !flow.id) {
      throw new Error('无效的工作流数据');
    }

    const filePath = this.getFlowPath(flow.id);

    const safeFlow = {
      id: flow.id,
      name: String(flow.name || '未命名').slice(0, 100),
      description: String(flow.description || '').slice(0, 500),
      keywords: (flow.keywords || []).slice(0, 20).map(k => String(k).slice(0, 50)),
      steps: (flow.steps || []).map(s => {
        const safe = {
          id: String(s.id || '').slice(0, 50),
          type: String(s.type || 'skill').slice(0, 20),
          skill: String(s.skill || 'text-input').slice(0, 50),
          input: String(s.input || '').slice(0, 10000),
          outputKey: String(s.outputKey || '').slice(0, 50)
        };
        if (s.type === 'condition') {
          safe.condition = String(s.condition || '').slice(0, 500);
          safe.trueStep = s.trueStep;
          safe.falseStep = s.falseStep;
        }
        return safe;
      }),
      version: '2.0',
      createdAt: flow.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    fs.writeFileSync(filePath, JSON.stringify(safeFlow, null, 2), 'utf-8');
    return safeFlow;
  }

  getFlowPath(flowId) {
    const safeId = String(flowId).replace(/[^a-zA-Z0-9_-]/g, '') || 'unnamed_flow';
    return path.join(this.flowsDir, `${safeId}.json`);
  }

  async loadFlow(flowId) {
    await this.initialize();

    if (!flowId) return null;

    const filePath = this.getFlowPath(flowId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      console.error(`❌ 加载工作流失败 ${flowId}:`, e.message);
      return null;
    }
  }

  async listFlows() {
    await this.initialize();

    if (!fs.existsSync(this.flowsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.flowsDir).filter(f => f.endsWith('.json'));
    const flows = [];

    for (const file of files) {
      try {
        const flow = JSON.parse(fs.readFileSync(path.join(this.flowsDir, file), 'utf-8'));
        if (flow && flow.id) {
          flows.push(flow);
        }
      } catch (e) {
        console.error(`⚠️ 跳过损坏的工作流文件: ${file}`);
      }
    }

    return flows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async getFlowsAsTools() {
    const flows = await this.listFlows();
    return flows.map(flow => ({
      name: `flow_${flow.id}`,
      description: `${flow.name}: ${flow.description || '无描述'} (关键词: ${(flow.keywords || []).join(', ') || '无'})`,
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '工作流输入文本' }
        }
      }
    }));
  }

  async deleteFlow(flowId) {
    await this.initialize();

    if (!flowId) return false;

    const filePath = this.getFlowPath(flowId);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }

    return false;
  }

  resolveInput(input, context) {
    if (input === undefined || input === null || input === '') {
      return context.previousOutput || '';
    }

    if (typeof input !== 'string') {
      return input;
    }

    const resolved = input.replace(/\$\{([^}]+)\}/g, (_, key) => {
      const value = context[key];
      if (value === undefined) return '';
      if (typeof value === 'object') {
        try { return JSON.stringify(value); }
        catch { return String(value); }
      }
      return String(value);
    });

    if (resolved.startsWith('$') && !input.includes('${')) {
      const key = resolved.slice(1);
      return context[key] !== undefined ? context[key] : resolved;
    }

    return resolved;
  }

  buildSkillParams(skillName, input, _context) {
    const paramMapping = {
      'multi-search-engine': { keyword: input },
      'financial-analyst': { data: input },
      'summarize-pro': { text: input }
    };

    if (paramMapping[skillName]) {
      return paramMapping[skillName];
    }

    return { input, data: input, text: typeof input === 'string' ? input : JSON.stringify(input) };
  }

  evaluateCondition(condition, context) {
    if (!condition) return true;

    try {
      const evaluated = condition.replace(/\$\{([^}]+)\}/g, (_, key) => {
        const value = context[key];
        if (typeof value === 'number') return value;
        if (typeof value === 'string') return `"${value.replace(/"/g, '\\"')}"`;
        if (typeof value === 'boolean') return value;
        if (value === undefined || value === null) return 'null';
        try { return JSON.stringify(value); }
        catch { return 'null'; }
      });

      const result = safeEvaluate(evaluated);
      if (!result.safe) {
        console.warn(`🔒 技能流条件被安全策略拒绝: ${condition} → ${result.reason}`);
      }
      return result.value;
    } catch (e) {
      console.warn(`⚠️ 条件评估失败: ${condition} → ${e.message}`);
      return true;
    }
  }

  async executeFlow(flow, initialInput = {}, skillExecutor, _skillsRegistry) {
    if (!flow || !flow.steps || flow.steps.length === 0) {
      return {
        success: false,
        error: '工作流为空',
        results: [],
        timeline: []
      };
    }

    const visitedSkills = new Set();
    for (const step of flow.steps) {
      if (step.skill && !CONTROL_NODES.includes(step.type || step.skill)) {
        if (visitedSkills.has(step.skill)) {
          console.warn(`⚠️ 工作流 ${flow.id} 包含重复技能调用: ${step.skill}，可能存在循环`);
        }
        visitedSkills.add(step.skill);
      }
    }

    if (flow.steps.length > MAX_STEPS) {
      return {
        success: false,
        error: `工作流步骤数(${flow.steps.length})超过上限(${MAX_STEPS})`,
        results: [],
        timeline: []
      };
    }

    const context = { ...initialInput };
    context.previousOutput = initialInput.input || initialInput.text || '';
    context.previousStructured = null;
    const results = [];
    const timeline = [];
    let skipped = false;

    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const stepType = step.type || 'skill';
      const startTime = Date.now();

      try {
        if (stepType === 'condition') {
          const conditionResult = this.evaluateCondition(step.condition, context);
          timeline.push({
            stepId: step.id || i,
            skill: 'condition',
            status: 'success',
            conditionResult,
            duration: Date.now() - startTime
          });
          results.push({
            stepId: step.id || i,
            skill: 'condition',
            success: true,
            conditionResult,
            output: `条件判断: ${conditionResult ? '真' : '假'}`
          });

          if (!conditionResult) {
            const skipCount = step.falseStep || 0;
            if (skipCount > 0) {
              i += skipCount;
              skipped = true;
            }
          }
          continue;
        }

        if (skipped) {
          skipped = false;
        }

        const input = this.resolveInput(step.input, context);
        let output;

        if (step.skill === 'text-input') {
          output = input;
        } else if (step.skill === 'pass-through') {
          output = context.previousOutput || input;
        } else if (skillExecutor) {
          const params = this.buildSkillParams(step.skill, input, context);
          output = await skillExecutor(step.skill, params);
        } else {
          output = `⚠️ 技能 ${step.skill} 不可用（无执行器）`;
        }

        context[step.outputKey || `result_${i}`] = output;
        context.previousOutput = output;

        if (typeof output === 'object' && output !== null) {
          context.previousStructured = output;
        } else {
          context.previousStructured = null;
        }

        results.push({
          stepId: step.id || i,
          skill: step.skill,
          success: true,
          output: String(output).slice(0, 500)
        });

        timeline.push({
          stepId: step.id || i,
          skill: step.skill,
          status: 'success',
          duration: Date.now() - startTime
        });

      } catch (error) {
        results.push({
          stepId: step.id || i,
          skill: step.skill,
          success: false,
          error: error.message
        });

        timeline.push({
          stepId: step.id || i,
          skill: step.skill,
          status: 'error',
          error: error.message,
          duration: Date.now() - startTime
        });

        break;
      }
    }

    return {
      flowId: flow.id,
      flowName: flow.name,
      success: results.length > 0 && results.every(r => r.success),
      results,
      timeline,
      finalOutput: context.previousOutput || results[results.length - 1]?.output || ''
    };
  }

  toWorkflowFormat(flow) {
    return {
      id: flow.id,
      name: flow.name,
      description: flow.description || '',
      version: '2.0',
      trigger: { type: 'manual' },
      conditions: [],
      actions: (flow.steps || []).map((step, index) => ({
        id: step.id || `action_${index}`,
        type: step.type === 'condition' ? 'condition' : 'skill',
        name: step.type === 'condition' ? '条件分支' : step.skill,
        skill: step.skill,
        params: {},
        input: step.input || '',
        outputKey: step.outputKey || `result_${index}`,
        condition: step.condition,
        falseStep: step.falseStep
      })),
      errorHandling: { strategy: 'stop' },
      metadata: {
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt,
        tags: flow.keywords || []
      },
      keywords: flow.keywords || []
    };
  }

  async executeWithEngine(flow, input, workflowEngine, context = {}) {
    const workflow = this.toWorkflowFormat(flow);
    
    workflowEngine.workflows.set(workflow.id, workflow);
    
    try {
      const execution = await workflowEngine.execute(workflow.id, input, {
        skillExecutor: context.skillExecutor,
        toolExecutor: context.toolExecutor
      });
      
      return {
        flowId: flow.id,
        flowName: flow.name,
        success: execution.status === 'completed',
        results: execution.results || [],
        timeline: execution.timeline || [],
        finalOutput: execution.result || '',
        execution
      };
    } finally {
      workflowEngine.workflows.delete(workflow.id);
    }
  }
}

module.exports = { SkillFlow };
