/**
 * Task 5: 子代理契约名与真实 spawn 类型对齐（维度 5 逻辑断裂）
 *
 * 背景: agent-contract-validator.registerDefaults 只注册 coder/researcher/planner/
 * analyst/communicator，而真实 spawn 类型是 subagent-enhanced.js SUBAGENT_TYPES 的
 * research/implement/verify/analyze/coordinator/worker —— 契约名与 spawn 类型错位，
 * 对真实类型的强校验全部退化为"无契约跳过"。
 */

const {
  globalAgentContractValidator,
  AgentContractValidator,
} = require('../core/agent-contract-validator');
const { deriveSubagentCapabilities } = require('../core/agent/capability-map');

const REAL_TYPES = ['research', 'implement', 'verify', 'analyze', 'coordinator', 'worker'];

// D1 后两条生产 spawn 链(subagent-enhanced / subagent)的真实工具白名单——
// capabilities 不再由调用方手工传入,而是从该类型工具白名单自动派生。
const TYPE_TOOL_SETS = {
  research: ['read', 'web_search', 'web_fetch', 'memory_search'],
  implement: ['read', 'write', 'edit', 'exec', 'web_search'],
  verify: ['read', 'exec', 'web_search'],
  analyze: ['read', 'web_search', 'memory_search'],
  coordinator: ['read', 'sessions_spawn', 'sessions_send'],
  worker: ['read', 'write', 'edit', 'exec'],
};

describe('子代理契约名与真实 spawn 类型对齐', () => {
  test.each(REAL_TYPES)('真实类型 "%s" 有契约且 validateSpawn 不再跳过', (t) => {
    const contracts = globalAgentContractValidator.getContracts();
    expect(contracts).toHaveProperty(t);

    // D1(Runtime差距分析): capabilities 从工具白名单派生后,requiredCapabilities
    // 已回填——带派生能力的 spec 必须通过;空能力 spec 被拦截(契约真实生效)。
    const ok = globalAgentContractValidator.validateSpawn(t, {
      capabilities: deriveSubagentCapabilities(TYPE_TOOL_SETS[t]),
      tools: TYPE_TOOL_SETS[t],
    }, {});
    expect(ok.valid).toBe(true);
    expect(ok.warnings.join(' ')).not.toMatch(/No contract/i);

    const empty = globalAgentContractValidator.validateSpawn(t, { capabilities: [] }, {});
    expect(empty.valid).toBe(false);
    expect(empty.errors.join(' ')).toMatch(/Missing capability/);
  });

  test.each(REAL_TYPES)('真实类型 "%s" 的契约校验真实生效（预算超限产生 warning 而非跳过）', (t) => {
    const contract = globalAgentContractValidator.getContracts()[t];
    expect(contract).toBeTruthy();

    const r = globalAgentContractValidator.validateSpawn(
      t,
      {
        capabilities: deriveSubagentCapabilities(TYPE_TOOL_SETS[t]),
        tools: TYPE_TOOL_SETS[t],
        budgetTokens: contract.maxBudgetTokens + 1,
      },
      {}
    );
    // 契约存在 = validateSpawn 走完整校验分支，预算超限必须被捕获为 warning
    expect(r.warnings.join(' ')).toMatch(/exceeds contract max/);
    expect(r.valid).toBe(true); // 预算超限是 warning 不是 error
  });

  test('旧契约名 coder/researcher/planner/analyst/communicator 保留（向后兼容）', () => {
    const contracts = globalAgentContractValidator.getContracts();
    for (const legacy of ['coder', 'researcher', 'planner', 'analyst', 'communicator']) {
      expect(contracts).toHaveProperty(legacy);
    }
  });

  test('validateSpawn 对未知类型仍 fail-open warning（既有语义不变）', () => {
    const r = globalAgentContractValidator.validateSpawn('nonexistent', {}, {});
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/No contract/i);
  });

  test('enforceSpawn 带派生能力不抛错; 空能力抛 Missing capability（D1 新契约）', () => {
    for (const t of REAL_TYPES) {
      expect(() =>
        globalAgentContractValidator.enforceSpawn(t, {
          capabilities: deriveSubagentCapabilities(TYPE_TOOL_SETS[t]),
          tools: TYPE_TOOL_SETS[t],
        }, {})
      ).not.toThrow();
      expect(() =>
        globalAgentContractValidator.enforceSpawn(t, { capabilities: [] }, {})
      ).toThrow(/Missing capability/);
    }
  });

  test('全新实例（防全局单例状态污染）registerDefaults 同样注册全部 11 个契约', () => {
    const v = new AgentContractValidator();
    v.registerDefaults();
    const contracts = v.getContracts();
    for (const t of [...REAL_TYPES, 'coder', 'researcher', 'planner', 'analyst', 'communicator']) {
      expect(contracts).toHaveProperty(t);
    }
  });
});
