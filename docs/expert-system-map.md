# 专家系统业务逻辑与流程全景图

> 2026-09-05 深度审计产出。覆盖管理舱「专家」页全部用户路径、后端专家系统全链路、数据分层与已知问题台账。
> 审计方式:双路勘察(前端全流程 / 后端全链路)+ 关键断言逐条人工核实 + 运行时黑盒探测。

## 一、系统组成

| 层 | 位置 | 职责 |
|---|---|---|
| 前端面板 | `gui/src/components/ExpertsPanel/`(index/ExpertCard/ExpertDetail/CreateExpert/RouterPanel/CollabWizard/ActivityFeed) | 管理舱 expert tab 的全部用户交互 |
| 主界面联动 | `gui/src/components/CollabOrbit`(协作成员卡)、`TaskOrbit`(任务轨道)、`ManagementCockpit`(expert tab 宿主, onSummon/onInsertToChat/onClose 契约) | 召唤话术注入、协作可视化 |
| 注册表核心 | `src/core/experts/index.js` | 三层数据合并、CRUD、路由打分、召唤、统计 |
| 组织层 | `src/core/experts/departments.js` | 七部门注册、编制政策、岗位别名、班组、部门工具面/技能包 |
| 校验器 | `src/core/experts/manifest-validate.js` | 清单面约束(仅告警不阻断) |
| 协作引擎 | `src/core/experts/collaboration.js` | 手选协作 + 部门例会两阶段编排、活动流存储 |
| 自动协作 | `src/core/experts/auto-collab.js` | 聊天意图触发多专家协作 |
| @提及 | `src/core/experts/mentions.js` | 消息中 @岗位 激活 |
| 聊天激活 | `src/core/expert-context.js` | 每轮按路由分激活/衰减人设 |
| HTTP 层 | `src/handlers/local-handlers/experts.js` | `/api/experts*` 全部端点 |

## 二、数据分层(加载顺序,后赢)

1. **代码内置层** 11 岗(`BUILTIN_EXPERTS`)+ `BUILTIN_DEPARTMENT_ASSIGNMENT` 注入部门/在编/别名/工具面;
2. **资产层** `data/experts-org.json`(268 位,部门化管线 `scripts/build-expert-org.js` 产物;运行时强制 builtin=false、source='agency-agents';id 撞内置跳过);
3. **回退层** `experts-from-agency-agents.json`(仅无组织库时);
4. **用户层** `DATA_DIR/experts.json`(同 id 覆盖一切,新 id 追加)。

关键不变量(2026-09-05 起):
- 用户层**只存自建记录**(`source !== 'agency-agents'`),不再整库快照导入专家(防资产再生成被陈旧副本遮蔽);
- 资产层删除落**墓碑**(`experts-deleted.json`),重启不复活;
- `builtin` 标志不可经 update 通道变更。

## 三、核心流程

### 3.1 浏览/过滤/搜索
- 装载 `loadData` 并行拉:分类过滤列表 + 分类 + 部门 + 班组 + **全量名单**(人名映射/重名校验用)。
- 部门 chips / 班组预设 chips / 分类下拉;部门为客户端过滤。
- 搜索:客户端过滤 + 500ms 防抖调 `POST /route`,第一名 score≥50 显示「隐式路由」tag;召唤按钮走 `handleSummonById`(先查过滤集,再按 id 兜底取详情)。

### 3.2 召唤(三条入口,同一后端语义)
`卡片/列表/详情/路由诊断/活动流 → handleSummon(ByById)`:
1. `GET /api/experts/:id` 取详情(404→null→toast「未找到该专家」);
2. `POST /api/experts/summon`(后端:**激活 + recordSession 计数**,单源;parked 可显式召唤);
3. `onSummon(detail)` → cockpit 注入话术「请以「X」(职称)的身份回答:」到输入框(不自动发送)→ 关闭 cockpit;
4. `POST /activity` 写「被召唤」流水(parked 之外均可点)。

后端 `resolveSummon` 四级匹配:精确 id → 别名/名/职称等值(优先于部门)→ 部门 id/别名/短句包含(激活主管)→ 双向模糊(多命中返回 candidates)。

### 3.3 聊天期人设激活(expert-context)
每轮 chat:mentions 解析(@岗位,最后者生效,命中则跳过路由)→ `routeAndActivate`:
- `routeMessage` 打分(关键词命中 +1/个、别名 +2、部门词 +1,归一化 0-100);
- **≥15 分才激活/切换**,未命中累计 3 轮未中即衰减清除;激活态为进程内存(每用户单槽,重启即失)。
- 激活后完整 systemPrompt 注入该轮;工具面/技能偏置由 ai.js/skill-router 消费。

### 3.4 详情/编辑/创建/删除
- 详情页自取 fresh detail;编辑(自建)→ `PUT /:id` 仅 systemPrompt;重置(仅内置)→ `POST /:id/reset`;删除(自建/资产层)→ `DELETE /:id`(资产层落墓碑;11 内置禁改禁删且不可旁路)。
- 创建 `POST /api/experts`:name 必填,重名校验用**全量名单**;不传 department → **泊车**(不参与自动路由/协作编排,仅显式召唤可达,创建页有提示)。

