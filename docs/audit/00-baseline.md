# BossAgent 审计基线 — 2026-07-30

> 本文档记录彻底检查启动时的基线数据与第一轮修复成果，作为后续迭代的对照基准。

## 一、基线快照（修复前）

### 1.1 代码质量（eslint）

| 指标 | 数值 |
|------|------|
| 扫描文件数 | 836 |
| Errors | 268 |
| Warnings | 1347 |
| 错误规则分布 | no-mixed-spaces-and-tabs: 256, no-empty: 7, no-undef: 4, no-dupe-else-if: 1 |
| 警告规则分布 | no-unused-vars: 1347 |

### 1.2 测试与覆盖率

| 指标 | 数值 |
|------|------|
| 测试套件 | 21 passed |
| 测试用例 | 272 passed |
| 语句覆盖率 | 9.63% (6798/70565) |
| 分支覆盖率 | 3.7% (1757/47439) |
| 函数覆盖率 | 6.53% (634/9698) |
| 行覆盖率 | 10.35% (6667/64387) |

### 1.3 依赖漏洞（npm audit）

| 包 | 严重度 | 状态 |
|----|--------|------|
| brace-expansion <=5.0.7 | high | ✅ 已修复（overrides → ^5.0.9） |
| uuid <11.1.1 (exceljs 传递依赖) | moderate | ⚠️ 保留（降级 exceljs 为 breaking，风险可控） |

漏洞数：4 → 2（仅剩 exceljs 传递依赖的 uuid moderate）

### 1.4 巨型文件（>30KB）

| 文件 | 大小 | 备注 |
|------|------|------|
| ai.js | 189KB | 已拆出 ai-parsers/ai-summarizer，仍需继续拆分 |
| system-prompt.js | 95KB | 提示词待外部化 |
| skills.js | 61KB | 待评估合并 |
| config.js | 52KB | 待按域拆分 |
| tool-contract.js | 42KB | — |
| subagent-enhanced.js | 35KB | — |
| tool-orchestrator.js | 33KB | — |

## 二、第一轮修复成果（P0 止血）

### 2.1 代码缺陷修复（12 个 eslint errors → 0）

| 文件 | 行 | 问题 | 修复 |
|------|----|------|------|
| src/core/ai.js | 753 | `globalRequestInterrupt` 未定义 + 空 catch | 改为 lazy require + catch 加注释 |
| src/core/ai.js | 997/999 | 空 catch（hotspot/weather 可选依赖） | 加注释说明 |
| src/core/ai.js | 1175 | 空 catch（MusicSearch 可选） | 加注释说明 |
| src/core/ai.js | 3082 | 空 catch（panel cmd 可选） | 加注释说明 |
| src/core/tool-contract-v2.js | 171 | `ruleFn` 未定义（自定义规则永不执行） | 改为 `rule(contract)` |
| src/core/browser-control/index.js | 863 | `maxAgeMs` 未定义（变量名拼写错误） | 改为 `maxAgeMs: maxAge` |
| src/core/init.js | 541 | `logger` 作用域错误（const 在 try 内，catch 访问不到） | 提到 try 外 `let logger = null` + catch 安全调用 |
| src/core/token-estimator.js | 133 | `no-dupe-else-if`（死代码分支） | 改为 `part.content` 分支 |
| src/handlers/voice-cloud-ws.js | 186/187 | 空 catch | 加注释说明 |

### 2.2 格式修复（256 个 mixed-spaces-tabs → 0）

4 个文件行首 tab/空格混合，统一为空格缩进：
- src/core/tts/index.js (177 处)
- src/handlers/panel-handler.js (73 处)
- src/core/voice-evolution.js (4 处)
- src/core/tts/piper-provider.js (2 处)

### 2.3 漏洞修复

- `brace-expansion`: overrides 从 `2.0.1` 升级到 `^5.0.9`，消除 high 漏洞
- `uuid` (exceljs 传递依赖): 评估为 moderate 且仅影响 v3/v5/v6+buf，项目用 v4，风险可控，暂保留

### 2.4 音乐面板语音关闭 Bug 修复

实施 music-panel-enhancement.md 步骤 2（语音关闭）：
- `gui/src/components/VoiceIntegration.tsx`
  - 新增 `interceptLocalVoiceCommand()` 函数 + `VOICE_CLOSE_MUSIC_PATTERNS` 模式表
  - `onFinal` 回调加即时拦截（无需等 2s 静默发送延迟）
  - `getSendMsg` 包装为拦截版（兜底覆盖 PTT/连续所有发送路径）
- 覆盖命令：关闭音乐/关闭播放/关闭播放器/关掉音乐/停止音乐/关闭音乐面板/暂停音乐 等

FloatingMusicPlayer 已实现的部分（无需改动）：
- ✅ 居中显示 + 背景虚化（backdrop-blur 16px）
- ✅ 入场/退场动画（scale + translateY，shouldRender/entered 状态机）
- ✅ 关闭面板时暂停播放
- ✅ 自动滚动到当前播放曲目（trackListRef + track-active）
- ✅ 全局状态暴露（__musicPanelVisible + __closeMusicPanel）

## 三、修复后验证

| 验证项 | 结果 |
|--------|------|
| eslint errors | 0（从 268 降至 0）|
| eslint warnings | 1346（no-unused-vars，待后续清理）|
| 测试用例 | 272 passed |
| TypeScript 编译 | 待验证 |

## 四、后续优先级（待推进）

1. **P1 契约对齐**：前后端 API endpoint 差异比对、{success,data} 格式统一
2. **P1 WebSocket**：消息 schema 对齐、全局变量同步方向梳理
3. **P2 架构瘦身**：ai.js 拆分、system-prompt.js 提示词外部化、模块族合并
4. **P3 体验打磨**：前端性能、音效/动效统一、语音命令扩展
5. **测试完善**：覆盖率从 9.63% 提升，为关键模块补回归测试
