/**
 * Scheduler Orchestrator — 统一调度编排器
 *
 * 替代三套并行调度系统（ConversationLoop / SwarmOrchestrator / KanbanBoard）
 * 提供统一的调度状态机和入口。
 *
 * 调度优先级（按序执行）：
 *   1. Background Review Fork — 上一轮对话的回顾学习（不阻塞）
 *   2. Skill Curator — 定期技能库维护（空闲时触发）
 *   3. Memory Consolidation — 记忆整合（低优先级后台）
 *   4. Main Loop — 用户对话处理（最高优先级, 同步）
 *   5. Swarm / Kanban — 多智能体 / 看板任务（按需启动）
 *
 * 约定：
 *   - 所有异步任务使用 setImmediate 启动，不阻塞主循环
 *   - 每种任务有独立的冷却期和运行状态
 *   - 失败不影响其他任务
 */

const { EventEmitter } = require('events');


// ============================================================
// 调度阶段
// ============================================================

const SCHEDULE_PHASES = {
  PRE_TURN: 'pre_turn',       // 用户消息到达后、处理前
  POST_TURN: 'post_turn',     // 处理完成后
  IDLE: 'idle',               // 空闲时
  SHUTDOWN: 'shutdown',       // 关闭时
};

// ============================================================
// 配置
// ============================================================

const DEFAULT_CONFIG = {
  // Background Review
  reviewEnabled: true,
  reviewCooldownMs: 5 * 60 * 1000,    // 5 min

  // Curator
  curatorEnabled: true,
  curatorIntervalMs: 7 * 24 * 3600 * 1000, // 7 days
  curatorMinIdleMs: 2 * 3600 * 1000,  // 2 hours

  // Memory Consolidation
  consolidationEnabled: true,
  consolidationIntervalMs: 24 * 3600 * 1000, // 1 day

  // 最大并发后台任务
  maxConcurrentTasks: 3,
};

// ============================================================
// SchedulerOrchestrator
// ============================================================

