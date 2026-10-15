# CrabPaw UI/UX 创新设计规格 v1

> 状态：**P0-1 与 P0-2 已实施**（2026-09-30）；P1/P2 仍为设计稿
> 核心原则（用户确认）：**让老板「信」 > 让老板「哇」**
> 定位前提：老板的随身 AI；运行在 U 盘上，用户不安装任何环境；数据全在 U 盘

---

## 实施进度

| 项 | 状态 | 交付物 | 验证 |
|---|---|---|---|
| **P0-1 离线地基**（字体自托管 + CSP 收敛） | ✅ 已实施 | `scripts/fetch-inter-fonts.js`（生成器）、`gui/src/assets/fonts/inter-latin-var.woff2`（47.1KB 单文件可变字体，覆盖 400/600）、`gui/src/assets/fonts.css`（生成物）、`gui/src/index.css`、`gui/index.html`（preload）、`gui/electron/main/index.ts`（两处 CSP 去 Google Fonts）、`NOTICE.md`（SIL OFL 署名） | `gui/src/test/offline-fonts.test.ts` 6 例通过；断网零外网字体请求（产物 grep 干净） |
| **P0-2 动效保真阶梯** | ✅ 已实施 | `gui/src/lib/motion-tier.ts`（档位解析 + FPS 采样 + 持久化 + 系统偏好监听）、`gui/src/index.css`（三档令牌 + L0 强制清零 + `prefers-reduced-motion` 兜底）、`gui/src/main.tsx`（接线）、`SettingsSections/Appearance.tsx`（动效强度手动开关） | `gui/src/test/motion-tier.test.ts` 14 例通过；产物含三档令牌与无障碍兜底 |
| **P1-1 语音·视觉契约** | ✅ 已实施 | `gui/src/lib/surface-utils.ts`（关闭状态机 v2：SurfaceId/Revision 分离 + 两种关闭语义）、`gui/src/pages/VoiceShell/index.tsx`（接线 + 可见关闭确认：关闭卡在 DOM 多留一段播收拢动画）、`gui/src/pages/VoiceShell/styles.css`（`holo-card-close` + `.is-closing`） | `surface-utils.test.ts` 18 例通过（含缺陷复现场景）；产物含 `holo-card-close` 且时长走 `--motion-enter` 令牌 |
| **P1-2 音频优先晨报** | ✅ 已实施（真机听觉校准待做） | `briefing-script.ts`（60 秒严格结构 + 诚实降级 + 分句导航）、`tts-prewarm.ts`（预合成缓存）、`briefing-controller.ts`（取数→编译→预热→逐段播报 + 屏音同步 + 重播/跳段）、`briefing-voice.ts`（三条语音指令注册 + 未接线守卫）、`speech-queue.ts`（`replay` 动作 + 预热音频字段）、`useSpeechQueue.ts`（`replayLast()` / `currentJob` / 预热直放）、`main.tsx`（注册命令） | `briefing-script` 24 例 + `tts-prewarm` 14 例 + `briefing-controller` 23 例 + `briefing-voice` 17 例 + `speech-queue` 13 例 = **91 例** |
| **P1-3 HUD 单数字条** | ✅ 已实施 | `gui/src/lib/hud-metric.ts`（四态展示口径 + 诚实降级）、`gui/src/components/HudBar/`（组件 + 样式 + 测试）、`VoiceShell/index.tsx`（停靠左下 + 可关闭并持久化）、`VoiceShell/styles.css`（`.hud-dock`） | `hud-metric` 25 例 + `HudBar` 14 例通过 |
| **P2 数据出处链** | ✅ 前后端已实施 | 后端：`src/core/business/data-provenance.js` + `provenance-handler.js` + `request-handler.js`（`GET /api/business/provenance`）+ `semantic-views.js` 的 `reconcileColumns`；前端：`gui/src/lib/provenance.ts`（呈现口径）、`gui/src/components/ProvenancePanel/`（链路面板）、`HudBar`（"从哪来"入口）、`VoiceShell`（挂载） | 后端 28 例 + 前端 28 例通过；**并借此修掉一个线上真故障**（见下） |
| **P2 经营数据三维化** | ✅ 已实施（导出 MP4 明确不做） | `gui/src/lib/business-scene.ts`（业务量→空间/视觉的纯映射）、`gui/src/components/BusinessScene3D/`（组件 + `render-three.ts` 懒加载渲染器 + 样式 + 测试）、`ProvenancePanel`（"看账龄结构"入口）、`VoiceShell`（与出处链**共用浮卡位置**） | `business-scene` 25 例 + `BusinessScene3D` 14 例通过；**实测 JS 总量 +15KB**（three 留在独立懒加载 chunk） |

