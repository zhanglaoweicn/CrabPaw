/**
 * ToolEvolution Tool — 工具自愈/自生成工具
 *
 * Browser Harness 启发: Agent 在任务中途发现能力缺口 → 自己写工具 → 立即使用
 *
 * 提供三个 action:
 *   generateTemplate  — 生成符合 CrabPaw Harness 规范的工具契约模板
 *   registerTool      — 注册 Agent 创作的工具（进入观察期）
 *   listAuthoredTools — 列出所有 Agent 创作的工具
 */

const { registry } = require('./registry');
const { getToolEvolutionBridge } = require('../core/tool-evolution-bridge');

async function handleToolEvolution(params, context) {
  const bridge = getToolEvolutionBridge();
  const { action } = params;

  switch (action) {
    case 'generateTemplate': {
      // 生成工具契约模板，Agent 填充后即可注册
      const { name, description, schema } = params;
      if (!name || !description) {
        return { success: false, error: 'generateTemplate 需要 name 和 description 参数' };
      }
      const template = bridge.generateContractTemplate(name, description, schema || null);
      return {
        success: true,
        data: {
          template,
          nextSteps: [
            '1. 审查生成的模板，确认 schema 和 riskLevel 是否正确',
            '2. 如果需要修改，直接编辑 schema 字段',
            '3. 使用 registerTool action 注册此工具',
            '4. 注册后立即可用，无需重启',
          ],
          _hint: `已生成工具 '${template.name}' 的契约模板。审查后使用 registerTool 注册。`,
        },
      };
    }

    case 'registerTool': {
      // 注册 Agent 创作的工具
      const { contract, sessionId, taskDescription } = params;
      if (!contract || !contract.name) {
        return { success: false, error: 'registerTool 需要 contract 参数，且 contract 必须包含 name 字段' };
      }

      // 验证契约完整性
      if (!contract.schema) {
        return { success: false, error: 'contract 必须包含 schema 字段' };
      }
      if (!contract.description) {
        return { success: false, error: 'contract 必须包含 description 字段' };
      }

      const result = bridge.registerAgentAuthoredTool(contract.name, contract, {
        sessionId: sessionId || context?.sessionId,
        taskDescription: taskDescription || 'Agent-authored via ToolEvolution',
      });

      return {
        success: true,
        data: {
          ...result,
          _hint: result.registered
            ? `✅ 工具 '${contract.name}' 已注册（状态: observing）。现在可以立即调用此工具了。`
            : `工具 '${contract.name}' 注册失败。`,
        },
      };
    }

    case 'listAuthoredTools': {
      const tools = bridge.getAgentAuthoredTools();
      return {
        success: true,
        data: {
          tools,
          count: tools.length,
          _hint: tools.length === 0
            ? '暂无 Agent 创作的工具。当 Agent 在任务中创建新工具后，会出现在这里。'
            : `${tools.length} 个 Agent 创作的工具。`,
        },
      };
    }

    default:
      return { success: false, error: `未知 action: ${action}。可用: generateTemplate, registerTool, listAuthoredTools` };
  }
}

registry.register({
  name: 'ToolEvolution',
  toolset: 'harness',
  category: 'harness',
  description: 'Tool self-healing and self-generation — generate contract templates for missing tools, register agent-authored tools at runtime. Use when the task needs a tool that does not exist yet.',
  schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['generateTemplate', 'registerTool', 'listAuthoredTools'],
        description: 'generateTemplate: create a contract template for a new tool. registerTool: register an agent-authored tool. listAuthoredTools: list all agent-authored tools.',
      },
      name: { type: 'string', description: 'Tool name (for generateTemplate)' },
      description: { type: 'string', description: 'Tool description (for generateTemplate)' },
      schema: { type: 'object', description: 'JSON Schema override (optional, for generateTemplate)' },
      contract: { type: 'object', description: 'Full contract object (for registerTool)' },
      sessionId: { type: 'string', description: 'Session ID for provenance tracking' },
      taskDescription: { type: 'string', description: 'Task description for provenance tracking' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler: handleToolEvolution,
  isDangerous: false,
  isReadOnly: false,
  timeout: 30000,
});

module.exports = { handleToolEvolution };
