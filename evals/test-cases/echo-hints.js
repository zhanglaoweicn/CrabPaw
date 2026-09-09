const { buildEchoHints, getRelatedMemories } = require('../../src/core/memory/echo-hints');
const { evaluateScenarios } = require('../../src/core/proactive/scenario-reminder-engine');

module.exports = {
  name: 'Echo Hints',
  cases: [
    {
      id: 'eh_001',
      name: '回响提示块包含相关记忆片段',
      category: 'echo_hints',
      run: () => {
        const r = buildEchoHints('预算方案', [{ id: 'm1', content: '您上个月定了 12 万预算方向', ts: Date.now() }]);
        return r.hints.length === 1 && r.promptBlock.includes('预算');
      },
    },
    {
      id: 'eh_002',
      name: '无相关记忆时回响块为空',
      category: 'echo_hints',
      run: () => {
        const r = buildEchoHints('天气', []);
        return r.hints.length === 0 && r.promptBlock === '';
      },
    },
    {
      id: 'eh_003',
      name: 'getRelatedMemories 检索失败降级空数组',
      category: 'echo_hints',
      run: async () => {
        const r = await getRelatedMemories('xxx', { limit: 3 });
        return Array.isArray(r);
      },
    },
    {
      id: 'eh_004',
      name: 'trend_interest：画像关键词命中热榜词 → 触发',
      category: 'echo_hints',
      run: () => {
        const hits = evaluateScenarios({
          weather: null, schedules: [], now: '2026-08-10T10:00:00',
          profileKeywords: ['餐饮'],
          trendingTitles: ['餐饮行业迎来复苏', '股市大涨'],
        });
        return hits.some((h) => h.ruleId === 'trend_interest' && h.text.includes('餐饮'));
      },
    },
    {
      id: 'eh_005',
      name: 'trend_interest：无命中关键词 → 不触发',
      category: 'echo_hints',
      run: () => {
        const hits = evaluateScenarios({
          weather: null, schedules: [], now: '2026-08-10T10:00:00',
          profileKeywords: ['汽修'],
          trendingTitles: ['股市大涨'],
        });
        return !hits.some((h) => h.ruleId === 'trend_interest');
      },
    },
  ],
};
