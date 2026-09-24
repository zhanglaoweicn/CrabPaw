# CrabPaw U 盘便携版 — 干净机验收清单

- 适用产物: `CrabPaw-Release/CrabPaw-<版本>-win64-Portable.zip`
- 环境: 一台**未安装** Node.js / Python / ffmpeg 的 Windows 10/11 机器（或恢复快照的虚拟机）
- 设计依据: `docs/superpowers/specs/2026-08-25-crabpaw-portable-usb-design.md` §8/§11
- 日期: 2026-09-08　执行人: ________

## 0. 开箱体检（U 盘制作方执行）

- [ ] zip 存在且体积在预期范围（约 400-500MB）
- [ ] 洁净度门禁通过（build-portable.ps1 内置，二次确认无 .test/.log/.db/仓库残留）
- [ ] 解压到 U 盘根目录（如 `E:\CrabPaw`），目录直含 `CrabPaw.exe`
- [ ] 包内**不含** `resources/data/cloakbrowser`、`resources/data/playwright-browsers`（许可合规+体积决策）
- [ ] 包内**含** `resources/npm`（npm-cli.js）、`resources/portable/ffmpeg/bin/ffmpeg.exe`、`resources/portable/python`（含 pip）
- [ ] `README.txt` 存在且第 1 条为「安全弹出」警告

## 1. 全新首启

- [ ] 双击 CrabPaw.exe：播种默认数据 → 后端（捆绑 node.exe）拉起 → 窗口出现 → 无报错
- [ ] 启动日志无 ABI 错误（better-sqlite3/sharp 在捆绑 node.exe 下正常加载）
- [ ] 日志出现「数据目录」指向 U 盘的 `CrabPaw-Data`（而非 C 盘 userData）

## 2. 基础功能

- [ ] 设置页填入模型 API Key → 对话成功
- [ ] TTS 语音播报有声（验证内置 ffmpeg 解码，干净机无系统 ffmpeg）
- [ ] 上传一个附件 + 生成一份文档 → 落盘于 `CrabPaw-Data/workspace/uploads`

## 3. 全内置组件链路（本轮重点）

- [ ] VideoEdit 视频截图/剪辑可用（内置 ffmpeg）
- [ ] 触发一个带 npm 依赖的技能 → `CrabPaw-Data/…` 依赖安装成功（便携 npm 生效）
- [ ] 触发一个带 pip 依赖的技能 → 安装成功（便携 pip 生效）
- [ ] 浏览器任务（非搜索）可用 → 走系统 Edge/Chrome（隐身组件未就绪时回退正常）

## 4. 隐身组件首启下载（§11 第 11 项，需联网）

- [ ] 首次搜索任务 → 提示「初始化中」且后台开始下载（国内网络应自动走镜像渠道）
- [ ] 下载完成 → `CrabPaw-Data/cloakbrowser/` 出现二进制
- [ ] 再次搜索 → 隐身搜索成功（百度/搜狗结果正常返回）
- [ ] 断网重试浏览器任务 → 系统浏览器兜底不崩溃

## 5. 持久化与迁移

- [ ] 重启程序：配置/Key/记忆/上传文件全部还在
- [ ] 换一台电脑（或换 USB 槽位/盘符）插上再启：数据完整
- [ ] `CrabPaw-Data/cloakbrowser` 随盘存在——拔盘后插入**无网**机器，隐身搜索仍可用（离线导入生效）

## 6. 安全与收尾

- [ ] 对话一分钟后「安全弹出」→ 重新插入 → 数据无损
- [ ] 任务管理器确认无残留 node/electron 进程

## 已知限制（验收时不必当作缺陷）

- 未签名 exe 触发 SmartScreen「未知发布者」（点「仍要运行」）
- 首启播种+后台拉起略慢
- 首次浏览器/搜索任务需联网下载约 500MB（无网走 §5 离线导入）
- 唤醒词模型状态、`~/.lark` 配置不随盘（Electron/Lark CLI 侧既有行为）
