/**
 * E2E Test: WorkflowEngine Condition Action (P1-1)
 */
const { WorkflowEngine } = require('../../src/core/workflow-engine');

module.exports = {
  name: 'WorkflowEngine Condition Tests',
  cases: [
    {
      id: 'cond_001',
      name: 'Condition true executes thenActions',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeCondition({
          condition: { type: 'simple', field: 'value', operator: 'eq', value: 100 },
          thenActions: [{ type: 'skill', skill: 'test', input: 'action=success' }],
          elseActions: [{ type: 'skill', skill: 'test', input: 'action=fail' }]
        }, { context: { value: 100 }, input: {} }, {});
        return result[0]?.result?.data?.input === 'action=success';
      },
    },
    {
      id: 'cond_002',
      name: 'Condition false executes elseActions',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeCondition({
          condition: { type: 'simple', field: 'value', operator: 'gt', value: 200 },
          thenActions: [{ type: 'skill', skill: 'test', input: 'action=wrong' }],
          elseActions: [{ type: 'skill', skill: 'test', input: 'action=correct' }]
        }, { context: { value: 50 }, input: {} }, {});
        return result[0]?.result?.data?.input === 'action=correct';
      },
    },
    {
      id: 'cond_003',
      name: 'Expression true returns branch=then',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeCondition({
          condition: { type: 'expression', expression: 'true' },
        }, { context: {}, input: {} }, {});
        return result.condition === true && result.branch === 'then';
      },
    },
    {
      id: 'cond_004',
      name: 'AND condition passes when both true',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeCondition({
          condition: { type: 'and', and: [
            { type: 'simple', field: 'a', operator: 'eq', value: 1 },
            { type: 'simple', field: 'b', operator: 'eq', value: 2 }
          ]},
          thenActions: [{ type: 'skill', skill: 'test', input: 'action=and_pass' }]
        }, { context: { a: 1, b: 2 }, input: {} }, {});
        return result[0]?.result?.data?.input === 'action=and_pass';
      },
    },
    {
      id: 'cond_005',
      name: 'OR condition passes when one true',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeCondition({
          condition: { type: 'or', or: [
            { type: 'simple', field: 'x', operator: 'eq', value: 999 },
            { type: 'simple', field: 'y', operator: 'eq', value: 1 }
          ]},
          thenActions: [{ type: 'skill', skill: 'test', input: 'action=or_pass' }]
        }, { context: { x: 0, y: 1 }, input: {} }, {});
        return result[0]?.result?.data?.input === 'action=or_pass';
      },
    },
  ],
};
