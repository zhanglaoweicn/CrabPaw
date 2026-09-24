# VoiceShell 一体机部署手册（P5）

## 1. 打包

```bash
cd /d/bossagent/gui
npm run build:portable    # → D:\CrabPaw-Release\win-unpacked\CrabPaw.exe（Electron 一体机版，目录形态免安装）
# 单文件便携 exe（自解压，体积更大）：
npx electron-builder --config.win.target=portable   # → D:\CrabPaw-Release\CrabPaw-<version>-Portable.exe
npm run build             # → nsis 安装版 + portable 双产物
```

- **产物说明（2026-08-02 实测）**：`npm run build:portable` 实为 `electron-builder --config.win.target=dir`，产出 **`win-unpacked/` 目录**（`CrabPaw.exe` + `resources/app.asar` + `resources/data`，双击即用，等价便携版）；`build:portable` 脚本本身不会生成单文件 `Portable.exe`——需要单文件自解压包时用上面第二行命令
- `gui/build-portable.ps1` 是另一套**后端便携版**（`node resources/src/cli/index.js start` + `Start-CrabPaw.bat`，无 Electron GUI 运行时），与 Electron 一体机版互斥，勿混淆
- 输出目录：`D:\CrabPaw-Release\`（gitignore 外）

## 2. 启动参数（kiosk 模式）

| 参数 | 行为 |
|---|---|
| `CrabPaw.exe --kiosk` | **全屏无边框 + 防熄屏**（一体机推荐）：窗口 kiosk 化 + powerSaveBlocker 保持屏幕不熄 + 静默待机 |
| `CrabPaw.exe --fullscreen` | 仅全屏（保留窗口边界控制） |
| （无参数） | 普通窗口模式（默认） |

## 3. 开机自启

**方式 A（向导设置，推荐）**：首次配置向导（SetupWizard）→ "一体机模式"步骤 → 勾选"开机自启" → 注册表 HKCU Run 键（electron `app.setLoginItemSettings`，自动带 `--kiosk` 参数，登录后直接进入全屏待机）。

**方式 B（任务计划程序，运维手动）**：任务计划程序 → 创建任务 → 触发器"登录时" → 操作 = `CrabPaw.exe --kiosk`。

**校验**：重启电脑 → 自动进入全屏待机（无任务栏/无窗口边界）。

## 4. 触摸适配（已内置 P5）

- **触摸 PTT**：按住屏幕中央的语音球说话，松手即发（空格键 = 桌面键盘 PTT，二者叠加语义一致）
- **热区 ≥44px**：控制台/静音/连续对话按钮全部达标
- **字号加大**：HUD 文本/提示语按观看距离 1-2m 调整（16px/15px）
- **滑动关闭**：SceneShell 面板卡片水平滑动（>40px 且横向为主）即关闭该面板
- 双击缩放/300ms 延迟：全局 `touch-action: manipulation` 已禁用

## 5. 静默待机

- kiosk 模式自动启用 `powerSaveBlocker`（`prevent-display-sleep`），屏幕不熄
- 待机态：球体小尺寸呼吸（AmbientGlow），无焦点时不显示多余 UI

## 6. 首次配置引导（SetupWizard 四步）

① API Key → ② 唤醒词（预设/自定义/语音测试）→ ③ **音色试听**（5 音色试听）→ ④ **一体机模式**（自启开关/部署提示）→ 完成。

## 7. 真机验收清单（一体机部署后执行）

- [ ] 开机自动进入 kiosk 全屏待机（无边框/无任务栏）
- [ ] 触摸 PTT：按住球说话、松手发送
- [ ] 唤醒词命中率 ≥90%（`scripts/test-wakeword.js` 指引）
- [ ] 四场景语音命令（会议/资讯/任务/浏览器）
- [ ] 多智能体协作：轨道图展开时序 + 语音归因听感（先完成先报 / 结论合并报，不打断主对话）
- [ ] 卡片水平滑动关闭
- [ ] 屏幕不熄（静默 30 分钟后观察）
- [ ] 音量系数真机验证（P3 遗留：系数 3 / 钳制 1.5）

## 8. P5.5 启动体验与语音控制

- **开机动画**：首次启动粒子汇聚成球 + 服务扫描检查（核心引擎/飞书/企业微信/语音引擎），就绪自动进入语音界面
- **球体 5 态**：待机(暗蓝呼吸) / 聆听(金色涟漪) / 思考(橙色扫描环) / 播报(蓝色能量脉冲) / 静音(银白静止)
- **语音开关面板**："打开/关闭任务面板"、"打开/关闭资讯"、"打开/关闭会议"、"打开/关闭音乐"、"关闭面板"（TTS 确认播报）

## 9. 语音球视觉与启动音频

- **语音球**：CrabPaw Fibonacci 点云球（Canvas 2D，5 态形态级：待机暗蓝呼吸 / 聆听金色涟漪 / 思考橙色扫描环 / 播报蓝色能量脉冲 / 静音银白静止）。曾试验 WebGL Gargantua 黑洞渲染（Haskely/Gargantua，Shadertoy lstSRS）——视觉效果不佳已回滚（git 历史保留；若后续重试需处理 CC BY-NC-SA 3.0 非商用许可证）。
- **启动音乐**：自备 `data/boot-music.mp3` 生效（启动动画自动播放，音量 25%）；无文件时 Web Audio 合成星际氛围段。
