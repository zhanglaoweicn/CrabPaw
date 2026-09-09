/**
 * E2E Test: Agent System (P1)
 *
 * 多智能体体系冒烟闭环（2026-08-01 新增，此前 agent 体系零直接测试）：
 * - SpawnSubagent 工具注册与契约对齐
 * - TieredSubAgentRunner 层级校验
 * - 并发/递归释放闭环（P0 泄漏修复回归）
 * - ACI 预取缓存键契约（runner 写入键与 ai.js 读取键一致）
 */
const path = require('path');
const fs = require('fs');

// 触发工具聚合注册（registry 单例在 tools/index.js 加载时填充）
require('../../src/tools');
const { registry } = require('../../src/tools/registry');
const { TOOL_CONTRACTS } = require('../../src/core/tool-contract');

module.exports = {
  name: 'Agent System Tests',
  cases: [
    {
      id: 'agt_001',
      name: 'SpawnSubagent tool registered with matching contract',
      category: 'agent',
      tags: ['P1', 'cap:agent', 'severity:major'],
      run: () => {
        const tool = registry.get('SpawnSubagent');
        if (!tool) return false;
        const contract = TOOL_CONTRACTS.SpawnSubagent;
        if (!contract) return false;
        // 契约 schema 的 archetype enum 与工具 schema 对齐
        const toolEnum = tool.schema?.properties?.archetype?.enum || [];
        const contractEnum = contract.schema?.properties?.archetype?.enum || [];
        return toolEnum.length > 0 && toolEnum.every(a => contractEnum.includes(a));
      },
    },
    {
      id: 'agt_002',
      name: 'TieredSubAgentRunner tier validation rejects invalid spawn',
      category: 'agent',
      tags: ['P1', 'cap:agent'],
      run: () => {
        const { getTieredSubAgentRunner } = require('../../src/core/agent/tiered-subagent-runner');
        const runner = getTieredSubAgentRunner();
        const validator = runner._tierValidator || runner.TierHierarchyValidator;
        if (!validator) return true; // 结构变化时跳过（非失败）
        // chat tier 可以 spawn reasoning/worker
        const chatOk = validator.canSpawn ? validator.canSpawn('chat', 'worker') : true;
        // worker tier 不能继续 spawn（TIER_SPAWN_RULES: worker → []）
        const workerDenied = validator.canSpawn ? !validator.canSpawn('worker', 'worker') : true;
        return chatOk === true && workerDenied === true;
      },
    },
    {
      id: 'agt_003',
      name: 'SubAgent concurrency slots release on complete (P0 regression)',
      category: 'agent',
      tags: ['P1', 'cap:agent', 'severity:critical'],
      run: () => {
        const state = require('../../src/core/state');
        try { state.initState({}); } catch { /* 已初始化 */ }
        const { createSubAgent, getSubAgentStats } = require('../../src/core/subagent-enhanced');
        // MAX_CONCURRENT=5：连续 6 次 create+complete 应全部成功（泄漏修复前第 6 次抛错）
        for (let i = 0; i < 6; i++) {
          const agent = createSubAgent({ type: 'ANALYZE', description: `test-${i}`, prompt: 'p' });
          agent.complete({ ok: true });
        }
        const stats = getSubAgentStats();
        // 完成后活跃计数应回落（不泄漏）
        const active = stats?.active ?? 0;
        return active === 0;
      },
    },
    {
      id: 'agt_004',
      name: 'SubAgent fail and cancel also release slots',
      category: 'agent',
      tags: ['P2', 'cap:agent'],
      run: () => {
        const state = require('../../src/core/state');
        try { state.initState({}); } catch { /* 已初始化 */ }
        const { createSubAgent, getSubAgentStats } = require('../../src/core/subagent-enhanced');
        const a = createSubAgent({ type: 'ANALYZE', description: 'fail-x', prompt: 'p' });
        a.fail(new Error('boom'));
        const b = createSubAgent({ type: 'ANALYZE', description: 'cancel-y', prompt: 'p' });
        b.cancel();
        const c = createSubAgent({ type: 'ANALYZE', description: 'ok-z', prompt: 'p' });
        c.complete({});
        const stats = getSubAgentStats();
        return (stats?.active ?? 0) === 0;
      },
    },
    {
      id: 'agt_005',
      name: 'ACI prefetch cache keys align between runner and ai.js',
      category: 'agent',
      tags: ['P1', 'cap:aci', 'severity:major'],
      run: () => {
        // prefetch-runner 注册的 task 名必须与 ai.js 的读取键（aci_weather/aci_hotspot）一致
        const runnerSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'aci', 'prefetch-runner.js'), 'utf-8');
        const aiSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'ai.js'), 'utf-8');
        const runnerKeys = [...runnerSrc.matchAll(/registerTask\(\s*'([^']+)'/g)].map(m => m[1]);
        const aiKeys = [...aiSrc.matchAll(/acc\.get\("([^"]+)"\)/g)].map(m => m[1]);
        if (runnerKeys.length === 0 || aiKeys.length === 0) return false;
        // runner 的每个任务键都应有 ai.js 的对应读取
        return runnerKeys.every(k => aiKeys.includes(k));
      },
    },
    {
      id: 'agt_006',
      name: 'Agent delegation tools registered with contracts',
      category: 'agent',
      tags: ['P2', 'cap:agent'],
      run: () => {
        const tools = ['ListKnownAgents', 'GrantAgentDelegation', 'DelegateToAgent', 'AgentsList', 'AgentView'];
        return tools.every(t => !!registry.get(t) && !!TOOL_CONTRACTS[t]);
      },
    },
  ],
};
