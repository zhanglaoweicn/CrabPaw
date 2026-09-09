/**
 * D1(Runtime差距分析实施): 子代理能力派生 × 契约校验 eval
 * 覆盖: 两套 runner 工具名体系派生、真实白名单全过契约、白名单漂移拦截。
 */

const { deriveSubagentCapabilities, TOOL_CAPABILITY_MAP } = require('../../src/core/agent/capability-map');
const { globalAgentContractValidator } = require('../../src/core/agent-contract-validator');

module.exports = {
  name: 'Capability Map',
  cases: [
    {
      id: 'capmap_001',
      name: '工具白名单派生能力(两套体系)',
      category: 'capability_map',
      run: () => {
        const enhanced = deriveSubagentCapabilities(['read', 'write', 'exec', 'web_search']);
        const legacy = deriveSubagentCapabilities(['read', 'grep', 'glob', 'bash']);
        return JSON.stringify(enhanced) === JSON.stringify(['file_read', 'file_write', 'code_execution', 'web_search'])
          && JSON.stringify(legacy) === JSON.stringify(['file_read', 'code_execution']);
      },
    },
    {
      id: 'capmap_002',
      name: '全部真实白名单派生路径通过契约校验',
      category: 'capability_map',
      run: () => {
        const cases = [
          ['implement', ['read', 'write', 'grep', 'glob', 'bash', 'str_replace']],
          ['implement', ['read', 'write', 'edit', 'exec', 'web_search']],
          ['research', ['read', 'grep', 'glob', 'web_search', 'web_fetch']],
          ['research', ['read', 'web_search', 'web_fetch', 'memory_search']],
          ['verify', ['read', 'grep', 'glob', 'bash']],
          ['verify', ['read', 'exec', 'web_search']],
          ['analyze', ['read', 'grep', 'glob']],
          ['analyze', ['read', 'web_search', 'memory_search']],
          ['coordinator', ['read', 'sessions_spawn', 'sessions_send']],
          ['worker', ['read', 'write', 'edit', 'exec']],
        ];
        return cases.every(([type, tools]) => {
          const v = globalAgentContractValidator.validateSpawn(type, {
            capabilities: deriveSubagentCapabilities(tools),
            tools,
          }, {});
          return v.valid;
        });
      },
    },
    {
      id: 'capmap_003',
      name: '白名单漂移被 Missing capability 拦截',
      category: 'capability_map',
      run: () => {
        // implement 缺失 exec → 无 code_execution 能力 → 契约必须拦截
        const v = globalAgentContractValidator.validateSpawn('implement', {
          capabilities: deriveSubagentCapabilities(['read', 'write']),
          tools: ['read', 'write'],
        }, {});
        return !v.valid && v.errors.some((e) => e.includes('Missing capability'));
      },
    },
    {
      id: 'capmap_004',
      name: 'requiredCapabilities 已回填(六个真实类型非空)',
      category: 'capability_map',
      run: () => {
        const contracts = globalAgentContractValidator.getContracts();
        return ['research', 'implement', 'verify', 'analyze', 'coordinator', 'worker']
          .every((t) => Array.isArray(contracts[t].requiredCapabilities) && contracts[t].requiredCapabilities.length > 0);
      },
    },
    {
      id: 'capmap_005',
      name: '关键工具全部有能力映射',
      category: 'capability_map',
      run: () => {
        return ['read', 'write', 'edit', 'exec', 'bash', 'grep', 'glob', 'web_search',
          'web_fetch', 'memory_search', 'sessions_spawn', 'sessions_send']
          .every((t) => typeof TOOL_CAPABILITY_MAP[t] === 'string');
      },
    },
  ],
};
