# CrabPaw 架构优化迭代路线图 v3.2

> 2026-08-07 更新 | 商用化冲刺收尾同步
>
> 参考文档：`docs/harness-gap-analysis-2026-06-29.md`（含第十二章自我审查）

---

## 复审结论（先读这个）

CrabPaw 的 8 维度 Harness 框架**已经相当成熟**，不是"缺很多东西"的状态：

- `interfaces.js` (197行) — 5 种接口 + 运行时检查
- `error-classifier.js` (695行) — 17 种 FailoverReason + 4 provider + RetryScheduler + FailoverChain
- `atomic-write.js` (96行) — 原子写入 + 备份 + 损坏恢复
- `health-monitor.js` (164行) — HTTP 探活 + 自动恢复 + 历史
- 所有 8 个维度的核心模块均已达到生产级质量

**当前最需要的不是大规模重构，而是：清理死代码 + 统一事件系统 + Eval 增强。**

---

## 商用化冲刺新增能力 (2026-08-07)

本次冲刺（v2.2.0 → v2.3.0）在 Harness 框架之上新增以下能力：

### 语音链路全部接线
- **voice_play 消费端修复**：TTS 生成后正确推送到前端播放队列
- **voice-evolution 接线**：voice-evolution-handler 接入 init.js，TTS 进化数据闭环
- **语音审批**：ASR 转录文本经人工审批确认后发送，防止误识别
- **DocReader + MediaStage 语音集成**：文档阅读和媒体播放时语音协调（suspendForMedia/resumeAfterMedia）
- **TTS 排序优化**：多 TTS provider 按质量/延迟排序选择

### B站直链解析
- 新增  工具：解析 B站视频/音频直链，支持多清晰度降级
- playurl API 降级链：完整清晰度 → 备用清晰度 → 错误提示

### 专家协作编排
- **后端 collab API**： — 多专家协作任务分配与结果聚合
- **SSE 实时推送**：协作进度通过 SSE 实时推送到前端
- **前端 CollabWizard**： — 协作任务向导
- **前端 CollabOrbit**： — 专家协作轨道可视化
- **eval 覆盖**：

### 8 个技能 Executor 补全
-  — 统一技能执行引擎
-  — 技能能力注册表
- 覆盖：文档生成（PDF/Word/PPT/HTML）、图表（Diagram/Chart）、图片编辑、数据分析

### 前端便捷性提升
- **Cmd+K 命令面板**： — 全局快捷命令
- **会话历史 API**： — 会话历史查询与管理
- **上传进度**：文件上传实时进度指示
- **审批音效**：审批操作 Web Audio 反馈音效
- **音频设备管理**： — 输出设备选择
- **Gateway 启停**：服务网关启动/停止控制

### Eval 增强
- 用例从 194 增至 231（+37 用例）
- 新增套件：expert-collaboration、regression、dry-run-inspector

### 债务清理
- 删除死代码/stub 文件
- 统一 async 模式（execSync → async API）
- 空 catch 全部补齐日志

---

## 迭代计划（修正后，缩减版）

### Phase A：代码清理（半天，零风险）

#### A.1 Evolution 目录去重

```
问题：
  src/core/evolution-coordinator.js      ← 重复文件（evolution/ 目录下也有一份）
  src/core/evolution-system.js           ← stub (13行，空实现)
  src/core/evolution-feedback-loop.js    ← @deprecated 包装器

动作：
  1. 确认 src/core/evolution/evolution-coordinator.js 是主版本
  2. 删除 src/core/evolution-coordinator.js（重复），或将其改为 re-export 适配器
  3. 删除 src/core/evolution-system.js（stub），如果调用方需要，返回空实现
  4. 保留 evolution-feedback-loop.js（已有 deprecated 标记和迁移提示）
```

#### A.2 清理其他 stub / 死代码

```bash
# 查找可能的死代码
grep -r "stub\|TODO.*complete\|placeholder" src/core/ --include="*.js"
```

