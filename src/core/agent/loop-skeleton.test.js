/**
 * loop-skeleton 单元测试——循环骨架共享件（Loop 第三刀第一小步, 2026-09-04）
 * 结果→内容构建的三形态：成功/失败/toolGap 自愈(chat 专属)。
 */

const {
  buildToolResultContent,
  buildToolGapHealContent,
  TOOL_FAILURE_HINT,
} = require('./loop-skeleton');

describe('buildToolResultContent 三形态', () => {
  test('成功: 对象取 content, 字符串直取', () => {
    expect(buildToolResultContent({ toolCall: {}, toolResult: { content: '结果A' }, success: true })).toBe('结果A');
    expect(buildToolResultContent({ toolCall: {}, toolResult: '原始文本', success: true })).toBe('原始文本');
  });

  test('失败: 错误信息 + 统一提示(无流式版漂移的尾部 ])', () => {
    const out = buildToolResultContent({ toolCall: {}, toolResult: { error: '超时' }, success: false });
    expect(out).toContain('错误: 超时');
    expect(out).toContain(TOOL_FAILURE_HINT);
    expect(out.endsWith(']')).toBe(false);
  });

  test('失败: 非对象结果直取字符串', () => {
    const out = buildToolResultContent({ toolCall: {}, toolResult: '炸了', success: false });
    expect(out).toContain('错误: 炸了');
  });

  test('toolGap 自愈(chat 专属): toolGapHeal=true 且带 toolGap 时输出创建指引', () => {
    const toolCall = { function: { name: 'WeatherPlus' } };
    const out = buildToolResultContent({
      toolCall,
      toolResult: { error: '未知工具', toolGap: { gapType: 'missing', suggestedName: 'WeatherPlus', reason: '缺口', contractTemplate: {} } },
      success: false,
      toolGapHeal: true,
    });
    expect(out).toContain('[工具缺口检测]');
    expect(out).toContain("WeatherPlus");
    expect(out).toContain('generateTemplate');
  });

  test('toolGapHeal=false(流式路径)不输出自愈指引, 走统一失败提示', () => {
    const out = buildToolResultContent({
      toolCall: { function: { name: 'WeatherPlus' } },
      toolResult: { error: '未知工具', toolGap: { gapType: 'missing', suggestedName: 'WeatherPlus' } },
      success: false,
      toolGapHeal: false,
    });
    expect(out).not.toContain('[工具缺口检测]');
    expect(out).toContain(TOOL_FAILURE_HINT);
  });

  test('TOOL_FAILURE_HINT 无漂移尾部 ]', () => {
    expect(TOOL_FAILURE_HINT.endsWith(']')).toBe(false);
  });

  test('buildToolGapHealContent 使用 toolCall 名兜底 unknown', () => {
    expect(buildToolGapHealContent('unknown', { gapType: 'g', suggestedName: 'S', reason: 'r', contractTemplate: {} })).toContain("'unknown'");
  });
});