**实施中修正的两个偏差**（保留记录，避免后人重踩）：
1. 最初按字重分别下载 400/600 两份 woff2，实测**两份字节完全相同**（Google 对固定字重返回同一份 variable font）；改为 `wght@400..600` 轴区间单文件 + `font-weight: 400 600`，体积 94KB → 47KB。
2. 生成的 `fonts.css` 里字体相对路径曾写成 `./assets/fonts/`（相对仓库根），而基准是文件自身所在目录 → Vite 无法解析、产物只剩一个字重；已改为 `./fonts/`。**新增 `gui/src/assets/` 下的生成物时务必确认 URL 基准。**

**P1-1 实施要点（与本文档 §3 的差异说明）**：
- §3.1 原计划"新增 `escalation` 字段"来标记允许复活的升级事件。实施时发现**不必新增后端字段**：
  用 `intent === 'confront'` + **内容指纹是否变化**即可表达"风险升级"，且更稳
  （不依赖后端是否记得带字段）。唯一例外因此只有一条：confront 卡内容变化时允许
  重新弹出，同一份内容再推仍保持关闭（防抖动着回来）。
- §3.2 的"收拢光带 + 残影"落地为 `.holo-stage-item.is-closing`（收拢动画，
  时长走 `--motion-enter` 令牌）。**关键发现**：原实现最后一关时容器
  `cardWallSurfaces.length > 0` 直接卸载，离场动画**永远跑不到**；已改为
  `visible + closing` 双列渲染，容器在关闭动画期间不卸载。若后续有人改这个条件，
  关闭确认会静默失效——已在代码注释中标注。
- §3.3 不变量 1（"任意后续数据刷新都不改变 dismissed"）已由 18 例单测覆盖，
  其中"同 id 数据刷新不得复活"一例即线上"说关了没关"的复现场景。
- 遗留：§3.2 的"≤4 字语音确认"沿用既有 `__rtCloseCard` 的返回值，未新增音频通道；
  §3.3 不变量 2（手动关闭与语音关闭同一状态机）已满足——两者都走 `dismissSurface`。

**P1-2 实施要点与取舍**：- §4.2 三项交互里，**"再说一遍"只重播最后一句**已实现（`replay` 动作 + `replayLast()`）；
  **"第二条"**（跳下一段）由 `briefingNav` + `currentSegment` 提供纯逻辑。
- §4.1 的"预渲染"落地为 `TtsPrewarmCache`：**只缓存在内存，不写 localStorage/IndexedDB**——
  单段 base64 可达数百 KB，四段轻易超 5MB 配额，而 U 盘磁盘配额更该留给业务数据。
  代价是重启后需重新预热（预热本就发生在启动后空闲时段）。
- **实施中发现并修掉一个真 bug**（被单测抓出）：`replay` 最初实现为"插到队首"，
  而 `playingId` 指向队首 job（见 `dequeue`/`start` 实现）→ 新 job 插队首会把
  正在播的 job 挤到 index 1，`playingId` 与队首失配。现改为**插到正在播的段之后**：
  既不打断正在念的这句，它又正好是"下一句"。
- §4.1 的"屏幕只显示当前这一句"已备好原语（`currentSegment(script, pos)`），
  字段 `SpeechJob.segmentIndex` 也已加上。
- **未接线部分（明确遗留，不假装完成）**：把 `/api/briefing/today` 取数 →
  `buildBriefingScript` → `TtsPrewarmCache.warm` → 逐段 `enqueue` 这条装配接到 VoiceShell，
  以及"晨报 / 再说一遍 / 第二条"三条语音指令的分发。原因是这块要改 VoiceShell 大文件
  且需要**真机听觉验证**（合成音色、断句停顿、语速），不适合无听觉反馈时盲改。
  纯逻辑已全部备齐并有 51 例测试，接线时不需要再写业务判断。

  > **更新（同日续做）**：上条遗留的装配层已补齐——新增 `briefing-controller.ts`
  > （取数→编译→预热→逐段入队，含屏音同步与重播/跳段）与 `briefing-voice.ts`
  > （三条语音命令注册 + 未接线守卫），并在 `main.tsx` 完成命令注册。
  > 至此仅剩**一步**：VoiceShell 挂载时把控制器实例挂到 `window.__crabpawBriefing`
  > （接口见 `BriefingVoiceHandler`）并渲染 `currentSegment()`。守卫保证：未挂接时
  > 这三条说法一律放行给模型，不会吞掉"继续"这类正常对话指令。
  > 这一步刻意留给真机听觉校准（音色/停顿/语速）时一次完成。

