# CrabPaw 项目深度 Bug 分析报告

> 分析范围：语音对话系统（TTS/ASR/Streaming）+ 面板系统（Hotspot/Weather/Status/MemoryGraph/Activity/StatusBar）
> 分析日期：2026-07-27

---

## 第一部分：语音对话系统 — 致命/严重级 Bug

### V1 [CRITICAL] 后端 TTS 引擎单例状态被并发请求相互覆盖

**文件**: `src/cli/request-handler.js:742-743,750-752,761-762,804-805,813-815`

每次 TTS HTTP 请求都直接修改全局单例 `ttsEngine.config.voice.doubaoKey`、`ttsEngine.config.voice.volcanoAppId`、`ttsEngine.config.voice.volcanoToken` 和 `ttsEngine._providerOrder`。

```js
// handleVoiceTTS (line 742)
ttsEngine.config.voice.doubaoKey = realKey;  // 修改全局单例
```

与 `voice-tool.js`（使用 try/finally 恢复）不同，`request-handler.js` 的 TTS 处理函数**从不恢复被修改的状态**。两个并发请求会互相覆盖配置——如果请求 A 设置 `doubaoKey` 为火山引擎 Key，请求 B 设置 `_providerOrder` 为 Edge 优先，则两者的实际行为不可预测。

### V2 [CRITICAL] `GET /api/voice/audio/` 目录与 TTS 输出目录不一致

**文件**: `src/cli/request-handler.js:906` vs `src/core/tts/index.js:112`

```js
// request-handler.js:906 — 音频服务目录
var audioDir = path.join(getDataDir(), "audio");

// tts/index.js:112 — TTS 实际输出目录
const DEFAULT_OUTPUT_DIR = path.join(DATA_DIR, 'tts-output');
```

两个目录不一致。`GET /api/voice/audio/tts_xxxxx.mp3` **永远返回 404**，因为文件写在 `tts-output/` 而服务从 `audio/` 读取。

### V3 [CRITICAL] `handleVoiceDiagnose` 调用 `validateCredentials()` 无参数 → `asrReady` 永远为 false

**文件**: `src/cli/request-handler.js:924`、`src/core/asr/providers/index.js:14`

```js
// request-handler.js
var valid = await validateCredentials(); // 无参数！

// asr/providers/index.js
async function validateCredentials(config) { ... }  // config = undefined
// → PROVIDER_META[undefined] → return { valid: false, missing: ['unknown provider'] }
```

语音诊断页面永远显示 ASR 未就绪，即使已正确配置。

### V4 [CRITICAL] 前端 VoiceStateContext 非响应式 — 所有消费者看到编译时状态

**文件**: `gui/src/contexts/VoiceStateContext.tsx:57`

```ts
const stateRef = useRef(initialState);
// ...
stateRef.current = newState;  // 更新 ref
// 但从不调用 setState()！Provider 不重新渲染
```

上下文值 `{ state: stateRef.current, updateState }` 在 Provider 首次渲染时冻结。调用 `updateState()` 只改变 ref，不触发重新渲染。依赖 `useVoiceState()` 的所有组件（VoiceDiagnostics、RightPanel 等）永远看不到状态变化。

**`window.__*` 全局变量**（代码第 60-73 行设置的）是唯一实际工作的机制——但其值无类型安全、无清理保证。

### V5 [CRITICAL] `VoiceIntegration` 的 `onStateChange` 在字符串上访问 `.sessionActive`

**文件**: `gui/src/components/VoiceIntegration.tsx:62-65`

```ts
onStateChange: useCallback((s) => {
  updateState({ voiceSessionState: s, voiceSessionActive: s.sessionActive })
  // s 是 'idle'|'listening'|'recognizing'|...  字符串，没有 .sessionActive
}, [updateState]),
```

`useVoiceSession` 调用 `onStateChange` 时传递的是 `VoiceSessionState`（**字符串**）。字符串没有 `.sessionActive` 属性。Context 始终得到 `voiceSessionActive: undefined`。VoiceDiagnostics、RightPanel 等依赖此值的组件全部失效。

### V6 [CRITICAL] `useVoiceSession` 中 `volume` 硬编码为 0

**文件**: `gui/src/hooks/useVoiceSession.ts:123`

```ts
const volume = 0;  // 硬编码！
```

`startMic` 中 `onFrame` 回调计算的 RMS 音量（第 406-412 行）通过 `onVolume?.(vol)` 传递，但 `volume` 变量永远是 `0`。VoiceOrb 动画、音量可视化、barge-in 能量检测全部失效。

---

