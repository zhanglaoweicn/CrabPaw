---
name: email-assistant
version: 1.0.0
description: "邮件助手，收件箱智能摘要、自动分类（重要/待回复/通知）、草拟回复、批量归档建议。当用户说“看看邮件”“帮我回复一下邮件”“整理收件箱”时使用。"
metadata:
  crabpaw:
    emoji: "📧"
    category: office
    capabilities: [email_management]
    triggers: [email, mail, inbox, reply, send_email, check_mail]
    platforms: [linux, macos, windows]
    requires: [email_list, email_read, email_send, email_search]
    priority: 3
    tags: [email, communication]
---

# 📧 邮件助手

## 概述

智能邮件管理，帮你高效处理收件箱。

## 核心功能

### 1. 收件箱摘要
/email digest
未读邮件数量 + 关键邮件摘要
按重要性排序（紧急回复 > 等待回复 > 仅通知 > 垃圾）
每日/每周定时推送

### 2. 自动分类
/email classify
重要且紧急: 老板/客户的邮件，需要今天回复
重要不紧急: 项目更新、周报，可以稍后处理
紧急不重要: 会议邀请、系统通知
不重要不紧急: 订阅、广告、Newsletter

### 3. 草拟回复
/email reply "邮件内容摘要" --tone professional
根据邮件内容草拟回复
支持语气选择（正式/友好/简洁）
自动附上原始邮件引用

### 4. 批量操作
/email archive --before 2026-01-01
归档旧邮件建议
退订不活跃的订阅
清理垃圾邮件

### 5. 邮件模板
/email template --type "项目周报"
常用邮件模板库
快速填充变量
