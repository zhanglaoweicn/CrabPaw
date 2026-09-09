const { ToolOrchestrator, NODE_TYPES } = require("../../src/core/tool-orchestrator");

module.exports = {
  name: "Tool Orchestrator",
  cases: [
    {
      id: "to_001",
      name: "ToolOrchestrator creates with default templates",
      category: "tool_orchestrator",
      run: () => {
        const to = new ToolOrchestrator();
        return to.templates !== null && typeof to.templates === 'object' && Object.keys(to.templates).length > 0;
      },
    },
    {
      id: "to_002",
      name: "ToolOrchestrator has wecomWorkflow template",
      category: "tool_orchestrator",
      run: () => {
        const to = new ToolOrchestrator();
        return to.templates.wecomWorkflow?.name === '企业微信工作流';
      },
    },
    {
      id: "to_003",
      name: "ToolOrchestrator has research template",
      category: "tool_orchestrator",
      run: () => {
        const to = new ToolOrchestrator();
        return to.templates.research?.nodes?.length > 0;
      },
    },
    {
      id: "to_004",
      name: "NODE_TYPES defines expected types",
      category: "tool_orchestrator",
      run: () => {
        return NODE_TYPES.TOOL === 'tool'
          && NODE_TYPES.PARALLEL === 'parallel'
          && NODE_TYPES.CONDITION === 'condition'
          && NODE_TYPES.MERGE === 'merge';
      },
    },
    {
      id: "to_005",
      name: "createPipeline creates valid pipeline",
      category: "tool_orchestrator",
      run: () => {
        const to = new ToolOrchestrator();
        const pipeline = to.createPipeline({
          name: 'test',
          nodes: [{ id: 'n1', type: 'tool', tool: 'noop' }],
        }, {});
        return pipeline !== null && pipeline.id.startsWith('pipeline_');
      },
    },
    {
      id: "to_006",
      name: "CONDITION node executes branches keyed by resolved template value",
      category: "tool_orchestrator",
      run: async () => {
        // 2026-08-15 P2-5: 内置模板 conditionalRoute/resilientPipeline 用 branches
        // (键=条件值),执行器此前只读 onTrue/onFalse → 分支永不执行。
        const to = new ToolOrchestrator();
        to.toolRegistry = {
          registry: {
            execute: async (_name, input) => ({ success: true, data: 'hit-' + (input && input.tag ? input.tag : 'none') }),
          },
        };
        const pipeline = to.createPipeline({
          name: 'cond-branches',
          nodes: [{
            id: 'route',
            type: NODE_TYPES.CONDITION,
            condition: '{{src.result}}',
            depends: [],
            branches: {
              yes: [{ id: 'hit', type: NODE_TYPES.TOOL, tool: 'Mock', input: { tag: '{{src.result}}' } }],
              no: [{ id: 'miss', type: NODE_TYPES.TOOL, tool: 'Mock', input: { tag: 'miss' } }],
            },
          }],
        }, {});
        pipeline.results['src'] = 'yes';
        await to.executeNode(pipeline, pipeline.nodes[0]);
        return pipeline.results['hit'] === 'hit-yes' && pipeline.results['miss'] === undefined;
      },
    },
    {
      id: "to_007",
      name: "CONDITION node keeps legacy onTrue/onFalse boolean branch support",
      category: "tool_orchestrator",
      run: async () => {
        const to = new ToolOrchestrator();
        to.toolRegistry = {
          registry: {
            execute: async (_name, input) => ({ success: true, data: 'legacy-' + (input && input.tag ? input.tag : 'none') }),
          },
        };
        const pipeline = to.createPipeline({
          name: 'cond-legacy',
          nodes: [{
            id: 'check',
            type: NODE_TYPES.CONDITION,
            condition: 'results.src === true',
            depends: [],
            onTrue: { id: 'ok', type: NODE_TYPES.TOOL, tool: 'Mock', input: { tag: 'go' } },
            onFalse: { id: 'no', type: NODE_TYPES.TOOL, tool: 'Mock', input: { tag: 'stop' } },
          }],
        }, {});
        pipeline.results['src'] = true;
        await to.executeNode(pipeline, pipeline.nodes[0]);
        return pipeline.results['ok'] === 'legacy-go' && pipeline.results['no'] === undefined;
      },
    },
  ],
};