## 第二部分：语音对话系统 — 高级 Bug

### V7 [HIGH] `usePushToTalk` 中 `sendPcm` 在 WS CLOSING 状态抛异常

**文件**: `gui/src/hooks/usePushToTalk.ts:479`

```ts
ws.send(pcm.buffer)  // 无 try/catch！
```

若 WebSocket 处于 `readyState=2`（CLOSING），`send()` 抛出 `InvalidStateError`。此调用在 AudioWorklet 渲染回调中同步执行，未捕获异常传播到音频线程全局错误处理器，可能导致**音频线程崩溃**。

### V8 [HIGH] `useVoiceSession` WS 重连孤立旧 WebSocket

**文件**: `gui/src/hooks/useVoiceSession.ts:570-604`

`resumeSession` → `resumeWs` 路径直接创建新 WebSocket 并赋值给 `asrWsRef.current`，覆盖对旧 WS 的引用。旧 WS **从不被显式关闭**——它保持打开状态，泄漏后端连接。

### V9 [HIGH] Piper 本地 TTS 完全孤立

**文件**: `src/core/tts/piper-provider.js`、`src/core/tts/index.js`

`PiperTTSProvider` 类已实现但**从未被导入或注册**到 `tts/index.js` 的 `TTS_PROVIDERS` 映射或 `_callProvider` switch 语句中。即使正确配置了 Piper，它也永远无法被使用。

### V10 [HIGH] `const process = exec(...)` 遮蔽 Node.js 全局 `process`

**文件**: `src/core/tts/piper-provider.js:148`

```js
const process = exec(command, { encoding: 'utf-8' }, (error, stdout, stderr) => {...});
```

在 `exec` 回调作用域内，`process` 指代子进程，非 Node.js 全局。任何回调中引用 `process.nextTick`、`process.env`、`process.exit` 将崩溃或行为异常。目前回调只使用 `error`、`stdout`、`stderr` 参数，但这是定时炸弹。

### V11 [HIGH] 段 ID 字符串字典序排序导致转录乱序

**文件**: `src/handlers/voice-asr-handler.js:84`、`gui/src/hooks/usePushToTalk.ts:343`

```js
// 后端 voice-asr-handler.js
const sorted = segments.sort((a, b) => a.id.localeCompare(b.id));
// seg_10 排在 seg_2 前面 → 转录文本顺序错误！
```

段 ID 为 `"seg_0"`、`"seg_1"`、... `"seg_10"`。字典序排序中 `"seg_10"` < `"seg_2"`。10 段以上的录音转录文本顺序错乱。

### V12 [HIGH] AudioOutputManager 无必要 props 被渲染 — `setSinkId` 空操作

**文件**: `gui/src/components/VoiceIntegration.tsx:203`

```tsx
return <AudioOutputManager />  // 无 audioElement、audioContext、pinnedDeviceId props
```

AudioOutputManager 尝试的 `setSinkId()` 调用全部空操作，因为没有音频元素或上下文连接。设备路由完全失效。

### V13 [HIGH] 看门狗与 WS `onclose` 双重计数重连次数

**文件**: `gui/src/hooks/useVoiceSession.ts:359-361,501`

看门狗（检测 WS 停滞，触发关闭）和 WS `onclose` 处理器都递增 `reconnectAttemptsRef.current`。同一次断开导致计数器增加两次，**在预期一半的时间内耗尽 5 次重连上限**。

---

## 第三部分：语音对话系统 — 中级 Bug

### V14 [MEDIUM] `playStreamingTTS` 不挂载 `__voiceResumeTTS`

**文件**: `gui/src/hooks/useVoiceReply.ts:832`

`setupResumeTTS()`（设置 `window.__voiceResumeTTS`）只在 `beginStreamingTTS()` 中调用。`playStreamingTTS()`（用于完整非流式回复）从不调用它。Barge-in 误报恢复功能对该路径不工作。

### V15 [MEDIUM] `local` TTS 在提供者排序中被跳过，`_hasValidKey('local')` 返回 false

**文件**: `src/core/tts/index.js:153,134`

`_buildProviderOrder()` 显式跳过 `local` 提供者。`_hasValidKey()` 对其返回 false。本地 TTS 在标准 fallback 链中完全不可达。

### V16 [MEDIUM] DeepSeek TTS 已知 404 但仍在枚举中

**文件**: `src/core/tts/index.js:133`、`src/tools/voice-tool.js:38`

代码注释承认 DeepSeek 的 `/v1/audio/speech` 返回 404，但 `TTS_PROVIDERS` 和 voice-tool schema 仍包含 `'deepseek'`。用户选择后将静默 fallback 到其他提供者，无提示。

