---
name: skill-creator
version: "0.1.0"
description: "技能创建指南，提供技能结构设计、渐进式披露、SKILL.md编写、脚本/参考/资产组织、验证打包方法论。当用户想创建新技能、更新现有技能或定制CrabPaw能力时使用。"
metadata:
  crabpaw:
    emoji: 🛠️
    category: meta
    capabilities: [prompt_design]
    triggers:
      - 创建技能
      - 新建技能
      - skill-creator
      - 技能开发
      - 技能打包
      - 技能验证
---

# 技能创建指南

当用户想创建新技能或更新现有技能，扩展 CrabPaw 的专业能力时使用此技能。

## 关于技能

技能是模块化、自包含的包，通过提供专业知识、工作流和工具来扩展 AI 的能力。可以将技能视为特定领域的"入职指南"——将通用代理转变为具备程序性知识的专业代理。

### 技能提供什么

1. **专业工作流** — 特定领域的多步骤流程
2. **工具集成** — 特定文件格式或 API 的操作指令
3. **领域专长** — 公司特定知识、数据模式、业务逻辑
4. **打包资源** — 复杂和重复任务的脚本、参考文档和资产

## 核心原则

### 简洁是关键

上下文窗口是公共资源。技能与系统提示、对话历史、其他技能元数据和用户请求共享上下文窗口。

**默认假设：AI 已经很聪明。** 只添加 AI 不具备的上下文。对每条信息质疑："AI 真的需要这个解释吗？"和"这段文字值得它的 token 成本吗？"

优先使用简洁示例而非冗长解释。

### 设置适当的自由度

将具体程度与任务的脆弱性和可变性匹配：

**高自由度（文本指令）**：当多种方法有效、决策依赖上下文、或启发式指导方法时使用。

**中自由度（伪代码或带参数的脚本）**：当存在首选模式、某些变化可接受、或配置影响行为时使用。

**低自由度（特定脚本，少参数）**：当操作脆弱易错、一致性关键、或必须遵循特定序列时使用。

### 技能结构

每个技能由必需的 SKILL.md 文件和可选的打包资源组成：

```
skill-name/
├── SKILL.md（必需）
│   ├── YAML frontmatter 元数据（必需）
│   │   ├── name:（必需）
│   │   ├── description:（必需）
│   │   └── metadata: （CrabPaw 扩展字段）
│   │       └── crabpaw:
│   │           ├── emoji:
│   │           ├── category:
│   │           └── triggers: []
│   └── Markdown 指令（必需）
└── 打包资源（可选）
    ├── scripts/          - 可执行代码（Python/Bash 等）
    ├── references/       - 按需加载到上下文的文档
    └── assets/           - 输出中使用的文件（模板、图标、字体等）
```

#### SKILL.md（必需）

每个 SKILL.md 包含：

- **Frontmatter**（YAML）：包含 `name`、`description` 和 `metadata` 字段。`name` 和 `description` 是 AI 判断何时使用技能的主要依据，因此必须清晰全面。
- **正文**（Markdown）：使用技能的指令和指导。仅在技能触发后加载。

**CrabPaw Frontmatter 格式：**

```yaml
---
name: skill-name
version: "1.0.0"
description: "技能描述。说明技能做什么以及何时使用。"
metadata:
  crabpaw:
    emoji: 🔧
    category: category-name
    triggers:
      - trigger-keyword-1
      - trigger-keyword-2
---
```

#### 打包资源（可选）

##### scripts/

可执行代码（Python/Bash 等），用于需要确定性可靠性或被反复重写的任务。

- **何时包含**：当相同代码被反复重写或需要确定性可靠性时
- **示例**：`scripts/rotate_pdf.py` 用于 PDF 旋转任务
- **好处**：token 高效、确定性、可在不加载到上下文的情况下执行

##### references/

按需加载到上下文的文档和参考材料。

- **何时包含**：AI 工作时需要参考的文档
- **示例**：`references/api_docs.md`、`references/schema.md`
- **最佳实践**：如果文件较大（>10k 字），在 SKILL.md 中包含 grep 搜索模式
- **避免重复**：信息应存在于 SKILL.md 或参考文件中，不要两者都有

