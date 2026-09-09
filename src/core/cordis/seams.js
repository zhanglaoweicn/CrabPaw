/**
 * seams.js — 接缝登记册（P2-①, dsh 对标机制③, 2026-09-03）
 *
 * 背景：扩展点此前无角色声明——三套扩展机制（plugin-system / harness-hooks /
 * cordis）并存、54 个 core 子目录里混着真接缝与伪接缝（定义了扩展点却只有
 * 定义者自己或孤岛消费方）。dsh 的纪律：每个接缝必须能回答三角色——
 *   定义（seam 定义在哪）→ 提供方（谁注册实现）→ 消费方（谁使用实现）。
 * 三角色不全 = 伪接缝，登记在册、限期收敛，而不是静默留着装作是架构。
 *
 * verdict 语义：
 *   live    三角色齐备且在主链路使用
 *   dual    双实现并存未收敛（功能重叠，方向：收敛为单一实现）
 *   pseudo  伪接缝（消费方≤1 且接近孤岛，或纯兼容壳；方向：并入/删除）
 *   dormant 已定义但主链路未用（方向：评估去留）
 *
 * 消费方：evals/test-cases/seam-roles.js（登记册纪律强制：路径存在性、
 * live 三角色完整性、已标记伪接缝不得静默消失——收敛必须改册再改码）。
 * 纯数据模块，不依赖 fs/重服务（eval 存在性检查自行做 fs）。
 */

const VERDICTS = Object.freeze(['live', 'dual', 'pseudo', 'dormant']);

const MECHANISMS = Object.freeze(['tool-contract', 'harness-hooks', 'plugin-system', 'cordis']);

/** 已判伪/双轨接缝——收敛后必须同步改册，否则 eval 红（防静默复活/静默漂移） */
const FLAGGED_SEAM_IDS = Object.freeze([
  'secret-store',
  'evolution-sandbox',
  'subagent-dual',
  'llm-registry-dual',
]);

/**
 * 已收敛接缝台账（P3 收敛轮, 2026-09-03 起）——收敛动作留痕处。
 * 纪律：条目从 REGISTRY/FLAGGED_SEAM_IDS 移除时必须在此登记（id 不得回流 flagged）。
 */
const CONVERGED_SEAMS = Object.freeze([
  {
    id: 'skill-executor-shell',
    convergedAt: '2026-09-03',
    how: '唯一真实消费方 server.js:68 内联直连 skills.js(executeSkillAdvanced 透明转发语义不变), 17 行 @deprecated 壳删除',
  },
  {
    id: 'skill-lifecycle-dual',
    convergedAt: '2026-09-03',
    how: '同名消歧: 状态机文件改名 skill/skill-lifecycle-state.js(3 消费方改 require), 评分链留根级。'
      + '两 manager 合并仍按 2026-08-18 决策不立项(职责独立: 老化状态机 vs 使用统计评分链, 数据文件/API 均不同)',
  },
  {
    id: 'llm-client-optional',
    convergedAt: '2026-09-03',
    how: 'stub 的 chat() 与引擎要求的 complete() 接口从不匹配→LLM 增强路径恒死(恒 _generateBasicPlan 兜底)。'
      + 'skill.js rewire 到 auxiliary-client 既有管线(TASK_TYPES.SKILL_MERGE 预置未接线), stub 删除; 未配置 provider 时行为不变(null)',
  },
]);