### V17 [MEDIUM] 流模式异步设置先于监听器注册 — 竞态

**文件**: `src/core/tts/index.js:627-641`

`innerStream` Readable 先创建（`{ read() {} }` 空操作），然后设置 data/end/error 监听器，再调用 `_streamFromProvider`。若提供者同步推送数据，数据在监听器注册前到达，造成**数据丢失**。

### V18 [MEDIUM] `_streamNonStreamingAsStream` 删除源文件 — 重播 404

**文件**: `src/core/tts/index.js:923`

流式传输后 `fs.unlinkSync(result.filePath)` 删除音频文件。后续对 `GET /api/voice/audio/` 的请求永远 404。

### V19 [MEDIUM] TTSFxProcessor LFO 振荡器永不停止 — AudioNode 泄漏

**文件**: `gui/src/components/TTSFxProcessor.ts:77-83`

```js
lfo.start()  // 无配对的 stop()
```

`disconnect()` 方法只断开 input，不停止 LFO 或断开链节点与 `ctx.destination` 的连接。LFO 驱动延迟时间的调制，无限期保持对 AudioContext 的引用。频繁创建/销毁 TTSFxProcessor 将泄漏 AudioNode。

### V20 [MEDIUM] 转录抑制期间重置累积 — 发送后清除所有 ASR 状态

**文件**: `gui/src/hooks/useVoiceSession.ts:298-300`

抑制转录时，不仅跳过传入文本，**整个累积被重置**（`resetTranscriptAccumulation()` 清空 `committedRef` 和 `pendingInterimRef`）。用户发送消息后紧接着的 ASR 转录全部丢失。

### V21 [MEDIUM] 无 `getUserMedia` 授权时设备标签为空 — 虚拟设备检测失败

**文件**: `gui/src/components/AudioOutputManager.tsx:66-76`

未调用 `getUserMedia` 直接 `enumerateDevices()`，浏览器返回的设备标签**全部为空字符串**。`isVirtualOutputLabel` 总返回 false。用户被静默路由到虚拟设备。

### V22 [MEDIUM] `PageFallback` 拼写错误 — 意为 `PageFallback` 而非 `PageFallback`

**文件**: `gui/src/pages/Dashboard/index.tsx:112`

```tsx
function PageFallback() {  // 应为 PageFallback
```

### V23 [MEDIUM] 唤醒词 20 次重连后永久静默失效

**文件**: `gui/src/hooks/useWakeWord.ts:215`

```ts
if (wakeRestartCountRef.current > 20) return;  // 静默永久停止
```

此计数器只在该 hook 重新调用时重置。若网络不稳定导致频繁断开且用户切换设置，20 次后唤醒词悄无声息地永久停止工作。

### V24 [MEDIUM] `tts-evolution.js` 的 `generateSSML()` 从未被调用

**文件**: `src/core/evolution/tts-evolution.js`

完整的 SSML 生成管线（`getVoiceParams` → `addNaturalPauses` → `addEmphasis` → `generateSSML`）已实现但**未被任何模块调用**。`tts/index.js` 的 Edge TTS 提供者内联构建自己的 SSML，不使用此引擎。进化引擎的 `learnedAdjustments` 对实际 TTS 输出无影响。

### V25 [MEDIUM] `voice-asr-handler.js` 中重叠的超时定时器

**文件**: `src/handlers/voice-asr-handler.js:89,147`

session 创建前启动 15 秒超时（第 89 行），`session.flush()` 后启动 12 秒超时（第 147 行）。后者开始更晚，实际有效超时为 flush 后 12 秒。前者成为死代码。

### V26 [MEDIUM] `voice-evolution.js` 缓存命中率除零产生 NaN

**文件**: `src/core/voice-evolution.js:172-174`

```js
cacheData.stats.averageHitRate = cacheData.stats.totalCacheHits /
    (cacheData.stats.totalCacheHits + cacheData.stats.totalCacheMisses);
// 首次请求：0/0 = NaN
```

首次缓存未命中（hits=0, misses=0）时结果为 `NaN`。此 `NaN` 持久化到磁盘，污染所有后续计算。

---

## 第四部分：面板系统 — 致命/严重级 Bug

### P1 [CRITICAL] `ShowHotspot` 工具始终绕过缓存

**文件**: `src/tools/panel-tools.js:92-94`

```js
// panel-tools.js — 传递对象
const data = await panels.hotspot.getHotspot(platform, { forceRefresh: params.refresh === true });

// panels/hotspot.js — 期望布尔值
getHotspot(platform, forceRefresh) {  // 第二个参数预期是 boolean
  if (forceRefresh) { /* 总是进入此分支，因为 {} 是 truthy */ }
}
```

