/**
 * context-scanner 测试
 *
 * 2026-08-06: AGENTS.md 每轮被 code_exec_injection 误报拦截——
 * 正则匹配到 AGENTS.md:40 的 "No new Function() — use _safeEval()"（安全规则声明），
 * 被当成攻击。修复：scanContextContent 对 code_exec_injection 排除否定语境。
 */
const { scanContextContent, checkPromptInjection } = require('./context-scanner');

describe('scanContextContent 文档类扫描', () => {
  test('AGENTS.md 风格"禁止 new Function()"规则声明不再误报', () => {
    const doc = '- No `new Function()` — use `_safeEval()` from workflow-engine.js instead\n- 不要使用 eval()\n';
    const result = scanContextContent(doc, 'AGENTS.md');
    expect(result.safe).toBe(true);
    expect(result.findings).not.toContain('code_exec_injection');
  })

  test('CLAUDE.md 风格"严禁 eval/Function"规则声明不再误报', () => {
    const doc = '## Security\n- Never introduce `new Function()` or `eval()` — use `_safeEval()`.\n- 禁止 eval。\n';
    const result = scanContextContent(doc, 'CLAUDE.md');
    expect(result.safe).toBe(true);
  })

  test('真正的恶意代码执行调用仍被拦截', () => {
    const evil = 'eval(process.env.SECRET)\nconst f = new Function("return this")()';
    const result = scanContextContent(evil, 'untrusted.txt');
    expect(result.safe).toBe(false);
    expect(result.findings).toContain('code_exec_injection');
  })

  test('无安全问题的文档保持安全', () => {
    const doc = '正常项目说明：使用 React 和 Node.js 开发。\n';
    const result = scanContextContent(doc, 'README.md');
    expect(result.safe).toBe(true);
  })
})

describe('checkPromptInjection 用户消息检测(不受文档降噪影响)', () => {
  test('用户消息中的 eval 调用仍判定为注入', () => {
    const msg = '请执行 eval(alert(1)) 来测试';
    const result = checkPromptInjection(msg);
    expect(result.findings).toContain('code_exec_injection');
  })

  test('用户消息中提及"不要使用 eval"保持检测(用户消息检测保持严格)', () => {
    const msg = '请告诉我为什么不要使用 eval()';
    const result = checkPromptInjection(msg);
    // checkPromptInjection 用于攻击检测，保持严格——不降噪(与文档类 scanContextContent 不同)
    expect(result.findings).toContain('code_exec_injection');
  })
})