const REGISTRY = Object.freeze([
  // ── live：三角色齐备 ──────────────────────────────────────────
  {
    id: 'tool-registry',
    title: '工具注册表（主接缝）',
    mechanism: 'tool-contract',
    verdict: 'live',
    definition: ['src/tools/registry.js', 'src/core/tool-contract.js'],
    providers: ['src/tools/index.js'],
    consumers: ['src/core/ai.js', 'src/core/tool-orchestrator.js', 'src/tools/panel-tools.js'],
    note: '208+ 工具经契约注册, 主循环唯一工具来源',
  },
  {
    id: 'harness-hooks',
    title: 'Harness 钩子（pre/post tool call）',
    mechanism: 'harness-hooks',
    verdict: 'live',
    definition: ['src/core/harness-hooks.js'],
    providers: ['src/core/harness-hooks.js'],
    consumers: ['src/core/ai.js'],
    note: 'createSafetyHooks 内置 + 插件可注册; 同步路径, 留在 core（审批语义）',
  },
  {
    id: 'plugin-manager',
    title: '业务插件管理器',
    mechanism: 'plugin-system',
    verdict: 'live',
    definition: ['src/core/plugin/index.js'],
    providers: ['plugins/regression-guard/plugin.js'],
    consumers: ['src/cli/server.js'],
    note: '业务插件面; plugin-system.js 与 plugin/ 目录双轨, 收敛方向: 统一登记入口(P3 候选)',
  },
  {
    id: 'cordis-tree',
    title: 'Cordis 服务树（登记面）',
    mechanism: 'cordis',
    verdict: 'live',
    definition: ['src/core/cordis/boot.js'],
    providers: ['src/core/cordis/boot.js'],
    consumers: ['src/core/cordis/audit.js', 'src/core/cordis/event-bridge.js'],
    note: 'Phase 1 引用现有单例(铺轨不换轨); Phase 2 方向: 登记面→行为面',
  },
  {
    id: 'skills',
    title: '技能装载与执行',
    mechanism: 'tool-contract',
    verdict: 'live',
    definition: ['src/core/skills.js'],
    providers: ['skills/'],
    consumers: ['src/core/ai.js', 'src/handlers/skill-handler.js'],
    note: 'SKILL.md 渐进加载; 周边 skill-* 群已有消费方(2026-09-03 审计)',
  },
  {
    id: 'panels-v2',
    title: '面板系统 v2',
    mechanism: 'tool-contract',
    verdict: 'live',
    definition: ['src/core/panels-v2.js'],
    providers: ['src/core/panels/'],
    consumers: ['src/tools/panels-v2-tool.js', 'src/core/tool-contract.js'],
    note: '面板经工具接缝暴露给模型',
  },
  {
    id: 'channel-registry',
    title: '渠道注册表',
    mechanism: 'plugin-system',
    verdict: 'live',
    definition: ['src/core/channel-registry.js'],
    providers: ['src/channels/'],
    consumers: ['src/core/init.js', 'src/core/config.js'],
    note: 'Lark/WeCom/微信桌面监控经此接入; 最接近 pi-mom 形态的层',
  },
  {
    id: 'mcp',
    title: 'MCP 管理器',
    mechanism: 'plugin-system',
    verdict: 'live',
    definition: ['src/core/mcp/mcp-manager.js'],
    providers: ['src/core/mcp/'],
    consumers: ['src/cli/handlers/mcp-handlers.js', 'src/core/cordis/boot.js'],
    note: '外接工具生态入口（内置/外接结论: MCP 属接入面, 外接）',
  },
  {
    id: 'event-bus',
    title: '类型化事件总线',
    mechanism: 'cordis',
    verdict: 'live',
    definition: ['src/core/events.js'],
    providers: [],
    consumers: ['src/core/cordis/event-bridge.js'],
    note: '基础设施接缝; 直接 require 7 处 + cordis 桥镜像; evolution 事件反转(候选)以此为载体',
  },

  // ── flagged：双轨/伪接缝/休眠（收敛必须改册再改码）──────────────
  {
    id: 'secret-store',
    title: '独立密钥存储（能力工具域）',
    mechanism: 'plugin-system',
    verdict: 'pseudo',
    definition: ['src/core/secret-store.js'],
    providers: [],
    consumers: ['src/tools/capability-secret-tool.js'],
    note: '消费方仅 1 处近乎孤岛。P3 复核修正: API 面与 credential-manager 实为不同域'
      + '(通用加密 KV+机器指纹主密钥 vs 通道凭据+故障转移池)——非机械并入关系',
    action: '与「密钥存储 v2」意图对齐后二选一: capability 工具域独立保留, 或统一到 secure-storage 原语之上(P3 评审)',
  },
  {
    id: 'evolution-sandbox',
    title: '进化沙箱',
    mechanism: 'plugin-system',
    verdict: 'dormant',
    definition: ['src/core/perception/evolution-sandbox.js'],
    providers: [],
    consumers: ['src/core/perception/index.js'],
    note: '仅同目录 index.js 聚合引用, 无外部消费方(2026-09-03 审计)',
    action: 'Phase 2 evolution 事件化时评估去留',
  },
  {
    id: 'subagent-dual',
    title: '子代理双执行器',
    mechanism: 'cordis',
    verdict: 'dual',
    definition: ['src/core/subagent.js', 'src/core/subagent-enhanced.js'],
    providers: [],
    consumers: ['src/core/index.js', 'src/core/agent/tiered-subagent-runner.js'],
    note: 'worker_threads 旧版(命令面在用) vs 增强版(新 agent/ 体系在用), 共享 subagent/concurrency-control。'
      + '⚠ 2026-09-03 观察到两文件均在并行 WIP 修改中——收敛疑似进行中, 本轮不触碰',
    action: '待并行 WIP 落地后复核: 命令面迁 enhanced 后删旧',
  },
  {
    id: 'llm-registry-dual',
    title: 'LLM 注册表双轨',
    mechanism: 'plugin-system',
    verdict: 'dual',
    definition: ['src/core/llm/'],
    providers: [],
    consumers: ['src/cli/index.js'],
    note: 'ProviderRegistry(新) 与 AdapterRegistry(旧兼容层) 并存于同一目录; 消费方含 cli/index+image-gen+video-gen+stock-interpret',
    action: '旧适配层收敛: 先核两 Registry API 面差距再迁消费方(独立轮)',
  },
]);

/** 按 verdict 过滤 */
function byVerdict(verdict) {
  return REGISTRY.filter((s) => s.verdict === verdict);
}

/** 按 id 取接缝 */
function getSeam(id) {
  return REGISTRY.find((s) => s.id === id) || null;
}

module.exports = { REGISTRY, VERDICTS, MECHANISMS, FLAGGED_SEAM_IDS, CONVERGED_SEAMS, byVerdict, getSeam };
