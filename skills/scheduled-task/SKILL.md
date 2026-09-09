---
name: scheduled-task
version: 1.0.0
description: "定时任务管理技能，创建、管理、监控一次性提醒与周期性任务，支持cron表达式和条件触发。当用户说「下午3点提醒我」「每天早上9点推送」或要设提醒时使用。"
metadata:
  crabpaw:
    emoji: "⏰"
    category: automation
    capabilities: [scheduling]
    triggers: [schedule, reminder, cron, timer, alarm, periodic, recurring]
    platforms: [linux, macos, windows]
---

# ⏰ 定时任务管理

## 概述

全面的定时任务和提醒管理，支持多种触发模式和执行策略。

## 核心能力

| 能力 | 示例 |
|------|------|
| **一次性提醒** | "下午3点提醒我开会" |
| **每日任务** | "每天早上9点发送今日待办" |
| **每周任务** | "每周五下午5点生成周报" |
| **Cron表达式** | 支持标准cron语法 |
| **条件触发** | "当天气下雨时提醒我带伞" |
| **任务链** | "完成A任务后自动触发B任务" |

## 任务类型

| 类型 | 说明 |
|------|------|
| reminder | 提醒通知 |
| report | 自动生成报告 |
| command | 执行系统命令 |
| workflow | 触发工作流 |
| api-call | 调用外部API |

## 任务状态

pending -> scheduled -> running -> completed
                            -> failed -> retry -> running

## 使用方式

/task create "任务名" --at "2026-07-01 09:00"
/task create "日报" --cron "0 18 * * 1-5"
/task list
/task delete <task-id>
/task history

## 执行记录

每次执行会记录：执行时间、执行结果、错误信息、执行耗时
