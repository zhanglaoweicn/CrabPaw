# CrabPaw Electron 前端全面深度分析报告

> 分析范围：gui/ — Electron 主进程 / Preload / 构建配置 / 14 页面 / 78 组件 / 13 Hooks / 2 Contexts / 10 Lib 模块
> 分析日期：2026-07-27
> 目标：不留死角，找出数据链、接口、代码逻辑等方面的所有问题

---

## 目录

1. [安全漏洞 — 高危](#1-安全漏洞--高危)
2. [Electron 主进程问题](#2-electron-主进程问题)
3. [构建与配置问题](#3-构建与配置问题)
4. [API 层数据链问题](#4-api-层数据链问题)
5. [Scene 协议客户端问题](#5-scene-协议客户端问题)
6. [Dashboard 状态管理问题](#6-dashboard-状态管理问题)
7. [SSE 事件中枢问题](#7-sse-事件中枢问题)
8. [流式聊天与 TTS 集成问题](#8-流式聊天与-tts-集成问题)
9. [语音系统前端问题](#9-语音系统前端问题)
10. [全局 window.__ 污染](#10-全局-window-污染)
11. [页面组件问题逐页分析](#11-页面组件问题逐页分析)
12. [组件问题逐组件分析](#12-组件问题逐组件分析)
13. [Lib 模块问题](#13-lib-模块问题)
14. [Context 问题](#14-context-问题)
15. [Hooks 问题](#15-hooks-问题)
16. [类型安全与 TypeScript 问题](#16-类型安全与-typescript-问题)
17. [错误处理问题](#17-错误处理问题)
18. [性能问题](#18-性能问题)
19. [内存泄漏清单](#19-内存泄漏清单)
20. [Cross-Cutting 架构问题](#20-cross-cutting-架构问题)
21. [严重性汇总表](#21-严重性汇总表)

---

## 1. 安全漏洞 — 高危

### S1 [CRITICAL] `webSecurity: false` 禁用同源策略
**文件**: `gui/electron/main/index.ts:426`
```ts
webSecurity: false
```
完全禁用 Electron 的同源策略。任何 XSS 漏洞可导致：
- 读取任意本地文件（通过 `local://` 协议）
- 向任意域名发起网络请求
- 绕过 CORS 限制访问内网服务

### S2 [CRITICAL] `sandbox: false` 渲染进程未沙箱化
**文件**: `gui/electron/main/index.ts:425`
```ts
sandbox: false
```
渲染进程拥有完全的 Node.js 权限（通过 preload 暴露的 IPC）。结合 `webSecurity: false`，渲染进程沦陷后可：
- 通过 `file:read-base64` IPC 读取任意文件（路径校验有缺陷）
- 通过 `config:set` IPC 写入配置
- 通过 `api:proxy` 代理任意 API 请求

### S3 [HIGH] `local://` 协议路径穿越
**文件**: `gui/electron/main/index.ts:2021-2103`
`protocol.handle('local', ...)` 的实现中：
- 路径校验使用 `startsWith` 字符串前缀匹配（非严格路径解析）
- 无符号链接检查
- 无 CSRF token / origin 校验
- Windows 驱动器大小写绕过可能

### S4 [HIGH] API Token 暴露给渲染进程
**文件**: `gui/electron/main/index.ts:1177-1191`, `gui/electron/preload/index.ts:5-7`
IPC handler `api:credentials` 和 `api:streamUrl` 将 `API_TOKEN` 返回给渲染进程。XSS 后可获取 token，直接调用后端 API。

### S5 [HIGH] `allowRunningInsecureContent: true`
**文件**: `gui/electron/main/index.ts:428`
允许安全页面加载不安全内容，MITM 攻击面扩大。

### S6 [HIGH] `webviewTag: true` + 弹出窗口沙箱弱
**文件**: `gui/electron/main/index.ts:427, 528-534`
webview 标签启用，弹出窗口使用 `sandbox: false` 且 `webSecurity: false`。

### S7 [MEDIUM] 基于正则的 HTML 清洗器可绕过
**文件**: `gui/src/lib/sanitize.ts:51-82`
- 正则无法解析 HTML（非正则语言），存在多种绕过方式
- 事件处理器正则要求引号，`onclick=alert(1)` 无引号版本不匹配
- `data:` URI 清洗不全
- HTML 注释 `<!-- -->` 透传不处理

### S8 [MEDIUM] `file:read-base64` 路径校验不严
**文件**: `gui/electron/main/index.ts:1721-1726`
```ts
if (!resolvedPath.startsWith(dataDirResolved + path.sep))
```
字符串前缀匹配而非规范化路径比较，正斜杠/反斜杠绕过可能。

### S9 [MEDIUM] `file:open` 路径校验不严
**文件**: `gui/electron/main/index.ts:1694-1706`
同一字符串前缀匹配模式。

### S10 [MEDIUM] `config:set` 将密钥明文写入磁盘
**文件**: `gui/electron/main/index.ts:1432-1441`
传入的 Lark/WeCom secret 直接序列化到 config JSON 文件。

### S11 [MEDIUM] `apiUpload` 不发送认证头
**文件**: `gui/src/lib/api.ts:273-295`
```ts
const res = await fetchWithTimeout(`${baseUrl}${endpoint}`, { method:'POST', body: formData })
```
无 `getApiHeaders()` 调用，在 Electron 模式下也不走 proxy。上传操作无认证。

### S12 [MEDIUM] Preload 无输入校验
**文件**: `gui/electron/preload/index.ts:3-71`
所有 15 个 IPC channel 的参数直接透传给主进程，零校验。

---

## 2. Electron 主进程问题

### E1 [HIGH] `createWindow` 在 `DATA_DIR` 存在前调用
**文件**: `gui/electron/main/index.ts:2105-2106`
```ts
app.whenReady().then(() => {
  createWindow()     // ← 窗口先创建
  createTray()
  startLogRotation()
  // saveApiCredentials() 和 ensureDataDir() 在 startCrabPawServer 内才调用
})
```
窗口创建后 renderer 可能立即发起 IPC 调用，此时 `DATA_DIR` 可能尚未就绪。

### E2 [HIGH] `stopServices` 时序问题
**文件**: `gui/electron/main/index.ts:1076-1154`
`stopServices` 调用关停 API，然后设 1s timeout 杀进程。但 `crabpawServer.kill()` 在 timeout **之外**立即执行，优雅关停和强制杀进程时序颠倒。

### E3 [HIGH] `startCrabPawServer` 自旋等待
**文件**: `gui/electron/main/index.ts:690-704`
```ts
while (Date.now() - startTime < 30000) { await new Promise(r => setTimeout(r, 500)) }
```
30 秒自旋等待，CPU 空转。

### E4 [MEDIUM] `(app as any).isQuitting` 无类型安全
**文件**: `gui/electron/main/index.ts:882,1002,1067,2345`
在 App 对象上设置非标准属性。

### E5 [MEDIUM] `isStartingServer` 竞态条件
**文件**: `gui/electron/main/index.ts:1193-1275`
`isStartingServer` 是类级别 boolean，无互斥锁。两个并发 IPC `service:start` 可能同时通过校验。

### E6 [MEDIUM] 硬编码 APP_VERSION
**文件**: `gui/electron/main/index.ts:28`
```ts
const APP_VERSION = '1.0.0'
```
与 `package.json` version 字段完全脱钩。版本号变更需手动同步。

### E7 [MEDIUM] 日志流错误被静默吞掉
**文件**: `gui/electron/main/index.ts:225`
```ts
this.stream.on('error', () => {})  // ALL errors swallowed
```
磁盘写满、权限错误全部不可见。

### E8 [MEDIUM] `bytesWritten` 与 `_reopen()` 竞态
**文件**: `gui/electron/main/index.ts:280-281`
`bytesWritten = 0` 在 `_reopen()` 之前设置，但 `_reopen()` 内部会从中断处重新计算 `bytesWritten`，导致覆盖。

### E9 [MEDIUM] `allow-file-access-from-files` 启用
**文件**: `gui/electron/main/index.ts:1988`
```ts
app.commandLine.appendSwitch('allow-file-access-from-files')
```
允许 `file://` URL 访问其他文件，生产环境为安全风险。

### E10 [MEDIUM] 无可信赖的自动更新机制
**文件**: `gui/package.json` — 无 `electron-updater` 依赖
更新机制为 DIY HTTP 轮询 + 浏览器下载，无签名验证、无静默安装、无差分更新。

### E11 [MEDIUM] 可执行文件未签名
**文件**: `gui/package.json:198-199`
`forceCodeSigning: false` + `signAndEditExecutable: false`，Windows SmartScreen 将标记为不可信。

### E12 [LOW] `makeFallbackIcon` RGBA vs BGRA
**文件**: `gui/electron/main/index.ts:2262-2275`
在 Windows 上，`nativeImage.createFromBuffer` 期望 BGRA 格式，但代码写入 RGBA 值。系统托盘图标颜色可能异常。

### E13 [LOW] ffmpeg 未打包，PowerShell 回退不可用
**文件**: `gui/electron/main/index.ts:1879-1914`
音频播放依赖 ffmpeg，但 ffmpeg 从未打包。PowerShell `System.Windows.Media.MediaPlayer` 回退在控制台 PowerShell 进程中不可用（需 WPF Dispatcher）。实际静音。

### E14 [LOW] `build-portable.ps1` 不保存/恢复工作目录
**文件**: `gui/build-portable.ps1:41,50`
`Set-Location` 改变全局工作目录无 save/restore，中断后 shell 停留在错误目录。

---

## 3. 构建与配置问题

### B1 [HIGH] DevDependencies 打包进 ExtraResources
**文件**: `gui/package.json:139-161`
整个 `../node_modules` 作为 extraResources 打包，包含 `@playwright/test`、`electron`、`typescript` 等运行时不需要的包。安装包膨胀数百 MB。

### B2 [MEDIUM] `/shutdown` 在开发代理中暴露
**文件**: `gui/vite.config.ts:19`
开发模式下 `/shutdown` 被代理。如果 dev server 监听网络接口，外部可触发后端关停。

### B3 [MEDIUM] `modulePreload: false` 禁用性能优化
**文件**: `gui/vite.config.ts:70`

### B4 [MEDIUM] 大型库未分块
**文件**: `gui/vite.config.ts:72-78`
只有 3 个 manual chunks。`mermaid` (~700KB)、`katex` (~200KB)、`three` (~600KB) 等在主包中。

### B5 [MEDIUM] `emptyOutDir: true` 与 Electron 输出冲突
**文件**: `gui/vite.config.ts:68`
清空 `dist/` 时可能影响 Electron 的输出目录。

### B6 [LOW] `npm run build` 执行顺序问题
**文件**: `gui/package.json:10`
`rebuild` 在 `vite build` 之前执行，但 `@electron/rebuild` 需要 dist-electron 输出目录。

### B7 [LOW] Postinstall 脚本语法错误
**文件**: `gui/package.json:16`
`require('@electron/rebuild').rebuild()` 在 v3+ 中 API 已变更，应为直接调用函数。

---

## 4. API 层数据链问题

### A1 [CRITICAL] `fetchWithTimeout` 静默覆盖调用方的 `AbortSignal`
**文件**: `gui/src/lib/api.ts:302`
```ts
const response = await fetch(url, { ...options, signal: controller.signal })
```
`...options` 中包含调用方的 `signal`，但立即被 `controller.signal` 覆盖。任何组件试图取消 `apiGet` 请求都将失败。

### A2 [CRITICAL] `apiPost` 返回类型与 `apiGet` 不一致
**文件**: `gui/src/lib/api.ts:189 vs 131`
- `apiGet<T>` 返回 `ApiResult<T>`（已解包 `{success, data}`）
- `apiPost<T>` 返回 `T`（**原始 JSON，不解包**）
- 调用方必须知道使用哪个函数并手动处理响应格式
- `chat-utils.ts:17-21` 缓存机制因此失效：`apiPost<{cached, data}>` 访问 `.cached` 为 undefined（实际在 `.data.cached`）

### A3 [CRITICAL] `apiUpload` 不走 Electron proxy 且无认证头
**文件**: `gui/src/lib/api.ts:273-295`
- 不调用 `getApiHeaders()` → 无 `X-Api-Key`
- 在 Electron 模式也使用直接 fetch（不走 proxy）
- 文件上传等同于未认证

### A4 [MEDIUM] `getCredentials` 与 `getApiHeaders` 重复获取
**文件**: `gui/src/lib/api.ts:28-56, 84-100`
每次 API 调用中，`getApiBaseUrl()` 和 `getApiHeaders()` 分别独立调用 `window.electronAPI.api.credentials()`，但只有前者管理缓存。

### A5 [MEDIUM] `scheduleCredentialRefresh` 对默认值也无意义运行
**文件**: `gui/src/lib/api.ts:53-55`
当无 Electron API 时设置默认值后仍调度 30 秒定时器，每次定时器到期重新计算默认值，无实际效益。

### A6 [MEDIUM] SSE 端点硬编码为相对路径
**文件**: `gui/src/lib/constants.ts` (或 useSSE)
`/events` 硬编码相对路径。代理/子路径部署下可能解析错误。（对比 WS 路径使用 `getWsBase()` 正确获取基础 URL）

---

## 5. Scene 协议客户端问题

### SC1 [MEDIUM] `pongTimer` 未正确清理 — 内存泄漏
**文件**: `gui/src/lib/scene-client.ts:192-196`
ping 定时器只在 `ws.onclose` 中清除。如果连接在 page 导航时断开（无 onclose），定时器持续运行并在已关闭的 socket 上调用 `ws.send()`。

### SC2 [MEDIUM] `tryConnectWs` Promise 拒绝未处理
**文件**: `gui/src/lib/scene-client.ts:161-162`
```ts
wsBasePromise.then((wsBase) => { ... })
// 无 .catch() — 如果 getWsBase() 拒绝，拒绝未被捕获
```
`getWsBase()` 的网络错误导致未处理的 Promise 拒绝。

### SC3 [MEDIUM] 静默错误处理 — 所有 catch 为空
**文件**: `gui/src/lib/scene-client.ts:41,50,66,112,140,180,220,234-235,265,272`
10+ 个 catch 块全部是 `/* ignore */` 或 `/* 静默 */`。WS/SSE/HTTP 三层失败均无诊断信息。

### SC4 [MEDIUM] `tryConnectSSE` 函数属性作为单例标记 — 脆弱
**文件**: `gui/src/lib/scene-client.ts:244`
```ts
(tryConnectSSE as any)._source = es
```
函数属性作为单例标记，函数重新绑定或混淆后行为异常。

### SC5 [LOW] `useSceneManifest` 暴露内部 Map
**文件**: `gui/src/lib/scene-client.ts:380`
```ts
return { manifest, rev, surfaceMap: surfaceCache as any }
```
内部 `Map` 通过 `surfaceMap` 直接暴露，消费者可突变全局缓存。

### SC6 [LOW] WebSocket 补丁间隙检测后 resync 可能丢失
**文件**: `gui/src/lib/scene-client.ts:133-156`
检测到补丁 gap 后在 WS 上发起 resync，若 WS 已断（回退到 SSE），resync 请求静默丢失。

---

## 6. Dashboard 状态管理问题

### D1 [HIGH] `voiceConfig.asrProvider` 始终为 `undefined`
**文件**: `gui/src/pages/Dashboard/index.tsx:390,435`
`voiceConfig` state 定义 ~20 个字段但不包含 `asrProvider`。`config-updated-voice` 事件处理器 (line 756-776) 也从不设置 `asrProvider`。PTT 始终使用默认 `'volcengine'`。

### D2 [MEDIUM] `activeTab` 类型被 `| string` 破坏
**文件**: `gui/src/pages/Dashboard/index.tsx:125`
```ts
const [activeTab, setActiveTab] = useState<'home' | 'chat' | ... | string>('home')
```
`| string` 让 union 类型退化为 `string`，TypeScript 不提供任何自动补全或类型检查。

### D3 [MEDIUM] 设置 Modal 与内联 Settings 共享同一 ref
**文件**: `gui/src/pages/Dashboard/index.tsx:2826,2943`
两个 Settings 实例（一个内联页面、一个 modal）共享同一个 `settingsRef`。`hasUnsavedChanges` 从不正确的实例读取值，行为不可预测。

### D4 [MEDIUM] 服务初始化竞态
**文件**: `gui/src/pages/Dashboard/index.tsx:1135-1160`
```ts
init()  // fire and forget
// 立即启动 interval:
setInterval(checkServices, 15000)
```
`init()` 无 `await`，`checkServices()` 可能在 `init` 内的第一次调用和 interval 之间并发执行。`checkServices` 无并发防护。

### D5 [MEDIUM] Ref 在渲染函数体中同步（违反 purity）
**文件**: `gui/src/pages/Dashboard/index.tsx:351-352`
```ts
serviceStatusRef.current = serviceStatus  // 每次渲染都执行
```
React concurrent mode 下渲染函数可能被挂起或重新执行，ref 与 state 可能不同步。

### D6 [LOW] 重复的 `sendMsgRef` sync effect
**文件**: `gui/src/pages/Dashboard/index.tsx:486, 501-502`
```ts
useEffect(() => { sendMsgRef.current = handleSendMessage })
// 同一个 effect 出现两次
```
无害但浪费每次渲染一次函数调用。

### D7 [LOW] 重复的 `setIsReflecting(false)` 调用
**文件**: `gui/src/pages/Dashboard/index.tsx:1377-1378`
`setIsReflecting(false)` 连续调用两次，重构遗留的死代码。

---

## 7. SSE 事件中枢问题

### SE1 [HIGH] 空 handler 浪费资源
**文件**: `gui/src/pages/Dashboard/index.tsx:891,1007-1009,1102`
```ts
'workflow:progress': (data) => {},        // 全空
'taskflow_created': (data) => {},          // 全空
'taskflow_completed': (data) => {},        // 全空
'taskflow_status_update': (data) => {},    // 全空
pulse: () => { /* comment only */ },       // 只有注释
```
每次事件触发都走一遍 JSON 解析 → handler 查找 → 空函数调用。移除这些 handler 可减少开销。

### SE2 [MEDIUM] `wecom_message` 可能产生重复消息
**文件**: `gui/src/pages/Dashboard/index.tsx:810-816`
SSE 事件 `wecom_message` 无条件调用 `addUniqueMessage`。如果 `/events` 通道和 `/chat` 流式响应都 emit 了相同的消息，前端出现重复。

---

## 8. 流式聊天与 TTS 集成问题

### C1 [HIGH] `onToolCall` 工具条目重复
**文件**: `gui/src/pages/Dashboard/index.tsx:1702-1711`
每次 `onToolCall` 无条件追加工具条目。后端对同一 tool ID 发送多次 `tool_call`（重试、更新），tool 在 `tools` 数组中重复出现。`onToolResult` 只更新**第一个**匹配的 toolId。

### C2 [MEDIUM] RAF throttle 使用字符串长度而非 chunk 计数
**文件**: `gui/src/pages/Dashboard/index.tsx:1633-1634`
```ts
if (accumulated.length % 20 < 3) { cancelAnimationFrame(...) }
```
依赖 `accumulated.length`（字符串长度）而非 chunk 数量来确定刷新时机，变长 chunk 下意图不达。

### C3 [MEDIUM] `onToolResult` 丢弃非字符串的结构化结果
**文件**: `gui/src/pages/Dashboard/index.tsx:1766`
```ts
detail: typeof toolResult === 'string' ? toolResult.slice(0, 500) : ''
```
结构化工具结果（如 `{"status": "ok"}`）被静默丢弃，执行链上不显示。

### C4 [MEDIUM] `finalizeStreamingTTS` 在消息标记为 done 之后调用
**文件**: `gui/src/pages/Dashboard/index.tsx:1889,1910`
```ts
updateLastAssistant(sanitizeContent(fullReply), 'done', ...)  // line 1889
// ... 副作用 ...
finalizeStreamingTTS()                                          // line 1910
```
消息标记 `'done'` 后才 finalize TTS。用户切换会话或关闭标签页时 TTS 被静默截断。

### C5 [LOW] 语音队列可能引发级联 toast
**文件**: `gui/src/pages/Dashboard/index.tsx:1979-1985`
队列中 10 条消息同时发送失败产生 10 个错误 toast。无去重或限速。

---

## 9. 语音系统前端问题

### V1 [CRITICAL] `VoiceStateContext` 非响应式 — 所有消费者看到编译时状态
**文件**: `gui/src/contexts/VoiceStateContext.tsx:39-84`
```tsx
const stateRef = useRef<VoiceState>(initialState)
// updateState 只改 ref.current，不触发 re-render
// Provider value 在首次渲染后冻结
```
依赖 `useVoiceState()` / `useTTSState()` / `useASRState()` 的所有组件永远看不到状态变化。`window.__` 全局变量是实际工作路径。

### V2 [CRITICAL] `onStateChange` 在字符串上访问 `.sessionActive`
**文件**: `gui/src/components/VoiceIntegration.tsx:62-65`
```ts
onStateChange: useCallback((s) => {
  updateState({ voiceSessionState: s, voiceSessionActive: s.sessionActive })
  // s 是 'idle'|'listening'|... 字符串，没有 .sessionActive
```
`useVoiceSession` 传入的是 `VoiceSessionState` 字符串。Context 始终得到 `voiceSessionActive: undefined`。

### V3 [CRITICAL] `useVoiceSession` 中 `volume` 硬编码为 0
**文件**: `gui/src/hooks/useVoiceSession.ts:123`
```ts
const volume = 0  // 硬编码，无视 onFrame 计算的 RMS 音量
```
VoiceOrb 动画、barge-in 能量检测全部失效。

### V4 [HIGH] `sendPcm` 在 WS CLOSING 状态抛异常
**文件**: `gui/src/hooks/usePushToTalk.ts:479`
```ts
ws.send(pcm.buffer)  // 无 try/catch
```
`readyState=2` (CLOSING) 时 `send()` 抛出 `InvalidStateError`，在 AudioWorklet 回调中导致音频线程崩溃。

### V5 [HIGH] WS 重连孤立旧连接
**文件**: `gui/src/hooks/useVoiceSession.ts:570-604`
`resumeSession` → `resumeWs` 创建新 WS 直接覆盖 `asrWsRef.current`，旧 WS 从不关闭。后端连接泄漏。

### V6 [HIGH] 看门狗 + `onclose` 双重计数重连次数
**文件**: `gui/src/hooks/useVoiceSession.ts:359,501`
同一断开事件被计数两次，5 次重连上限在预期一半时间内耗尽。

### V7 [HIGH] AudioOutputManager 无必要 props — `setSinkId` 空操作
**文件**: `gui/src/components/VoiceIntegration.tsx:203`
```tsx
return <AudioOutputManager />  // 无 audioElement、audioContext、pinnedDeviceId
```

### V8 [MEDIUM] `playStreamingTTS` 不挂载 `__voiceResumeTTS`
**文件**: `gui/src/hooks/useVoiceReply.ts:832`
`setupResumeTTS()` 只在 `beginStreamingTTS()` 中调用。`playStreamingTTS()`（非流式回复）从不调用。Barge-in 误报恢复对该路径不工作。

### V9 [MEDIUM] TTSFxProcessor LFO 永不停止 — AudioNode 泄漏
**文件**: `gui/src/components/TTSFxProcessor.ts:77-83`
```ts
lfo.start()  // 无配对的 stop()
```

### V10 [MEDIUM] 转录抑制期间重置累积
**文件**: `gui/src/hooks/useVoiceSession.ts:298-300`
抑制转录时不清除累积数据而是重置全部 ASR 状态。用户发送消息后紧接着的 ASR 转录全部丢失。

### V11 [MEDIUM] 唤醒词 20 次重连后永久静默失效
**文件**: `gui/src/hooks/useWakeWord.ts:215`
```ts
if (wakeRestartCountRef.current > 20) return;  // 永久静默停止
```

### V12 [MEDIUM] 无 `getUserMedia` 授权时设备标签为空
**文件**: `gui/src/components/AudioOutputManager.tsx:66-76`
未调用 `getUserMedia` 直接 `enumerateDevices()`，浏览器返回的设备标签全部为空字符串，`isVirtualOutputLabel` 总返回 false。

### V13 [MEDIUM] PTT 空格键与文本输入冲突
**文件**: `gui/src/pages/Dashboard/index.tsx:442-480`
```ts
tag === 'input' || tag === 'textarea'  // 包含 checkbox、button 等非文本输入
```
用户在与 checkbox、button 等非文本元素交互时，PTT 无法触发。

### V14 [MEDIUM] `sendMsgRef` TDZ 工作区脆弱
**文件**: `gui/src/pages/Dashboard/index.tsx:484-502`
复杂的 ref 连接（`sendMsgRef`、双重 `useEffect`）是 Temporal Dead Zone 的变通方法，依赖 React 渲染顺序。

---

## 10. 全局 window.__ 污染

### W1 [HIGH] 24+ 个 window 全局变量

| 全局变量 | 设置位置 | 用途 |
|---------|---------|------|
| `__ttsVolume` | Dashboard:407 | 语音球脉动动画 |
| `__ptt` | Dashboard:487 | PTT 控制器实例 |
| `__pttSend` | Dashboard:488 | sendMsgRef 引用 |
| `__sendVoiceMessage` | Dashboard:2021 | 语音消息发送函数 |
| `__releaseMicForSession` | Dashboard:492 | 为会议释放麦克风 |
| `__ttsFxEnabled` | Dashboard:583 | TTS FX 状态 |
| `__voiceWakeRequestDismiss` | 外部 | 关闭唤醒 UI |
| `__voiceWakeHit` | 外部 | 唤醒词触发信号 |
| `__voiceInterruptTTS` | useVoiceReply | 中断 TTS 播放 |
| `__voiceSessionActive` | 外部 | 语音会话轮询 |
| `__voiceSessionState` | 外部 | 语音会话状态 |
| `__voiceSessionSuspend` | 外部 | 暂停语音会话 |
| `__voiceSessionResume` | 外部 | 恢复语音会话 |
| `__voiceSessionResumeAfterTTS` | 外部 | TTS 后恢复 |
| `__voiceSuppressTranscripts` | 外部 | 转录抑制 |
| `__voiceWakeMarkActive` | 外部 | 标记语音系统激活 |
| `__voiceWakeOnResponse` | 外部 | 唤醒词响应 |
| `__ttsAbortController` | useVoiceReply | 中止 TTS fetch |
| `__ttsFxAudioCtx` | 外部 | TTS FX audio context |
| `__ttsSourceNode` | 外部 | TTS FX source node |
| `__pttAudioCtx` | usePushToTalk | PTT AudioContext |
| `__ttsActive` | useVoiceReply | TTS 激活状态 |
| `__audioOutputDeviceId` | 外部 | 音频输出路由 |
| `__CRABPAW_PLUGINS__` | usePlugins | 插件实例 |
| `__CRABPAW_PLUGIN_SDK__` | usePlugins | 插件 SDK |

- **无类型声明**
- **无文档或所有权追踪**
- **命名冲突风险**
- **无法追踪依赖关系**

---

## 11. 页面组件问题逐页分析

### 11.1 SmartControl/index.tsx (835 行) — 微信桌面监控 UI

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SM1 | MEDIUM | 350-360 | `autoWechatInput` ref 链路径复杂，`handleAutoInput` 与 `doAutoInputFromRef` 功能重叠，职责不清晰 |
| SM2 | MEDIUM | 420-480 | VLM 分析结果展示缺乏错误边界，后端 image analysis 失败时 UI 状态未正确回退 |
| SM3 | LOW | 全部 | 无单元测试覆盖 |

### 11.2 Settings/index.tsx (1186 行) — 配置面板

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| ST1 | MEDIUM | 多处 | `_props`/`_unused` 前缀参数 — 显式表示 unused 但未来不会清理 |
| ST2 | MEDIUM | 300-400 | 多个 API 密钥表单无输入校验，空字符串/格式错误直接提交 |
| ST3 | LOW | 全部 | 配置面板与 Dashboard 内联 Settings 共享 ref，行为不可预测（见 D3） |

### 11.3 Memory/index.tsx (806 行) — 记忆面板

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| M1 | MEDIUM | 200-300 | 记忆搜索 API 调用无 `AbortSignal` 传递（apiGet 的 signal 被覆盖 = A1） |
| M2 | MEDIUM | 400-500 | 记忆可视化使用 D3 力模拟图，resize 时未正确更新容器尺寸 |
| M3 | LOW | 各处 | `as any` 类型转换频繁出现 |

### 11.4 Gateway/index.tsx (758 行) — 信道配置

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| G1 | MEDIUM | 100-200 | 信道状态显示与后端 SSE 事件可能不同步（轮询 vs 推送冲突） |
| G2 | LOW | 300-400 | 桥接配置表单无保存确认反馈 |

### 11.5 Automation/index.tsx (508 行) + index-enhanced.tsx (793 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| AU1 | HIGH | 所有 | **两层代码重复**：`index.tsx` (508 行) 与 `index-enhanced.tsx` (793 行) 核心逻辑重叠。用户看到哪版取决于入口路由配置，分歧的代码覆盖不同的边缘情况 |
| AU2 | MEDIUM | enhanced:200 | NL 任务解析结果预览缺乏置信度阈值，低置信度解析不提示用户 |
| AU3 | LOW | 所有 | 工作流状态无序列化，页面刷新后丢失 |

### 11.6 Calendar/index.tsx (890 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| CA1 | MEDIUM | 300-400 | 日程显示时区处理不一致，部分使用本地时间部分使用 UTC |
| CA2 | LOW | 500-600 | 创建日程 API 调用无 loading 状态反馈 |

### 11.7 Other Pages (Home/Logs/News/EvolutionLog/Status)

| ID | 严重性 | 文件 | 行 | 问题 |
|----|--------|------|---|------|
| HP1 | LOW | Home/index.tsx | 200 | 记忆图快捷键入口无说明提示 |
| LG1 | LOW | Logs/index.tsx | 100 | 日志自动滚动到最新行为在手动浏览后不停止 |
| NW1 | LOW | News/index.tsx | 300 | 文章列表无分页加载，大量条目 OOM 风险 |
| EV1 | LOW | EvolutionLog/index.tsx | 200 | 进化历史列表无搜索/过滤 |
| ST1 | LOW | Status/index.tsx | 400 | 服务状态面板无 WebSocket 连接状态显示 |

---

## 12. 组件问题逐组件分析

### 12.1 Sidebar/index.tsx (223 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SB1 | MEDIUM | 35 | `serviceStatus.server = true` 硬编码。服务状态永远显示在线 |
| SB2 | LOW | 150 | 插件贡献的 sidebar items 无 error boundary |

### 12.2 SceneShell/index.tsx (594 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SS1 | MEDIUM | 200-300 | 两个 Scene 协议客户端并行（一个在 SceneShell，一个在 scene-client.ts）。重复 WebSocket 连接可能 |
| SS2 | MEDIUM | 400-450 | FLIP 动画中 key 冲突导致不正确转场 |
| SS3 | LOW | 全部 | 17 种卡片有些从未被 agent 使用，死代码 |

### 12.3 ActivityStream/index.tsx (778 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| AS1 | HIGH | 588-598 | 去重键 `toolName + '|' + roundId` 对于非工具项产生 `"undefined|undefined"`，错误去重所有非工具项 |
| AS2 | MEDIUM | 300-350 | 50+ 种工具分类图标映射不全，未知工具类型回退到默认图标 |
| AS3 | MEDIUM | 全部 | 活动流数据依赖 SSE 实时推送，页面刷新后历史数据丢失 |

### 12.4 MemoryGraph/index.tsx (677 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| MG1 | MEDIUM | 509-520 | 滚轮事件监听器在每次 `nodesKey`/`edgesKey` 变化时叠加，多次缩放触发失控 |
| MG2 | LOW | 412-435 | 注入的 `<style id="memory-graph-animations">` 元素永不移除 |

### 12.5 StatusBar/index.tsx (313 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SR1 | HIGH | 35 | `tokenUsed` 始终为 0。进度条永远 0% |
| SR2 | MEDIUM | 100-200 | 状态轮询与 Dashboard 内部轮询重复，不必要的网络请求 |

### 12.6 HotspotPanel/index.tsx (719 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| HP1 | HIGH | 444-445 | 颜色正则 `\w+` 不匹配 `#` → 产生无效 `rgba(ff, 0.1)`，Stat Card 背景消失 |
| HP2 | MEDIUM | 133-135 | `result?.ok` 不匹配后端格式（`apiGet` 标准化嵌套后 `ok` 在 `result.data` 内） |
| HP3 | LOW | 106 | SkeletonBar 动画错误（使用 `hsSlideUp` + `infinite alternate` → 连续淡入淡出而非脉冲） |

### 12.7 VoiceIntegration.tsx (204 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| VI1 | CRITICAL | 62-65 | `onStateChange` 在字符串上访问 `.sessionActive`（见 V2） |
| VI2 | HIGH | 203 | AudioOutputManager 无必要 props（见 V7） |

### 12.8 AudioOutputManager.tsx (230 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| AO1 | MEDIUM | 66-76 | 无 `getUserMedia` 授权时设备标签为空（见 V12） |

### 12.9 TTSFxProcessor.ts (77+ 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| TF1 | MEDIUM | 77-83 | LFO 振荡器永不停止（见 V9） |

### 12.10 FloatingMusicPlayer (546 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| FM1 | MEDIUM | 200-300 | 歌词解析无编码检测，非 UTF-8 歌词乱码 |
| FM2 | LOW | 400 | 音乐搜索调用 `apiPost` 时未使用调用方 AbortSignal（A1 影响） |

### 12.11 WorkflowStepCard.tsx (56 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| WC1 | LOW | 全部 | 使用 `React.createElement` 而非 JSX — 与全项目风格不一致 |

### 12.12 MediaStage/index.tsx (409 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| MD1 | MEDIUM | 200 | 图片查看器无缩放限制，超大图片可能导致 OOM |

### 12.13 SetupWizard/index.tsx (748 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SW1 | MEDIUM | 500-600 | 配置保存后无后端连通性验证，配置错误用户需手动排查 |
| SW2 | LOW | 全部 | 设置向导步骤无法回溯编辑 |

### 12.14 VoiceDiagnostics.tsx (130 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| VD1 | MEDIUM | 80-100 | Ctrl+Shift+D 快捷键在 Electron 中可能与系统快捷键冲突 |

### 12.15 SkillDependencyGraph/index.tsx (286 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SK1 | LOW | 150-200 | 拓扑排序无循环检测，循环依赖导致无限循环 |

### 12.16 MarkdownRenderers/index.tsx (84 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| MR1 | MEDIUM | 40-50 | Mermaid 动态导入可能失败，失败时无降级显示（显示源代码） |

---

## 13. Lib 模块问题

### 13.1 chat-utils.ts (80 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| CU1 | CRITICAL | 17-21 | 缓存机制死掉：`apiPost` 返回原始 JSON，`result.cached` 为 undefined（在 `result.data.cached` 中）（见 A2） |

### 13.2 error-handler.ts (37 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| EH1 | MEDIUM | 27-29 | 子串匹配过宽：`'fetch'` 匹配 `'fetchUser failed'`。`'token'` 匹配 `'token数量超限'` → 错误的 "认证失败" 信息 |
| EH2 | LOW | 全部 | 仅有 8 个错误分类，许多后端错误映射到通用 fallback |

### 13.3 sanitize.ts (115 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SA1 | HIGH | 34-35 | Script/style 移除正则不处理嵌套标签、自闭合标签、注释绕过 |
| SA2 | HIGH | 37-42 | 事件处理器正则要求引号，`onclick=alert(1)` 无引号版本不匹配。反引号引用不处理 |
| SA3 | MEDIUM | 45-48 | `DANGEROUS_PROTOCOLS` 缺少 `data:image/svg+xml` 等变体。缺少 `formaction`、`xlink:href` |
| SA4 | MEDIUM | 104 | 移除所有自闭合标签（包括 `<br/>`、`<img/>` 等合法标签） |
| SA5 | MEDIUM | 106 | 移除以特定 emoji 开头的用户输入行 |

### 13.4 schedule-parser.ts (233 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SP1 | HIGH | 89 | 夜间时间抽取正则所有组均为可选 → 空字符串匹配 → 始终返回 20:00 |
| SP2 | HIGH | 67,142 | "每天早上8点" 不解析 — "早" 字干扰 "每天" 与时间数字之间的正则 |
| SP3 | MEDIUM | 79-86 | "每天中午12点30分" 忽略分钟信息，硬编码 12:00 |
| SP4 | MEDIUM | 54-65 | `match![2]` 非空断言 — 如果 `.test()` 守卫条件不符合时崩溃 |
| SP5 | MEDIUM | 10-21 | TIME_PATTERNS 正则重叠，先匹配胜出产生不可预测的结果 |
| SP6 | LOW | 172 | `/每隔\s*(\d+)\s*/` 只匹配数字，不匹配中文数字 "两" |

### 13.5 voice-utils.ts (143 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| VU1 | MEDIUM | 34 | Markdown 链接正则 `[^)]+` 不匹配 URL 中的 `)` — `[Go](https://en.wikipedia.org/wiki/Go_(programming))` 失败 |
| VU2 | LOW | 140-142 | 硬编码 emoji 列表随 Unicode 更新过时。ZWJ 序列（如 `👨‍👩‍👧‍👦`）不被覆盖 |

### 13.6 schedule-detect.ts (41 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| SD1 | LOW | 15 | 200 字符硬限制 — "明天下午3点在望京SOHO跟张总开会讨论Q2项目进展和预算分配" 可能超长 |

---

## 14. Context 问题

### 14.1 VoiceStateContext.tsx (121 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| VC1 | CRITICAL | 39-84 | stateRef 非响应式 — 所有消费者看到编译时状态（见 V1） |

### 14.2 ThemeContext.tsx (72 行)

**无 Bug.** 干净的实现。

---

## 15. Hooks 问题

### 15.1 useChatStream.ts (330 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| HC1 | MEDIUM | 150-200 | ReadableStream 解析在 SSE 数据块跨多个 `data:` 行时可能出错 |
| HC2 | MEDIUM | 全部 | 15+ 事件类型的事件分发使用 `switch/case`，新事件类型添加时 TypeScript 不检查穷尽性 |

### 15.2 useChatSession.ts (371 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| HS1 | MEDIUM | 150-200 | `beforeunload` keepalive 保存与自动保存 (1s debounce) 可能冲突，同时发出两次保存请求 |
| HS2 | LOW | 200-250 | 会话列表无分页，大量会话场景下 OOM |

### 15.3 usePlugins.ts (287 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| HP1 | MEDIUM | 150-200 | 动态 JS 注入创建 `<script>` 标签，插入后不清理。卸载插件脚本仍在运行 |
| HP2 | LOW | 200-250 | 插件 CSS 注入无 scope，插件之间可能样式冲突 |

### 15.4 useVoiceSession.ts (677 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| VS1 | CRITICAL | 123 | volume 硬编码 0（见 V3） |
| VS2 | HIGH | 570-604 | WS 重连孤立旧连接（见 V5） |
| VS3 | HIGH | 359,501 | 双重计数重连次数（见 V6） |
| VS4 | MEDIUM | 298-300 | 转录抑制重置累积（见 V10） |

### 15.5 usePushToTalk.ts (811 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| UP1 | HIGH | 479 | `sendPcm` 抛异常（见 V4） |
| UP2 | MEDIUM | 300-400 | AudioWorklet 消息通信无错误处理，Worker 崩溃无声 |

### 15.6 useVoiceReply.ts (896 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| UR1 | MEDIUM | 832 | `playStreamingTTS` 不挂载 `__voiceResumeTTS`（见 V8） |

### 15.7 useWakeWord.ts (278 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| UW1 | MEDIUM | 215 | 20 次重连后永久静默失效（见 V11） |

### 15.8 useContinuousVoice.ts (269 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| UC1 | MEDIUM | 100-150 | Barge-in 检测依赖的 volume 值为 0（V3 影响），barge-in 判定永远不会触发 |

### 15.9 useSSE.ts (139 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| UE1 | MEDIUM | 80-100 | 指数退避重连最大延迟 60s，长时间网络故障时恢复延迟高 |
| UE2 | LOW | 全部 | `EventSource` 默认不发送认证头，如果后端要求 token 认证，SSE 连接 401 |

### 15.10 useMeetingTranscription.ts (295 行)

| ID | 严重性 | 行 | 问题 |
|----|--------|---|------|
| MT1 | MEDIUM | 150-200 | AudioWorklet 录音时无音量指示器，用户不确定是否在录音 |
| MT2 | LOW | 200-250 | 转录文本保存无编码处理，非英文字符可能乱码 |

---

## 16. 类型安全与 TypeScript 问题

### 16.1 `as any` 数量统计

| 区域 | 大致次数 |
|------|---------|
| Dashboard/index.tsx | 30+ |
| api.ts | 5 |
| scene-client.ts | 8 |
| 各页面 | 20+ |
| 各组件 | 30+ |
| **总计** | **93+ 次** |

### 16.2 关键类型问题

| ID | 严重性 | 文件 | 行 | 问题 |
|----|--------|------|---|------|
| TS1 | MEDIUM | `Dashboard/index.tsx` | 125 | `activeTab` 类型被 `\| string` 破坏 |
| TS2 | MEDIUM | `Dashboard/index.tsx` | 102 | `Record<string, any>` 应为具体类型 |
| TS3 | MEDIUM | `electron/main/index.ts` | 882+ | `(app as any).isQuitting` |
| TS4 | MEDIUM | `main.tsx` | 72 | `render-process-gone` 事件不存在于 window |
| TS5 | MEDIUM | `main.tsx` | 76 | `(window as any).PerformanceObserver` |
| TS6 | LOW | `tsconfig.json` | - | 无 `node`/`electron` types |
| TS7 | LOW | 各文件 | - | 93+ `as any` 类型安全退化 |

---

## 17. 错误处理问题

### 17.1 空 catch 块统计

| 位置 | 数量 |
|------|------|
| `electron/main/index.ts` | 30+ |
| `src/main.tsx` | 12 |
| `src/lib/api.ts` | 2 |
| `src/lib/scene-client.ts` | 10+ |
| 各 hook | 若干 |
| **总计** | **55+ 个空 catch** |

违反 AGENTS.md 规则 #6："No silent failures — every error path must be logged or propagated"

### 17.2 关键错误处理缺失

| ID | 严重性 | 文件 | 问题 |
|----|--------|------|------|
| EH1 | MEDIUM | `audioOutputManager.tsx` | 设备枚举失败无回退 |
| EH2 | MEDIUM | `scene-client.ts` | 三层传输（WS/SSE/HTTP）全部静默失败 |
| EH3 | MEDIUM | `electron/main/index.ts:225` | 日志流错误静默忽略 |
| EH4 | MEDIUM | `electron/main/index.ts:1125-1131` | 进程 kill 双重尝试静默吞异常 |

---

## 18. 性能问题

| ID | 严重性 | 文件 | 问题 |
|----|--------|------|------|
| PF1 | MEDIUM | `electron/main/index.ts:690-704` | 30 秒自旋等待 |
| PF2 | MEDIUM | `Dashboard/index.tsx:521-528` | `sessionState` 变化时 interval 重建（200ms 一次） |
| PF3 | MEDIUM | `Dashboard/index.tsx:891,1007-1009,1102` | 空 SSE handler 浪费资源 |
| PF4 | MEDIUM | `vite.config.ts:72-78` | 大型库未分块 |
| PF5 | MEDIUM | `APi.ts:28-56,84-100` | 每次 API 调用两次 credential fetch |
| PF6 | LOW | 各组件 | 多处 useEffect 缺少依赖数组导致额外渲染 |

---

## 19. 内存泄漏清单

| ID | 严重性 | 文件 | 泄漏详情 |
|----|--------|------|---------|
| ML1 | MEDIUM | `scene-client.ts:192-196` | ping 定时器未在页面卸载时清理 |
| ML2 | MEDIUM | `TTSFxProcessor.ts:77-83` | LFO 振荡器不停止，AudioNode 泄漏 |
| ML3 | MEDIUM | `MemoryGraph/index.tsx:509-520` | 滚轮事件监听器叠加 |
| ML4 | MEDIUM | `Dashboard/index.tsx:576-594` | TTS FX AudioContext 在 unmount 时不关闭 |
| ML5 | LOW | `MemoryGraph/index.tsx:412-435` | `<style>` DOM 元素永不移除 |
| ML6 | LOW | `usePlugins.ts:150-200` | 动态 `<script>` 标签卸载不清理 |
| ML7 | LOW | `Dashboard/index.tsx:1135-1160` | `setInterval(checkServices, 15000)` 在组件卸载时可能不清理 |

---

## 20. Cross-Cutting 架构问题

### X1 [HIGH] Dashboard 巨型文件 (3024 行)
严重违反单一职责原则。涉及：标签路由、状态管理、SSE 中枢、流式聊天、语音/PTT 集成、服务生命周期、插件集成、文件拖拽、30+ 窗口全局变量。

### X2 [HIGH] 无单元测试
`package.json` 只有 `test:e2e` (Playwright) — 无 Jest/Vitest 配置。前端零单元测试覆盖。

### X3 [HIGH] `window.__` 全局变量强耦合
24+ 全局变量在无类型、无文档、无所有权追踪的情况下跨组件共享。

### X4 [HIGH] API 响应包装不一致
`apiGet` 解包 `{success, data}`，`apiPost` 返回原始 JSON。调用方必须根据方法名处理不同格式。

### X5 [MEDIUM] 空 catch 块遍及代码库
55+ 个空 catch 块，诊断定位问题极为困难。

### X6 [MEDIUM] 无状态恢复 (SSR/SSG)
纯客户端渲染，无服务端渲染支持。首屏加载依赖 Electron 窗口 ready。

### X7 [MEDIUM] Module-level 单例与 HMR 不兼容
`scene-client.ts`、`api.ts`、`userScopedStorage.ts` 中的模块级单例在 Vite HMR 时可变成陈旧引用。

### X8 [MEDIUM] 两个 Scene 协议客户端并行
SceneShell（WS）和 scene-client.ts（WS + SSE + HTTP）同时运行，可能重复 WS 连接。

### X9 [MEDIUM] 代码重复：Automation 两层实现
`index.tsx` (508 行) 与 `index-enhanced.tsx` (793 行) 功能重叠，分歧代码覆盖不同边缘情况。

---

## 21. 严重性汇总表

### 总数：126 个问题

| 严重性 | 数量 | 占比 |
|--------|------|------|
| 🔴 **CRITICAL** | 9 | 7% |
| 🟠 **HIGH** | 23 | 18% |
| 🟡 **MEDIUM** | 60 | 48% |
| 🔵 **LOW** | 34 | 27% |

### 按类别分布

| 类别 | CRITICAL | HIGH | MEDIUM | LOW |
|------|----------|------|--------|-----|
| 安全 | 2 | 4 | 6 | 0 |
| Electron 主进程 | 0 | 3 | 8 | 3 |
| 构建/配置 | 0 | 1 | 4 | 2 |
| API 层 | 3 | 0 | 3 | 0 |
| Scene 协议 | 0 | 0 | 5 | 1 |
| Dashboard | 0 | 3 | 6 | 3 |
| SSE 事件 | 0 | 1 | 1 | 0 |
| 流式聊天 | 0 | 1 | 3 | 1 |
| 语音系统 | 3 | 4 | 6 | 0 |
| `window.__` 污染 | 0 | 1 | 0 | 0 |
| 页面组件 | 0 | 1 | 8 | 5 |
| 组件 | 0 | 3 | 9 | 5 |
| Lib 模块 | 1 | 3 | 5 | 2 |
| Context | 1 | 0 | 0 | 0 |
| Hooks | 1 | 3 | 6 | 2 |
| 类型安全 | 0 | 0 | 5 | 2 |
| 错误处理 | 0 | 0 | 4 | 0 |
| 性能 | 0 | 0 | 5 | 1 |
| 内存泄漏 | 0 | 0 | 4 | 3 |
| Cross-Cutting | 0 | 4 | 4 | 0 |

### 优先修复建议

**P0 — 立即修复：**
1. S1 — `webSecurity: false` 修正
2. S2 — `sandbox: false` 修正
3. A1 — `fetchWithTimeout` AbortSignal 覆盖
4. A2 — `apiPost` / `apiGet` 返回类型统一
5. V1 — `VoiceStateContext` 响应式重写
6. V2 — `onStateChange` 类型修正
7. V3 — `volume` 硬编码修正
8. A3 — `apiUpload` 认证头 + Electron proxy
9. CU1 — `chat-utils` 缓存机制修复

**P1 — 高优先级：**
10. S3-S12 — 安全漏洞修补
11. E1-E2 — 服务启动/停止时序
12. D1 — `voiceConfig.asrProvider` 修复
13. C1 — tool call 去重
14. HP1 — HotspotPanel 颜色正则
15. SR1 — StatusBar token 追踪
16. AS1 — ActivityStream 去重键
17. SP1-SP3 — 日程解析器夜间 + 早上时间
18. SA1-SA5 — 清洗器漏洞修补

**P2 — 中等优先级：**
19. D2 — `activeTab` 类型修复
20. D3 — Settings 共享 ref 修复
21. SE1 — 空 SSE handler 移除
22. W1 — 逐步迁移 `window.__` 到 context
23. X1 — Dashboard 拆分
24. X8 — Scene 协议客户端合并
25. 各内存泄漏修复
26. 各类型安全修复

---

> 报告完 — 共 126 个问题，涵盖安全、数据链、API、组件逻辑、状态管理、错误处理、性能、内存泄漏等全部维度