`getHotspot()` 的第二个参数是 **boolean**，但调用者传入**对象**。任何对象都是 truthy，因此 cache 总是被跳过，30 分钟缓存形同虚设。每次 AI 调用热点面板都触发全量网络抓取。

### P2 [HIGH] HotspotPanel 颜色正则破坏 Stat Card 背景

**文件**: `gui/src/components/HotspotPanel/index.tsx:444-445`

```tsx
// 输入：'#ff6b6b'
const match = stat.color.matchAll(/\w+/g);  // \w 不匹配 # → ['ff', '6b6b']
const [r] = match.next().value;             // r = 'ff'
style={{ background: `rgba(${r}, 0.1)` }}   // 输出 rgba(ff, 0.1) — 无效 CSS！
```

所有 Stat Card 渲染为无效 `rgba()` 值，自定义背景和边框完全丢失。

### P3 [HIGH] `tokenUsed` 始终为 0 — StatusBar 上下文条永远 0%

**文件**: `gui/src/components/StatusBar/index.tsx:35`

```tsx
const [ctxState] = useState({ tokenUsed: 0, contextLength: 200000 });
// tokenUsed 从未被更新！
```

后端 `/config` 只返回 `contextLength`（上限），不返回当前用量。前端没有任何代码路径更新 `tokenUsed`。进度条永远显示 `0 / 200000 (0%)`。

---

## 第五部分：面板系统 — 中级 Bug

### P4 [MEDIUM] API 响应包装不一致

**文件**: `src/handlers/panel-handler.js:63,93,103`

| 端点 | 包装格式 |
|------|---------|
| `/panels/*` | `{ ok, data }` |
| `/panels/activity` | `{ success, data }` |
| `/panels/activity/state` | **无包装**（直接返回 `{ state, meta, ... }`） |

三种不同格式迫使前端 `apiGet` 的标准化逻辑（`src/lib/api.ts:169`）每种端点都需要特殊处理。

### P5 [MEDIUM] MemoryGraph 滚轮事件监听器泄漏

**文件**: `gui/src/components/MemoryGraph/index.tsx:509-520`

```tsx
svg.node()?.addEventListener('wheel', ...)  // 每次 effect 运行时添加
// cleanup 函数中未移除这个监听器！
```

当 `nodesKey` 或 `edgesKey` 变化时 effect 重复运行，每次叠加一个新的 wheel 监听器。累积的监听器导致一次滚轮触发多次缩放变换，**缩放行为异常**。

### P6 [MEDIUM] HotspotPanel 的 `result?.ok` 检查不匹配后端格式

**文件**: `gui/src/components/HotspotPanel/index.tsx:133-135`

```tsx
const data = (result as any)?.ok ? (result as any).data : (result as any)?.data || [];
```

后端返回 `{ ok: true, data: [...] }`，但 `apiGet` 标准化为 `{ success: true, data: { ok: true, data: [...] } }`。`result?.ok` 从不 match（因为 `ok` 嵌套在 `result.data` 中）。代码通过 `raw?.data || []` fallback 路径工作，但这是脆弱且令人困惑的。

### P7 [MEDIUM] ActivityStream 去重键可能产生 `"undefined|undefined"`

**文件**: `gui/src/components/ActivityStream/index.tsx:588-598`

```ts
// 轮询数据过滤器
.filter(i => i.toolName + '|' + i.roundId)  // 非工具项 → "undefined|undefined"
```

非工具项（thinking、response）的 `toolName` 为 undefined，去重键变为 `"undefined|undefined"`，可能错误去重所有非工具项。

### P8 [LOW] MemoryGraph 注入的 `<style>` 元素永不移除

**文件**: `gui/src/components/MemoryGraph/index.tsx:412-435`

组件 unmount 后，`<style id="memory-graph-animations">` 元素永久留在 DOM 中。虽有 id 防重但无清理逻辑。

### P9 [LOW] panels-v2-tool `_pushScene` 空 catch

**文件**: `src/tools/panels-v2-tool.js:25-31`

SceneStore 操作错误被静默吞掉，违反"无静默失败"规则。

### P10 [LOW] HotspotPanel SkeletonBar 动画错误

**文件**: `gui/src/components/HotspotPanel/index.tsx:106`

使用 `hsSlideUp`（透明度淡入）加 `infinite alternate`，连续淡入淡出。正确行为应是脉冲/闪烁动画。