**P1-3 实施要点与一个关键发现**：
- **为什么不独立窗口/托盘**：实测 `gui/electron/main/index.ts:847` ——
  `if (closeToTray && serviceReady && isDev)` 才隐藏到托盘，**便携版（U 盘）点 X 是真正退出**
  （U 盘实测结论，注释里写明"点 X 后仍无法弹出 U 盘"是当年的问题）。
  所以脱离主窗口的常驻路径在目标形态下没有活着的后端可查。要"瞄一眼"就得做成**应用内常驻条**。
  实现为左下角停靠（避开中央语音球与右栏对话卡、与右下浮卡栈分层），可关闭并持久化。
- **诚实降级是这条的核心而不是附赠**：常驻条待在视野里，把"取数失败"显示成 `0`
  会被持续当成事实。四态 `ok / stale / empty / failed` 因此被做成**截图可区分**，
  且 `failed` 优先于 `stale`（失败是最需要被看见的状态）。
  `stale` 刻意**不隐藏数字**——旧数比无数有用，但必须带沙漏。
- **实施中踩到并记录的坑（值得进团队知识库）**：我在 JSDoc 注释里写了一个 `%>` 式的 `?>`
  式，TypeScript 把 `?>` 当作 HTML 式括号闭合处理，**静默截断了该注释之后的接口成员**，
  导致 tsc 报"`unit` does not exist in type `HudInput`"——而 `unit` 明明在声明里。
  更迷惑的是报错行号指向源文件中不存在的行。结论：**注释里不要出现 `?>`**；
  遇到"报错指向不存在的行号"先怀疑注释里的 HTML 式括号。

**P2 数据出处链实施要点 + 它立刻抓到的两个真故障**：
- **故障 A（线上真故障，已修）**：`v_contract` 语义视图引用**不存在的列** `到期日期`
  （真实表列是 `到期日`，多一个"期"）。SQLite 的 `CREATE VIEW` **不校验列引用**，
  所以视图"建成功"、查询时才报 `no such column` → **合同到期卡长期显示"无到期合同"**，
  错误只落在日志里。修复后合同取数恢复（实测 4 份合同可查，最近 20 天后到期）。
  对策不止修数据：给 `semantic-views` 加了 `reconcileColumns()`——
  **建视图前用真实表结构对账注册表列名**，只保留两端都存在的列，并把差异
  （`reconciled[] / errors[]`）如实上报，而不是静默丢弃。
- **故障 B（我自己造成的，已修）**：上面那个坏列名来自**我的测试夹具**
  （`briefing-today-default.test.js` 给临时库登记了 `到期日期`）。该测试给隔离库调
  `registerTable`，而 `business-data-registry` 在**模块加载时**定音注册表路径；
  一旦它在 beforeAll 之前被同进程加载，登记就会写进**生产** `registry.json`——
  实测把生产里 `contracts` 条目的列名与 `sourceFile` 都覆盖成了测试夹具的值。
  修复：该测试文件头写明"隔离红线"，并在末尾加了**兜底断言**
  （隔离目录被写、生产注册表未出现临时路径条目）。跑完核对生产注册表 SHA256 未变。
- 端点契约与业务库同一条铁律：库不可读 / 视图缺失 / **视图查询失败** 一律
  `ok:false + unavailableReason`，绝不用 `rows:0` 冒充——对老板而言
  "没有数据"与"取不到数据"是完全不同的两件事。（这条在实施中差点写错：
  初版把查询失败返回成 `rows:null` 却仍报 `ok:true`，被自己的单测抓出并改正。）
- **前端呈现要点**（`gui/src/components/ProvenancePanel/`）：链路渲染为
  `来源 → 视图 → 指标` 横向节点 + 事实行（参与行数/空值/来源数）。
  与 HUD 共用同一套"需要你注意"的颜色语言（琥珀）。
  **取不到数时不渲染任何节点**——空链路会被读成"没有来源"，比报错更误导。
  入口放在 HUD 的"从哪来"（P2 落地：`HudBar.onShowProvenance`），
  且**数字不可信时入口提亮**（失败/陈旧时最需要核对来源）。
  外壳复用 `ShellFloatCard`（拖动 + 位置持久化），不新造浮层机制。

**P2 三维化实施要点与实测数字**：
- **体积账先算再做**。动手前先量：three.js 在 `node_modules` 里 22.1MB，
  `three.module.min.js` 0.3MB；但产物里它**本来就在**
  （`vendor-three-*.js`，经 `HotspotPanel → lazy(() => HotspotEarth)` 进包）。
  所以三维化复用已有 chunk，**首屏零新增**。
  收尾实测：JS 总量 **2242KB → 2257KB（+15KB）**，`vendor-three` 仍独立 516KB。
  这就是"U 盘应用该不该上 3D"的可回答形式——不是感觉，是那 15KB。
