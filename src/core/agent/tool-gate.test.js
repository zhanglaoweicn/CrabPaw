/**
 * tool-gate 单元测试——Loop 第二刀（2026-09-04）
 * 六道前置关卡 + 放行形态。deps 全 fake，审计注入防落盘。
 */

const { createToolGate, WRITE_PROTECTED_TOOLS } = require('./tool-gate');

/** 内存 fake 装配 */
function makeDeps(overrides = {}) {
  const auditCalls = [];
  const deps = {
    toolGuardrail: {
      isBlocked: () => false,
      getBlockedReason: () => '',
      getHaltDecision: () => null,
      beforeCall: () => ({ shouldHalt: false, message: '' }),
    },
    globalFailureGuard: { record: () => null },
    getCircuitBreakerRegistry: () => ({
      getBreaker: () => ({ isOpen: () => false }),
    }),
    toolSystem: {
      get: (name) => ({ name, handler: () => {} }),
    },
    isWriteDenied: () => ({ denied: false }),
    shellHooksBridge: { invokeHook: async () => ({ blocked: false }) },
    WORKSPACE_DIR: '/ws',
    getUserId: () => 'gate_test_user',
    auditSynthetic: (decision, ctx) => {
      auditCalls.push({ decision, ctx });
      return `SYNTH:${decision.code}`;
    },
    log: { warn: () => {}, log: () => {} },
    ...overrides,
  };
  return { deps, auditCalls };
}

describe('tool-gate 六道关卡', () => {
  test('① 坏 JSON 参数: 修复器兜底为 {} 后放行(与原 ai.js 行为一致, repair 从不抛错)', async () => {
    const { deps } = makeDeps();
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({ name: 'Bash', function: { arguments: '{broken json' } });
    expect(r.pass).toBe(true);
    expect(r.params).toEqual({});
    // 非 JSON 字符串同样兜底 {} 放行——参数为空时工具自身的 validateInput 把关
    const r2 = await gate.gateToolCall({ name: 'Bash', function: { arguments: 'not json at all !@#' } });
    expect(r2.pass).toBe(true);
    expect(r2.params).toEqual({});
  });

  test('② 已阻断 → 合成结果 + TOOL_DENIED 审计 + failureGuard 记录', async () => {
    const { deps, auditCalls } = makeDeps({
      toolGuardrail: {
        isBlocked: () => true,
        getBlockedReason: () => '已连续失败',
        getHaltDecision: () => ({ action: 'block', code: 'halt_x' }),
        beforeCall: () => { throw new Error('不应走到 beforeCall'); },
      },
      globalFailureGuard: { record: (name, tag) => `拒绝过多:${tag}` },
    });
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({ name: 'Bash', params: {} });
    expect(r.pass).toBe(false);
    expect(r.result.error).toContain('拒绝过多');
    expect(r.result.circuitBreaker).toBe(true);
    expect(auditCalls[0].ctx.phase).toBe('already_blocked');
  });

  test('③ beforeCall shouldHalt → 审计合成(before_call)', async () => {
    const { deps, auditCalls } = makeDeps({
      toolGuardrail: {
        isBlocked: () => false,
        beforeCall: () => ({ shouldHalt: true, message: '循环防护', code: 'loop_block' }),
      },
    });
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({ name: 'Bash', params: {} });
    expect(r.pass).toBe(false);
    expect(r.result.error).toBe('SYNTH:loop_block');
    expect(auditCalls[0].ctx.phase).toBe('before_call');
  });

  test('④ 熔断器开启 → error', async () => {
    const { deps } = makeDeps({
      getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ isOpen: () => true }) }),
    });
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({ name: 'Bash', params: {} });
    expect(r.pass).toBe(false);
    expect(r.result.error).toContain('熔断器');
  });

  test('⑤ 未知工具 → error', async () => {
    const { deps } = makeDeps({ toolSystem: { get: () => null } });
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({ name: 'Nope', params: {} });
    expect(r.pass).toBe(false);
    expect(r.result.error).toContain('未知工具');
  });

  test('⑥ 写保护: Write 到被拒路径 → error; 普通工具不受影响', async () => {
    const { deps } = makeDeps({ isWriteDenied: (p) => ({ denied: p === '/etc/passwd', reason: '系统路径' }) });
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({ name: 'Write', params: { file_path: '/etc/passwd' } });
    expect(r.pass).toBe(false);
    expect(r.result.error).toContain('文件写入被安全策略阻止');
    const ok = await gate.gateToolCall({ name: 'Read', params: { file_path: '/etc/passwd' } });
    expect(ok.pass).toBe(true);
  });

  test('⑥b preToolHook 拦截 → error 且 sessionId 来自 getUserId', async () => {
    const seen = [];
    const { deps } = makeDeps({
      shellHooksBridge: { invokeHook: async (kind, payload) => { seen.push({ kind, payload }); return { blocked: true, reason: '禁用' }; } },
    });
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({ name: 'Bash', params: {} });
    expect(r.pass).toBe(false);
    expect(r.result.error).toContain('Shell Hook 拦截');
    expect(seen[0].payload.sessionId).toBe('gate_test_user');
    expect(seen[0].payload.cwd).toBe('/ws');
  });

  test('全关卡通过 → pass:true 携带 name/params/tool(放行形态)', async () => {
    const { deps, auditCalls } = makeDeps();
    const gate = createToolGate(deps);
    const r = await gate.gateToolCall({
      name: 'Write',
      function: { arguments: JSON.stringify({ file_path: '/ws/a.txt', content: 'x' }) },
    });
    expect(r.pass).toBe(true);
    expect(r.name).toBe('Write');
    expect(r.params.file_path).toBe('/ws/a.txt');
    expect(r.tool).toBeTruthy();
    expect(auditCalls).toHaveLength(0);
  });

  test('WRITE_PROTECTED_TOOLS 清单与 ai.js 语义一致(四件)', () => {
    expect(WRITE_PROTECTED_TOOLS).toEqual(['Write', 'Edit', 'DeleteFile', 'CreateDirectory']);
  });
});
