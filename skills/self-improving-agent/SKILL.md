---
name: self-improving-agent
description: "持续自我改进技能，命令失败、用户纠正或发现更好方法时自动记录学习经验到.learnings/。当用户纠正AI、说「记住这个」、命令报错或要求保存经验时使用。"
version: "4.0.0"
metadata:
  crabpaw:
    emoji: "📎"
    category: meta
    capabilities: [self_improvement]
    triggers:
      - error_detection
      - user_correction
      - knowledge_gap
    platforms: [linux, macos, windows]
---

# Self-Improvement Skill

持续学习和自我改进——记录错误、纠正和最佳实践，实现能力持续提升。

## 触发条件

以下场景发生时，Background Review Fork 会自动检测并触发技能更新：
1. 命令或操作意外失败
2. 用户纠正（"不对..."、"应该..."、"不要这样..."）
3. 发现更简单/更好的完成方法
4. 用户显式要求记录（"记住这个"、"保存技能"）

## 学习文件结构

项目根目录创建 `.learnings/` 目录：

```
.learnings/
├── LEARNINGS.md          # 学习记录、纠正、最佳实践
├── ERRORS.md             # 错误记录、异常原因
└── index.md              # 索引和统计
```

### LEARNINGS.md 格式

```markdown
## [LRN-YYYYMMDD-XXX] 类别

**时间**: ISO-8601
**优先级**: low | medium | high | critical
**状态**: pending | applied | archived

### 摘要
一句话描述学到了什么。

### 详情
完整上下文：发生了什么、哪里出错了、正确做法。

### 建议
如何防止再次发生。
```

### ERRORS.md 格式

```markdown
## [ERR-YYYYMMDD-XXX] 错误类型

**时间**: ISO-8601
**命令**: 出错的命令
**错误**: 错误信息
**原因**: 根本原因
**修复**: 解决方案
**状态**: resolved | open | wont_fix
```

## 安全边界

### 禁止存储

| 类别 | 示例 |
|------|------|
| 凭证 | 密码、API Key、Token、SSH 密钥 |
| 财务 | 银行卡号、银行账户 |
| 医疗 | 诊断、药物、病情 |
| 第三方信息 | 关于他人的个人信息 |
| 位置模式 | 住址、工作地点、日常路线 |

### 谨慎存储

| 类别 | 规则 |
|------|------|
| 工作上下文 | 项目结束后衰减，不跨项目共享 |
| 人际关系 | 仅记录角色（"经理"），不记录个人信息 |
| 日程 | 通用模式可记录（"上午忙"），不记录具体时间 |

### 一键清除

用户说"忘记一切"时：
1. 导出当前记忆到文件（供审查）
2. 清除所有学习数据
3. 确认："记忆已清除，重新开始"

## 快速查询

| 用户说 | 操作 |
|--------|------|
| "你知道 X 什么？" | 搜索全部层级，返回匹配和来源 |
| "看看我的记忆" | 显示 LEARNINGS.md 内容 |
| "忘记 X" | 从所有层级移除，确认删除 |
| "忘记一切" | 完整清除，先导出 |
| "记忆统计" | 显示各层级数量和最近活动 |

## 与自动学习系统的关系

**重要**：CrabPaw 的 Background Review Fork 会在每轮对话后自动运行，
检测学习信号并主动更新技能。本 SKILL.md 作为手动补充——
当 Agent 需要显式记录或查询学习内容时使用。

自动系统 > 手动记录。如果 Background Review Fork 已经捕获了某个
学习信号，本技能不需要重复记录。
