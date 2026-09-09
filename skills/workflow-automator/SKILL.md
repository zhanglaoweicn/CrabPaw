---
name: workflow-automator
version: 1.0.0
description: "工作流自动化技能，把多步骤重复业务串成一键流程，内置合同处理、报销处理等模板。当用户说「自动处理合同邮件、下载附件、填台账发审批」或要自动化流程时使用。"
metadata:
  crabpaw:
    emoji: "🤖"
    category: office
    capabilities: [desktop_automation]
    triggers: [automation, workflow, pipeline, auto_process, trigger, chain]
    platforms: [linux, macos, windows]
    requires: [email_list, doc_read, xlsx_query, email_send]
---

# 🤖 工作流自动化

## 概述

把重复性多步骤业务流程变成一键执行的自动化工作流。

## 内置工作流模板

### 合同处理流程
收到合同邮件 -> 下载附件 -> 提取关键信息(金额/日期/签约方) -> 填入合同台账Excel -> 发送审批通知

触发: 邮件主题包含"合同"
步骤:
1. email_read 读取邮件内容和附件
2. doc_read 提取合同关键字段
3. xlsx_query 写入台账
4. email_send 通知审批人

### 报销处理流程
收到报销申请 -> 验证发票信息 -> 汇总本月报销 -> 生成报销单 -> 发送财务

### 报表自动生成
每周五17:00 -> 拉取销售数据 -> 生成周报Excel -> 发送给管理层

### 客户跟进流程
新客户邮件 -> 提取需求 -> 分配跟进任务 -> 3天后未回复 -> 自动提醒

## 自定义工作流

/workflow create "流程名"
/workflow step add --action "email_read" --filter "subject:合同"
/workflow step add --action "doc_read" --input "{上一步附件路径}"
/workflow step add --action "xlsx_query" --file "台账.xlsx"
/workflow step add --action "email_send" --to "经理"

/workflow test "流程名"     # 测试运行
/workflow enable "流程名"    # 启用自动触发

## 触发器类型

- 邮件到达（指定关键词）
- 文件新增（监控目录）
- 定时触发（Cron）
- 手动触发（命令）
