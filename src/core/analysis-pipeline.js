/**
 * analysis-pipeline — 查询结果分析总结管道
 *
 * rows + columns → LLM 3 点式洞察（趋势/异常/结论）→ 语音摘要 + 图表推断（确定性规则）。
 * LLM 失败自动降级为确定性摘要，绝不阻塞播报。
 */

const { getAuxiliaryClient } = require('./auxiliary-client');

/** 确定性图表推断：时间×数值→折线；类别×数值→柱状；单数值→饼图 */
function inferCharts(rows, columns) {
  const charts = [];
  try {
    const cols = Array.isArray(columns) ? columns : [];
    const numCol = cols.find((c) => c.type === 'REAL' || c.type === 'INTEGER');
    const dateCol = cols.find((c) => /(日期|时间|date|time)/i.test(c.name));
    const catCol = cols.find((c) => !numCol || c.name !== numCol.name);
    if (!numCol || rows.length === 0) return charts;
    const data = rows.slice(0, 200).map((r) => ({ name: r[dateCol ? dateCol.name : (catCol && catCol.name) || 'row'], value: Number(r[numCol.name]) || 0 }));
    if (dateCol) {
      charts.push({
        id: `chart_${charts.length + 1}`,
        type: 'line',
        title: `${numCol.name} 趋势`,
        option: {
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: data.map((d) => d.name) },
          yAxis: { type: 'value' },
          series: [{ type: 'line', smooth: true, data: data.map((d) => d.value), name: numCol.name }],
        },
      });
    } else if (catCol && catCol.name !== numCol.name) {
      charts.push({
        id: `chart_${charts.length + 1}`,
        type: 'bar',
        title: `${catCol.name} × ${numCol.name}`,
        option: {
          tooltip: { trigger: 'axis' },
          xAxis: { type: 'category', data: data.map((d) => d.name) },
          yAxis: { type: 'value' },
          series: [{ type: 'bar', data: data.map((d) => d.value), name: numCol.name }],
        },
      });
    } else {
      charts.push({
        id: `chart_${charts.length + 1}`,
        type: 'pie',
        title: `${numCol.name} 占比`,
        option: {
          tooltip: { trigger: 'item' },
          series: [{ type: 'pie', radius: '65%', data: data.map((d) => ({ name: d.name, value: d.value })) }],
        },
      });
    }
  } catch (e) {
    console.warn('[analysis-pipeline] 图表推断失败:', e.message || e);
  }
  return charts;
}

function formatSummaryText(insights) {
  const list = Array.isArray(insights) ? insights.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (list.length === 0) return '这次查询没有识别出明显的趋势或异常。';
  if (list.length === 1) return `结论：${list[0]}。`;
  const labels = ['第一', '第二', '第三', '第四', '第五'];
  return list.slice(0, 5).map((x, i) => `${labels[i]}：${x}`).join('，') + '。';
}

function defaultLlmCall(messages) {
  return getAuxiliaryClient().callLlm({ taskType: 'analysis', messages, maxTokens: 500, temperature: 0.2, timeout: 30000 });
}

/**
 * 分析查询结果
 * @param {{ question: string, rows: Array<object>, columns: Array<{name,type}>, llmCall?: Function }} opts
 */
async function analyzeResult({ question, rows, columns, llmCall }) {
  const data = Array.isArray(rows) ? rows.slice(0, 100) : [];
  const cols = Array.isArray(columns) ? columns : [];
  const call = llmCall || defaultLlmCall;
  try {
    const sample = JSON.stringify(data.slice(0, 30));
    const messages = [
      { role: 'system', content: '你是企业经营数据分析师。基于查询结果，输出最多 3 条洞察（趋势/异常/结论，每条 ≤ 25 字），只输出 JSON: {"insights": ["..."]}' },
      { role: 'user', content: `问题: ${question}\n列: ${cols.map((c) => c.name).join('、')}\n数据样本: ${sample}` },
    ];
    const resp = await call(messages);
    const text = String(resp.content || '');
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    const parsed = first !== -1 && last > first ? JSON.parse(text.slice(first, last + 1)) : {};
    const insights = Array.isArray(parsed.insights) ? parsed.insights.slice(0, 3).map(String) : [];
    if (insights.length === 0) throw new Error('LLM 未产出洞察');
    return { insights, summaryText: formatSummaryText(insights), charts: inferCharts(data, cols) };
  } catch (e) {
    console.warn('[analysis-pipeline] LLM 洞察失败，降级确定性摘要:', e.message || e);
    const charts = inferCharts(data, cols);
    const insights = [];
    if (data.length) {
      const numCol = cols.find((c) => c.type === 'REAL' || c.type === 'INTEGER');
      if (numCol) {
        const total = data.reduce((s, r) => s + (Number(r[numCol.name]) || 0), 0);
        insights.push(`共 ${data.length} 条记录，${numCol.name} 合计约 ${Math.round(total)}`);
        const vals = data.map((r) => Number(r[numCol.name]) || 0);
        insights.push(`最大 ${Math.max(...vals)}，最小 ${Math.min(...vals)}`);
      } else {
        insights.push(`共 ${data.length} 条记录`);
      }
    }
    return { insights, summaryText: formatSummaryText(insights), charts, degraded: true };
  }
}

module.exports = { analyzeResult, inferCharts, formatSummaryText };
