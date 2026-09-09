const { WorkflowEngine } = require('../core/workflow-engine');

describe('WorkflowEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new WorkflowEngine();
  });

  describe('suggest', () => {
    test('should return step plan for skill actions', async () => {
      const plan = await engine.suggest({
        id: 'wf_test',
        actions: [
          { id: 'a1', type: 'skill', skill: 'deep-research', input: { topic: 'AI' } },
          { id: 'a2', type: 'tool', tool: 'WebSearch', input: { query: 'AI news' } },
        ],
      }, { topic: 'AI' }, {});

      expect(plan.workflowId).toBe('wf_test');
      expect(plan.steps.length).toBe(2);
      expect(plan.steps[0].skill).toBe('deep-research');
      expect(plan.steps[1].tool).toBe('WebSearch');
      expect(plan.sideEffects).toContain('skill:deep-research');
      expect(plan.sideEffects).toContain('tool:WebSearch');
    });

    test('should handle condition actions', async () => {
      const plan = await engine.suggest({
        id: 'wf_cond',
        actions: [{
          type: 'condition',
          condition: { type: 'simple', field: 'val', operator: 'eq', value: 1 },
          thenActions: [{ type: 'skill', skill: 'process-true' }],
          elseActions: [{ type: 'skill', skill: 'process-false' }],
        }],
      }, {}, { val: 1 });
 
      expect(plan.hasConditions).toBe(true);
      expect(plan.steps[0].expectedBranch).toBe('then');
      expect(plan.sideEffects).toContain('skill:process-true');
    });

    test('should handle loop actions', async () => {
      const plan = await engine.suggest({
        id: 'wf_loop',
        actions: [{
          type: 'loop',
          maxIterations: 5,
          actions: [{ type: 'skill', skill: 'iterate' }],
        }],
      }, {}, {});

      expect(plan.hasLoops).toBe(true);
      expect(plan.steps[0].maxIterations).toBe(5);
      expect(plan.steps[0].loopBody.length).toBe(1);
    });

    test('should handle parallel actions', async () => {
      const plan = await engine.suggest({
        id: 'wf_par',
        actions: [{
          type: 'parallel',
          actions: [
            { type: 'skill', skill: 'branch-a' },
            { type: 'skill', skill: 'branch-b' },
          ],
        }],
      }, {}, {});

      expect(plan.hasParallel).toBe(true);
      expect(plan.steps[0].branches).toBe(2);
      expect(plan.steps[0].substeps.length).toBe(2);
    });

    test('should return preConditionsMet: false when conditions fail', async () => {
      const plan = await engine.suggest({
        id: 'wf_fail',
        conditions: [{ type: 'simple', field: 'x', operator: 'eq', value: 10 }],
        actions: [{ type: 'skill', skill: 'test' }],
      }, {}, { x: 0 });

      expect(plan.preConditionsMet).toBe(false);
      expect(plan.steps.length).toBe(0);
    });

    test('should return empty plan for string workflow ID', async () => {
      const plan = await engine.suggest('wf_unresolved', {}, {});
      expect(plan.steps.length).toBe(0);
      expect(plan.note).toContain('unresolved');
    });

    test('should handle delay and transform actions', async () => {
      const plan = await engine.suggest({
        id: 'wf_misc',
        actions: [
          { type: 'delay', delay: 5000 },
          { type: 'transform', transform: 'upper_case' },
        ],
      }, {}, {});

      expect(plan.steps[0].type).toBe('delay');
      expect(plan.steps[0].delay).toBe(5000);
      expect(plan.steps[1].type).toBe('transform');
    });
  });

  // 2026-08-15 P2-6: matches ReDoS 防护 + 求值器收敛(P2-4)锁定
  describe('condition evaluation safety', () => {
    test('matches rejects patterns longer than 200 chars', () => {
      const pattern = 'a'.repeat(201);
      expect(engine._evaluateSimpleCondition(
        { field: 'val', operator: 'matches', value: pattern }, { val: 'a' }
      )).toBe(false);
    });

    test('matches rejects catastrophic nested quantifier patterns', () => {
      expect(engine._evaluateSimpleCondition(
        { field: 'val', operator: 'matches', value: '(a+)+$' }, { val: 'aaaaaa' }
      )).toBe(false);
      expect(engine._evaluateSimpleCondition(
        { field: 'val', operator: 'matches', value: '(.*)+' }, { val: 'aaaaaa' }
      )).toBe(false);
    });

    test('matches accepts normal patterns', () => {
      expect(engine._evaluateSimpleCondition(
        { field: 'val', operator: 'matches', value: '^doc' }, { val: 'document' }
      )).toBe(true);
      expect(engine._evaluateSimpleCondition(
        { field: 'val', operator: 'matches', value: '[0-9]{3}' }, { val: 'abc123' }
      )).toBe(true);
    });

    test('matches handles invalid regex safely (logs + false)', () => {
      expect(engine._evaluateSimpleCondition(
        { field: 'val', operator: 'matches', value: '(' }, { val: 'x' }
      )).toBe(false);
    });

    test('_safeEval delegates to consolidated safe-expression', () => {
      expect(engine._safeEval('a === 1 && b !== 2', { a: 1, b: 3 })).toBe(true);
      expect(engine._safeEval('a > 2', { a: 1 })).toBe(false);
      expect(engine._safeEval('!a', { a: false })).toBe(true);
      // 全局对象访问被拦截(求值器收敛后的安全基线)
      expect(engine._safeEval('process.exit', {})).toBe(false);
    });

    test('expression condition evaluates via consolidated evaluator', async () => {
      expect(await engine._evaluateCondition(
        { type: 'expression', expression: 'x === 10' }, { x: 10 }
      )).toBe(true);
      expect(await engine._evaluateCondition(
        { type: 'expression', expression: 'x === 10' }, { x: 0 }
      )).toBe(false);
    });
  });
});
