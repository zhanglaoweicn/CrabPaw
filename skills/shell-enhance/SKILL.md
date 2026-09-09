---
name: shell-enhance
version: 1.0.0
description: "智能命令行辅助技能，理解项目上下文，把自然语言需求转成正确Shell命令，兼容Windows PowerShell与Linux Bash。当用户想查端口进程、批量操作文件、配置环境时使用。"
metadata:
  crabpaw:
    emoji: "💻"
    category: system
    capabilities: [shell_command]
    triggers: [shell, terminal, command_line, bash, powershell, cmd]
    platforms: [linux, macos, windows]
    priority: 5
    tags: [system, cli, terminal]
---

# 💻 智能命令行辅助

## 概述

理解项目上下文和用户意图，将自然语言描述转换为正确、安全的Shell命令。

## 核心能力

| 场景 | 示例 |
|------|------|
| **文件操作** | "找出所有大于10MB的日志文件并压缩" |
| **进程管理** | "查看占用8080端口的进程并杀掉" |
| **文本处理** | "提取所有ERROR日志并按时间排序" |
| **网络诊断** | "检查与api.example.com的网络连通性" |
| **环境配置** | "设置JAVA_HOME环境变量" |
| **批量操作** | "将所有PNG图片转换为WebP格式" |

## 平台适配

- Windows: 优先输出PowerShell命令
- Linux/macOS: 输出Bash命令
- 自动检测当前平台并适配命令语法

## 安全检查

以下操作需要用户确认：
- rm -rf / Remove-Item -Recurse -Force
- 修改系统配置/注册表
- 安装/卸载软件
- 修改环境变量
- 涉及sudo的操作

## 使用方式

/shell <自然语言需求>
/shell --explain <命令>
/shell --dry-run <需求>
