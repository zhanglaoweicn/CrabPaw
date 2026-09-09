/**
 * Evolution System — 统一进化系统入口
 *
 * CrabPaw v4 自进化系统：
 *
 *   每轮对话 ──> ConversationReviewFork ──> 语义学习信号检测 ──> 技能更新
 *                                                   │
 *   定期维护 ──> SkillCurator ──> 生命周期管理 ──> active→stale→archived
 *         │
 *   技能创建 ──> SkillProvenance ──> 来源追踪 ──> 保护用户技能
 *
 * 旧版进化引擎（指标阈值驱动）作为辅助，新版语义驱动为主。
 *
 * 初始化流程：
 *   1. 加载 provenance 数据
 *   2. 初始化 SkillLifecycle
 *   3. 创建 ConversationReviewFork
 *   4. 创建 SkillCurator
 *   5. 注册到 SchedulerOrchestrator
 *   6. 启动
 */

const path = require('path');
const fs = require('fs');

// 新版核心组件
const { getReviewFork, ConversationReviewFork } = require('./conversation-review-fork');
const { SkillCurator, getCurator } = require('../skill/skill-curator');
const { SkillLifecycleManager, LIFECYCLE_STATES } = require('../skill/skill-lifecycle-state');
const {
  WRITE_ORIGINS,
  initialize: initProvenance,
  markProvenance,
  getProvenance,
  isAgentCreated,
  isUserOwned,
  canAutoEvolve,
  setCurrentWriteOrigin,
  getCurrentWriteOrigin,
  isBackgroundReview,
} = require('../skill/skill-provenance');
const { preprocessSkillContent, matchesCurrentPlatform } = require('../skill/skill-template');
const { getOrchestrator, SchedulerOrchestrator } = require('../scheduler-orchestrator');

// 保留旧版引擎作为辅助
const { getSkillEvolutionEngine } = require('./skill-evolution');
const { getEvolutionCoordinator } = require('./evolution-coordinator');

// 提示词
const { detectLearningSignals, COMBINED_REVIEW_PROMPT } = require('./review-prompts');

// ============================================================
// 统一初始化
// ============================================================

let _system = null;

class EvolutionSystem {
  constructor(config = {}) {
    this.config = {
      dataDir: config.dataDir || path.join(__dirname, '..', '..', 'data', '.crabpaw'),
      ...config,
    };

    /** @type {ConversationReviewFork} */
    this.reviewFork = null;

    /** @type {SkillCurator} */
    this.curator = null;

    /** @type {SkillLifecycleManager} */
    this.lifecycle = null;

    /** @type {SchedulerOrchestrator} */
    this.orchestrator = null;

    /** @type {object|null} LLM 客户端 */
    this.llmClient = null;

    this._initialized = false;
    this._started = false;
  }

  /**
   * 初始化所有子系统
   * @param {object} [llmClient] - LLM 客户端（用于 Review Fork 和 Curator）
   */
  initialize(llmClient = null) {
    if (this._initialized) return;

    this.llmClient = llmClient;
    const dataDir = this.config.dataDir;

    // 确保数据目录存在
    const evolutionDir = path.join(dataDir, 'evolution');
    if (!fs.existsSync(evolutionDir)) {
      fs.mkdirSync(evolutionDir, { recursive: true });
    }

    // Step 1: 初始化 Provenance
    const provenancePath = path.join(evolutionDir, 'provenance.json');
    initProvenance(provenancePath);

    // Step 2: 初始化 SkillLifecycle
    this.lifecycle = new SkillLifecycleManager({
      dataPath: path.join(evolutionDir, 'lifecycle.json'),
      ...this.config,
    });
    this.lifecycle.initialize();

    // Step 3: 创建 ConversationReviewFork
    this.reviewFork = getReviewFork();
    this.reviewFork.initialize(llmClient);

    // Step 4: 创建 SkillCurator
    this.curator = getCurator({
      lifecycle: this.lifecycle,
      dataDir,
      ...this.config,
    });
    this.curator.initialize(dataDir, llmClient);

    // Step 5: 创建 SchedulerOrchestrator
    this.orchestrator = getOrchestrator();
    this.orchestrator.initialize();
    this.orchestrator.registerReviewFork(this.reviewFork);
    this.orchestrator.registerCurator(this.curator);

    // Step 6: 桥接 SkillEvolutionEngine → 真实文件写入（通过 skill_manage 工具）
    this._bridgeSkillEvolution();

    // 注册事件监听
    this._setupEventListeners();

    this._initialized = true;
    console.log('[EvolutionSystem] v4 统一进化系统初始化完成');
  }