class SchedulerOrchestrator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {Map<string, object>} 组件注册表 */
    this._components = new Map();

    /** @type {Map<string, boolean>} 组件运行状态 */
    this._running = new Map();

    /** @type {Map<string, number>} 组件上次运行时间 */
    this._lastRuns = new Map();

    /** @type {number} 当前活跃的后台任务数 */
    this._activeBackgroundTasks = 0;

    /** 是否正在关闭 */
    this._shuttingDown = false;

    this._initialized = false;
  }

  // ============================================================
  // 组件注册
  // ============================================================

  /**
   * 注册组件
   * @param {string} name - 组件名称
   * @param {object} component - 组件实例
   * @param {object} opts - 配置
   * @param {string} opts.phase - 执行阶段 'pre_turn' | 'post_turn' | 'idle'
   * @param {number} opts.priority - 优先级（数字越小越高）
   * @param {Function} opts.handler - 执行函数
   */
  register(name, component, opts = {}) {
    this._components.set(name, {
      name,
      instance: component,
      phase: opts.phase || SCHEDULE_PHASES.POST_TURN,
      priority: opts.priority || 10,
      handler: opts.handler || (async () => {}),
      cooldownMs: opts.cooldownMs || 0,
    });
    this._running.set(name, false);
    this._lastRuns.set(name, 0);
  }

  /**
   * 注册 Background Review Fork
   */
  registerReviewFork(reviewFork) {
    this.register('reviewFork', reviewFork, {
      phase: SCHEDULE_PHASES.POST_TURN,
      priority: 1,
      cooldownMs: this.config.reviewCooldownMs,
      handler: async (ctx) => {
        if (!this.config.reviewEnabled) return;
        if (this._isInCooldown('reviewFork')) return;
        this._markRunning('reviewFork');

        try {
          const result = await reviewFork.reviewAfterTurn(ctx);
          if (result) {
            this.emit('review:done', result);
          }
        } catch (err) {
          console.warn('[SchedulerOrchestrator] Review fork 失败:', err.message);
        } finally {
          this._markStopped('reviewFork');
        }
      },
    });
  }

  /**
   * 注册 Skill Curator
   */
  registerCurator(curator) {
    this.register('curator', curator, {
      phase: SCHEDULE_PHASES.IDLE,
      priority: 5,
      cooldownMs: this.config.curatorIntervalMs,
      handler: async () => {
        if (!this.config.curatorEnabled) return;
        if (!curator.shouldRun()) return;

        this._markRunning('curator');
        try {
          const result = await curator.run();
          if (result) {
            this.emit('curator:done', result);
          }
        } catch (err) {
          console.warn('[SchedulerOrchestrator] Curator 失败:', err.message);
        } finally {
          this._markStopped('curator');
        }
      },
    });
  }

  // ============================================================
  // 调度入口
  // ============================================================

  /**
   * 初始化
   */
  initialize() {
    if (this._initialized) return;
    this._initialized = true;
    this.emit('initialized');
    console.log('[SchedulerOrchestrator] 初始化完成');
  }

  /**
   * Pre-Turn Hook — 用户消息到达后、Agent 处理前
   *
   * 在此阶段可以：
   *   - 检查会话状态
   *   - 预加载相关技能
   *   - 注入上下文
   *
   * @param {object} ctx - 会话上下文
   */
  async onPreTurn(ctx) {
    if (!this._initialized) this.initialize();
    if (this._shuttingDown) return;

    await this._runPhase(SCHEDULE_PHASES.PRE_TURN, ctx);
  }

  /**
   * Post-Turn Hook — Agent 完成一轮响应后
   *
   * 在此阶段：
   *   - 触发 Background Review Fork（异步）
   *   - 更新技能使用统计
   *   - 记录会话历史
   *
   * @param {object} ctx - 包含 { sessionId, messages, loadedSkills, ... }
   */
  async onPostTurn(ctx) {
    if (!this._initialized) this.initialize();
    if (this._shuttingDown) return;

    // 异步执行所有 post-turn 任务（不阻塞主循环）
    setImmediate(() => {
      this._runPhase(SCHEDULE_PHASES.POST_TURN, ctx).catch(err => {
        console.warn('[SchedulerOrchestrator] Post-turn 阶段错误:', err.message);
      });
    });
  }

  /**
   * Idle Hook — Agent 空闲时
   *
   * 在此阶段：
   *   - 触发 Curator（如果到期）
   *   - 触发 Memory Consolidation
   *   - 执行清理任务
   *
   * @param {number} idleSeconds - 空闲秒数
   */
  async onIdle(idleSeconds) {
    if (!this._initialized) this.initialize();
    if (this._shuttingDown) return;

    // 空闲时执行低优先级任务
    setImmediate(() => {
      this._runPhase(SCHEDULE_PHASES.IDLE, { idleSeconds }).catch(err => {
        console.warn('[SchedulerOrchestrator] Idle 阶段错误:', err.message);
      });
    });
  }

  /**
   * Shutdown — 关闭清理
   */
  async shutdown() {
    this._shuttingDown = true;
    this.emit('shutdown');

    // 等待活跃任务完成
    let waitCount = 0;
    while (this._activeBackgroundTasks > 0 && waitCount < 30) {
      await new Promise(r => setTimeout(r, 1000));
      waitCount++;
    }

    console.log('[SchedulerOrchestrator] 已关闭');
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 执行指定阶段的所有任务
   */
  async _runPhase(phase, ctx) {
    const tasks = [...this._components.values()]
      .filter(c => c.phase === phase)
      .sort((a, b) => a.priority - b.priority);

    for (const task of tasks) {
      // 检查冷却期
      if (task.cooldownMs > 0 && this._isInCooldown(task.name)) continue;

      // 检查是否正在运行
      if (this._running.get(task.name)) continue;

      // 检查并发限制
      if (this._activeBackgroundTasks >= this.config.maxConcurrentTasks) break;

      // 执行
      this._activeBackgroundTasks++;

      try {
        this._running.set(task.name, true);
        this._lastRuns.set(task.name, Date.now());
        await task.handler(ctx);
      } catch (err) {
        this.emit('task:error', { name: task.name, error: err });
      } finally {
        this._running.set(task.name, false);
        this._activeBackgroundTasks--;
      }
    }
  }

  /**
   * 检查组件是否在冷却期内
   */
  _isInCooldown(name) {
    const component = this._components.get(name);
    if (!component || component.cooldownMs <= 0) return false;

    const lastRun = this._lastRuns.get(name) || 0;
    return (Date.now() - lastRun) < component.cooldownMs;
  }

  _markRunning(name) {
    this._running.set(name, true);
    this._lastRuns.set(name, Date.now());
  }

  _markStopped(name) {
    this._running.set(name, false);
  }

  // ============================================================
  // 状态查询
  // ============================================================

  /**
   * 获取所有组件的运行状态
   */
  getStatus() {
    const status = {};
    for (const [name, component] of this._components) {
      status[name] = {
        running: this._running.get(name) || false,
        lastRun: this._lastRuns.get(name)
          ? new Date(this._lastRuns.get(name)).toISOString()
          : null,
        phase: component.phase,
        priority: component.priority,
      };
    }
    return {
      components: status,
      activeBackgroundTasks: this._activeBackgroundTasks,
      shuttingDown: this._shuttingDown,
    };
  }
}

// ============================================================
// 单例
// ============================================================

let _instance = null;

function getOrchestrator(config = {}) {
  if (!_instance) {
    _instance = new SchedulerOrchestrator(config);
  }
  return _instance;
}

module.exports = {
  SchedulerOrchestrator,
  SCHEDULE_PHASES,
  getOrchestrator,
};