### 3.5 路由诊断(RouterPanel)
输入 → `POST /route`(全库打分,parked 跳过)→ 结果列表(第一名自动选中)→ `POST /chain` 协作链建议 → 「召唤」直达。失败保留旧结果仅停 loading。

### 3.6 协作编排(CollabWizard,手选)
滤掉 parked 选 2-4 人 + 各自子任务 → `POST /collab/start`(goal 必填,任务≤4,专家必须存在)→ 1.5s 轮询 `collab/status` 直到 done/error(连续 8 次查询失败才放弃;关闭面板即失联,后端有 collab/list 端点 GUI 未接)。
执行:成员并发(≤3)跑 SubAgent(人设独立注入,单任务 300s 超时/整体 600s 看门狗);**手动协作汇总是纯拼接**(无 LLM);广播 `collab:started/progress/completed/error`。

### 3.7 部门例会(两阶段)
部门 chip「例会」/ 班组预设 → `POST /collab/department`:
- Phase1 成员并行(quiet 模式,不写半程动态);Phase2 **主管真跑 LLM 汇总**(失败回退拼接);
- 完成广播 + 主管激活 + TaskRun lane + 活动流正式完成记录。
- 前端呈现:CollabOrbit 成员卡(按专家记名,queued 不建卡,整场终态强收)+ TaskOrbit 轨道 + 语音播报。

### 3.8 活动流(ActivityFeed)
`GET /activity`(上限 200 条,limit 合法化)双份字段兼容旧格式;10s 轮询。
行可点性 = 全量名单中存在该 expertId(collab 流水/空 expertId 行置灰「不在编」不可点);动作文案:summoned=被召唤 / routed=被路由匹配 / collab:*=协作动态。

## 四、2026-09-05 修复台账

### P1(已修)
| # | 问题 | 修复 |
|---|---|---|
| 1 | 聊天路由阈值 0.15 配 0-100 分制 = 任意 1 词命中即接管人设 | `MIN_SCORE=15`(expert-context.js) |
| 2 | createExpert 撞 id 用真值判断,下标 0(boss_cockpit)可被自定义专家遮蔽 | `!== undefined` 判定 |
| 3 | 任意 CRUD 把 268 位导入专家全量快照进 experts.json,遮蔽资产再生成 | 用户层只存 `source!=='agency-agents'` |
| 4 | 删除资产层专家重启复活 | 墓碑文件 + 加载过滤 |
| 5 | collabs/ 目录 2.4 万文件 + 每轮聊天全量扫盘(auto-collab 幂等) | 内存近期索引替代扫盘 + 30 天 TTL 惰性清理 |
| 6 | 使用计数双/三倍(GUI 卡片×1 + 详情×1 + 后端 summon×1) | GUI 侧 recordSession 全部移除,后端单源 |
| 7 | 详情页保存/重置成功后回显旧提示词 | 保存/重置成功同步本地 detail |

### P2(已修)
过滤视图下 manifest 误报孤儿引用(改全量校验);ROLE_ALIASES 7 键指向不存在 id(已按真身重映射);update 经 `builtin:false` 旁路篡改内置岗(封死+剥离字段);activity limit=NaN 返回空(合法化);例会 Phase1 premature「协作完成」动态(quiet 守卫);CollabWizard 轮询卸载后 setState + 单次错误永久停摆(守卫前置+连续 8 次才弃);召唤失败仍闪「已召唤」(成功才置位);expertNameMap/重名校验用过滤子集(改全量);活动流 quick stats 渲染「null N次」(空名守卫);CreateExpert 泊车语义无提示(补说明)。

### 遗留(记录在案,未动)
1. **268 条磁盘记录 builtin=true**——运行时已强制 false,保护逻辑只对 11 代码内置生效;建议生成管线直接写 false 或按 source 判定(本轮已部分缓解:存储过滤/墓碑按 source 走)。
2. **激活单槽制**:每用户仅 1 个激活专家,@财务部 @营销部 只有最后者生效——多部门点名语义需产品决策。
3. **汇总双标准**:手选协作=纯拼接,例会=主管 LLM 汇总,同 UI 质量不一致。
4. **例会两阶段间 status 瞬时 done**(Phase1 收尾置 done → Phase2 置 synthesizing),轮询方可能提前见 done。
5. **TaskRun lane 执行期不更新**(例会成员 lane 全程 waiting,收尾一次性翻转),与「进度见任务面板」承诺有落差。
6. **collab/list 端点响应无 data 包装**(破坏全站约定)+ GUI 未接历史协作入口(协作启动后关面板即失联)。
7. **VoiceShell/纯 API 召唤不写活动流水**(activity 依赖 GUI 客户端补报)。
8. 用户层与资产层的「覆盖一切」合并顺序 vs 资产可再生成的定位矛盾——长期应让用户层只存 override 增量。

## 五、测试基线

- 后端:experts 相关 10 套件 109 用例全过(boss/manifest-validate/manifest-runtime/voice/context/delegation/auto-collab/api-routes.contract/departments/mentions)。
- 前端:79 文件 765 用例全过(含 collab-orbit reducer finishAll、FocusRibbon、sheet-state overlay 等)。
