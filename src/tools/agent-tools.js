/**
 * Agent Tools — 列出和查看已注册/可生成的智能体
 *
 * AgentsList: 列出所有可用的智能体角色（内置 + 合成 + 工作区）
 * AgentView: 查看某个智能体的详细信息
 *
 * 解决了"Composed Agents 未暴露给 LLM"的问题——模型现在能看到
 * 50+ 种可用角色（7 内置 + ~40 合成），并调用 SpawnSubagent 使用它们。
 */

const { registry } = require('./registry');

function _getAllAgents() {
  try {
    const { getAgentRegistry } = require('../core/agent/agent-registry');
    const agentRegistry = getAgentRegistry();
    // 触发懒加载 composer，确保 composed agents 被同步
    // eslint-disable-next-line no-unused-vars
    const composer = agentRegistry.composer;
    return agentRegistry.listSpawnable();
  } catch (e) {
    return [];
  }
}

async function handleAgentsList(params, _context) {
  const { filter } = params;
  const all = _getAllAgents();

  let filtered = all;
  if (filter) {
    const q = filter.toLowerCase();
    filtered = all.filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.id || '').toLowerCase().includes(q) ||
      (a.description || '').toLowerCase().includes(q) ||
      (a.tier || '').toLowerCase().includes(q)
    );
  }

  // 按 tier 分组
  const byTier = {};
  for (const agent of filtered) {
    const tier = agent.tier || 'worker';
    if (!byTier[tier]) byTier[tier] = [];
    byTier[tier].push({
      id: agent.id,
      name: agent.name || agent.id,
      description: agent.description || '',
      emoji: agent.emoji || '🤖',
      tier,
      source: agent.source || 'builtin',
      model: agent.model || 'fast',
      maxIterations: agent.maxIterations || 10,
    });
  }

  // 构建响应
  const response = {
    success: true,
    total: filtered.length,
    available: all.length,
    byTier,
  };

  // 添加友好的使用说明
  if (params.help) {
    response.usage = '使用 SpawnSubagent({archetype: "agent_id", task: "..."}) 来委派任务给特定智能体。';
  }

  return response;
}

async function handleAgentView(params, _context) {
  const { agentId } = params;
  if (!agentId) return { success: false, error: '需要 agentId 参数' };

  const all = _getAllAgents();
  const agent = all.find(a => a.id === agentId);
  if (!agent) return { success: false, error: `未找到智能体: ${agentId}` };

  return {
    success: true,
    agent: {
      id: agent.id,
      name: agent.name || agent.id,
      description: agent.description || '',
      emoji: agent.emoji || '🤖',
      tier: agent.tier,
      source: agent.source,
      model: agent.model,
      maxIterations: agent.maxIterations,
      allowedTools: agent.allowedTools || [],
      disallowedTools: agent.disallowedTools || [],
      systemPrompt: agent.systemPrompt || agent.systemPromptSuffix || '',
      capabilityId: agent.capabilityId || null,
      domainId: agent.domainId || null,
    },
    usage: `调用方式: SpawnSubagent({ archetype: "${agentId}", task: "..." })`,
  };
}

registry.register({
  name: 'AgentsList',
  toolset: 'agent',
  category: 'interaction',
  description: '列出所有可用的智能体角色。内置 7 个通用角色（planner/researcher/code_executor/critic/summarizer/tools_agent/archivist），以及通过能力和领域自动合成的专业角色（如 "finance_researcher" = 财务调研员）。传 filter 参数按名称/描述筛选。传 help=true 查看使用说明。',
  schema: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: '按名称/ID/描述/层级筛选（选填）' },
      help: { type: 'boolean', description: '设为 true 返回使用说明' },
    },
  },
  handler: handleAgentsList,
  timeout: 5000,
  isReadOnly: true,
});

registry.register({
  name: 'AgentView',
  toolset: 'agent',
  category: 'interaction',
  description: '查看某个智能体的详细信息，包括可用工具、禁止工具、System Prompt 和适用场景。需要 agentId 参数，可以从 AgentsList 获取。',
  schema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: '智能体 ID（必填），如 "planner"、"finance_researcher"、"code_executor"' },
    },
    required: ['agentId'],
  },
  handler: handleAgentView,
  timeout: 5000,
  isReadOnly: true,
});

module.exports = { handleAgentsList, handleAgentView };
