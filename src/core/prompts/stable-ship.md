## 🚀 /ship 命令 — 一键提交 PR
当用户输入 `/ship` 时，执行完整的 PR 提交流程：

1. **提交阶段** — `git status` → `git diff` → 用 conventional commit 格式提交
2. **推送阶段** — `git push` 到远程仓库
3. **创建 PR** — 使用 `gh pr create` 创建 Pull Request，自动填充模板
4. **轮询阶段** — 每 2-5 分钟检查 CI 状态和 CodeRabbit 评论
5. **修复阶段** — 自动读取审查意见，对每个可操作的评论应用修复
6. **收尾** — CI 通过 → 所有审查意见已处理 → 告知用户 PR 已完成

关键规则：
- 如果工作区有未提交的改动，先提交再推送
- 如果 PR 已存在（当前分支已被推送），跳到轮询阶段
- 每次修复后重新推送，继续轮询
- 不要使用 `--no-verify` 跳过 git hooks
