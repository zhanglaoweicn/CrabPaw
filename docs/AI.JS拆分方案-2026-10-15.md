# ai.js 拆分方案（P0 技术债）

> 2026-10-15 | 现状：`src/core/ai.js` 5253 行、146 处 require，全项目最重复杂度单点。
> 前置事实：**拆分已有成功先例与现成接缝**——`src/core/ai/` 子目录已存在（agent-router /
> context-processor / dsml / intents / streaming / tool-call-processor / tool-router 等
> 11 个模块、2549 行已迁出），本方案是既有拆分路线的延续，不是新发明。

## 一、现状解剖（实测）

| 区段 | 行范围 | 行数 | 职责 |
|---|---|---|---|
| ACI 缓冲/失败守卫/技能缓存 | 97–312 | ~215 | 会话级工具调用缓冲、failure guard |
| 文件生成意图族 | 417–663 | ~250 | filegen 意图正则×10、任务恢复、收答保底 nudge |
| executeToolCall | 702–954 | ~250 | 单工具执行 + 危险参数清洗 |
| prepareChatContext | 994–1360 | ~366 | 上下文组装（记忆/技能/渠道排除） |
| **chatImpl** | 1448–2794 | **~1350** | 非流式主循环 |
| 摘要/多Agent/enhancedChat | 2795–3055 | ~260 | 周边入口 |
| **chatStreamImpl** | 3067–5132 | **~2050** | 流式主循环（最大单点） |
| 中断转发 | 5133–5253 | ~120 | interrupt relay |

两个 `*Impl` 主循环合计约 3400 行，占 65%——拆分主战场在这里。

## 二、拆分原则（对应 Harness 治理维度）

1. **纯搬运优先**：先零行为变化搬移（voice-shell 五批拆分已验证此模式：3170→1919 行全绿）；
2. **每批一闸**：每批结束必须 `npm test` + 相关 eval 套件全绿才进下一批；
3. **依赖单向**：新模块只允许被 ai.js require，不允许反向 require ai.js（防环，守 layer:check 基线）；
4. **单测随迁**：搬移的纯函数补 jest 单测锁行为。

## 三、五批拆分清单（按风险从低到高）

| 批 | 内容 | 目标文件（src/core/ai/） | 预计迁出 | 风险 |
|---|---|---|---|---|
| 1 | 文件生成意图族（正则/恢复/保底 nudge，全是纯函数+常量） | `filegen-intent.js` | ~250 行 | 低 |
| 2 | ACI 缓冲 + failure guard + Lark card 缓存 + 技能缓存 | `session-state.js` | ~215 行 | 低 |
| 3 | prepareChatContext + injectSkillGuidance + buildMemoryContextPrompt | `context-builder.js` | ~500 行 | 中 |
| 4 | executeToolCall + parseToolCall + stripHarmlessMetaParams（需与 tool-orchestrator/harness-hooks 的调用面核对） | `tool-executor.js` | ~300 行 | 中 |
| 5 | chatImpl / chatStreamImpl 主循环——先抽共同骨架（消息组装→模型调用→工具循环→收尾），两个 Impl 各自瘦身为差异分支；如仍超 800 行再按阶段拆 `stream-phases/*.js` | `chat-loop.js` + `stream-loop.js` | ~2000 行 | **高** |

第 5 批是真正的硬仗，建议单独开分支、单独一轮、由 eval:regression 全量门禁护航；
若时间紧可只做 1–4 批（迁出 ~1300 行，ai.js 降到 ~3950 行），收益/风险比已经很好。

## 四、验收标准

- `npm run precommit`（lint 含 layer:check + facts:check → test → eval）全绿；
- `src/core/ai.js` 每批迁出后行数只减不增，最终 ≤ 4200 行（1–4 批）或 ≤ 2200 行（含第 5 批）；
- 每个新模块有独立 jest 文件，`npx jest src/core/ai` 全绿；
- 对外 API 不变：ai.js 的 module.exports（chat/chatStream/enhancedChat/summarize/setToolCallCallback…）签名与行为逐一保持。

## 五、不建议在拆分中顺带做的事

- ❌ 顺带改任何提示词/路由逻辑（拆分必须是纯结构变更，混入行为变更会让回归无法归因）；
- ❌ 顺带接 OpenViking 网关（模型路由变更是独立工作项，走独立 eval）；
- ❌ CommonJS→ESM 迁移（gui 侧是 TS/ESM，src 侧保持 CJS 现状，避免双线作战）。
