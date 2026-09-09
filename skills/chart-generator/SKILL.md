---
name: chart-generator
version: "1.0.0"
description: "数据图表生成，接收 JSON 数据和可视化需求，用 ECharts/Chart.js 渲染 PNG/SVG，支持柱状、折线、饼图、散点、雷达、热力、仪表盘等20+类型。当用户给数据说“画个图/生成图表/数据可视化”时使用。"
metadata:
  crabpaw:
    emoji: 📈
    category: visualization
    capabilities: [data_visualization]
    requires:
      npm:
        - echarts
        - canvas
      bins:
        - node
    priority: 3
    tags: [chart, data, echarts, visualization]
---

# Chart Generator

从数据生成专业图表，可嵌入文档或独立交付。

## 快速参考

| 主题 | 说明 |
|------|------|
| 输入 | JSON数据 + 图表类型选择 |
| 输出 | PNG/SVG 图表文件 |
| 引擎 | ECharts (首选) + Chart.js (备选) |
| 支持图表 | 柱状图、折线图、饼图、散点、雷达、热力、仪表盘等 |

## 支持的图表类型

| 图表 | ECharts series.type | 适用场景 |
|------|-------------------|---------|
| 柱状图 | `bar` | 分类对比、排名 |
| 折线图 | `line` | 趋势、时间序列 |
| 饼图 | `pie` | 占比、构成 |
| 散点图 | `scatter` | 相关性、分布 |
| 雷达图 | `radar` | 多维对比 |
| 仪表盘 | `gauge` | 指标达成率 |
| 热力图 | `heatmap` | 密度、频率 |
| 桑基图 | `sankey` | 流向、转化 |
| 漏斗图 | `funnel` | 转化率 |
| 地图 | `map` | 地理分布 |
| 混合图 | `bar` + `line` | 双轴图表 |

## 工作流程

### Phase 1: 数据分析
1. 识别数据维度（x轴/y轴/系列/分组）
2. 选择最佳图表类型
3. 自动推断颜色方案

### Phase 2: 图表生成
```javascript
const echarts = require('echarts');
const { createCanvas } = require('canvas');

// 服务端渲染 ECharts
echarts.setPlatformAPI({ createCanvas });
const chart = echarts.init(createCanvas(800, 500));
chart.setOption({
  title: { text: '月度销售趋势' },
  xAxis: { type: 'category', data: ['1月','2月','3月','4月'] },
  yAxis: { type: 'value' },
  series: [{ data: [120, 200, 150, 80], type: 'bar' }]
});

// 导出为 PNG buffer
const buffer = chart.getDom().toBuffer('image/png');
```

### Phase 3: 输出交付
- 输出 PNG 文件到工作目录
- 可嵌入 Word/PPT/PDF/HTML
- 支持批量生成多张图表

## 自动推断规则

| 数据特征 | 推荐图表 | 原因 |
|---------|---------|------|
| 1维时间序列 | 折线图 | 显示趋势 |
| 2-8个分类 | 柱状图 | 易于比较 |
| 占比数据 (<8类) | 饼图 | 直观显示比例 |
| 2个数值列 | 散点图 | 发现相关性 |
| 多维指标 | 雷达图 | 多维度对比 |
| 含地理名称 | 地图 | 地理分布 |

## 核心规则

### 1. 图表设计标准
- 标题：中文、简洁（≤15字）
- 颜色：色盲友好调色板
- 标签：直接标注而非仅靠图例
- 坐标轴：从0开始（柱状图）
- 响应式：适配嵌入场景（最小300px）

### 2. 安全限制
- 数据行数 ≤ 1000 行
- 图例项 ≤ 20 个
- 渲染超时 15 秒

## 依赖安装

```bash
npm install echarts canvas
```

## Chart.js 备选方案
当 ECharts 不可用时，自动降级到 Chart.js：
```javascript
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const renderer = new ChartJSNodeCanvas({ width: 800, height: 500 });
const image = await renderer.renderToBuffer({
  type: 'bar',
  data: { labels: ['A','B','C'], datasets: [{ data: [10,20,30] }] }
});
```
