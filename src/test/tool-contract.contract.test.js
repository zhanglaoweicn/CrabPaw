/**
 * 工具契约测试 — 防止 execute→handler 类回归与契约字段缺失
 *
 * 背景：document-tools/email-tools/platform-api-tools 曾误用 `execute` 作为 handler
 * 字段名，导致 registry.execute() 调用 `tool.handler(...)` 时 handler 为 undefined，
 * 工具完全不可用。本测试对每个已注册工具做硬性契约校验，杜绝此类回归。
 *
 * 硬断言（失败即阻断）：
 *   - name: 非空字符串
 *   - handler: 可调用函数（核心 —— 拦截 execute 误用）
 *   - schema: 存在且为对象
 *
 * 软度量（汇总报告，不阻断）：
 *   - description / whenNotToUse / riskLevel 完备率
 */

describe('工具契约（所有已注册工具必须满足）', () => {
  let registry;
  let toolNames;

  // 同步加载：test.each 需在 describe 注册阶段拿到数组，不能放在 beforeAll
  process.env.NODE_ENV = 'test';
  registry = require('../tools/registry').registry;
  require('../tools');
  toolNames = registry.getNames();

  test('工具注册表应非空', () => {
    expect(toolNames.length).toBeGreaterThan(0);
  });

  describe('硬契约：每个工具必须有可调用的 handler', () => {
    // 动态生成用例，任一工具 handler 缺失即失败
    test.each(toolNames)('工具 %s 的 handler 必须是函数', (name) => {
      const tool = registry.get(name);
      expect(tool).toBeTruthy();
      expect(typeof tool.handler).toBe('function');
    });
  });

  describe('硬契约：每个工具必须有合法 name 与 schema', () => {
    test.each(toolNames)('工具 %s 必须有非空 name 与对象 schema', (name) => {
      const tool = registry.get(name);
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.schema).toBeTruthy();
      expect(typeof tool.schema).toBe('object');
    });
  });

  describe('硬契约：execute 误用回归检测', () => {
    // 防止未来新增工具再次误用 execute 字段：registry 已内置自动映射兜底，
    // 但此处额外断言没有工具的 entry 上残留 execute 字段（说明走了兜底路径）。
    test('没有工具应携带 execute 字段（应统一为 handler）', () => {
      const offenders = toolNames.filter((n) => registry.get(n).execute !== undefined);
      expect(offenders).toEqual([]);
    });
  });

  describe('契约完备性度量（软报告）', () => {
    test('应输出 description / whenNotToUse / riskLevel 覆盖率', () => {
      const stats = { total: toolNames.length, withDesc: 0, withWntu: 0, withRisk: 0, missing: [] };
      for (const name of toolNames) {
        const t = registry.get(name);
        const hasDesc = !!(t.description && t.description.length > 0);
        const hasWntu = !!(Array.isArray(t.whenNotToUse) && t.whenNotToUse.length > 0);
        const hasRisk = !!t.riskLevel;
        if (hasDesc) stats.withDesc++;
        if (hasWntu) stats.withWntu++;
        if (hasRisk) stats.withRisk++;
        if (!hasWntu) stats.missing.push(name);
      }
      // 仅打印覆盖率，不阻断 —— 作为技术债务追踪
      const pct = (n) => ((n / stats.total) * 100).toFixed(1) + '%';
      console.log(
        `\n[工具契约覆盖率] total=${stats.total} ` +
          `description=${pct(stats.withDesc)} whenNotToUse=${pct(stats.withWntu)} riskLevel=${pct(stats.withRisk)}\n` +
          `缺失 whenNotToUse 的工具 (${stats.missing.length}): ${stats.missing.join(', ') || '无'}`
      );
      // riskLevel 必须全部具备（registry 已自动派生，不应缺失）
      expect(stats.withRisk).toBe(stats.total);
    });
  });

  describe('高风险工具契约强化', () => {
    test('isDangerous=true 的工具 riskLevel 必须为 high', () => {
      for (const name of toolNames) {
        const t = registry.get(name);
        if (t.isDangerous) {
          expect(t.riskLevel).toBe('high');
        }
      }
    });
  });
});

// 2026-08-15 P1-2: 动态契约注册不再静默放行 —— 编译失败必须落日志并显式标记 invalid
describe('动态契约注册(P1-2)', () => {
  const { registerToolContract, getToolContract } = require('../core/tool-contract');

  test('schema 编译失败时: 落日志 + 标记 invalid + 校验放行(与既有处理对齐)', () => {
    const origError = console.error;
    let logged = '';
    console.error = (...args) => { logged += args.join(' '); };
    try {
      registerToolContract('BrokenDynamicContract', {
        description: 'broken schema test',
        whenNotToUse: [],
        schema: { type: 'not-a-real-type' },
        maxTimeout: 1000,
        riskLevel: 'low',
        validate: null,
      });
    } finally {
      console.error = origError;
    }
    const c = getToolContract('BrokenDynamicContract');
    expect(c).toBeTruthy();
    expect(c.invalid).toBe(true);
    expect(typeof c.invalidReason).toBe('string');
    expect(c.validate({ anything: true })).toBe(true); // 放行(与 :1124 既有处理一致),不抛
    expect(logged).toContain('BrokenDynamicContract');
  });

  test('正常 schema 注册后 invalid 未标记且校验生效', () => {
    registerToolContract('HealthyDynamicContract', {
      description: 'healthy schema',
      whenNotToUse: [],
      schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      maxTimeout: 1000,
      riskLevel: 'low',
      validate: null,
    });
    const c = getToolContract('HealthyDynamicContract');
    expect(c.invalid).toBeFalsy();
    expect(c.validate({ name: 'ok' })).toBe(true);
    expect(c.validate({})).toBe(false);
  });
});