##### assets/

不加载到上下文，而是在 AI 产出的输出中使用的文件。

- **何时包含**：技能需要在最终输出中使用的文件
- **示例**：`assets/logo.png`、`assets/template.pptx`、`assets/frontend-template/`

### 渐进式披露设计原则

技能使用三级加载系统高效管理上下文：

1. **元数据（name + description）** — 始终在上下文中（~100 词）
2. **SKILL.md 正文** — 技能触发时（<5k 词）
3. **打包资源** — 按需加载（无限制，因为脚本可不读入上下文直接执行）

**关键原则：** 保持 SKILL.md 正文在 500 行以内。接近此限制时将内容拆分到独立文件。

**模式 1：高级指南 + 参考**

```markdown
# PDF 处理

## 快速开始

使用 pdfplumber 提取文本：[代码示例]

## 高级功能

- **表单填写**：参见 [FORMS.md](FORMS.md)
- **API 参考**：参见 [REFERENCE.md](REFERENCE.md)
```

**模式 2：领域特定组织**

```
bigquery-skill/
├── SKILL.md（概览和导航）
└── reference/
    ├── finance.md（收入、账单指标）
    ├── sales.md（商机、管线）
    └── product.md（API 使用、功能）
```

**模式 3：条件详情**

```markdown
# DOCX 处理

## 创建文档

使用 docx-js 创建新文档。参见 [DOCX-JS.md](DOCX-JS.md)。

## 编辑文档

简单编辑直接修改 XML。
**修订追踪**：参见 [REDLINING.md](REDLINING.md)
```

## 技能创建流程

### 步骤 1：通过具体示例理解技能

跳过此步仅当技能的使用模式已经清楚理解。

明确了解技能将如何被使用的具体示例。可通过用户直接提供或生成后经用户验证的示例。

关键问题：
- "这个技能应该支持什么功能？"
- "能举一些使用示例吗？"
- "用户会说什么来触发这个技能？"

### 步骤 2：规划可复用的技能内容

分析每个示例：
1. 考虑如何从零执行该示例
2. 识别反复执行时哪些脚本、参考和资产有帮助

**示例分析：**
- "帮我旋转这个 PDF" → 需要 `scripts/rotate_pdf.py`
- "给我建一个待办应用" → 需要 `assets/hello-world/` 模板
- "今天有多少用户登录？" → 需要 `references/schema.md`

### 步骤 3：初始化技能

运行初始化脚本创建技能目录结构：

```bash
python3 skills/skill-creator/scripts/init_skill.py <技能名> --path <输出目录>
```

脚本会：
- 创建技能目录
- 生成带 frontmatter 和 TODO 占位符的 SKILL.md 模板
- 创建示例资源目录：`scripts/`、`references/`、`assets/`
- 添加示例文件

### 步骤 4：编辑技能

#### 编写 SKILL.md

**写作指南：** 始终使用祈使句/不定式形式。

**Frontmatter：**
- `name`：技能名称（hyphen-case）
- `description`：这是技能的主要触发机制。包含技能做什么以及何时使用的具体场景/上下文。所有"何时使用"信息放在这里，而非正文中。

**正文：**
- 只包含 AI 不具备的程序性知识
- 参考打包资源而非内联所有内容
- 使用简洁示例而非冗长解释

**参考设计模式：**
- 多步骤流程 → 参见 [workflows.md](references/workflows.md)
- 特定输出格式或质量标准 → 参见 [output-patterns.md](references/output-patterns.md)

### 步骤 5：验证技能

运行验证脚本检查技能结构：

```bash
python3 skills/skill-creator/scripts/quick_validate.py <技能目录路径>
```

验证内容：
- YAML frontmatter 格式和必需字段
- 技能命名约定和目录结构
- 描述完整性和质量
- 文件组织和资源引用

### 步骤 6：打包技能

```bash
python3 skills/skill-creator/scripts/package_skill.py <技能目录路径> [输出目录]
```

打包脚本会先自动验证，然后创建 .skill 文件。

### 步骤 7：配置 CrabPaw 路由

**这是 CrabPaw 特有的步骤。** 在 `src/core/skill-router.js` 中添加路由配置：

