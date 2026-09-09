/**
 * system-prompt 时间指令测试
 *
 * 背景（2026-08-06 真机 bug）：用户问"现在几点了"，模型不用上下文已注入的时间，
 * 而是调用 Bash 执行 Get-Date → 沙箱拦截（standard 模式 allowExecute:false）→
 * 前端播报"正在执行命令..."但最终无回答。
 *
 * 根因：system-prompt 时间块（"## ⏰ 当前时间"）声明了时间但没明确
 * "问时间/日期/几点时直接回答，不要调用工具查时间"。弱模型倾向调工具确认。
 *
 * 修复：时间块明确禁止用工具查询时间。
 */
const { buildSystemPrompt, buildRuntimeInfo } = require('../core/system-prompt');

// 最小 config：buildSystemPrompt 需要 models/providers 等字段
function makeConfig() {
  return {
    user: { timezone: 'Asia/Shanghai' },
    agent: { name: 'CrabPaw' },
    models: {
      currentProvider: 'deepseek',
      providers: {
        deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
      },
    },
    chatChannel: 'none',
  };
}

describe('system-prompt 时间指令（问时间应直接用注入时间，勿用工具）', () => {
  test('时间块包含"勿用工具查时间"指令', () => {
    const config = makeConfig();
    const runtimeInfo = buildRuntimeInfo(config);
    const prompt = buildSystemPrompt(config, { runtimeInfo });

    // 时间块存在（当前时间已注入）
    expect(prompt).toContain('当前时间');
    expect(prompt).toContain(runtimeInfo.currentDate);

    // 修复目标：明确禁止用工具查询时间
    // （当前代码没有此指令 → 此断言应失败）
    expect(prompt).toMatch(/不要.*工具.*(时间|日期|几点)/);
  });

  test('时间块存在且含精确时间（不要求工具指令，作为基线）', () => {
    const config = makeConfig();
    const runtimeInfo = buildRuntimeInfo(config);
    const prompt = buildSystemPrompt(config, { runtimeInfo });

    expect(prompt).toContain('必须以此为准');
    expect(runtimeInfo.currentTime).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});
