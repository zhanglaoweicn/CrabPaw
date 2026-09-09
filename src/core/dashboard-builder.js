/**
 * dashboard-builder — 单文件可视化看板生成
 *
 * KPI 卡 + 多 ECharts 图表 → 独立 HTML（内嵌数据 JSON + CDN ECharts），
 * 离线可打开、可分享、可交付。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildDashboardHtml({ title = '经营看板', kpis = [], charts = [] }) {
  const chartsJson = JSON.stringify(charts).replace(/</g, '\\u003c');
  const kpisHtml = kpis.length
    ? `<div class="kpi-row">${kpis.map((k) => `<div class="kpi"><div class="kpi-label">${escapeHtml(k.label)}</div><div class="kpi-value">${escapeHtml(k.value)}</div></div>`).join('')}</div>`
    : '';
  const chartsHtml = charts.length
    ? charts.map((c, i) => `<div class="chart-card"><div class="chart-title">${escapeHtml(c.title || '')}</div><div id="chart_${i}" class="chart-box"></div></div>`).join('')
    : '<div class="empty">暂无图表数据</div>';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #0a0e16; color: #e5e7eb; margin: 0; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  .kpi-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
  .kpi { flex: 1; min-width: 140px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 14px 16px; }
  .kpi-label { font-size: 13px; opacity: 0.7; }
  .kpi-value { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .chart-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 14px; margin-bottom: 16px; }
  .chart-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .chart-box { width: 100%; height: 320px; }
  .empty { opacity: 0.5; padding: 40px; text-align: center; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${kpisHtml}
${chartsHtml}
<script>
var __CHARTS__ = ${chartsJson};
window.addEventListener('DOMContentLoaded', function () {
  __CHARTS__.forEach(function (c, i) {
    var el = document.getElementById('chart_' + i);
    if (!el) return;
    var chart = echarts.init(el);
    chart.setOption(c.option || {});
  });
});
</script>
</body>
</html>`;
}

function saveDashboardFile(html, { name }) {
  try {
    const dir = path.join(config.DATA_DIR, '..', 'workspace');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || `dashboard_${Date.now()}`).replace(/[^\w一-鿿-]/g, '_');
    const filePath = path.join(dir, `${safe}.html`);
    fs.writeFileSync(filePath, html, 'utf8');
    return { success: true, path: filePath };
  } catch (e) {
    console.error('[dashboard-builder] 保存失败:', e.message || e);
    return { success: false, error: e.message || '保存失败' };
  }
}

module.exports = { buildDashboardHtml, saveDashboardFile };
