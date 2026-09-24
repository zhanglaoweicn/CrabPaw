# BossAgent 升级迭代路线图 (Based on Grok Build Analysis)

> 基于对 `D:\Down\grok-build-main` (xAI Agent OS) 的深度分析，为 BossAgent (Node.js/TypeScript) 制定的演进规划。
> 核心哲学：**协议优先 + 分层解耦 + 生产级可靠性默认**

## 0. 总体架构演进蓝图

```mermaid
graph TD
    subgraph BossAgent vNext (Node.js Ecosystem)
        direction LR
        A[UI: React/Desktop] --> B[Agent Runtime]
        B --> C[Tools & Workspace]
        B --> D[Memory & Knowledge]
        B --> E[Voice & TTS]
        C --> F[Extensions & Hooks]
        D --> G[(SQLite + Vector DB)]
        
        subgraph Reliability Layer (Inspired by Grok)
            H[Circuit Breaker]
            I[Smart Retry Classifier]
            J[Doom Loop Detection]
            K[Compaction Engine]
        end
        
        B -- integrates --> H
        B -- integrates --> I
        B -- integrates --> J
        B -- integrates --> K
    end
    
    style Reliability Layer fill:#f9f,stroke:#333,stroke-width:2px
```

---

## 1. 分阶段实施规划

### Phase 0: 基础设施攻坚 (Infrastructure Foundation)
**目标**：确立系统可靠性底座，快速引入核心防护机制。
**预估工期**：1-2 周
**依赖项**：无

| 优先级 | 模块 | Grok Build 参考 | BossAgent 落地位置 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | **Circuit Breaker (断路器)** | `xai-circuit-breaker` | `src/core/tool-circuit-breaker.js` (**增强**) | 增强现有断路器，引入滑动窗口算法；添加 Lock-free fast path；实现 Half-open 探针超时回收。 |
| **P0** | **Smart Retry Classifier** | `xai-grok-sampler/retry.rs` | `src/core/error-classifier.js` (**增强**) | 增强现有错误分类器，增加服务端 `x-should-retry` 语义；实现智能退避 (Exponential Backoff with Jitter)；支持 413 图片自动剥离重试。 |
| **P1** | **Token 估算独立化** | `xai-token-estimation` | `src/core/token-estimator.js` | 从现有各处 token 计算逻辑中抽取为独立服务；提供精确估算接口。 |
| **P1** | **SQLite 基础设施引入** | `rusqlite` + `sqlite-vec` | `src/db/init.js` | 集成 `better-sqlite3`；初始化基础表结构；封装通用 CRUD 接口。 |

### Phase 1: 核心机制升级 (Core Mechanisms)
**目标**：将 Grok 的核心智能机制转化为 BossAgent 的 Node.js 实现。
**预估工期**：3-4 周
**依赖项**：Phase 0 (SQLite 必须先完成)

| 优先级 | 模块 | Grok Build 参考 | BossAgent 落地位置 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | **Hybrid Memory Search** | `xai-grok-memory/search.rs` | `src/core/memory/hybrid-search.js` | 实现 FTS (Full-Text Search) + 向量相似度检索；引入 Temporal Decay (时间衰减) 机制；支持 Evergreen 源豁免。 |
| **P1** | **Two-Phase Compaction** | `xai-grok-compaction` | `src/core/compaction/two-phase.js` | 实现后台预压缩 (Pre-fire)；独立压缩模型配置；压缩前自动触发 Memory Flush。 |
| **P1** | **Doom Loop Detection** | `xai-grok-sampler/doom_loop.rs` | `src/core/doom-loop/` | 客户端置信度累积检测；Mid-Stream Abort 机制；重试预算耗尽后 Disarm (解除熔断)。 |

### Phase 2: 体验优化与扩展 (Experience & Extension)
**目标**：优化交互体验，提升系统扩展性。
**预估工期**：2-3 周
**依赖项**：Phase 1

| 优先级 | 模块 | Grok Build 参考 | BossAgent 落地位置 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | **Voice Pipeline 并发优化** | `xai-grok-voice/pipeline.rs` | `src/handlers/voice-cloud-ws.js` (重构) | 实现录音子进程化 (Node.js Child Process)；引入 Bounded Backlog (有界缓冲)；实现 No-Speech Watchdog。 |
| **P1** | **MCP Setup 交互式配置** | `xai-grok-mcp/config-types.rs` | `src/core/mcp/config-resolver.js` | 支持 `setup` 字段模板渲染 (如 `{{region}}` -> URL)；实现 OAuth 完整授权流程。 |
| **P2** | **Dream Consolidation (自动巩固)** | `xai-grok-memory/dream.rs` | `src/core/memory/dream-consolidation.js` | 定时任务；低峰期批量合并会话为 MEMORY.md；带 DreamLock 互斥锁。 |