### P11 [LOW] panel-handler `readJsonBody` 静默吞掉 JSON 解析错误

**文件**: `src/handlers/panel-handler.js:146-156`

POST 请求体 JSON 解析失败时静默返回 `{}`，不给调用者任何提示。

---

## 第六部分：跨系统串联 Bug

### C1 [CRITICAL] TTS 文本在 handler 和 engine 中被重复处理

`request-handler.js:724` 调用 `stripMarkdownForSpeech(body.text)`，然后 `tts/index.js` 内部再次调用 `sanitizeTextForSpeech`。文本经过双层清理，但两者的逻辑不100%一致（`voice-utils.ts` 版本与 `tts/index.js` 内联版本有差异），可能导致某些字符被处理两次或产生不一致结果。

### C2 [HIGH] `Local Piper TTS` + `voice-evolution` 的双重死代码

Piper 提供者从未注册到引擎（V9），`generateSSML()` 从未被调用（V24）。这两个功能各自独立开发但从未集成——表明语音系统的组件间集成测试缺失。

### C3 [HIGH] `voice-cloud-ws.js` 中 `doubaoAppId` 未映射到 WebSocket creds

**文件**: `src/handlers/voice-cloud-ws.js:95`

```js
const creds = { volcAsrAppKey, volcAsrAccessKey };  // 没有 doubaoAppId！
```

ASR 配置若通过 `doubaoAppId`/`doubaoAppKey` 字段配置，不会被传递到火山引擎 factory。WebSocket 实时 ASR 路径认证失败。

### C4 [MEDIUM] `handleVoiceDiagnose` GET/POST 方法无区分

`ROUTE_TABLE`（`request-handler.js:601-602`）同时注册 `GET` 和 `POST` 到 `/api/voice/diagnose`，handler 内部不区分方法。功能上无害但违反 REST 约定。

---

## 第七部分：按严重性汇总

| 严重性 | 数量 | 关键问题 |
|--------|------|---------|
| 🔴 **CRITICAL** | 10 | 并发 TTS 状态覆盖、音频路径不一致、ASR 诊断永远失败、VoiceStateContext 非响应式、onStateChange 类型错误、volume 硬编码 0、ShowHotspot 缓存绕过 |
| 🟠 **HIGH** | 13 | WS 发送异常、WS 泄漏、Piper 孤立、process 遮蔽、转录排序错误、设备路由失效、重连计数翻倍、TTS 重播 404、LFO 泄漏、ASR 状态重置、唤醒词静默失效 |
| 🟡 **MEDIUM** | 20 | barge-in 恢复缺失、local TTS 不可达、DeepSeek 404、流竞态、SSML 死代码、除零 NaN、颜色正则错误、token 显示 0、API 包装不一致、滚轮泄漏、去重键错误、等等 |
| 🔵 **LOW** | 8 | Style 泄漏、空 catch、动画错误、readJsonBody 静默、等 |

---

## 第八部分：修复优先级建议

### P0 — 立即修复（阻止功能运行）

1. **V1** — 修复 TTS 引擎并发：`handleVoiceTTS`/`handleVoiceTTSStream` 中 save/restore 被修改的单例属性
2. **V2** — 统一音频目录：`handleVoiceAudio` 改从 `tts-output/` 读取，或写入 `audio/`
3. **V3** — 为 `validateCredentials()` 传递正确的 config 参数
4. **V4 + V5** — 重写 `VoiceStateContext` 使其真正响应式，修复 `onStateChange` 类型
5. **V6** — 将 `volume` 变量连接到 `onFrame` 回调的计算值
6. **P1** — 修复 `getHotspot` 布尔/对象参数不匹配

### P1 — 高优先级（功能降级但未完全阻断）

7. **P2** — 修复颜色正则匹配 `rgba()` 值
8. **P3** — 添加 token 用量追踪 API 并更新前端
9. **V7** — `sendPcm` 添加 try/catch
10. **V8** — WS 重连时关闭旧连接
11. **V11** — 使用数字排序代替 `localeCompare`
12. **V26** — 修正除零为 `total === 0 ? 0 : hits/total`

### P2 — 中等优先级（质量、性能、维护性）

13. **V9** — 注册 Piper 到 TTS 引擎
14. **V10** — 重命名 `const process = exec(...)` 为 `const child = exec(...)`
15. **V13** — 统一重连计数逻辑，避免双重计数
16. **P4** — 统一 API 响应格式为 `{ success, data }`
17. **P5** — MemoryGraph cleanup 添加 wheel 监听器移除
18. **P6** — 修复 HotspotPanel 数据提取逻辑