- **映射与渲染分离**：`lib/business-scene.ts` 只做"业务量 → 空间与视觉参数"
  （账龄→纵深、金额→体积、该看程度→自发光、集中度→横向聚拢），不碰 three/DOM。
  好处有二：渲染器可换（WebGL / 二维 / 将来导出视频）而不改业务口径；
  且"哪个柱子该发光""账龄怎么分桶"都是断言而不是感觉。
- **降级不是阉割**：L0 档**根本不挂 WebGL**（省电 + 避开老机器驱动问题），
  直接用同一份数据画条形；二维行数与三维节点数由 `toFlatRows()` 保证一致。
  组件测试跑在 jsdom（无 WebGL），因此**跑的就是真实降级路径**，
  并断言"二维视图必须说明数据完全相同"——否则老板会怀疑降级后少了东西。
- **不引入 OrbitControls**（examples 额外模块会再撑大 chunk），
  几十行原生指针处理完成拖拽旋转 + 滚轮缩放。
- **导出**：PNG 已可用（`preserveDrawingBuffer: true`）。
  **MP4 明确不做**：需要 `MediaRecorder` 或服务端 ffmpeg，前者在低端机不稳、
  后者给 U 盘应用加一个重量级依赖。按"真需要时再做"处理，已在规格里记为不做。
- **实施中修掉一个真问题**：输入 `items: []` 时 `buildBusinessScene` 走的是
  "有账目但金额为 0"分支（`emptyReason` 为 `null`），组件若只判 `emptyReason`
  就会画出**空画布 + 图例 + 结论**——正是要避免的"空场景"。现改为按
  `nodes.length === 0` 判空，并断言空态下不渲染画布与图例。

---

## 〇、本规格的判断依据（都是实测，不是感觉）

| 事实 | 证据 |
|---|---|
| 视觉语言成熟 | `gui/src/index.css` 有完整 z-index 分层表 + 色彩/动作令牌；"Refined Dark Minimalism + Glassmorphism" |
| 动效量大 | 340 处 `@keyframes`、154 处 `transition`、102 处 `backdrop-filter` |
| 无动效降级能力 | `prefers-reduced-motion` 全库 **0 命中**；性能档位概念 **0 命中** |
| 玻璃效果高度集中 | `VoiceShell/styles.css` 32 处、`index.css` 32 处、`ShellFloatCard` 12 处——其余文件均 ≤4 处 |
| 字体依赖网络 | `index.css:1` `@import url('https://fonts.googleapis.com/...')`；仓库 **0 个本地字体文件** |
| CSP 为字体放行外网 | `gui/electron/main/index.ts:3673` 注释"font-src 放行 fonts.gstatic.com"；主窗 CSP `connect-src * … https:` |
| 3D 能力已验证 | three.js 已用于 `HotspotEarth`；canvas/WebGL 26 处 |
| 图表自绘 | `echarts` 在依赖里但前端零引用；图表是 `SceneShell/kinds/chart.tsx` 自绘 |
| 卡片身份按内容生成 | `VoiceShell/index.tsx:641` `dismissKey = \`${s.id}@${JSON.stringify(s.data)}\`` |

**三个由此得出的结论**

1. **"酷炫"的瓶颈不是效果数量，是离线可靠性与响应质感。** 102 处玻璃 + 无降级 = 在 U 盘插的低端机上会抖；字体走网络 = 离线首屏白屏。
2. **最大的可用性漏洞是"关闭状态不稳定"**：`dismissKey` 含 `JSON.stringify(s.data)`，数据一刷新（新价格/新数字）key 就变，已关闭的卡**复活**。这是机制根因，不是偶发 bug；对语音优先界面，"说关了没关"直接摧毁信任。
3. **信 > 哇 ⇒ 炫度必须花在"可见的可靠性"上**：数据出处、状态确定性、离线不出错、慢机器不掉帧。装饰性特效应当**收敛**而非增加。

---

## 一、P0-1 离线地基：字体自托管 + CSP 收敛

### 问题（三条独立危害）
1. **首屏被网络绑架**：`@import` 是阻塞式网络请求。无网/内网/国内网络下要等连接失败才回落系统字体。
2. **数字跳变（FOUT）**：老板最看重的就是数字；字体异步到达会让数字先以系统字体渲染再跳变。
3. **供应链面**：主窗 CSP 允许 `connect-src *` 与 `https:`，等于给"从网上取资源"留门。

