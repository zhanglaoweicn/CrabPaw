/**
 * E2E Test: Workflow Template Engine - Condition & Loop templates (P1-1)
 */
const { getWorkflowTemplateEngine } = require('../../src/taskflow/workflow-template-engine');

module.exports = {
  name: 'Template Condition & Loop Tests',
  cases: [
    {
      id: 'tpl_001',
      name: 'batch_process template is registered',
      category: 'workflow',
      run: () => {
        const engine = getWorkflowTemplateEngine();
        const tmpl = engine.getTemplate('batch_process');
        if (!tmpl) return false;
        if (tmpl.category !== 'automation') return false;
        if (tmpl.steps.length === 0) return false;
        const loopStep = tmpl.steps.find(s => s.type === 'loop');
        return loopStep !== undefined && loopStep.maxIterations === 50;
      },
    },
    {
      id: 'tpl_002',
      name: 'conditional_approval template is registered',
      category: 'workflow',
      run: () => {
        const engine = getWorkflowTemplateEngine();
        const tmpl = engine.getTemplate('conditional_approval');
        if (!tmpl) return false;
        if (tmpl.steps.length === 0) return false;
        const condStep = tmpl.steps.find(s => s.type === 'condition');
        return condStep !== undefined && condStep.thenActions.length > 0 && condStep.elseActions.length > 0;
      },
    },
    {
      id: 'tpl_003',
      name: 'Keyword matching for batch_process',
      category: 'workflow',
      run: () => {
        const engine = getWorkflowTemplateEngine();
        const match = engine.matchTemplate('need to batch process 100 records');
        if (!match) return false;
        return match.template.id === 'batch_process';
      },
    },
    {
      id: 'tpl_004',
      name: 'Keyword matching for conditional_approval',
      category: 'workflow',
      run: () => {
        const engine = getWorkflowTemplateEngine();
        const match = engine.matchTemplate('conditional approval required');
        if (!match) return false;
        return match.template.id === 'conditional_approval';
      },
    },
    {
      id: 'tpl_005',
      name: 'buildTaskFlowGoal returns valid string',
      category: 'workflow',
      run: () => {
        const engine = getWorkflowTemplateEngine();
        const tmpl = engine.getTemplate('batch_process');
        const goal = engine.buildTaskFlowGoal(tmpl, { items: 'logs', batch_size: '20' });
        return typeof goal === 'string' && !goal.includes('undefined');
      },
    },
    {
      id: 'tpl_006',
      name: 'createFlowFromTemplate returns goal and metadata',
      category: 'workflow',
      run: () => {
        const engine = getWorkflowTemplateEngine();
        const flow = engine.createFlowFromTemplate('batch_process', { items: 'test_data' });
        return flow.goal != null && flow.metadata.templateId === 'batch_process';
      },
    },
    {
      id: 'tpl_007',
      name: 'validateTemplates returns valid',
      category: 'workflow',
      run: () => {
        const engine = getWorkflowTemplateEngine();
        const result = engine.validateTemplates([]);
        return result.valid === true && result.totalTemplates > 0;
      },
    },
  ],
};