### Phase 3: 架构演进 (Architecture Evolution)
**目标**：向 Agent OS 形态演进，实现协议化与插件化。
**预估工期**：持续迭代
**依赖项**：Phase 2

| 优先级 | 模块 | Grok Build 参考 | BossAgent 落地位置 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| **P1** | **工具三层协议分离** | `xai-tool-protocol/runtime/types` | `src/tools/protocol/`, `src/tools/runtime/` | 拆分工具定义、运行时、协议层；支持流式工具输出 (SSE)。 |
| **P2** | **Hook/Plugin 系统** | `xai-grok-hooks` + `plugins/` | `src/core/plugins/` | 三级插件发现 (~/.bossagent/plugins)；Trust Store 信任管理；插件 Manifest 解析。 |
| **P2** | **Prompt 安全与清理** | `xai-grok-agent/template.rs` (Zeroizing) | `src/core/system-prompt.js` | 生产环境对 Prompt 模板进行混淆 (XOR)；使用后内存清理 (GC 建议)。 |

---

## 2. 关键技术栈映射 (Rust -> Node.js)

| Grok Build (Rust) | BossAgent (Node.js/TypeScript) | 说明 |
| :--- | :--- | :--- |
| **Actor Model** (tokio::spawn) | **Async Generator** / **Worker Threads** | 保持异步非阻塞，利用 Node.js 事件循环的并发模型。 |
| **Lock-free Atomic** (AtomicBool) | **Atomics** (SharedArrayBuffer) / **AsyncMutex** | 对于进程内共享状态，使用 `Atomics`；对于普通场景使用异步锁。 |
| **OS-level Sandbox** (nono) | **Node.js Permissions** + **Child Process** | 利用 Node.js 20+ 的权限模型；或使用独立子进程执行高危命令。 |
| **SQLite + rusqlite** | **better-sqlite3** + **sql.js** | Node.js 生态下的最佳 SQLite 绑定，支持同步 API 高性能。 |
| **Sub-process Audio** (cpal -> Child) | **child_process.spawn** (sox/parec) | 跨平台调用系统录音工具，避免主进程音频库依赖。 |
| **Stream Transform** | **Web Streams API** / **TransformStream** | Node.js 原生流处理，用于解析 LLM 输出流。 |

---

## 3. 风险与缓解措施

| 风险项 | 描述 | 缓解措施 |
| :--- | :--- | :--- |
| **SQLite 并发写入** | Node.js 单线程特性下，高频 Memory 更新可能阻塞事件循环。 | 使用 **WAL 模式** (Write-Ahead Logging)；将 DB 操作放入独立 Worker Thread。 |
| **Windows 音频子进程兼容性** | Grok 在 Linux 用 `pw-record`，Windows 需找等效方案。 | 封装跨平台录音抽象层：Windows 使用 PowerShell + WASAPI 脚本；macOS 使用 `sox`。 |
| **向量数据库集成复杂** | 纯 JS 向量检索性能可能不足。 | 优先使用 SQLite + 简单哈希/词频检索 (Phase 1)；后续考虑本地启动轻量级 `vectordb` (如 hnswlib-node)。 |
| **重构引起的回归** | Hybrid Search 替换现有 Memory 逻辑可能导致功能异常。 | 引入 Feature Flag (特性开关)；双写验证，新旧逻辑对比一致性。 |
| **Token 估算精度** | 独立化 Token Estimator 可能与 LLM 实际计费不符。 | 提供 `estimate` (估算) 和 `actual` (实际) 双接口；记录偏差日志用于调优。 |

---

## 4. 下一步行动

1.  **启动 Phase 0 设计评审**：细化 `Circuit Breaker` 和 `Retry Classifier` 的接口定义。
2.  **技术预研 (Spike)**：验证 `better-sqlite3` 在 BossAgent 业务场景下的性能。
3.  **Code Sprint**：按 Phase 0 清单创建核心文件骨架。