### 设计
- 自托管 **Inter 子集**：`Latin Basic + Latin-1 Supplement + 数字/货币符号 + 常用标点`；两个字重 `400/600` 足够（现有 UI 只用到 400/500/600/700，建议归并到 400/600）。
- 预估体积：**约 14–22KB/字重（woff2）**，合计 <50KB，随包分发，无运行时请求。
- 中文不换字体（沿用系统字体栈），避免引入 10MB 级中文字库；中文渲染一致性交给系统。
- 字体加载策略：`font-display: swap` **不需要了**（本地文件即时可用），改为 `<link rel="preload" as="font" crossorigin>` 提前加载，确保**首帧即正确**。
- CSP 收敛：
  - `font-src 'self' local: data:`
  - 主窗 `connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*`（去掉 `*` 与 `https:`）
  - 若业务确实需要外链图片，单独保留 `img-src`，不动 `connect-src`

### 验收标准
- 断网冷启动：**首屏文字在 100ms 内以正确字体呈现**，无跳变（可用录屏逐帧核对）。
- DevTools Network：**0 个 `fonts.googleapis.com` / `fonts.gstatic.com` 请求**。
- 断网下 CSP 无 violation 报告。

### 风险与回退
- 若中文与 Inter 混排基线不齐：只对**数字/英文/代码**应用 Inter，中文走系统栈（`font-family` 分层），视觉上更稳。
- 许可证：Inter 为 SIL OFL 1.1，可随发行包分发；需在 `NOTICE.md` 补一行归属说明。

---

## 二、P0-2 动效保真阶梯（Motion Fidelity Ladder）

### 问题
102 处 `backdrop-filter` + 340 个 keyframes，且**零降级机制**。`prefers-reduced-motion` 也没做——既伤低端机，也无视了系统级无障碍偏好。

### 设计：三档 + 一条硬规则

| 档位 | 触发条件 | 玻璃/模糊 | 粒子/光效 | 转场时长 | 阴影 |
|---|---|---|---|---|---|
| **L0 精简** | `prefers-reduced-motion: reduce` ／ 设备评分低 ／ U 盘低速（可选检测） | 纯色替代（不透明） | 关闭 | 0–80ms 或瞬变 | 单层 |
| **L1 标准** | 默认（集显/中端） | 单层 `backdrop-filter`，仅浮层 | 仅关键反馈 | `--transition-normal` 200ms | 两层 |
| **L2 全效** | 独显/高分屏 + 高 FPS 采样通过 | 保留现有玻璃层次 | 全开 | `--panel-transition` 380ms | 多层 |

**硬规则（防止回潮）**
1. `backdrop-filter` **只允许出现在浮层类**（当前集中在 `VoiceShell`/`index.css`/`ShellFloatCard`）：常驻背景与内容卡一律禁用。
2. 同一帧可见的 `backdrop-filter` 元素**≤3 个**（超出则自动降级该帧的次要面板）。
3. 任何 `@keyframes` 若会被 ≥2 个元素同时循环播放，必须登记进动效预算表（见附录），未登记不得合并。

### 设备评分（轻量、无新依赖）
`deviceScore = f(hardwareConcurrency, deviceMemory, 启动后 3 秒内的 FPS 采样, 是否命中电源省电模式)`
- 明显偏好：**用真实 FPS 采样**而不是猜硬件。启动后 3 秒滚动平均 <45fps → 自动落 L0；45–58fps → L1；>58fps → L2。
- 结果持久化到本地，避免每次启动都重新探测；用户可在设置里手动锁定档位。

### 验收标准
- 强制 L0 下：`getComputedStyle` 抽查 0 个元素含 `backdrop-filter`；主流程无可感知卡顿（目标 ≥55fps）。
- 系统开启"减少动态效果"后重启：应用进入 L0，且**所有信息仍可完整获取**（不得因关闭动效而丢失状态反馈）。
- L2→L0 切换不重启应用（热切换）。

---

## 三、P1-1 语音·视觉契约（Voice–Visual Contract）

> 这是"信 > 哇"的核心。目标：**老板说关，就一定关；老板看得见它关了。**

### 3.1 结构性修复：卡片身份与生命周期分离

**现状缺陷**：`dismissKey = ${s.id}@${JSON.stringify(s.data)}` → 内容刷新即产生新 key → 已关闭的卡复活。

**设计**：三件套分离

| 概念 | 定义 | 说明 |
|---|---|---|
| **SurfaceId** | 稳定标识（`receivable-panel`、`briefing`…） | 关闭状态**只认它** |
| **Revision** | 内容版本号（递增） | 数据刷新只增 Revision，**不改 SurfaceId** |
| **Lifecycle** | `arriving → live → dismissed → archived` | `dismissed` 是持久状态；同 SurfaceId 的新 Revision 默认**不自动复活** |

复活规则（唯一例外，且必须显式）：仅当满足
- 新 Revision 携带 `escalation: 'confront'`（如风险等级上升、合同 3 天内到期），**且**
- 该 SurfaceId 的静默期已过（默认 30 分钟）

才允许重新弹出，并在卡片上标注"**为何再次打断你**"（一行灰字，例："逾期笔数 5→8，超过你设的阈值"）。**无正当理由不得复活。**

