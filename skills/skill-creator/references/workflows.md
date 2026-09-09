# 工作流模式

## 顺序工作流

对于复杂任务，将操作分解为清晰的顺序步骤。通常在 SKILL.md 开头给出流程概览：

```markdown
填写 PDF 表单涉及以下步骤：

1. 分析表单（运行 analyze_form.py）
2. 创建字段映射（编辑 fields.json）
3. 验证映射（运行 validate_fields.py）
4. 填写表单（运行 fill_form.py）
5. 验证输出（运行 verify_output.py）
```

## 条件工作流

对于有分支逻辑的任务，引导 AI 通过决策点：

```markdown
1. 确定修改类型：
   **创建新内容？** → 按"创建工作流"执行
   **编辑现有内容？** → 按"编辑工作流"执行

2. 创建工作流：[步骤]
3. 编辑工作流：[步骤]
```

## CrabPaw 路由配置工作流

创建新技能后，必须配置路由：

1. 确定技能分类（在 `TASK_CATEGORIES` 中查找或新建）
2. 将技能名添加到分类的 `skills` 数组
3. 补充分类 `keywords`
4. 在 `INTENT_PATTERNS` 中添加匹配用户请求的正则模式
5. 设置 `skillHint` 和 `confidence`
6. 验证路由：`node -e "const {INTENT_PATTERNS} = require('./src/core/skill-router'); ..."`
