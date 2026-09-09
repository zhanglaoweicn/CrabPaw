const { buildExpertPromptSuffix } = require('../core/expert-context');

describe('buildExpertPromptSuffix 专家人设注入', () => {
  const LONG_PROMPT = '①知识体系：宏观经济、财报三表、估值模型、行业比较。②工作习惯：先看数据再下结论。③输出标准：结论前置、数据佐证。④边界：不给投资建议。'.repeat(5); // >200 字

  test('完整注入 systemPrompt，不做 200 字截断', () => {
    const out = buildExpertPromptSuffix({
      name: '财务顾问', title: 'CFO', systemPrompt: LONG_PROMPT,
      voiceStyle: '专业稳重', dataSources: '股票行情、财务数据',
    });
    expect(out).toContain(LONG_PROMPT);
    expect(out.length).toBeGreaterThan(200 + 60);
  });

  test('null/无名专家 → 空串（不注入）', () => {
    expect(buildExpertPromptSuffix(null)).toBe('');
    expect(buildExpertPromptSuffix({})).toBe('');
  });

  test('缺省字段不产生 undefined 字样', () => {
    const out = buildExpertPromptSuffix({ name: '销售总监' });
    expect(out).toContain('销售总监');
    expect(out).not.toContain('undefined');
  });

  test('保留 voiceStyle 与 dataSources 行', () => {
    const out = buildExpertPromptSuffix({ name: 'X', voiceStyle: '干练', dataSources: 'CRM' });
    expect(out).toContain('语气: 干练');
    expect(out).toContain('可用数据源: CRM');
  });
});