---

### Phase B：统一事件系统（2-3 天，中风险，最高 ROI）

#### B.1 目标

将当前散落在各处的 `EventEmitter` / `emit()` / `on()` 替换为一个类型化的事件系统：

```javascript
// src/core/events.js

/**
 * @template T
 */
class HarnessEvent {
  constructor(category, type, payload) {
    this.id = crypto.randomUUID();
    this.timestamp = Date.now();
    this.category = category;  // 'tool' | 'llm' | 'session' | 'evolution' | 'system'
    this.type = type;          // 'call_start' | 'call_success' | 'call_failure' | ...
    this.payload = payload;    // T
  }
}

class EventBus {
  constructor() { this.#handlers = new Map(); }

  /** @template T */
  publish(category, type, payload) { ... }

  /** @template T */
  subscribe(category, type, handler) { ... }

  /** @template T */
  replay(category, type, since) { ... }  // 用于调试/审计
}

// 全局单例
const eventBus = new EventBus();
```

#### B.2 事件目录

```
category:tool     → call_start, call_success, call_failure, contract_violation
category:llm      → call_start, call_success, call_failure, token_usage
category:session  → start, end, compaction, anomaly
category:evolution → feedback, degradation, evolution_triggered
category:system   → health_check, config_change, error
```

#### B.3 集成路径

1. `harness-lifecycle.js` 的 onToolCallStart/Success/Failure → 改为 `eventBus.publish('tool', ...)`
2. `harness-hooks.js` 的 PostToolUse 触发 → 改为 `eventBus.publish('tool', 'call_end', ...)`
3. `metrics-pipeline.js` → `eventBus.subscribe('tool', '*', handler)` + `eventBus.subscribe('llm', '*', handler)`
4. `trajectory.js` → `eventBus.subscribe('*', '*', handler)` 全量记录
5. `audit-log-v2.js` → `eventBus.subscribe('system', '*', handler)`
6. `dashboard.js` → `eventBus.subscribe('*', '*', handler)` 实时更新

**价值**：一条 LLM 调用的 traceId 贯穿 lifecycle/metrics/trajectory/audit 四层，可观测性跃升一个台阶。

---

### Phase C：Eval 增强（1-2 天，低风险）

#### C.1 Eval 回归基准

- `evals/snapshots/` 目录存储历史结果
- `evals/regression-check.js` 对比当前与上次
- CI 中添加回归检测步骤

#### C.2 契约兼容性检查

```javascript
// src/core/tool-contract-compat.js
// 检测规则：
//   新增必填参数 → BREAKING
//   收紧参数约束 → BREAKING
//   新增可选参数 / 放宽约束 → OK
```

---

## 既往已完成 Phase

- **记忆系统瘦身** ✅ — 文件 35→28
- **Cron 调度器统一** ✅ — enhanced-scheduler.js 为唯一引擎
- **v2.2.0 Harness 完整性** ✅ — 4 层架构全部 active
- **v2.3.0 商用化冲刺** ✅ — 语音链路接线 + B站直链 + 专家协作 + 8 技能 executor + 前端便捷性 + eval 231 用例（2026-08-07）

---

## 不做的事（及原因）

| 原提议 | 不做原因 |
|--------|---------|
| 引入 DI 容器 (awilix) | Node.js `require()` 已提供模块单例；重构 234+ 文件的收益远小于成本 |
| 新建错误分类体系 | error-classifier.js 已成熟 (695行, 生产级) |
| 新建接口抽象体系 | interfaces.js 已存在 (5 接口 + InterfaceChecker) |
| 文件事务化 (多文件) | atomic-write.js 已覆盖单文件原子性；多文件事务在当前场景极少需要 |
| 统一配置中心重构 | config.yaml + .env 模式在 Node.js 生态中正常，非紧急 |
| 乐观锁 / 分布式追踪 | 先做好事件系统，这些自然建立在事件之上 |
