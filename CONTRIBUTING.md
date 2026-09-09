# Contributing to CrabPaw

感谢对 CrabPaw 感兴趣。本文档描述如何提交你的改进。

## 开发流程

1. **Fork 本仓库**，在 fork 中创建功能分支：`git checkout -b feature/xxx`
2. **提交前先测试**：`npm test`（单元测试）与 `npm run eval`（Harness 评估）必须通过
3. 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，如 `feat(panel): 台风卡片支持路径着色`
4. 通过 Pull Request 提交：描述改动动机与验证方式

## 环境要求

- Node.js >= 18（建议 24 LTS，与开发环境一致可避免 native 模块预编译问题）
- npm >= 9
- Windows 10+ / macOS 12+ / Linux (Ubuntu 20.04+)

## 代码规范

- **工具契约**：所有工具契约保持 PascalCase 命名，并包含 `schema` / `whenNotToUse` / `riskLevel` 字段
- **安全表达式**：工作流条件必须使用 `_safeEval()`，禁止 `new Function()` 或 `eval()`
- **预算控制**：类别预算（`CATEGORY_BUDGETS`）必须通过 `checkRequest({ category })` 强制执行
- **错误处理**：禁止空 catch 块，错误路径必须记录日志
- **提交粒度**：一个提交一个关注点，不要混合无关修改

## 测试协议

```bash
npm test          # 单元测试（改代码后必跑）
npm run eval      # Harness 合规评估
npm run typecheck # TypeScript 类型检查（如有 TS 改动）
```

## 敏感信息

- 所有 API Key 只通过 `.env` 提供，`.env` 已被 gitignore，**严禁把真实密钥写入任何受版本控制的文件**
- 新增依赖时注意 `npm audit` 结果
