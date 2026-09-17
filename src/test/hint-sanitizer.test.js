/**
 * hint-sanitizer 回归测试（2026-09-18 会话膨胀治理）
 *
 * 背景：chat 管线注入的系统脚手架（语音模式/taskflow/专家人设/实时上下文接力）
 * 随用户消息持久化进会话历史，累积把上下文撑到 83K tokens（超限 1022%）。
 * stripInjectedHints 用于历史装配与持久化两个入口，回归钉死剥离行为。
 */
const { stripInjectedHints } = require('../core/hint-sanitizer');

describe('hint-sanitizer 注入提示剥离', () => {
  test('剥离语音模式提示(尾部块)，保留用户原话', () => {
    const raw = '你会唱歌吗？  [系统提示：当前是语音对话模式，你的回复将被 TTS 朗读——用户在听而不是在读。请默认用 1-2 句口语化的短句回复。]';
    expect(stripInjectedHints(raw)).toBe('你会唱歌吗？');
  });

  test('剥离 taskflow 提示块', () => {
    const raw = '帮我查一下大华股份这支股票。 [系统提示: 此任务可能需要创建工作流来协调完成。 你可以使用 taskflow 工具的 create 操作来创建工作流。 推荐模板: "股票分析"]';
    const out = stripInjectedHints(raw);
    expect(out).toBe('帮我查一下大华股份这支股票。');
    expect(out).not.toContain('taskflow');
  });

  test('剥离专家人设长块(3.8KB 级)', () => {
    const persona = '人设要求: # 财务分析师 你是**财务分析师**，一位拥有 12 年以上经验的资深财务分析专家，横跨投资银行、企业财务和 FP&A 领域。你要用专业视角分析。'.repeat(10);
    const raw = `你刷新一下股票的行情面板 [系统提示: 本对话将根据「财务分析师」专家视角回答。(角色: 财务分析师) ${persona}]`;
    const out = stripInjectedHints(raw);
    expect(out).toBe('你刷新一下股票的行情面板');
    expect(out).not.toContain('财务分析师');
  });

  test('剥离实时语音上下文接力前缀整块', () => {
    const raw = '[实时语音上下文（刚才会话的最近内容，仅供理解本轮请求，不要复述）]\n用户：你会唱歌吗\n用户：那你帮我唱一首孙燕姿的歌吧\n[/实时语音上下文]\n\n帮我播放孙燕姿的歌';
    expect(stripInjectedHints(raw)).toBe('帮我播放孙燕姿的歌');
  });

  test('组合注入(前缀+尾部)全部剥离', () => {
    const raw = '[系统提示: 本对话将根据「财务分析师」专家视角回答。] 你帮我查一下大华股份 [系统提示：当前是语音对话模式，你的回复将被 TTS 朗读。]';
    expect(stripInjectedHints(raw)).toBe('你帮我查一下大华股份');
  });

  test('无注入的干净消息原样保留', () => {
    expect(stripInjectedHints('你好呀，最近怎么样？')).toBe('你好呀，最近怎么样？');
    expect(stripInjectedHints('')).toBe('');
  });
});
