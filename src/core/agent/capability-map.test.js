/**
 * capability-map + agent-contract-validator 集成测试——D1(Runtime差距分析实施)
 * 覆盖: 工具白名单→能力派生、两条 spawn 链真实白名单全部过契约、
 *       白名单漂移(缺失关键工具)被 Missing capability 拦截。
 */

const { deriveSubagentCapabilities, TOOL_CAPABILITY_MAP } = require('./capability-map');
const { globalAgentContractValidator } = require('../agent-contract-validator');

describe('deriveSubagentCapabilities', () => {
  test('两套 runner 工具名体系都映射正确', () => {
    expect(deriveSubagentCapabilities(['read', 'write', 'exec']))
      .toEqual(['file_read', 'file_write', 'code_execution']);
    expect(deriveSubagentCapabilities(['read', 'grep', 'glob']))
      .toEqual(['file_read']);
    expect(deriveSubagentCapabilities(['read', 'sessions_spawn', 'sessions_send']))
      .toEqual(['file_read', 'subagent_spawn']);
    expect(deriveSubagentCapabilities(['bash'])).toEqual(['code_execution']);
    expect(deriveSubagentCapabilities(['str_replace'])).toEqual(['file_write']);
  });

  test('去重且保持首现顺序; 空输入安全', () => {
    expect(deriveSubagentCapabilities(['exec', 'read', 'bash']))
      .toEqual(['code_execution', 'file_read']);
    expect(deriveSubagentCapabilities([])).toEqual([]);
    expect(deriveSubagentCapabilities(undefined)).toEqual([]);
  });

  test('映射表覆盖两套白名单的全部工具名(防新增工具漏映射)', () => {
    // 任一未映射工具不报错但也不产生能力——这里仅校验已知关键工具全部在表中
    for (const tool of ['read', 'write', 'edit', 'exec', 'bash', 'grep', 'glob', 'web_search', 'web_fetch', 'memory_search', 'sessions_spawn', 'sessions_send']) {
      expect(TOOL_CAPABILITY_MAP[tool]).toBeDefined();
    }
  });
});

describe('agent-contract-validator × capability-map 集成', () => {
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

  test.each(cases)('%s 真实白名单派生能力通过契约校验', (type, tools) => {
    const caps = deriveSubagentCapabilities(tools);
    const v = globalAgentContractValidator.validateSpawn(type, { capabilities: caps, tools }, {});
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
  });

  test('工具集漂移被拦截(移除关键工具 → Missing capability)', () => {
    // implement 缺失 exec(无 code_execution 能力) → enforce 应失败
    const caps = deriveSubagentCapabilities(['read', 'write']);
    const v = globalAgentContractValidator.validateSpawn('implement', { capabilities: caps, tools: ['read', 'write'] }, {});
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes('Missing capability'))).toBe(true);
  });

  test('requiredCapabilities 已回填(非空)', () => {
    const contracts = globalAgentContractValidator.getContracts();
    for (const type of ['research', 'implement', 'verify', 'analyze', 'coordinator', 'worker']) {
      expect(contracts[type].requiredCapabilities.length).toBeGreaterThan(0);
    }
  });
});