1. **添加到分类**：在 `TASK_CATEGORIES` 中找到合适的分类，将技能名添加到 `skills` 数组，补充关键词

2. **添加意图模式**：在 `INTENT_PATTERNS` 中添加匹配用户请求的正则模式：

```javascript
{
  pattern: /(?:关键词1|关键词2|关键词3)/i,
  category: 'CATEGORY_NAME',
  skillHint: 'skill-name',
  confidence: 0.9
}
```

3. **如需新分类**：创建新的分类对象：

```javascript
NEW_CATEGORY: {
  name: 'new-category',
  keywords: ['关键词1', '关键词2'],
  skills: ['skill-name']
}
```

### 步骤 8：迭代

使用技能后根据实际效果改进：
1. 在真实任务中使用技能
2. 注意困难或低效之处
3. 识别 SKILL.md 或资源需要如何更新
4. 实施变更并再次测试

---

## 不应包含的内容

技能只应包含直接支持其功能的核心文件。**不要**创建额外的文档或辅助文件：
- README.md
- INSTALLATION_GUIDE.md
- QUICK_REFERENCE.md
- CHANGELOG.md

技能只应包含 AI 完成任务所需的信息。

---

## 快速参考

| 步骤 | 命令 |
|------|------|
| 初始化 | `python3 scripts/init_skill.py <名称> --path <路径>` |
| 验证 | `python3 scripts/quick_validate.py <路径>` |
| 打包 | `python3 scripts/package_skill.py <路径>` |
| 路由 | 编辑 `src/core/skill-router.js` |

## 技能导入

CrabPaw 支持从多种来源导入技能：

### GitHub 导入
crabpaw skill import gh:user/repo/skills/my-skill

### URL 导入
crabpaw skill import https://example.com/skill.zip

### 本地文件导入
crabpaw skill import ./my-skill.zip
crabpaw skill import ./my-skill/

### 在线市场
crabpaw skill search <query> — 搜索在线技能市场
crabpaw skill updates — 检查已安装技能的更新

导入的安全策略：
- 所有外部技能自动经过安全扫描
- 默认以只读模式运行
- 含网络/文件写入的 executor 需要用户授权

## 技能进化

技能支持多维度自动进化：

| 类型 | 说明 |
|------|------|
| FIX | 修复执行错误或过时逻辑 |
| DERIVED | 从现有技能派生增强版 |
| CAPTURED | 从对话模式捕获新技能 |
| FUSED | 合并两个相关技能创建更强大的组合 |

进化闭环：
- 执行分析 → 生成提案 → 安全验证 → 灰度发布 → 回滚保护
- 每次进化自动生成 changelog
- A/B 实验模式支持渐进式上线

## 技能融合

crabpaw skill suggest-fusions — 发现可融合的技能对
crabpaw skill fuse <skillA> <skillB> — 执行技能融合

融合引擎基于组合图上高频共现 + 语义相似度自动发现候选。

## 技能热替换

技能支持运行时热替换，无需重启：
- 在 data/skills/ 添加/删除目录即时生效
- 拖拽 .zip 到 GUI 即可导入
- 注册表自动刷新，命令缓存即时失效

## 技能即服务

声明 mode: "service" 的技能以长驻守护进程运行：
- startService / stopService / estartService / getServiceStatus
- 30s 心跳监测 + 自动重启（5分钟内最多3次）
- IPC 通信（process.send / process.on('message')）

## 技能血缘

追踪技能间的派生/继承/融合关系：
- getAncestors(skill) / getDescendants(skill) / getAffectedSkills(skill)
- 当父技能进化时，自动提示所有派生技能更新
- 支持 DOT 格式导出可视化

## 技能适配层

通用的意图自动路由到渠道特定技能：
- send_message → 飞书/企微/邮件（根据上下文）
- schedule_meeting → 飞书日历/企微日历
- 支持自定义适配器注册

## 联邦技能市场

支持多源技能注册中心：
- clawhub（官方）
- GitHub 组织和仓库
- 私有 HTTP registry
- 本地目录 registry
- 通过 config.yaml 的 skillRegistries 配置
