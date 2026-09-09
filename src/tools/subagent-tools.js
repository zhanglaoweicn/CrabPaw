/**
 * SpawnSubagent Tool — 子智能体委派工具
 *
 * 让主 Agent 在对话中将子任务委派给专业子智能体：
 *   planner      → 复杂任务分解
 *   researcher   → 信息搜索和引用追踪
 *   code_executor → 代码编写/运行/调试
 *   critic       → 代码审查和质量检查
 *   summarizer   → 压缩超大输出结果
 *   tools_agent  → 使用内置工具完成临时任务
 *
 * revfactory/harness 启发: 6 种团队协作模式 → Planner→Researcher→Executor→Critic Pipeline
 */

const { registry } = require('./registry');
const { getTieredSubAgentRunner, AGENT_TIERS } = require('../core/agent/tiered-subagent-runner');
const { broadcastEvent } = require('../core/sse-broadcast');

const VALID_ARCHETYPES = [
  'planner', 'researcher', 'code_executor', 'critic',
  'summarizer', 'tools_agent', 'archivist',
];

async function handleSubagent(params, _context) {
  // eslint-disable-next-line no-unused-vars -- action 为兼容旧参数保留，SpawnSubagent 以 archetype+task 驱动
  const { action, task, archetype } = params;

  // 参数校验
  if (!archetype) {
    return { success: false, error: '缺少 archetype 参数。可用: ' + VALID_ARCHETYPES.join(', ') };
  }
  if (!VALID_ARCHETYPES.includes(archetype)) {
    return { success: false, error: `未知子智能体类型: ${archetype}。可用: ${VALID_ARCHETYPES.join(', ')}` };
  }
  if (!task || typeof task !== 'string' || !task.trim()) {
    return { success: false, error: 'task 参数不能为空' };
  }

  const runner = getTieredSubAgentRunner();

  // SSE 广播：子智能体启动
  broadcastEvent('subagent:start', {
    archetype,
    task: task.slice(0, 100),
    timestamp: Date.now(),
  });

  const startTime = Date.now();

  try {
    const result = await runner.spawnSubAgent(archetype, {
      task,
      parentTier: AGENT_TIERS.CHAT,
      depth: 0,
      background: false,
    });

    const duration = Date.now() - startTime;

    // SSE 广播：子智能体完成
    broadcastEvent('subagent:end', {
      archetype,
      success: result.status === 'completed',
      duration,
      timestamp: Date.now(),
    });

    if (result.status === 'completed') {
      const output = typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result, null, 2);

      return {
        success: true,
        data: {
          archetype,
          task,
          output,
          duration,
          _hint: `${archetype} 子智能体已完成 (${(duration / 1000).toFixed(1)}s)。将结果整合到你的回复中，用自然语言告诉用户。`,
        },
      };
    }

    return {
      success: false,
      error: `${archetype} 子智能体未完成: ${result.error || result.status || '未知原因'}`,
      data: { archetype, task, duration },
    };
  } catch (e) {
    broadcastEvent('subagent:end', {
      archetype,
      success: false,
      error: e.message,
      duration: Date.now() - startTime,
      timestamp: Date.now(),
    });

    return {
      success: false,
      error: `子智能体执行失败: ${e.message}`,
      data: { archetype, task },
    };
  }
}

registry.register({
  name: 'SpawnSubagent',
  toolset: 'agent',
  category: 'agent',
  description: 'Delegate a subtask to a specialized sub-agent. Use when the task requires multi-step decomposition, deep research, code execution/review, or summarization. Available archetypes: planner (task decomposition), researcher (info search), code_executor (write/run/debug code), critic (code review), summarizer (compress large outputs), tools_agent (general tool use).',
  schema: {
    type: 'object',
    properties: {
      archetype: {
        type: 'string',
        enum: VALID_ARCHETYPES,
        description: 'planner: decompose complex tasks. researcher: search and find information. code_executor: write, run, debug code. critic: review code quality. summarizer: compress large outputs. tools_agent: general tool-based tasks.',
      },
      task: {
        type: 'string',
        minLength: 10,
        description: 'The specific subtask to delegate. Be precise — the sub-agent only sees this task description.',
      },
    },
    required: ['archetype', 'task'],
    additionalProperties: false,
  },
  handler: handleSubagent,
  isDangerous: false,
  isReadOnly: false,
  timeout: 180000,
});

module.exports = { handleSubagent };
