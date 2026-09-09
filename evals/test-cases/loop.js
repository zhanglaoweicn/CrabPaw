/**
 * E2E Test: WorkflowEngine Loop Action (P1-1)
 */
const { WorkflowEngine } = require('../../src/core/workflow-engine');

module.exports = {
  name: 'WorkflowEngine Loop Tests',
  cases: [
    {
      id: 'loop_001',
      name: 'Loop iterates maxIterations times',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeLoop({
          maxIterations: 3,
          actions: [{ type: 'skill', skill: 'test', input: 'action=iter' }]
        }, { context: {}, input: {} }, {});
        return result.loop === true && result.iterations === 3;
      },
    },
    {
      id: 'loop_002',
      name: 'Loop breaks on breakCondition',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeLoop({
          maxIterations: 10,
          breakCondition: { type: 'simple', field: '_loopIteration', operator: 'gte', value: 2 },
          actions: [{ type: 'skill', skill: 'test', input: 'action=break_early' }]
        }, { context: {}, input: {} }, {});
        return result.iterations === 2;
      },
    },
    {
      id: 'loop_003',
      name: 'Default maxIterations caps at 10',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeLoop({
          breakCondition: { type: 'simple', field: 'index', operator: 'gte', value: 1 },
          actions: [{ type: 'skill', skill: 'test', input: 'action=default_max' }]
        }, { context: {}, input: {} }, {});
        return result.iterations <= 10;
      },
    },
    {
      id: 'loop_004',
      name: 'Loop results collected as array',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeLoop({
          maxIterations: 2,
          actions: [{ type: 'skill', skill: 'test', input: 'action=collect' }]
        }, { context: {}, input: {} }, {});
        return Array.isArray(result.results) && result.results.length === 2;
      },
    },
    {
      id: 'loop_005',
      name: 'Minimal loop returns loop=true',
      category: 'workflow',
      run: async () => {
        const engine = new WorkflowEngine();
        const result = await engine._executeLoop({
          maxIterations: 2,
          breakCondition: { type: 'simple', field: 'index', operator: 'gte', value: 1 },
        }, { context: {}, input: {} }, {});
        return result.loop === true;
      },
    },
  ],
};
