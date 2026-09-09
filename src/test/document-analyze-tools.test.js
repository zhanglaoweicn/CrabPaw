/**
 * document-analyze-tools.test.js — 文档分析工具（2026-08-19）
 * 锁定纯函数（TSV 扁平化/统计聚合/JSON 提取/报告组装/图表数据/看板模板）
 * + 工具注册与契约双写一致（registry schema 与 tool-contract schema）。
 */
jest.mock('../core/sse-broadcast', () => ({
  broadcastEvent: jest.fn(),
}));

const { registry } = require('../tools/registry');
const {
  flattenXlsxToTsv,
  computeSheetAnalysis,
  extractJsonFromLlmReply,
  buildAnalysisMarkdown,
  buildDashboardCharts,
  buildDashboardHtml,
} = require('../tools/document-analyze-tools');

const SAMPLE = {
  sheets: [
    {
      name: '销售',
      rowCount: 5,
      rows: [
        ['月份', '销售额', '区域'],
        ['一月', 100, '华东'],
        ['二月', 150, '华东'],
        ['三月', 80, '华南'],
        ['四月', 120, '华南'],
      ],
    },
    { name: '空表', rowCount: 0, rows: [] },
  ],
};

describe('flattenXlsxToTsv — DeepTutor 式逐 sheet TSV 扁平化', () => {
  test('每个 sheet 输出标题行 + tab 分隔行', () => {
    const tsv = flattenXlsxToTsv(SAMPLE);
    expect(tsv).toContain('--- Sheet: 销售 (5 rows) ---');
    expect(tsv).toContain('--- Sheet: 空表 (0 rows) ---');
    expect(tsv).toContain('一月\t100\t华东');
    expect(tsv).toContain('二月\t150\t华东');
  });

  test('null/undefined 单元格 → 空串；无 sheets → 空串', () => {
    expect(flattenXlsxToTsv({ sheets: [{ name: 'x', rowCount: 1, rows: [[null, undefined, 'a']] }] }))
      .toContain('\ta\ta'.replace('a\ta', '\ta').replace('\t\t', '\t'));
    expect(flattenXlsxToTsv({})).toBe('');
    expect(flattenXlsxToTsv(null)).toBe('');
  });
});

describe('computeSheetAnalysis — 服务端统计聚合', () => {
  const sheets = computeSheetAnalysis(SAMPLE);

  test('首行视为表头，数值列按 ≥60% 可转数字判定', () => {
    const s = sheets[0];
    expect(s.headers).toEqual(['月份', '销售额', '区域']);
    expect(s.dataRows.length).toBe(4);
    expect(s.numericCols).toEqual(['销售额']);
    expect(s.colStats['销售额'].sum).toBe(450);
    expect(s.colStats['销售额'].avg).toBeCloseTo(112.5);
    expect(s.colStats['销售额'].min).toBe(80);
    expect(s.colStats['销售额'].max).toBe(150);
    expect(s.colStats['销售额'].count).toBe(4);
    expect(s.colStats['月份'].numeric).toBe(false);
    expect(s.colStats['月份'].distinct).toBe(4);
  });

  test('Top 类目按计数降序取前 8', () => {
    const s = sheets[0];
    expect(s.topCategories['区域']).toEqual([
      { value: '华东', count: 2 },
      { value: '华南', count: 2 },
    ]);
  });

  test('空表不抛错', () => {
    const s = sheets[1];
    expect(s.headers).toEqual([]);
    expect(s.numericCols).toEqual([]);
  });
});

describe('extractJsonFromLlmReply — 稳健 JSON 提取', () => {
  test('代码围栏内的 JSON', () => {
    const out = extractJsonFromLlmReply('```json\n{"summary": "好", "keyPoints": ["a"]}\n```');
    expect(out).toEqual({ summary: '好', keyPoints: ['a'] });
  });

  test('前后缀文本 + 无围栏', () => {
    expect(extractJsonFromLlmReply('好的，分析如下：{"summary":"s"} 完毕')).toEqual({ summary: 's' });
  });

  test('尾逗号自动修复', () => {
    expect(extractJsonFromLlmReply('{"a":1,"b":[1,2,],}')).toEqual({ a: 1, b: [1, 2] });
  });

  test('非 JSON → null（不抛错）', () => {
    expect(extractJsonFromLlmReply('抱歉，我无法分析')).toBeNull();
    expect(extractJsonFromLlmReply('')).toBeNull();
    expect(extractJsonFromLlmReply(null)).toBeNull();
  });
});

describe('buildAnalysisMarkdown — 报告组装', () => {
  test('五个章节齐全，空列表 → （无）', () => {
    const md = buildAnalysisMarkdown(
      { summary: '摘要A', keyPoints: ['要点1'], numbers: [], risks: [], entities: [] },
      { title: '测试文档', sourcePath: 'D:/a.docx', sourceFormat: 'docx', focus: '合同条款' }
    );
    expect(md).toContain('# 测试文档 — 分析报告');
    expect(md).toContain('## 摘要');
    expect(md).toContain('摘要A');
    expect(md).toContain('## 核心要点');
    expect(md).toContain('1. 要点1');
    expect(md).toContain('## 关键数字');
    expect(md).toContain('（无）');
    expect(md).toContain('## 风险与注意点');
    expect(md).toContain('## 关键实体');
    expect(md).toContain('来源文件：D:/a.docx');
    expect(md).toContain('分析侧重：合同条款');
  });

  test('截断标注', () => {
    const md = buildAnalysisMarkdown(
      { summary: 's' },
      { title: 't', sourcePath: 'p', totalChars: 100000, truncated: true, maxChars: 30000 }
    );
    expect(md).toContain('原文长度：100000 字符');
    expect(md).toContain('已截断，分析基于前 30000 字符');
  });
});

