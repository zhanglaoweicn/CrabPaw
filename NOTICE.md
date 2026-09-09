# 第三方组件声明 / Third-Party Notices

本项目整体以 MIT 许可发布。仓库中包含或引用的第三方组件著作权与许可归属如下：

## 随仓库分发的代码

| 组件 | 来源 | 许可 / 版权 |
|---|---|---|
| `vendor/cordis` `vendor/cosmokit` `vendor/loader` `vendor/include` `vendor/group` `vendor/assembler` | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（cordis 生态） | MIT — Copyright (c) 2021-present Shigma |
| 专家库 `data/experts-from-agency-agents.json`（267 个角色中文化改编） | [agency-agents](https://github.com/msitarzewski/agency-agents) 及其中文社区版 [agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | MIT（遵循上游署名要求，本说明即署名） |
| 技能 `healthcheck` / `system-info` / `weather` 的元数据结构 | 改编自 OpenClaw 技能元数据格式，正文与实现为本项目重写 | MIT |
| 语音唤醒模型 `gui/resources/kws-model/` | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 发布的预训练模型 | Apache License 2.0 |

## 运行时引入、不随仓库分发的组件

| 组件 | 说明 |
|---|---|
| Remotion | 视频渲染引擎，运行时经 npm 自行安装，适用 [Remotion License](https://www.remotion.dev/license)（个人与 3 人以下团队免费，非 OSI 开源许可） |
| CloakBrowser | 浏览器内核二进制不随仓库/安装包分发，首次使用时由程序自动下载，使用受上游许可约束 |
| ComPDFKit Conversion SDK | PDF 转换技能为其可选增强，需用户自行按上游条款获取 SDK，本仓库不含其任何代码 |
| Electron / React / three.js / lucide-react 等全部 npm 依赖 | 随 package.json 引入，许可以各自仓库为准（npm install 时自动接受） |

如认为本仓库内容侵犯了您的权益，请提 Issue，我们会第一时间处理。
