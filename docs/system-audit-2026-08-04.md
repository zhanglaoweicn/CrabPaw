# CrabPaw 系统深度审计报告(2026-08-04)

> 5 维度并行审计:前端业务逻辑 / 前后端契约 / 工具调用链路 / 技能系统 / 卡片流程
> 审计方式:只读代码分析 + 运行时日志交叉验证

## 审计结论总览

| 维度 | P0(致命) | P1(功能失败) | P2 |
|---|---|---|---|
| 工具调用链路 | 1 | 5 | 2 |
| 前端业务逻辑 | 2 | 4 | 5 |
| 前后端契约 | 0 | 6 | 6 |
| 技能系统 | 2 | 5 | 2 |
| 卡片流程 | 1 | 4 | 4 |
| **合计** | **6** | **24** | **19** |

---

## P0 — 致命问题(直接导致用户可见功能失败)

### 1. skill_manage 参数断裂——技能执行收到空 input
【src/core/skills.js:1255-1276 JavaScriptExecutor.run】
LLM 传 `params:{title,content...}` → executeInput 合并 scriptPath → `fn(...args, context)`,args 默认 `[]` → **整个 input 对象被丢弃**,执行器收到 `context={}`。html-generator 生成空壳页、word-docx/pdf 报"请提供内容"、summarize-pro 返回空摘要。
**修复**:JS 执行器将 input 作为首参传入 `fn(input, context)`。

