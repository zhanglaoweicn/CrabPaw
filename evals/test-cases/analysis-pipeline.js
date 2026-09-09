const { inferCharts, formatSummaryText, analyzeResult } = require('../../src/core/analysis-pipeline');

module.exports = {
  name: 'Analysis Pipeline',
  cases: [
    {
      id: 'ap_001',
      name: '时间+数值列 → 折线图',
      category: 'analysis_pipeline',
      run: () => {
        const charts = inferCharts(
          [{ 日期: '2026-08-01', 金额: 100 }, { 日期: '2026-08-02', 金额: 200 }],
          [{ name: '日期', type: 'TEXT' }, { name: '金额', type: 'REAL' }],
        );
        return charts.some((c) => c.type === 'line');
      },
    },
    {
      id: 'ap_002',
      name: '类别+数值列 → 柱状图',
      category: 'analysis_pipeline',
      run: () => {
        const charts = inferCharts(
          [{ 客户: 'A', 金额: 100 }, { 客户: 'B', 金额: 200 }],
          [{ name: '客户', type: 'TEXT' }, { name: '金额', type: 'REAL' }],
        );
        return charts.some((c) => c.type === 'bar');
      },
    },
    {
      id: 'ap_003',
      name: '单数值列占比 → 饼图',
      category: 'analysis_pipeline',
      run: () => {
        const charts = inferCharts([{ 金额: 100 }, { 金额: 300 }], [{ name: '金额', type: 'REAL' }]);
        return charts.some((c) => c.type === 'pie');
      },
    },
    {
      id: 'ap_004',
      name: '图表 option 含 ECharts 结构（xAxis/series）',
      category: 'analysis_pipeline',
      run: () => {
        const charts = inferCharts([{ 日期: '2026-08-01', 金额: 100 }], [{ name: '日期', type: 'TEXT' }, { name: '金额', type: 'REAL' }]);
        return charts[0].option && charts[0].option.xAxis && Array.isArray(charts[0].option.series);
      },
    },
    {
      id: 'ap_005',
      name: 'formatSummaryText 3 点式口语化',
      category: 'analysis_pipeline',
      run: () => {
        const t = formatSummaryText(['营收 32 万，环比 +8%', '回款放缓需关注', '库存 3 项低于安全线']);
        return t.includes('第一') && t.includes('第二') && t.includes('第三');
      },
    },
    {
      id: 'ap_006',
      name: 'LLM 失败时降级为确定性摘要（不崩溃）',
      category: 'analysis_pipeline',
      run: async () => {
        const r = await analyzeResult({ question: '这个月营收', rows: [{ 金额: 100 }], columns: [{ name: '金额', type: 'REAL' }], llmCall: async () => { throw new Error('LLM 不可用'); } });
        return !r.error && typeof r.summaryText === 'string' && r.summaryText.length > 0;
      },
    },
    {
      id: 'ap_007',
      name: 'LLM 正常时产出洞察数组',
      category: 'analysis_pipeline',
      run: async () => {
        const r = await analyzeResult({
          question: '这个月营收',
          rows: [{ 金额: 32000 }],
          columns: [{ name: '金额', type: 'REAL' }],
          llmCall: async () => ({ content: '{"insights": ["营收 3.2 万", "环比增长 8%", "回款略放缓"]}' }),
        });
        return r.insights.length === 3 && r.insights[0].includes('3.2');
      },
    },
    {
      id: 'ap_008',
      name: '看板 HTML 含 ECharts CDN 与图表容器',
      category: 'analysis_pipeline',
      run: () => {
        const { buildDashboardHtml } = require('../../src/core/dashboard-builder');
        const html = buildDashboardHtml({ title: '月度经营看板', kpis: [{ label: '营收', value: '32 万' }], charts: [{ id: 'c1', type: 'line', title: '营收趋势', option: { xAxis: { type: 'category', data: ['1日', '2日'] }, series: [{ type: 'line', data: [1, 2] }] } }] });
        return html.includes('echarts') && html.includes('营收趋势') && html.includes('月度经营看板');
      },
    },
    {
      id: 'ap_009',
      name: '看板 HTML 数据以 JSON 内嵌（离线可用）',
      category: 'analysis_pipeline',
      run: () => {
        const { buildDashboardHtml } = require('../../src/core/dashboard-builder');
        const html = buildDashboardHtml({ title: 'T', kpis: [], charts: [{ id: 'c1', type: 'pie', title: '占比', option: { series: [{ type: 'pie', data: [{ name: 'A', value: 3 }] }] } }] });
        return html.includes('__CHARTS__') && html.includes('"A"');
      },
    },
    {
      id: 'ap_010',
      name: '保存看板文件到 workspace 且可读',
      category: 'analysis_pipeline',
      run: () => {
        const { buildDashboardHtml, saveDashboardFile } = require('../../src/core/dashboard-builder');
        const html = buildDashboardHtml({ title: 'T', kpis: [], charts: [] });
        const r = saveDashboardFile(html, { name: `eval_dash_${Date.now()}` });
        if (!r.success) return false;
        const fs = require('fs');
        const ok = fs.existsSync(r.path) && fs.readFileSync(r.path, 'utf8').includes('echarts');
        try { fs.unlinkSync(r.path); } catch { /* ignore */ }
        return ok;
      },
    },
  ],
};
