/**
 * tool-hints 单测——工具执行提示单一事实源（2026-10-01）
 *
 * 回归背景：对话窗口同时出现「正在执行命令」与「正在执行 Bash」——原生分支与
 * DSML 兜底分支各有一份手写文案表且互不查重。收敛后两分支必须同词，且跨轮
 * 回声（原生已执行、下一轮 DSML 复述同一调用）的签名必须对得上。
 */
const { TOOL_RUNNING_HINTS, toolRunningHint, toolCallSignature } = require('../core/tool-hints');

describe('toolRunningHint —— 提示文案单一事实源', () => {
  test('已知工具返回友好文案（Bash 统一为「正在执行命令」）', () => {
    expect(toolRunningHint('Bash')).toBe('正在执行命令...');
    expect(toolRunningHint('ShellExec')).toBe('正在执行命令...');
    expect(toolRunningHint('WebSearch')).toBe('正在搜索网络...');
  });

  test('未知工具回退为「正在执行 <工具名>...」', () => {
    expect(toolRunningHint('ShowTyphoon')).toBe('正在执行 ShowTyphoon...');
    expect(toolRunningHint('SomeFutureTool')).toBe('正在执行 SomeFutureTool...');
  });

  test('文案表覆盖了旧三份映射的工具（收敛不丢词）', () => {
    // 来自旧 ai.js 原生分支
    for (const t of ['StockQuery', 'WebSearch', 'Read', 'LS', 'Grep', 'SearchCodebase', 'Glob', 'Bash', 'WebFetch']) {
      expect(TOOL_RUNNING_HINTS[t]).toBeTruthy();
    }
    // 来自旧 chat-handler 企微分支
    for (const t of ['Write', 'Weather', 'TodoRead', 'TodoWrite']) {
      expect(TOOL_RUNNING_HINTS[t]).toBeTruthy();
    }
  });
});

describe('toolCallSignature —— 跨轮回声去重的规范化签名', () => {
  test('【核心回归】原生 FC 的字符串参数与 DSML 解析的对象参数得到同一签名', () => {
    // 上一轮原生调用: arguments 是 JSON 字符串(模型输出形态)
    const native = toolCallSignature('Bash', '{"command":"ls -la","timeout":5000}');
    // 下一轮 DSML 复述: params 是解析后的对象(键序可能不同)
    const dsml = toolCallSignature('Bash', { timeout: 5000, command: 'ls -la' });
    expect(native).toBe(dsml);
  });

  test('参数不同 → 签名不同（不能误杀合法的新调用）', () => {
    const a = toolCallSignature('Bash', { command: 'ls' });
    const b = toolCallSignature('Bash', { command: 'ls -la' });
    expect(a).not.toBe(b);
  });

  test('工具名不同 → 签名不同', () => {
    expect(toolCallSignature('Bash', { command: 'ls' }))
      .not.toBe(toolCallSignature('ShellExec', { command: 'ls' }));
  });

  test('非法 JSON 字符串参数不抛错（回退为原串参与签名）', () => {
    expect(() => toolCallSignature('Bash', 'not-json')).not.toThrow();
    expect(toolCallSignature('Bash', 'not-json')).toBe('Bash:not-json');
  });

  test('空参数形态归一（undefined/null/空对象/空串 → 同一签名）', () => {
    const a = toolCallSignature('ShowTyphoon', undefined);
    const b = toolCallSignature('ShowTyphoon', null);
    const c = toolCallSignature('ShowTyphoon', {});
    const d = toolCallSignature('ShowTyphoon', '{}');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
  });

  test('嵌套参数键序不影响签名', () => {
    const a = toolCallSignature('Write', { file_path: '/tmp/a.md', content: { title: 'x', body: 'y' } });
    const b = toolCallSignature('Write', { content: { body: 'y', title: 'x' }, file_path: '/tmp/a.md' });
    expect(a).toBe(b);
  });
});