### 2. 工具契约 84 个与 registry 不一致——合法调用被契约误杀
【src/core/tool-contract.js preExecuteHook vs src/tools/*.js registry schema】
契约全部 `additionalProperties:false`,按"理想参数"手写;LLM 视野 schema 来自 registry。196 工具中 **84 个不一致**(Bash 的 cwd、WebSearch 的 backend/engine、skill_generate 的 skillName、TodoWrite 的 mode 等)。真实调用被拒 → 重试仍失败 → 降级回复。
**修复**:以 registry 为唯一事实源自动生成契约。

### 3. 打断不触发 onInterrupted——isSpeaking 死锁
【gui/src/hooks/useVoiceChatFlow.ts:133-139】
`interruptTTS()` 无参调用时 fireCallbacks 为 undefined,onInterrupted 不触发 → `setIsSpeaking(false)` 永不执行。触发路径:静音切换、onError 降级。球体永久"播报中"、ASR 会话永久挂起(连续对话死锁)。
**修复**:打断路径统一触发回调。

### 4. TTS 播放 Promise 无超时——网络挂起全链停摆
【gui/src/hooks/useVoiceReply.ts:236-271/418-457】
playTTSViaHttpGet/playTTSStream 的 Promise 只在 onended/onerror 时 settle;GET 流中段挂起时 playNext 永久 pending → 队列停播、onComplete 不触发、mic 挂起。
**修复**:播放 Promise 加整体超时(15s)走降级链。

### 5. DocReader morph 竞态——生成舱永久失效
【gui/src/components/DocReader/index.tsx:88-104】
close() 不清除 file_generated 的 900ms morph 定时器,回调无 closedRef 守卫。用户关舱后 file_generated 到达 → phaseRef 卡在 reading → 后续 tool_call 永不 openBay(需刷新页面)。
**修复**:定时器存 ref,close() 清除;回调开头检查 closedRef。

### 6. 全局技能目录遮蔽内置真执行器
【src/core/skills.js:1553-1568】
executeSkillAdvanced 先查 GLOBAL_SKILLS_DIR 再兜底 SKILLS_DIR。data/skills/deep-research 与内置同名但只有 SKILL.md 无执行器 → 真执行器(skills/deep-research/executor.js)被文档壳遮蔽 → "No executor found"。
**修复**:全局目录无执行器时回退内置目录。

---

## P1 — 功能失败(次优先级)

### 工具调用链路
- **chatStream 与 chat 工具集不一致**:流式(语音主路径)未走意图注入,全量 80+ 工具;chat() 走 buildToolDefinitions(意图路由/熔断/checkFn)。→ chatStream 复用 buildToolDefinitions
- **tool_result 事件缺 toolName**:onToolEnd 无 toolName → 前端工具卡工具名为空
- **非流式 chat() 零事件广播**:stream:false 时前端无工具卡/文件卡,DocReader 不触发
- **Write 只对 .html 广播 file_generated**:.md/.txt 等无广播 → DocReader 停在 generating 60s 超时收起
- **幻觉门 _hallucinationGuardFired 模块级共享**:并发请求互踩;chat() 无此门

### 前端业务逻辑
- **start 事件缺失 → 整条回复无 TTS**:beginStreamingTTS 仅在 onStreamStart 调用,无"首 chunk 惰性启动"兜底
- **Dashboard onError 不清理 TTS 状态**:mid-stream 错误后会话挂死
- **consumed 指针漂移**:基于清洗后文本,markdown 清洗缩水 → 朗读与显示错位
- **重复句子被去重丢弃**:sttsExtractedRef 按内容去重,重复句播报缺失
- **finalize 早于最终 flush**:尾段文本永久丢失
- **预取命中播放失败静默吞掉**:不走降级,该段无声音
- **VoiceStateContext ttsActive 恒 false**:双源状态不同步温床
- **stopSession flush 失效**:末句丢失

### 前后端契约
- **useSpeechQueue 裸 fetch 401**:语音回复队列 TTS 全 401
- **Dashboard voice_play audio 无鉴权 401**:AI 主动语音播不出
- **VoiceShell 上传依赖 creds.token 恒空 401**:附件上传失败
- **workflow:step 前端监听后端不广播**:多步任务步骤卡永不更新
- **浏览器模式系统性 401**:getApiHeaders 浏览器模式恒空
- **subagent 事件名不统一**:后端广播 'subagent',前端监听 subagent:start/end
- **api:proxy 白名单 '/' startsWith 恒真**:SSRF 白名单形同虚设

### 技能系统
- **detectExecutorType 漏 analyzer.js/summarizer.js/index.js**:合法技能被拒
- **依赖检查只查全局不查本地 node_modules**:可用性判定错误
- **DOC_CATEGORY_RE 与 DocReader OPEN_RE 互斥失效**:非文档技能双卡同屏
- **薄壳执行器 6/10**:html-generator/excel-xlsx/powerpoint-pptx/chart-generator/summarize-pro/report-generator 声称能力未实现
- **skill-tools 三套 frontmatter 解析器**:SkillsList category/depIssues 判定矛盾

### 卡片流程
- **60s 超时守卫对 write 类开舱无效**:误开舱永久占屏
- **__taskPanel 接口从未注册**:语音"打开任务面板"永远失败播报
- **crabpaw:open-browser 无人监听**:浏览器自动预览死广播

---

## 修复路线图

### 第一波(P0,本轮实施)
1. skill_manage 参数断裂 → JS 执行器传 input
2. 契约单源化 → registry schema 自动生成契约(84 个一次性修复)
3. interruptTTS onInterrupted 死锁 → 打断统一触发回调
4. TTS 播放超时 → 播放 Promise 15s 超时降级
5. DocReader morph 竞态 → 定时器 ref + closedRef 守卫
6. 全局目录遮蔽 → 无执行器回退内置

### 第二波(P1,下一轮)
7. chatStream 复用 buildToolDefinitions
8. tool_result 补 toolName + Write 全扩展名广播 + 非流式广播
9. start 事件缺失惰性启动 + Dashboard onError 清理
10. 前端鉴权统一(useSpeechQueue/voice_play/上传走 streamUrl)
11. 幻觉门作用域 + chat() 复用
12. 技能执行器探测补齐 + 依赖检查修正

### 第三波(P2,按需)
13. 冗余广播/事件名统一/SSE 单例/死监听清理/z-index 微调
