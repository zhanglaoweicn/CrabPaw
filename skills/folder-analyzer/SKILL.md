---
name: folder-analyzer
version: "1.0.0"
description: "文件夹结构分析：递归扫描目标目录，产出概览统计、限量目录树、扩展名分布、最大文件/子目录 TOP 榜与疑似重复文件报告。当用户说「分析一下这个项目的目录结构」「看看这个文件夹里都有什么」「哪些文件占空间最大」「有没有重复文件」时使用。"
metadata:
  crabpaw:
    emoji: 🗂️
    category: automation
    capabilities: [folder_analysis, disk_usage, duplicate_detect]
    requires:
      bins:
        - node
    priority: 2
---

# 🗂️ 文件夹结构分析

递归扫描目录并产出结构报告：概览统计、限量目录树、扩展名分布、最大文件/子目录 TOP 榜、疑似重复文件（同名同大小）。零外部依赖（Node 内置模块），内置安全护栏（条目数上限、符号链接不递归、默认排除 node_modules/.git 等重目录）。

## 调用方式（SkillExecute 工具，action 三选一）

### ⭐ 综合结构报告（默认）

```
execute({ path: "D:/某个项目", action: "analyze" })
→ { success: true, report: "（Markdown 结构报告）", stats: { dirs, files, totalSize, truncated, dupeGroups } }
```

报告包含：概览统计 → 目录树（每层限量渲染）→ 扩展名分布 TOP → 最大子目录 TOP → 最大文件 TOP → 疑似重复文件。

### 仅目录树

```
execute({ path: "D:/某个项目", action: "tree", maxDepth: 4 })
```

### 仅查疑似重复（清理磁盘前先看这个）

```
execute({ path: "D:/下载目录", action: "dupes", topN: 20 })
```

## 参数

| 参数 | 默认 | 说明 |
|------|------|------|
| path | 当前工作目录 | 目标目录（绝对/相对均可） |
| action | analyze | analyze 综合报告 / tree 仅目录树 / dupes 仅疑似重复 |
| maxDepth | 8 | 递归深度上限（最大 20） |
| topN | 10 | 各 TOP 榜单条数（最大 30） |
| exclude | node_modules/.git 等 | 排除的目录名数组；传 `[]` 可关闭排除 |
| includeHidden | false | 是否包含 `.` 开头的隐藏条目 |

## 使用要点

- **先 analyze 后 dupes**：摸清结构用 analyze；清理磁盘用 dupes 看同名同大小文件。
- **巨型目录有护栏**：条目数超 3 万自动截断并在报告标注；目录树每层限量渲染不会刷屏。
- **默认排除** node_modules/.git/__pycache__/.crabpaw/dist/build——分析项目源码结构不需要它们；要看构建产物请传自定义 exclude。
- 报告是给人和模型读的 Markdown；如需程序化处理，读返回值 `stats` 字段。