describe('buildDashboardCharts — 确定性图表数据', () => {
  const sheets = computeSheetAnalysis(SAMPLE);

  test('bar：类目 × 数值列求和 Top 8，降序', () => {
    const charts = buildDashboardCharts(sheets);
    expect(charts.bar).not.toBeNull();
    expect(charts.bar.labels).toEqual(['二月', '四月', '一月', '三月']);
    expect(charts.bar.values).toEqual([150, 120, 100, 80]);
    expect(charts.bar.title).toContain('销售额');
  });

  test('line：数值列按行序（≥3 点）', () => {
    const charts = buildDashboardCharts(sheets);
    expect(charts.line).not.toBeNull();
    expect(charts.line.values).toEqual([100, 150, 80, 120]);
    expect(charts.line.labels).toEqual(['第1行', '第2行', '第3行', '第4行']);
  });

  test('pie：首列分布 Top4 + 其他折叠', () => {
    const charts = buildDashboardCharts(sheets);
    expect(charts.pie).not.toBeNull();
    expect(charts.pie.slices).toEqual([
      { value: 1, label: '一月' },
      { value: 1, label: '二月' },
      { value: 1, label: '三月' },
      { value: 1, label: '四月' },
    ]);
  });

  test('无数值列 → bar/line 为 null，pie 仍可出（仅分类数据）', () => {
    const catOnly = computeSheetAnalysis({
      sheets: [{ name: 'c', rowCount: 4, rows: [['城市'], ['北京'], ['上海'], ['北京']] }],
    });
    const charts = buildDashboardCharts(catOnly);
    expect(charts.bar).toBeNull();
    expect(charts.line).toBeNull();
    expect(charts.pie.slices).toEqual([
      { value: 2, label: '北京' },
      { value: 1, label: '上海' },
    ]);
  });

  test('空表 → 全 null', () => {
    const charts = buildDashboardCharts(computeSheetAnalysis(SAMPLE).slice(1, 2));
    expect(charts.bar).toBeNull();
    expect(charts.line).toBeNull();
    expect(charts.pie).toBeNull();
  });
});

describe('buildDashboardHtml — 看板模板', () => {
  const sheets = computeSheetAnalysis(SAMPLE);
  const html = buildDashboardHtml({
    title: '销售看板',
    sourceName: '销售.xlsx',
    tiles: [
      { label: '数据行数', value: '5', sub: '已解析 4 行' },
      { label: '销售额 合计', value: '450', sub: '4 个非空值' },
    ],
    charts: buildDashboardCharts(sheets),
    analysis: { summary: '总体平稳', keyPoints: ['华东领先'], insights: ['加大华南投入'] },
    headers: ['月份', '销售额', '区域'],
    previewRows: [['一月', '100', '华东']],
  });

  test('结构要素齐全', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('chart.umd.min.js');
    expect(html).toContain('销售看板');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('总体平稳');
    expect(html).toContain('华东领先');
    expect(html).toContain('--series-1:#2a78d6');
    expect(html).toContain('--series-1:#3987e5'); // 深色档
    expect(html).toContain('<canvas id="barChart"></canvas>');
    expect(html).toContain('<table>');
    expect(html).toContain('font-variant-numeric:tabular-nums');
  });

  test('LLM 文本注入 HTML 转义（防 XSS）', () => {
    const evil = buildDashboardHtml({
      title: 'x</title><script>alert(1)</script>',
      sourceName: 'a.csv',
      tiles: [],
      charts: { bar: null, line: null, pie: null },
      analysis: { summary: '<script>alert(2)</script>', keyPoints: [], insights: [] },
      headers: ['a'],
      previewRows: [],
    });
    expect(evil).not.toContain('<script>alert(1)');
    expect(evil).not.toContain('<script>alert(2)');
    // 文本上下文转义 < 即防标签注入（> 无需转义）
    expect(evil).toContain('&lt;script');
  });
});

describe('工具注册与契约双写', () => {
  test('DocumentAnalyze / DashboardGenerate 已注册（PascalCase + 契约要素）', () => {
    for (const name of ['DocumentAnalyze', 'DashboardGenerate']) {
      const tool = registry.get(name);
      expect(tool).toBeTruthy();
      expect(tool.schema.required).toEqual(['filePath']);
      expect(tool.riskLevel).toBe('low');
      expect(Array.isArray(tool.whenNotToUse)).toBe(true);
      expect(tool.timeout).toBe(180000);
    }
  });

  test('registry schema 与 tool-contract schema 双写一致', () => {
    const { getToolContract } = require('../core/tool-contract');
    for (const name of ['DocumentAnalyze', 'DashboardGenerate']) {
      const regSchema = registry.get(name).schema;
      const contract = getToolContract(name);
      expect(contract).toBeTruthy();
      expect(Object.keys(contract.schema.properties).sort())
        .toEqual(Object.keys(regSchema.properties).sort());
      expect(contract.schema.required).toEqual(regSchema.required);
      expect(contract.riskLevel).toBe('low');
      expect(contract.maxTimeout).toBe(180000);
    }
  });
});
