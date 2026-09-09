---
name: deep-research
version: "2.0.0"
description: "5步深度研究：子问题分解→联邦搜索→提取发现→缺口检测→综合报告，支持pack/brief/comparison等格式。当用户说“深入研究一下X”“做个行业报告/竞品分析/技术调研/学术综述”时使用。"
metadata:
  crabpaw:
    emoji: 🔬
    category: research
    priority: 5
    tags: [search, deep-research, recursive, research, analysis, report]
    triggers: [深度研究, 递归搜索, 全面调研, 竞品分析, 行业报告, 技术调研, 学术综述]
---

# 🔬 Deep Research — 5步迭代深度研究

> 此技能合并了原 xyz-multi-search 的设计，并增添了可执行 executor。

## 快速参考

| 参数 | 说明 | 默认值 |
|------|------|--------|
| query | 研究主题 | 必填 |
| breadth | 子问题数 | 3 |
| depth | 迭代轮数 | 2 |
| format | 输出格式 | pack |

## 5步流程

### Step 1: 子问题分解
AI 将主题拆为 2-4 个子问题，每个聚焦不同角度。

### Step 2: 联邦搜索
每个子问题并行搜索，调用 CrabPaw 内置多引擎搜索。

### Step 3: 提取发现
AI 从搜索结果中提取关键发现 + 研究方向的延伸。

### Step 4: 缺口检测
分析已有发现，识别信息缺口，自动补充搜索。

### Step 5: 综合报告
编译结构化报告。

## 输出格式

| 格式 | 适用场景 | 结构 |
|------|---------|------|
| **pack** (默认) | 通用研究报告 | 概述 + 核心发现 + 分类详情 + 缺口 + 引用 |
| **brief** | 快速简报 | 核心发现 + 3-5 条要点 |
| **comparison** | 竞品/方案对比 | 对比表 + 差异分析 |
| **timeline** | 事件时间线 | 按时间排列 + 趋势解读 |
| **dossier** | 深度档案 | 概述 + 详细证据 + 交叉验证 + 引用列表 |

## 适用场景

- 行业分析："深度研究中国宠物医疗行业"
- 技术调研："研究 WebAssembly 最新进展"
- 竞品分析："调研 Notion 的竞品格局"
- 学术综述："梳理量子机器学习的最新进展"

## 依赖

无需额外安装。使用 CrabPaw 内置的 AI 和多引擎搜索能力。
