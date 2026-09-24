# CrabPaw Git 工作流

## 仓库

远程仓库（Gitee）：

```
https://gitee.com/zmgzlw/crab-paw.git
```

远程名称：`gitee`

## 工作流程

每次确认代码能跑通后：

```bash
bash save.sh "这次改了什么"
```

这个脚本会自动执行：

```
git add .          → 添加所有改动
git commit -m "xx" → 提交
git push gitee     → 推送到 Gitee
```

## 手动操作

```bash
# 查看改了什么
git status

# 查看提交历史
git log --oneline -10

# 回到某个历史版本
git checkout <commit-hash>

# 创建一个备份分支
git checkout -b stable-v0.1
```

## 注意事项

- 保存前确认后端能启动、前端能打开
- 一次保存只做一件事，commit 信息写清楚改了什么
- `data/.crabpaw/` 已在 `.gitignore` 中忽略，用户数据不上传
