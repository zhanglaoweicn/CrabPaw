/**
 * ToolRegistry Runtime 加固测试——A1/C1/A2(Runtime差距分析实施)
 * 覆盖: 契约 maxTimeout 成为权威上限、riskLevel=high 强制审批(selfApproval 豁免)、
 *       权限系统故障 fail-closed。
 */

const { ToolRegistry } = require('./registry');
const { registerToolContract, TOOL_CONTRACTS } = require('../core/tool-contract');
const { permissionSystem } = require('./permissions');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('A1: 契约 maxTimeout 接线', () => {
  const NAME = 'TestSlowToolA1';

  afterAll(() => {
    delete TOOL_CONTRACTS[NAME];
  });

  test('生效超时 = min(条目 timeout, 契约 maxTimeout)', async () => {
    registerToolContract(NAME, {
      description: 'test slow tool',
      schema: { type: 'object', properties: {}, additionalProperties: true },
      maxTimeout: 80,
      riskLevel: 'low',
    });
    const registry = new ToolRegistry();
    registry.register({
      name: NAME,
      schema: { type: 'object', properties: {} },
      timeout: 60000, // 条目超时远大于契约上限
      handler: async () => { await sleep(500); return 'never'; },
    });
    const result = await registry.execute(NAME, {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('超时');
    expect(result.error).toContain('80ms');
  });

  test('契约无 maxTimeout 时按条目 timeout 执行(向后兼容)', async () => {
    const NAME2 = 'TestNormalToolA1';
    registerToolContract(NAME2, {
      description: 'test normal tool',
      schema: { type: 'object', properties: {}, additionalProperties: true },
      riskLevel: 'low',
    });
    try {
      const registry = new ToolRegistry();
      registry.register({
        name: NAME2,
        schema: { type: 'object', properties: {} },
        timeout: 3000,
        handler: async () => 'ok',
      });
      const result = await registry.execute(NAME2, {});
      expect(result.success).toBe(true);
      expect(result.data).toBe('ok');
    } finally {
      delete TOOL_CONTRACTS[NAME2];
    }
  });
});

describe('C1: riskLevel=high 强制审批', () => {
  const ORIG_WAIT = process.env.APPROVAL_WAIT_MS;

  afterAll(() => {
    if (ORIG_WAIT === undefined) delete process.env.APPROVAL_WAIT_MS;
    else process.env.APPROVAL_WAIT_MS = ORIG_WAIT;
    delete TOOL_CONTRACTS['TestHighRiskC1'];
    delete TOOL_CONTRACTS['TestSelfApprovalC1'];
  });

  test('高风险工具执行前触发审批,无人响应时拒绝', async () => {
    process.env.APPROVAL_WAIT_MS = '150'; // 缩短等待,超时自动拒绝
    registerToolContract('TestHighRiskC1', {
      description: 'test high risk tool',
      schema: { type: 'object', properties: {}, additionalProperties: true },
      riskLevel: 'high',
    });
    const registry = new ToolRegistry();
    // 风险门挂在 setPolicyManager 注册的策略钩子内(与权限 deny/ask 同管线,
    // deny 规则优先于审批弹窗)——测试须与生产一致接线
    registry.setPolicyManager(permissionSystem);
    let executed = false;
    registry.register({
      name: 'TestHighRiskC1',
      schema: { type: 'object', properties: {} },
      riskLevel: 'high',
      handler: async () => { executed = true; return 'ok'; },
    });
    const result = await registry.execute('TestHighRiskC1', {});
    expect(result.blocked).toBe(true);
    expect(executed).toBe(false);
  }, 15000);

  test('selfApproval 高风险工具豁免 registry 层审批', async () => {
    registerToolContract('TestSelfApprovalC1', {
      description: 'test self approval tool',
      schema: { type: 'object', properties: {}, additionalProperties: true },
      riskLevel: 'high',
    });
    const registry = new ToolRegistry();
    registry.setPolicyManager(permissionSystem);
    registry.register({
      name: 'TestSelfApprovalC1',
      schema: { type: 'object', properties: {} },
      riskLevel: 'high',
      selfApproval: true,
      handler: async () => 'ok',
    });
    const result = await registry.execute('TestSelfApprovalC1', {});
    expect(result.success).toBe(true);
    expect(result.data).toBe('ok');
  });
});

describe('A2: 权限系统故障 fail-closed', () => {
  test('checkPermission 抛错时拒绝而非放行', async () => {
    const orig = permissionSystem.checkPermission;
    permissionSystem.checkPermission = () => { throw new Error('permission system boom'); };
    try {
      const decision = await permissionSystem.isToolAllowed('Read', 'fs', { input: {} });
      expect(decision.allowed).toBe(false);
      expect(String(decision.reason)).toContain('权限策略系统异常');
    } finally {
      permissionSystem.checkPermission = orig;
    }
  });
});
