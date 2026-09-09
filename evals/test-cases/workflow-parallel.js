/**
 * E2E Test: WorkflowEngine PARALLEL 容错 (P1)
 *
 * Verifies _executeParallel allSettled rewrite:
 * - Failed branches do not discard successful branch results (wp_001)
 * - All-success preserves order and status (wp_002)
 * - Empty branch array returns empty without throwing (wp_003)
 */
const { WorkflowEngine } = require('../../src/core/workflow-engine');

module.exports = {
  name: 'Workflow Parallel',
  cases: [
    {
      id: 'wp_001',
      name: '并行分支一败一胜：成功分支结果保留',
      category: 'workflow_parallel',
      run: async () => {
        const engine = new WorkflowEngine();
        // Use delay (always succeeds) + skill with throwing executor (rejected branch).
        // wp_001 semantic: failed branch must NOT swallow successful branch.
        const context = {
          skillExecutor: (skillName) => {
            if (skillName === '__throw_test__') {
              throw new Error('SIMULATED_BRANCH_FAILURE');
            }
            return { ok: true, skill: skillName };
          },
        };
        const results = await engine._executeParallel(
          [
            { type: 'delay', delay: 10 },
            { type: 'skill', skill: '__throw_test__' },
          ],
          { id: 'wf_eval_1' },
          context,
        );
        // After allSettled rewrite: results is array of { status, value/reason }
        return (
          Array.isArray(results) &&
          results.length === 2 &&
          results.some((r) => r && r.status === 'fulfilled') &&
          results.some((r) => r && r.status === 'rejected') &&
          results.find((r) => r.status === 'rejected')?.reason === 'SIMULATED_BRANCH_FAILURE'
        );
      },
    },
    {
      id: 'wp_002',
      name: '全成功时结果与顺序保持',
      category: 'workflow_parallel',
      run: async () => {
        const engine = new WorkflowEngine();
        const results = await engine._executeParallel(
          [
            { type: 'delay', delay: 10 },
            { type: 'delay', delay: 20 },
          ],
          { id: 'wf_eval_2' },
          {},
        );
        return (
          Array.isArray(results) &&
          results.length === 2 &&
          results.every((r) => r && r.status === 'fulfilled') &&
          results[0]?.value?.delayed === 10 &&
          results[1]?.value?.delayed === 20
        );
      },
    },
    {
      id: 'wp_003',
      name: '空分支数组返回空不崩溃',
      category: 'workflow_parallel',
      run: async () => {
        const engine = new WorkflowEngine();
        const results = await engine._executeParallel([], { id: 'wf_eval_3' }, {});
        return Array.isArray(results) && results.length === 0;
      },
    },
  ],
};