  /**
   * 启动（开始接受调度）
   */
  start() {
    if (!this._initialized) this.initialize();
    this._started = true;
    console.log('[EvolutionSystem] 已启动');
  }

  /**
   * Set LLM client (for late binding)
   */
  setLLMClient(client) {
    this.llmClient = client;
    if (this.reviewFork) this.reviewFork.setLLMClient(client);
    if (this.curator) this.curator.setLLMClient(client);
  }

  // ============================================================
  // Conversation Hooks — 供主循环调用
  // ============================================================

  /**
   * 在每轮对话后调用
   * @param {object} ctx - { sessionId, messages, loadedSkills }
   */
  afterTurn(ctx) {
    if (!this._started) return;
    if (this.orchestrator) {
      this.orchestrator.onPostTurn(ctx);
    }
  }

  /**
   * Agent 空闲时调用
   * @param {number} idleSeconds
   */
  onIdle(idleSeconds) {
    if (!this._started) return;
    if (this.orchestrator) {
      this.orchestrator.onIdle(idleSeconds);
    }
  }

  // ============================================================
  // 技能生命周期钩子
  // ============================================================

  /**
   * 记录技能被使用（在执行技能时调用）
   */
  markSkillUsed(skillName) {
    if (this.lifecycle) {
      this.lifecycle.markUsed(skillName);
    }
  }

  /**
   * 注册新技能到生命周期
   */
  registerSkill(skillName, provenance) {
    if (this.lifecycle) {
      this.lifecycle.register(skillName, provenance);
    }
  }

  // ============================================================
  // 设置事件监听
  // ============================================================

  _setupEventListeners() {
    if (this.reviewFork) {
      this.reviewFork.on('review:complete', (result) => {
        if (result && result.skillsAffected && result.skillsAffected.length > 0) {
          // 更新生命周期的 usage 数据
          for (const skillName of result.skillsAffected) {
            this.lifecycle?.register(skillName, 'background_review');
          }
        }
      });
    }

    if (this.curator) {
      this.curator.on('run:complete', (_result) => {
        const stats = this.curator.getStats();
        console.log(`[EvolutionSystem] Curator 完成: ${stats.activeSkills || 0} active, ${stats.staleSkills || 0} stale`);
      });
    }
  }