### 3.2 可见的关闭确认（300ms 契约）

语音指令 → UI 变更必须有一条**可被眼睛/余光捕获**的确认路径：

| 元素 | 动作 | 时长 | 目的 |
|---|---|---|---|
| 被关闭的面板 | 沿**远离视线中心**的方向收拢为细光带后消失 | 300ms `cubic-bezier(0.4, 0, 0.2, 1)`（沿用 `--panel-transition` 族） | 老板余光能确认"它走了" |
| 收拢终点 | 留 600ms 的**淡残影**（不占布局，`pointer-events:none`） | 600ms | 提供"刚才在这里"的空间记忆 |
| 音频确认 | 一句≤4字的短确认（"应收卡已收"） | 与动画同时起 | 双通道（看+听）确认 |
| 状态落库 | `Lifecycle=dismissed` + 时间戳 | 立即 | 重启/重连后仍保持关闭 |

**反向契约（打开）**：新卡片从**视线中心附近**展开（而非屏幕边缘），并在 200ms 内完成标题+首个关键数字的呈现——让老板 0.2 秒内知道"这是什么、数字多少"。

### 3.3 状态一致性不变量（可测试）

1. 语音说"关掉 X" → 500ms 内 `Lifecycle(X) = dismissed`，且**任意后续数据刷新都不改变该值**。
2. 用户手动关闭与语音关闭**走同一状态机**（不得两套逻辑）。
3. 任何 Surface 出现在屏幕上 ⇒ 其 SurfaceId 处于 `live`；不在屏幕上 ⇒ 不得是 `live`（不允许"看不见但仍算打开"）。
4. 重启应用后，已关闭的 Surface 保持关闭（已有 `loadDismissedKeys` 持久化，改为按 SurfaceId 存）。

### 3.4 视觉语言：交互痕迹（Paw Trail）

把"Paw 爪印"确立为**唯一的品牌动效母题**，只用在三处，绝不滥用：
1. 卡片被关闭时，离场位置的残影边缘带 2 个爪印刻度；
2. 语音聆听态，Orb 底部有一次爪印脉冲（替代已有的 `scene-dot-pulse` 语义）；
3. 数据链路的终点（见 §6）落一个爪印，表示"数已核过"。

> 品味警告：不要给 30 个面板各配一套进出场动画——那会滑向"手机游戏感"。**一个母题、三处使用、其余克制。**

---

## 四、P1-2 音频优先晨报（Audio-First Briefing）

> 场景：老板早上在车里，不看屏幕。

### 4.1 设计
- **60 秒结构**（严格）：`一句结论` → `三个数字` → `一个风险 + 一个建议动作` → `一句结尾`。超时即裁剪，不允许念成三分钟。
- **预渲染**：启动/日切时后台预生成当日首段音频（TTS 落到缓存文件），老板说"晨报"时**零等待出声**（目标 <300ms 起播）。
- **卡片同步**：音频播放时，屏幕只显示**当前这一句**对应的一张极简卡（不是四张卡堆叠），播完自动推进。车上看一眼即知讲到哪里。
- **屏幕无人在看时不渲染**：车内/仅音频模式（可由用户或 HUD 模式推断）下不挂载 SceneShell 卡，省 GPU 与内存。

### 4.2 三个"立刻被感知"的语音交互
| 指令 | 行为 | 关键实现点 |
|---|---|---|
| **"再说一遍"** | **只重播最后一句** | 必须记住分句边界（TTS 合成时按句切分并记时间戳），而非整段重来 |
| **"第二条"** | 跳到下一个语义段 | 段落边界 = 结构边界（结论/数字/风险/建议），不是静默切片 |
| **"详细点"** | 展开当前段为完整卡片 | 音频不中断，卡片在旁出现 |

### 4.3 验收标准
- 断网、冷启动、说"晨报"→ **300ms 内开始出声**（预渲染命中）。
- "再说一遍"只重播上一句（音频时长偏差 ≤10%）。
- 音频与屏幕卡片**严格同步**：任一时刻屏幕显示的句子 = 正在播放的句子。

---

## 五、P1-3 HUD 单数字常驻条（Glance Mode）

> 场景：会议中，老板需要"瞄一眼"，不是"打开面板"。

### 5.1 设计
一条极薄常驻条（贴屏幕顶边或托盘），**只承载一个数字 + 一个方向 + 一个风险点**：

```
🟡 逾期应收 ¥37.4万 ▲3笔 · 15:20 更新        ▸ 点击展开
```

