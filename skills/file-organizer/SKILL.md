---
name: file-organizer
version: 1.0.0
description: "文件整理，按规则自动分类（类型/日期/项目）、智能重命名、归档，保持桌面和下载目录整洁。当用户说“桌面好乱帮我整理”“下载文件夹按类型归档”“批量重命名文件”时使用。"
metadata:
  crabpaw:
    emoji: "🗂"
    category: office
    capabilities: [file_organization]
    triggers: [organize, file_sort, cleanup, tidy, arrange_files, file_management]
    platforms: [linux, macos, windows]
    requires: [bash, file_read]
---

# 🗂 文件整理

## 概述

自动化文件整理，让桌面、下载目录、项目文件夹保持整洁有序。

## 核心功能

### 1. 自动分类
/file organize <目录>
按文件类型分类：文档/图片/视频/压缩包/代码/其他
按日期归档：YYYY/MM 目录结构
按项目归类：根据文件名关键词

### 2. 智能重命名
/file rename <文件> --pattern "YYYY-MM-DD_项目名_版本号"
从文件内容推断关键信息
批量重命名
保留原始文件名映射

### 3. 清理规则
/file clean --older-than 30d --type "*.tmp,*.log"
清理过期临时文件
归档旧版本
去重（按内容哈希）

### 4. 自动监控
/file watch <目录> --rule "图片->Pictures, 文档->Documents"
监控指定目录
新文件自动按规则移动
即时通知

### 5. 整理报告
/file report <目录>
目录结构分析
空间占用分布
重复文件列表
整理建议

## 预设规则

下载目录: *.exe->Software, *.pdf->Documents, *.jpg->Pictures
桌面: 超过7天未打开的文件 -> Archive
项目目录: node_modules/* -> .gitignore 提示
