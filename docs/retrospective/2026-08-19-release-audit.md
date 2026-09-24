# 2026-08-19 发行前复盘审计报告（v2.2.0）

六维度并行审计（测试基线 / 打包配置 / git 清理 / 安全 / 接线 / 文档一致性），为打包发行做准备。

## 审计发现汇总

### 发行阻止项（5 个，全部已修复）
| # | 问题 | 修复 |
|---|------|------|
| S1 | 废弃脚本 `gui/build-portable.ps1` 把开发机真实密钥+全部业务数据打进发行包（旧产物实测含明文 DeepSeek key） | 脚本已删除；旧产物目录已不存在；**DeepSeek 密钥 sk-c55e***1f6 需用户后台轮换** |
| S2 | better-sqlite3 ABI 不匹配：本地 node v24(137) vs 打包内置 node v20(115) → 打包版后端启动即崩 | 内置 node 改 v24.13.0（方案 A），better-sqlite3 走官方 node-v127 prebuild，零编译；v12.10.0 无 node-v115 资产已实锤 |
| S3 | `build:electron`/`build:release` 冷跑必失败（data/cloakbrowser 缺失） | download:deps 改为 fail-fast；发行走 `build:portable-full`（先下载） |
| S4 | v2.2.0 tag 指向 2026-06-24 旧提交（落后 HEAD 677 commits） | tag 重打至 f040055（用户批准） |
| S5 | CHANGELOG 顶部泄漏未格式化片段、2.3.0 条目版本倒挂 | 重写顶部为正式 2.2.0 发行条目，2.3.0 标注"开发中未发行" |

### WARN 修复
- **意图路由断层（W4/W5）**：calendar/reminder/stock/network 四个工具集不在任何意图 required/optional（LLM 文本路径永远不可见）；SceneSet 仅 video_play 可见 → tool-router.js 五处补全（schedule+calendar、set_reminder+reminder、stock+stock、fetch_url+network、open_app+scene）
- **安全 MEDIUM（W1/W2/W3）**：lark-adapter 命令转义补 \r\n%；docx 解压弃 Expand-Archive 改 extract-zip + zip-slip 校验；server 监听加 CRABPAW_HOST 收紧选项（默认保持 0.0.0.0 以保留 webhook 回调）
- **打包（W9）**：download:deps 失败静默 exit 0 → fail-fast 非零退出；首启数据拷贝 EXCLUDE_DIRS 加 cloakbrowser（省 400MB 冗余+慢首启）
- **git**：23 个未暂存删除收编、一次性脚本归档 scripts/archive/、gitee 落后 4 提交已补 3 个新提交（待 push）

### 健康面（审计确认）
- 测试基线全绿：jest 1338/1338、eval 424/424、gui typecheck 0 错误、lint 0 errors
- 本轮新功能（会议/日程卡片、UiCommandBridge、文档分析）五环接线全闭环
- 现代 electron-builder 管线无密钥；git 仓库无真实凭据；_safeEval 无逃逸；Electron 沙箱齐全
- OPTIMIZATION_PLAN §10「已落地」声明 7/7 实锤；品牌铁律零违例

### 遗留（发行后处理）
- W12 文档计数漂移 ~10 处（契约 224 vs 文档 205/208、eval 424 vs 194/231、skills 61 vs 257、插件 10 vs 14、套件 53 vs 15、audit 51 vs 42）+ 微信退役功能在 README/AGENTS/OPTIMIZATION_PLAN 残留宣传
- W10 electron-builder 24.9.1 × electron 43 组合首次实跑，首包后必须冒烟验证
- W11 gui src/lib/*.test.ts 单测无运行脚本（孤儿测试）
- INFO：SceneSet(open)/本地语音开卡不写 panel-state open（AI 上下文只知关不知开）；新功能用户面文档（README/DEVELOPMENT_MANUAL）零覆盖

## 提交记录
- `3500912` fix(release): 审计修复批（意图路由/安全/打包/CHANGELOG/废弃脚本）
- `3879de9` chore(repo): 发行清理批（私人文档/二进制/纸面代码/归档）
- `3058bef` feat: 开发轮收编批（会议/日程卡片等未提交工作）

## 发行待办
1. **用户手动：DeepSeek 后台轮换 sk-c55e***1f6**
2. `npm run build:portable-full`（CloakBrowser 535MB 下载完成后）
3. 首包冒烟：CrabPaw-2.2.0-Setup.exe / Portable.exe 启动（后端进程/KWS/CloakBrowser）
4. gui e2e（jarvis-single-ui.spec.ts）
5. `git push gitee`（本地已领先远端 7 提交 + tag 重打）