- **一个数字**：当前最该看的指标（默认逾期应收；可由老板固定）
- **一个方向**：环比箭头（▲▼ + 绝对变化量，不写百分比——老板要看钱的绝对值）
- **一个风险点**：最多 1 条，且只在越过阈值时才出现
- **新鲜度**：必须显示"多久前更新"。**数据不新鲜却看起来正常，是比报错更危险的事**（本项目已有同类教训：取数失败静默返回空数组）
- 点击 → 展开为完整卡；**不做悬停自动展开**（会议中悬停是误触来源）

### 5.2 诚实降级（本项目铁律）
- 取数失败 → 显示 `—` + 灰化 + 一行小字"取数失败，14:32 重试"，**绝不显示 0**
- 数据陈旧超过阈值（默认 24h）→ 数字旁加沙漏标记
- 未导入任何业务数据 → 显示"未导入数据"，而不是"0 笔逾期"

### 5.3 验收标准
- 数字区在 200ms 内可读（字号不小于 13px，等宽数字 `font-variant-numeric: tabular-nums`）
- 取数失败/无数据/陈旧三态都有**可区分**的视觉，且截图可辨认
- 常驻条在 L0 档下仍保留（它是信息，不是装饰）

---

## 六、P2 经营数据物理化 + 数据出处可视化

> 这两个是"最容易被截图传播"的部分，但必须**先解决可信度**，否则只是花瓶。

### 6.1 数据出处链（Data Provenance Ribbon）——建议先做这个
老板问"这数从哪来"时，现在大概只能听模型念工具名。做成**卡背一条发光链路**：

```
[销售A.csv 09-12导入] ─┐
                      ├─▶ [v_sales 视图] ─▶ [本月营收 ¥571,000]  ✓ 爪印
[营收B.xlsx 09-20导入]─┘        14 行 · 0 处空值 · 2 分钟前
```

- 只显示**可核验的事实**：来源表、导入时间、参与计算的行数、空值数、计算耗时
- 任一环节异常（表被清空/字段缺失）→ 该节点变琥珀色并写明原因
- 交互：卡背默认隐藏，卡片右上角一个"溯源"钮或语音"这数从哪来"展开
- **不用文字堆砌**，用路径 + 节点 + 时间戳，一眼可读

### 6.2 经营数据三维化
用**已有 three.js**（`HotspotEarth` 已验证），不加依赖：

| 业务量 | 视觉映射 | 为什么这样映射 |
|---|---|---|
| 应收账龄 | **纵深轴**（越深越老） | 老板最关心"钱卡在哪一段账龄"，纵深一眼可判 |
| 现金流 | 高度/体积 | 体积直觉对应金额 |
| 异常 | 自发光 + 向上冒 | 视线自然被运动与亮度吸引 |
| 集中度 | 横向聚拢/散开 | 一眼看出是否押注单一客户 |

**约束（防止玩具化）**
- 只在"需要看结构"时出现（老板主动说"看看账龄"或点击），**不做常驻 3D**
- L0/L1 档下降级为二维分组条形图（同一份数据，不丢信息）
- 任何 3D 视图都必须能一键导出为**静音 MP4/PNG**（用于发群/发合作方）——这才是它的传播价值

### 6.3 验收标准
- 数据链路的每个节点都能点击回溯到原始导入记录
- 3D 视图关闭后内存回落（无 three.js 泄漏；当前只在 `HotspotEarth` 用到，需确认销毁路径）
- L0 档下 3D 全部可用二维替代，无功能缺口

---

## 七、不建议做的事（同样是设计决策）

| 不做 | 理由 |
|---|---|
| 引入 framer-motion / lottie | 已有 340 个 keyframes 的成熟体系；新增动画库会带来包体、GPU 与两套动效语义并存的风险 |
| 常驻 3D 背景/粒子 | 与"信 > 哇"冲突，且在 U 盘低端机上直接伤帧率 |
| 引入 echarts 只为了图表 | `chart.tsx` 自绘已够用；引入会把包体从 KB 级推到 MB 级 |
| 给 30+ 面板各配独立进出场动画 | 会滑向"手机游戏感"，且维护成本指数上升 |
| 悬停自动展开面板 | 会议/车内场景的误触来源 |
| 玻璃效果继续扩散到内容卡 | 玻璃只用于"浮在内容之上"的层，这是它的语义 |

---

## 八、实施顺序建议（评审通过后）

