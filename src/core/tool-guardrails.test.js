/**
 * RunGuardrails 单元测试——P1-① 单调守卫 + P1-③ 可见即记录(2026-09-03)
 * 对标 dsh 机制②④: 决策严重度只升不降、对象冻结不可变、阻断构造即落审计。
 */
const {
  ToolCallGuardrail,
  ToolGuardrailDecision,
  buildAuditedSyntheticResult,
  buildSyntheticResult,
} = require('./tool-guardrails');

describe('ToolGuardrailDecision 单调性(dsh 机制④)', () => {
  it('非法动作在构造期即拒绝', () => {
    expect(() => new ToolGuardrailDecision({ action: 'deny' })).toThrow(/非法守卫动作/);
    expect(() => new ToolGuardrailDecision({ action: 'allow' })).not.toThrow();
  });

  it('严重度语义不变: warn 放行, block/halt 阻断', () => {
    expect(new ToolGuardrailDecision({}).allowsExecution).toBe(true);
    expect(new ToolGuardrailDecision({ action: 'warn' }).allowsExecution).toBe(true);
    expect(new ToolGuardrailDecision({ action: 'warn' }).shouldHalt).toBe(false);
    expect(new ToolGuardrailDecision({ action: 'block' }).shouldHalt).toBe(true);
    expect(new ToolGuardrailDecision({ action: 'halt' }).allowsExecution).toBe(false);
  });

  it('决策对象冻结: 试图改写 action 不生效(阻断不可翻案)', () => {
    const d = new ToolGuardrailDecision({ action: 'block', code: 'b' });
    expect(Object.isFrozen(d)).toBe(true);
    try {
      d.action = 'allow';
    } catch (e) {
      // 严格模式下抛 TypeError, 同样属预期
    }
    expect(d.action).toBe('block');
  });

  it('escalateTo 只升不降: block 不可降为 allow/warn, 可升为 halt 并携带 patch', () => {
    const block = new ToolGuardrailDecision({ action: 'block', code: 'b', message: 'm', toolName: 'Bash', count: 3 });
    expect(block.escalateTo('allow')).toBe(block);
    expect(block.escalateTo('warn')).toBe(block);
    const up = block.escalateTo('halt', { code: 'halt_code', message: 'halted' });
    expect(up).not.toBe(block);
    expect(up.action).toBe('halt');
    expect(up.code).toBe('halt_code');
    expect(up.toolName).toBe('Bash');
  });

  it('combine 取最严: 多决策合并不降级, 空入参为 null', () => {
    const allow = new ToolGuardrailDecision({});
    const warn = new ToolGuardrailDecision({ action: 'warn' });
    const block = new ToolGuardrailDecision({ action: 'block' });
    const halt = new ToolGuardrailDecision({ action: 'halt' });
    expect(ToolGuardrailDecision.combine(allow, halt)).toBe(halt);
    expect(ToolGuardrailDecision.combine(null, block, allow, warn)).toBe(block);
    expect(ToolGuardrailDecision.combine(warn, warn)).toBe(warn);
    expect(ToolGuardrailDecision.combine()).toBeNull();
  });
});

describe('ToolCallGuardrail 引擎回归(单调存储后行为不变)', () => {
  const CFG = {
    hardStopEnabled: true,
    warningsEnabled: true,
    exactFailureWarnAfter: 1,
    exactFailureBlockAfter: 2,
    sameToolFailureWarnAfter: 3,
    sameToolFailureHaltAfter: 9,
    noProgressWarnAfter: 5,
    noProgressBlockAfter: 5,
  };

  it('相同参数连续失败 N 次后 beforeCall 阻断, 决策元数据完整', () => {
    const g = new ToolCallGuardrail(CFG);
    const first = g.beforeCall('Write', { file_path: '/tmp/a' });
    expect(first.action).toBe('allow');
    g.afterCall('Write', { file_path: '/tmp/a' }, { success: false }, true);
    g.afterCall('Write', { file_path: '/tmp/a' }, { success: false }, true);
    const decision = g.beforeCall('Write', { file_path: '/tmp/a' });
    expect(decision.action).toBe('block');
    expect(decision.code).toBe('repeated_exact_failure_block');
    expect(decision.shouldHalt).toBe(true);
    expect(g.isBlocked()).toBe(true);
    expect(g.getHaltDecision().action).toBe('block');
  });

  it('_haltDecision 单调存储: 后续更轻决策不会覆盖更重决策', () => {
    const g = new ToolCallGuardrail({ ...CFG, sameToolFailureHaltAfter: 2 });
    g.beforeCall('Write', { file_path: '/tmp/a' });
    g.afterCall('Write', { file_path: '/tmp/a' }, { success: false }, true);
    const haltDecision = g.afterCall('Write', { file_path: '/tmp/a' }, { success: false }, true);
    expect(haltDecision.action).toBe('halt');
    // 此后再产生 block 级决策, 存储面保持 halt(更严)
    const blocked = g.beforeCall('Write', { file_path: '/tmp/a' });
    expect(blocked.action).toBe('block');
    expect(g.getHaltDecision().action).toBe('halt');
  });
});

describe('buildAuditedSyntheticResult 可见即记录(dsh 机制②)', () => {
  it('构造合成结果即写审计: TOOL_DENIED 语义字段 + 决策元数据, 合成结果携带 guardrail 块', () => {
    const decision = new ToolGuardrailDecision({
      action: 'block',
      code: 'repeated_exact_failure_block',
      message: '已阻止 Bash: 相同参数已失败 5 次。',
      toolName: 'Bash',
      count: 5,
    });
    const captured = [];
    const synthetic = buildAuditedSyntheticResult(decision, {
      phase: 'before_call',
      auditFn: (entry) => {
        captured.push(entry);
        return { id: 'test-entry' };
      },
    });
    expect(captured).toHaveLength(1);
    const entry = captured[0];
    expect(entry.action).toBe('guardrail_block');
    expect(entry.result).toBe('blocked');
    expect(entry.resourceType).toBe('tool');
    expect(entry.resource).toBe('Bash');
    expect(entry.reason).toContain('已阻止 Bash');
    expect(entry.metadata.guardrail.action).toBe('block');
    expect(entry.metadata.phase).toBe('before_call');
    expect(entry.metadata.syntheticVisible).toBe(true);
    const parsed = JSON.parse(synthetic);
    expect(parsed.guardrail.code).toBe('repeated_exact_failure_block');
  });

  it('auditFn 抛错不吞阻断: 合成结果照常返回', () => {
    const decision = new ToolGuardrailDecision({ action: 'block', code: 'b', message: 'm' });
    const synthetic = buildAuditedSyntheticResult(decision, {
      auditFn: () => {
        throw new Error('audit down');
      },
    });
    expect(synthetic).toBe(buildSyntheticResult(decision));
  });
});