  /**
   * 桥接 SkillEvolutionEngine 到 skill_manage 工具
   *
   * 当 SkillEvolutionEngine 的 evolveSkill() 检测到改进机会时，
   * 此桥接会通过 skill_manage 工具对 SKILL.md 执行真正的文件写入。
   *
   * 不使用已废弃的 SkillEvolver 类，而是直接通过 tool registry 调用
   * skill_manage 的 edit 操作。
   */
  _bridgeSkillEvolution() {
    try {
      const { getSkillEvolutionEngine } = require('./skill-evolution');
      const { registry } = require('../../tools/registry');
      // 2026-08-15 T7(累积K): 优先委托已初始化的 getSkillEvolver() 单例——server.js
      // 启动序列已注入 coordinator/validator/rollbackManager/versionStore
      // (provenance 门/观察期/次数上限/校验门/版本历史)。此前绕过单例直调
      // skill_manage handler，所有门禁全部失效。未初始化(测试/未启动场景)时
      // 保留原直写 fallback。
      const { getSkillEvolver } = require('../skill/skill-evolver');
      const gatedEvolver = getSkillEvolver();

      getSkillEvolutionEngine().then(engine => {
        const skillManageTool = registry.get('skill_manage');

        engine.setSkillEvolver({
          /**
           * 处理进化建议 — 将建议写入 SKILL.md
           * @param {object} suggestion - { type, targetSkillIds, reason, suggestedChanges, priority }
           * @returns {Promise<{success: boolean, type: string, staged: boolean, error?: string}>}
           */
          processSuggestion: async (suggestion) => {
            // 门禁单例可用时优先走单例（门裁决优先于直写；gate 返回 null 即本周期不进化）
            if (gatedEvolver && gatedEvolver.isInitialized()) {
              try {
                // 归一化 skillName——引擎建议只带 targetSkillIds，provenance 门按 skillName 判定
                const normalized = { ...suggestion, skillName: suggestion.skillName || suggestion.targetSkillIds?.[0] };
                const gated = await gatedEvolver.processSuggestion(normalized);
                if (gated) return gated;
                console.log('[EvolutionSystem] 进化建议经门禁裁决跳过(观察期/次数上限/校验未通过)');
                return null;
              } catch (gatedErr) {
                console.warn('[EvolutionSystem] 门禁 SkillEvolver 执行失败,回退 skill_manage 直写:', gatedErr?.message || gatedErr);
              }
            }
            if (!skillManageTool) {
              console.warn('[EvolutionSystem] skill_manage 工具未注册，跳过技能文件写入');
              return null;
            }

            const skillName = suggestion.targetSkillIds?.[0];
            if (!skillName) {
              console.warn('[EvolutionSystem] 进化建议缺少 targetSkillIds[0]');
              return null;
            }

            try {
              // 1. 读取当前 SKILL.md
              const viewResult = await skillManageTool.handler(
                { action: 'view', name: skillName },
                {}
              );

              if (!viewResult || !viewResult.success) {
                console.warn(`[EvolutionSystem] 无法读取技能 ${skillName}，跳过内容进化`);
                return { success: false, type: suggestion.type, error: 'read_failed' };
              }

              const currentContent = viewResult.raw_content || viewResult.content || '';

              // 2. 追加进化摘要作为新章节
              const evolutionSection = [
                '',
                '## 自动进化',
                '',
                `- **进化时间**: ${new Date().toISOString()}`,
                `- **进化类型**: ${suggestion.type || '优化'}`,
                `- **原因**: ${suggestion.reason || '性能优化'}`,
                suggestion.suggestedChanges ? `- **修改内容**:` : '',
                suggestion.suggestedChanges ? suggestion.suggestedChanges.split('\n').map(l => `  - ${l}`).join('\n') : '',
                '',
              ].filter(Boolean).join('\n');

              const patchedContent = currentContent.trim() + evolutionSection;

              // 3. 通过 skill_manage edit 写入
              const editResult = await skillManageTool.handler(
                { action: 'edit', name: skillName, content: patchedContent },
                {}
              );

              if (editResult && editResult.success) {
                console.log(`[EvolutionSystem] 技能 ${skillName} 已通过 skill_manage 进化`);
                return { success: true, type: suggestion.type, staged: false };
              }

              console.warn(`[EvolutionSystem] skill_manage 编辑 ${skillName} 失败: ${editResult?.error || 'unknown'}`);
              return { success: false, type: suggestion.type, error: editResult?.error || 'edit_failed' };

            } catch (err) {
              console.warn(`[EvolutionSystem] 技能进化写入失败 ${skillName}:`, err.message);
              return { success: false, type: suggestion.type, error: err.message };
            }
          },
        });

        console.log('[EvolutionSystem] SkillEvolutionEngine 已桥接到 skill_manage 工具');
      }).catch(err => {
        console.warn('[EvolutionSystem] SkillEvolutionEngine 获取失败, 跳过桥接:', err.message);
      });
    } catch (err) {
      console.warn('[EvolutionSystem] SkillEvolutionEngine 桥接失败 (非关键):', err.message);
    }
  }

  // ============================================================
  // 状态查询
  // ============================================================

  getStatus() {
    return {
      initialized: this._initialized,
      started: this._started,
      lifecycle: this.lifecycle?.getStats() || null,
      curator: this.curator?.getStats() || null,
      orchestrator: this.orchestrator?.getStatus() || null,
      lastReview: null, // 由 reviewFork 提供
    };
  }

  /**
   * 关闭
   */
  async shutdown() {
    this._started = false;
    if (this.orchestrator) {
      await this.orchestrator.shutdown();
    }
    console.log('[EvolutionSystem] 已关闭');
  }
}

// ============================================================
// 统一初始化入口（替代旧版 evolution-system.js）
// ============================================================

function getEvolutionSystem(config = {}) {
  if (!_system) {
    _system = new EvolutionSystem(config);
  }
  return _system;
}

module.exports = {
  // 统一系统
  EvolutionSystem,
  getEvolutionSystem,

  // 子系统（可直接引用）
  ConversationReviewFork,
  getReviewFork,
  SkillCurator,
  getCurator,
  SkillLifecycleManager,
  SchedulerOrchestrator,
  getOrchestrator,

  // Provenance
  WRITE_ORIGINS,
  markProvenance,
  getProvenance,
  isAgentCreated,
  isUserOwned,
  canAutoEvolve,
  setCurrentWriteOrigin,
  getCurrentWriteOrigin,
  isBackgroundReview,

  // Skill Template
  preprocessSkillContent,
  matchesCurrentPlatform,

  // Review Prompts
  detectLearningSignals,
  COMBINED_REVIEW_PROMPT,

  // Lifecycle
  LIFECYCLE_STATES,

  // 旧版引擎（向后兼容）
  getSkillEvolutionEngine,
  getEvolutionCoordinator,
};