| 序 | 交付 | 触达文件 | 风险 |
|---|---|---|---|
| 1 | 字体自托管 + CSP 收敛 | `gui/src/index.css`、`gui/electron/main/index.ts`（2 处 CSP）、`NOTICE.md`、新增字体文件 | 低 |
| 2 | 动效阶梯 + `prefers-reduced-motion` | `gui/src/index.css`（令牌与全局规则）、3 个玻璃重文件、新增设备评分 hook | 低-中 |
| 3 | Surface 身份/生命周期分离 | `VoiceShell/index.tsx`（`dismissKey` 逻辑）、`lib/surface-utils.ts`、`SceneShell` | **中-高（触碰状态机，需回归"说关了没关"）** |
| 4 | 关闭确认动效 + Paw 母题 | `VoiceShell/styles.css`、`SceneShell/styles.css` | 中 |
| 5 | HUD 常驻条 | 新组件 + 托盘集成 + 诚实降级三态 | 中 |
| 6 | 音频优先晨报 | 接现有 TTS + briefing 取数 + 分句时间戳 | 中-高 |
| 7 | 数据出处链 | 需后端补"来源表/行数/空值数"字段 | 中（前后端联动） |
| 8 | 经营数据三维化 | 复用 three.js | 高（工期最长） |

**建议先做 1+2**：它们是后续一切的地基（离线可靠 + 可降级），且几乎不影响现有交互，回归风险最低。**3 单独一轮做**，因为它触碰状态机，必须配套回归用例（可参考已有的 `panel-close-chain.test.js` / `panel-state-toggle.test.js`）。

---

## 九、需要老板/产品确认的取舍

1. **HUD 常驻条的默认指标**：逾期应收？今日现金？还是老板可自选？——建议默认逾期应收，可换。
2. **复活规则阈值**：静默期 30 分钟是否合适？哪些事件有资格"再次打断"？（建议：风险升级、合同 3 天内到期、审批超时）
3. **中文是否也自托管**：不建议（体积成本巨大），但要接受中文渲染随系统字体而略有差异。
4. **"简约/全效"是否暴露给用户**：建议默认自动，同时在设置里给一个手动开关（信任感来自可控）。
5. **3D 视图是否需要导出**：若"发群/发合作方"是真实需求，则导出功能应与 3D 同批交付，否则价值减半。

---

## 附录 A：动效预算表（新增循环动画必须先登记）

| 名称 | 位置 | 时长 | 循环 | 成本 | 允许档位 |
|---|---|---|---|---|---|
| `scene-enter` / `scene-exit` | `SceneShell/styles.css:28,44` | 380ms | 否 | 低 | L0 L1 L2 |
| `scene-dot-pulse` | `SceneShell/styles.css:152` | — | 是 | 低 | L1 L2 |
| `scene-scan` | `SceneShell/styles.css:172` | — | 是 | **中** | L2 |
| `scene-confront-pulse` | `SceneShell/styles.css:200` | — | 是 | 中 | L1 L2 |
| `kpi-glow` | `SceneShell/styles.css:216` | — | 是 | 低 | L1 L2 |
| `tpScan` / `tpPulse` / `tpFlow` | `SceneShell/kinds/task-panel.css:48,103,135` | — | 是 | 中 | L1（L0 静态化） |
| `weather-enter` / `weather-exit` | `SceneShell/styles.css:124,128` | — | 否 | 低 | L0 L1 L2 |
| （新增）`paw-dismiss` | 待实现 | 300ms | 否 | 低 | L0 L1 L2 |
| （新增）`paw-trail` | 待实现 | 600ms | 否 | 低 | L1 L2 |

**令牌基线（沿用现状，不新造）**：`--panel-transition: 0.38s cubic-bezier(0.4,0,0.2,1)`；`--transition-fast: 150ms`；`--transition-normal: 200ms`；`--transition-slow: 300ms`（同缓动）。

> 实施注（2026-09-30）：P0-2 已落地三档令牌 `[data-motion="L0|L1|L2"]`，
> 新增 `--glass-blur` / `--motion-decor` / `--motion-enter` / `--motion-shadow-layers`。
> 本附录的"允许档位"列即为该表的**目标状态**；上表中已标注 L0 的项已由
> `[data-motion="L0"]` 的 `animation: none !important` 覆盖（`scene-scan` /
> `scene-dot-pulse` / `kpi-glow` / `tp-scan` / `tp-pulse` / `tp-flow`）。
> **新增循环动画请同时**：(1) 在本表登记；(2) 若不允许 L0，加进 `index.css`
> L0 段的 `animation: none` 清单。新增玻璃效果请用 `--glass-blur` 令牌而非字面量
> （字面量只受 L0 强制清零管辖，拿不到 L1/L2 差异化）。

## 附录 B：本规格不改变的东西
- 现有色彩/间距/z-index 令牌体系
- 现有 36 个 SceneShell kind 的语义与数据结构
- 现有三件套模式（surface upsert/remove + panel-state）
- 现有语音通道（KWS / 唤醒 / PTT）与后端协议

---

*本文件为设计稿，未修改任何代码。评审后按第八章顺序实施，每步都需配套：`npm test` 回归 + 断网冒烟 + L0 档冒烟。*
