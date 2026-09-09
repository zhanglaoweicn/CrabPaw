/**
 * chart-generator — 数据图表生成
 * 用法：execute({ type: 'bar'|'line'|'pie', title, data: [...], options?: {...} })
 * echarts + canvas 可用时输出 PNG 文件；否则输出自包含 HTML（前端渲染）
 */
const path = require('path');
const config = require('../../src/core/config');

let canvasReady = false;
try { require.resolve('canvas'); canvasReady = true; } catch { canvasReady = false; }
let echartsReady = false;
try { require.resolve('echarts'); echartsReady = true; } catch { echartsReady = false; }

function buildOption(type, title, data) {
  const base = { title: { text: title || '', left: 'center' }, tooltip: {} };
  if (type === 'pie') {
    return { ...base, series: [{ type: 'pie', radius: '60%', data: data.map(d => ({ name: String(d.name ?? d.label ?? d), value: Number(d.value ?? 1) })) }] };
  }
  const categories = data.map(d => String(d.name ?? d.label ?? d));
  const values = data.map(d => Number(d.value ?? 0));
  return {
    ...base,
    xAxis: { type: 'category', data: categories },
    yAxis: { type: 'value' },
    series: [{ type: type === 'line' ? 'line' : 'bar', data: values }],
  };
}

async function renderPng(option) {
  const echarts = require('echarts');
  const { createCanvas } = require('canvas');
  const canvas = createCanvas(800, 480);
  const chart = echarts.init(canvas);
  chart.setOption(option);
  const outDir = path.join(config.DATA_DIR, 'output');
  const fs = require('fs');
  fs.mkdirSync(outDir, { recursive: true });
  const pngPath = path.join(outDir, `chart-${Date.now()}.png`);
  fs.writeFileSync(pngPath, canvas.toBuffer('image/png'));
  chart.dispose();
  return pngPath;
}

async function execute(params = {}) {
  try {
    const type = ['bar', 'line', 'pie'].includes(params.type) ? params.type : 'bar';
    const data = Array.isArray(params.data) ? params.data : [];
    const option = buildOption(type, params.title, data);
    let degradeReason = 'canvas/echarts 依赖不可用，已输出 HTML 嵌入方案';
    if (canvasReady && echartsReady) {
      try {
        const pngPath = await renderPng(option);
        return { success: true, output: { pngPath, config: option } };
      } catch (renderErr) {
        // 渲染分支失败不允许拖垮整个 execute——捕获后降级 HTML 分支
        degradeReason = `PNG 渲染失败已降级 HTML: ${renderErr.message}`;
        console.error('[chart-generator]', degradeReason);
      }
    }
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${params.title || 'chart'}</title><script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script></head><body><div id="c" style="width:800px;height:480px"></div><script>echarts.init(document.getElementById('c')).setOption(${JSON.stringify(option)});</script></body></html>`;
    return { success: true, output: { html, config: option }, note: degradeReason };
  } catch (err) {
    console.error('[chart-generator] 失败:', err);
    return { success: false, error: `图表生成失败: ${err.message}` };
  }
}

module.exports = { execute };
