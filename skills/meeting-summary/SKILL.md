---
name: meeting-summary
version: 1.0.0
description: "会议纪要整理，从录音（MP3/WAV/M4A/FLAC）、文字记录（TXT/MD/DOCX）或飞书妙记链接提取关键信息，生成含决议、待办、时间线的结构纪要。当用户说“整理会议纪要”“总结这段会议记录”或提供录音/妙记链接时使用。"
metadata:
  crabpaw:
    emoji: "📋"
    category: productivity
    capabilities: [meeting_summary]
    triggers: [meeting, meeting_notes, meeting_summary, minutes, agenda, conference]
    platforms: [linux, macos, windows]
    priority: 3
    tags: [meeting, summary, productivity]
---

# 📋 会议纪要

## 概述

从会议录音或文字记录中智能提取结构化信息，生成专业会议纪要。

## 输入源

| 类型 | 支持格式 |
|------|---------|
| 录音文件 | MP3, WAV, M4A, FLAC |
| 文字记录 | TXT, Markdown, DOCX |
| 飞书妙记 | 妙记链接 |

## 输出结构

```
# 会议纪要: [会议主题]
**时间**: YYYY-MM-DD HH:MM
**参会人**: 
**地点/方式**: 

## 一、会议议题

## 二、讨论要点

## 三、决议事项

## 四、待办事项

## 五、下次会议
```

## 使用方式

/meeting summarize <file-path>
/meeting summarize <飞书妙记链接>
/meeting action-items
/meeting decisions
