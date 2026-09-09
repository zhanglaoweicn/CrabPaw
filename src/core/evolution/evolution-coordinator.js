const crypto = require('crypto');
/**
 * Evolution Coordinator - Cross-system evolution coordination
 *
 * Provides coordinated evolution for the CrabPaw ecosystem
 * - Proposal submission and scheduling
 * - Dependency resolution and execution ordering
 * - Conflict detection
 * - Coordination across skill/memory/agent systems
 *
 * Workflow:
 *   submit proposal -> analyze deps -> execute -> verify -> complete
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function _getDataDir() {
  // Determine data directory, with env var override
  if (process.env.CRABPAW_DATA_DIR) return process.env.CRABPAW_DATA_DIR;
  try {
    const config = require('../config');
    return config.DATA_DIR;
  } catch (_) {
    return path.join(__dirname, '..', '..', 'data', '.crabpaw');
  }
}

function _getCoordinatorDir() {
  return path.join(_getDataDir(), 'coordinator');
}
function _getLogFilePath() {
  return path.join(_getCoordinatorDir(), 'coordination-log.json');
}
function _getGrayscaleFilePath() {
  return path.join(_getCoordinatorDir(), 'grayscale-state.json');
}

/**
 * Target systems that can evolve
 */
const TARGET_SYSTEMS = {
  SKILL: 'skill',
  MEMORY: 'memory',
  AGENT: 'agent',
  COGNITIVE: 'cognitive',
  SECURITY: 'security',
};

/**
 * Coordination states for proposals
 */
const COORDINATION_STATE = {
  PENDING: 'pending',
  RUNNING: 'running',
  GRAYSCALE: 'grayscale',   // In grayscale rollout
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Grayscale rollout stages with increasing traffic percentage
 */
const GRAYSCALE_STAGES = [
  { name: 'canary', percent: 10, observationMs: 900000 },   // 10% traffic, observe 15min
  { name: 'half', percent: 50, observationMs: 600000 },     // 50% traffic, observe 10min
  { name: 'full', percent: 100, observationMs: 0 },         // 100% traffic, fully rolled out
];

/**
 * A coordinated proposal with tracking state
 */
class CoordinatedProposal {
  constructor(data = {}) {
    this.id = `coord_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    this.proposal = data.proposal || {};
    this.targetSystem = data.targetSystem || TARGET_SYSTEMS.SKILL;
    this.dependencies = data.dependencies || [];
    this.priority = data.priority || 'medium';
    this.status = COORDINATION_STATE.PENDING;
    this.submittedAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.result = null;
    this.error = null;

    // Grayscale rollout tracking
    this.grayscaleEnabled = data.grayscaleEnabled !== false; // Enabled by default
    this.grayscaleStage = -1;  // Current grayscale stage index, -1 = not started
    this.grayscaleBaseline = null;  // Metrics baseline before grayscale
    this.grayscaleStartedAt = null;
  }
}

/**
 * Evolution Coordinator class - orchestrates cross-system evolution
 */

// ============================================================
// Regression guard and rollback integration (auto-detect degradation after evolution)
// ============================================================
const { getRegressionGuard } = require('../skill/regression-guard');
const { getRollbackManager } = require('./rollback-manager');

class EvolutionCoordinator extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      maxConcurrent: config.maxConcurrent || 3,
      retryAttempts: config.retryAttempts || 2,
      timeoutMs: config.timeoutMs || 60000,
      ...config,
    };

    // Registered evolution engines per system
    this._engines = new Map();

    // Proposal queue and running set
    this._queue = [];
    this._running = new Map();

    // All proposals ever submitted (P1-9: 此前 getReport 引用未定义字段恒返回 0)
    this._proposals = [];

    // Grayscale default (P1-9: 此前 getReport 引用未定义字段恒返回 undefined)
    this.grayscaleEnabled = this.config.grayscaleEnabled !== false;

    // Dependency tracking graph
    this._dependencyGraph = new Map();

    // Coordination log
    this._log = [];

    this._processing = false;
    this._resumeRequested = false;
    this._initialized = false;
    this._isEvolving = false;
  }

  /**
   * Initialize the coordinator, setup directories and recover state
   */
  initialize() {
    if (this._initialized) return;

    // Ensure coordinator directory exists
    if (!fs.existsSync(_getCoordinatorDir())) {
      fs.mkdirSync(_getCoordinatorDir(), { recursive: true });
    }

    // Load persisted log
    this._loadLog();

    // Recover incomplete grayscale state from disk
    this._recoverGrayscaleState();

    this._initialized = true;
    this.emit('initialized');

    console.log('[EvolutionCoordinator] Initialized');
  }

  /**
   * Register an evolution engine for a target system
   */
  registerEngine(system, engine) {
    if (!engine || typeof engine.evolve !== 'function') {
      throw new Error(`Engine for ${system} must implement evolve()`);
    }

    this._engines.set(system, engine);
    this.emit('engine:registered', { system });

    console.log(`[EvolutionCoordinator] Registered engine: ${system}`);
  }

  /**
   * Get the engine for a given system
   */
  getEngine(system) {
    return this._engines.get(system);
  }

  // ========== Proposal Submission ==========

  /**
   * Submit an evolution proposal for coordinated execution
   */
  async submit(proposal, options = {}) {
    if (!this._initialized) {
      this.initialize();
    }

    const targetSystem = options.targetSystem || this._inferTargetSystem(proposal);

    // Analyze cross-system dependencies
    const dependencies = await this._analyzeDependencies(proposal, targetSystem);

    // Create coordinated proposal
    const coordinated = new CoordinatedProposal({
      proposal,
      targetSystem,
      dependencies,
      priority: options.priority || 'medium',
      grayscaleEnabled: options.grayscaleEnabled !== false, // Enabled by default
    });

    // Add to queue
    this._queue.push(coordinated);
    this._proposals.push(coordinated);

    // Update dependency graph
    this._updateDependencyGraph(coordinated);

    this.emit('proposal:submitted', { id: coordinated.id, targetSystem });

    console.log(
      `[EvolutionCoordinator] Proposal submitted: ${coordinated.id}, ` +
      `system=${targetSystem}, deps=${dependencies.length}`
    );

    // Start queue processing if not already running
    if (!this._processing) {
      setImmediate(() => this._processQueue());
    }

    return coordinated;
  }

  /**
   * Infer the target system from proposal contents
   */
  _inferTargetSystem(proposal) {
    if (proposal.targetSkillIds?.length > 0) {
      return TARGET_SYSTEMS.SKILL;
    }
    if (proposal.memoryPattern) {
      return TARGET_SYSTEMS.MEMORY;
    }
    if (proposal.agentBehavior) {
      return TARGET_SYSTEMS.AGENT;
    }
    return TARGET_SYSTEMS.SKILL;
  }

  /**
   * Analyze cross-system dependencies for a proposal
   */
  async _analyzeDependencies(proposal, targetSystem) {
    const dependencies = [];

    // Skill evolution may require memory pattern update
    if (targetSystem === TARGET_SYSTEMS.SKILL && proposal.requiresMemoryUpdate) {
      dependencies.push({
        system: TARGET_SYSTEMS.MEMORY,
        action: 'update',
        reason: 'skill_requires_memory_pattern',
      });
    }

    // Agent evolution may require specific skills
    if (targetSystem === TARGET_SYSTEMS.AGENT && proposal.requiredSkills) {
      for (const skill of proposal.requiredSkills) {
        dependencies.push({
          system: TARGET_SYSTEMS.SKILL,
          action: 'ensure_available',
          target: skill,
          reason: 'agent_requires_skill',
        });
      }
    }

    // Cognitive evolution requires consolidated memory
    if (targetSystem === TARGET_SYSTEMS.COGNITIVE) {
      dependencies.push({
        system: TARGET_SYSTEMS.MEMORY,
        action: 'consolidate',
        reason: 'cognitive_requires_consolidated_memory',
      });
    }

    return dependencies;
  }

  /**
   * Update the dependency graph with a new proposal
   */
  _updateDependencyGraph(coordinated) {
    this._dependencyGraph.set(coordinated.id, {
      proposal: coordinated,
      dependents: [],
    });

    // Link to completed proposals that satisfy dependencies
    for (const dep of coordinated.dependencies) {
      // Find already completed proposals for this system
      // eslint-disable-next-line no-unused-vars
      for (const [id, node] of this._dependencyGraph) {
        if (node.proposal.targetSystem === dep.system && node.proposal.status === COORDINATION_STATE.COMPLETED) {
          node.dependents.push(coordinated.id);
        }
      }
    }
  }

  // ========== Queue Processing ==========

  /**
   * Process the queue: select and execute proposals
   */
  async _processQueue() {
    if (this._processing) return;
    this._resumeRequested = false;
    this._processing = true;

    while (this._queue.length > 0) {
      // Check running tasks for completion
      await this._checkRunningTasks();

      // Select proposals ready for execution
      const executable = this._selectExecutable();

      if (executable.length === 0) {
        // If a same-system proposal is running, wait for its completion callback
        // to schedule the next processing pass instead of busy-looping here.
        break;
      }

      // Execute selected proposals
      for (const coordinated of executable) {
        if (this._running.size >= this.config.maxConcurrent) break;
        this._executeProposal(coordinated);
      }

      // Wait briefly before next iteration
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this._processing = false;
    if (this._resumeRequested) {
      this._resumeRequested = false;
      this._scheduleProcessing();
    } else if (this._queue.length === 0 && this._running.size === 0) {
      this.emit('queue:empty');
    }
  }

  /**
   * Schedule a queue pass after a running proposal releases its target system.
   */
  _scheduleProcessing() {
    if (this._processing) {
      this._resumeRequested = true;
      return;
    }
    setImmediate(() => {
      if (!this._processing && this._queue.length > 0) {
        this._processQueue().catch(error => {
          console.error('[EvolutionCoordinator] Queue processing failed:', error.message);
          this._processing = false;
        });
      }
    });
  }

  /**
   * Select proposals ready for execution from the queue
   */
  _selectExecutable() {
    const executable = [];

    for (const coordinated of this._queue) {
      if (coordinated.status !== COORDINATION_STATE.PENDING) continue;

      // Skip if dependencies not met
      if (!this._areDependenciesMet(coordinated)) continue;

      // Skip if conflicts detected
      if (this._hasConflict(coordinated)) continue;

      executable.push(coordinated);
    }

    // Sort by priority
    executable.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    return executable;
  }

  /**
   * Check if all dependencies for a proposal are satisfied
   */
  _areDependenciesMet(coordinated) {
    for (const dep of coordinated.dependencies) {
      // Check if any completed proposal in the target system exists
      let satisfied = false;
      // eslint-disable-next-line no-unused-vars
      for (const [id, node] of this._dependencyGraph) {
        if (
          node.proposal.targetSystem === dep.system &&
          node.proposal.status === COORDINATION_STATE.COMPLETED
        ) {
          satisfied = true;
          break;
        }
      }
      if (!satisfied) return false;
    }
    return true;
  }

  /**
   * Check if a proposal conflicts with currently running proposals
   */
  _hasConflict(coordinated) {
    // eslint-disable-next-line no-unused-vars
    for (const [id, running] of this._running) {
      // Same system cannot run concurrently
      if (running.targetSystem === coordinated.targetSystem) {
        return true;
      }
      // Dependency conflict with running proposal
      if (coordinated.dependencies.some(dep => dep.system === running.targetSystem)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Execute a single proposal with grayscale rollout
   */
  async _executeProposal(coordinated) {
    coordinated.status = COORDINATION_STATE.RUNNING;
    coordinated.startedAt = Date.now();
    this._running.set(coordinated.id, coordinated);

    // Remove from queue
    const index = this._queue.indexOf(coordinated);
    if (index >= 0) {
      this._queue.splice(index, 1);
    }

    this.emit('proposal:started', { id: coordinated.id });

    try {
      const engine = this._engines.get(coordinated.targetSystem);
      if (!engine) {
        // 2026-08-18 残留修复: 无引擎是预期降级(memory/agent 走各自定时/自愈路径,
        // 不注册协调器提案引擎)而非失败——标记 CANCELLED + info 级日志,
        // 不再以 Failed 污染错误日志。
        coordinated.status = COORDINATION_STATE.CANCELLED;
        coordinated.reason = `no_engine_${coordinated.targetSystem}`;
        coordinated.completedAt = Date.now();
        this._running.delete(coordinated.id);
        this.emit('proposal:cancelled', { id: coordinated.id, targetSystem: coordinated.targetSystem });
        console.info(`[EvolutionCoordinator] Skipped proposal ${coordinated.id} (${coordinated.targetSystem}): no engine registered (expected for memory/agent), proposal not executed`);
        return { skipped: true, reason: coordinated.reason };
      }

      // Capture baseline metrics before grayscale
      if (coordinated.grayscaleEnabled) {
        coordinated.grayscaleBaseline = this._captureBaseline(coordinated.targetSystem);
      }

      // Execute evolution with timeout + retry（P1-9: retryAttempts 此前定义但无重试逻辑）
      let result = null;
      let evolved = false;
      let lastError = null;
      const maxAttempts = Math.max(1, (this.config.retryAttempts || 0) + 1);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          result = await this._withTimeout(engine.evolve(coordinated.proposal), coordinated.id);
          evolved = true;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            console.warn(
              `[EvolutionCoordinator] ${coordinated.id} evolve attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying`
            );
            await new Promise(resolve => setTimeout(resolve, 200 * attempt));
          }
        }
      }
      if (!evolved) throw lastError;

      coordinated.result = result;

      // ============================================================
      // Regression guard: detect degradation after evolution
      // ============================================================
      if (result && coordinated.targetSystem === TARGET_SYSTEMS.SKILL) {
        try {
          const skillName = coordinated.proposal?.skillName || coordinated.proposal?.name;
          if (skillName) {
            const regressionGuard = getRegressionGuard();
            regressionGuard.initialize();
            const currentMetrics = {
              successRate: result.successRate ?? result.metrics?.successRate,
              avgDuration: result.avgDuration ?? result.metrics?.avgDuration,
              qualityScore: result.qualityScore ?? result.metrics?.qualityScore,
            };
            const regressionResult = await regressionGuard.checkRegression(skillName, currentMetrics);
            if (regressionResult.regressed) {
              console.warn(`[EvolutionCoordinator] Regression detected: ${skillName}, severity: ${regressionResult.severity}, ${regressionResult.summary}`);
              if (regressionResult.severity === "high") {
                try {
                  const rollbackManager = getRollbackManager();
                  rollbackManager.initialize();
                  const rollbackRecord = await rollbackManager.rollback(
                    skillName,
                    { newVersion: result.version, parentVersion: result.previousVersion },
                    { reason: `Auto-rollback: regression detected - ${regressionResult.summary}`, action: "rollback" }
                  );
                  if (rollbackRecord?.success) {
                    console.log(`[EvolutionCoordinator] Auto-rolled back: ${skillName}`);
                    coordinated.result = { ...result, rolledBack: true, rollbackReason: regressionResult.summary };
                    coordinated.status = COORDINATION_STATE.FAILED;
                    coordinated.error = `Regression triggered rollback: ${regressionResult.summary}`;
                    coordinated.completedAt = Date.now();
                    this._log.push({ id: coordinated.id, targetSystem: coordinated.targetSystem, status: coordinated.status, regression: regressionResult, rollback: rollbackRecord?.id });
                    this._trimLog();
                    this._saveLog();
                    this._running.delete(coordinated.id);
                    this._scheduleProcessing();
                    this.emit("proposal:rolled_back", { id: coordinated.id, skillName, reason: regressionResult.summary });
                    return;
                  }
                } catch (rollbackErr) {
                  console.error(`[EvolutionCoordinator] Rollback failed: ${skillName}`, rollbackErr.message);
                }
              }
            } else {
              console.log(`[EvolutionCoordinator] Regression check passed: ${skillName}`);
            }
          }
        } catch (guardErr) {
          console.warn("[EvolutionCoordinator] Regression guard check failed, continuing:", guardErr.message);
        }
      }

      // Start grayscale rollout
      if (coordinated.grayscaleEnabled && result) {
        coordinated.status = COORDINATION_STATE.GRAYSCALE;
        coordinated.grayscaleStage = 0;
        coordinated.grayscaleStartedAt = Date.now();

        this.emit('proposal:grayscale_started', {
          id: coordinated.id,
          stage: GRAYSCALE_STAGES[0].name,
          percent: GRAYSCALE_STAGES[0].percent,
        });

        console.log(
          `[EvolutionCoordinator] Grayscale started: ${coordinated.id}, ` +
          `stage: ${GRAYSCALE_STAGES[0].name} (${GRAYSCALE_STAGES[0].percent}%)`
        );

        // Start observation period for this stage
        this._startGrayscaleObservation(coordinated);
      } else {
        // No grayscale, complete immediately
        coordinated.status = COORDINATION_STATE.COMPLETED;
        coordinated.completedAt = Date.now();
        this.emit('proposal:completed', { id: coordinated.id, result });
        console.log(`[EvolutionCoordinator] Completed: ${coordinated.id}`);

        this._running.delete(coordinated.id);
        this._triggerDependents(coordinated);
        this._scheduleProcessing();
      }
    } catch (e) {
      coordinated.error = e.message;
      coordinated.status = COORDINATION_STATE.FAILED;
      coordinated.completedAt = Date.now();

      this.emit('proposal:failed', { id: coordinated.id, error: e.message });
      console.error(`[EvolutionCoordinator] Failed: ${coordinated.id}, ${e.message}`);

      // Persist failure to log
      this._log.push({
        id: coordinated.id,
        targetSystem: coordinated.targetSystem,
        status: coordinated.status,
        startedAt: coordinated.startedAt,
        completedAt: coordinated.completedAt,
        error: coordinated.error,
      });
      this._trimLog();
      this._saveLog();

      this._running.delete(coordinated.id);
      this._scheduleProcessing();
    }
  }

  /**
   * Start observation period for current grayscale stage
   */
  _startGrayscaleObservation(coordinated) {
    const stage = GRAYSCALE_STAGES[coordinated.grayscaleStage];
    if (!stage || stage.observationMs === 0) {
      // Final stage or no observation needed, complete immediately
      this._completeGrayscale(coordinated);
      return;
    }

    // Persist grayscale state to survive restarts
    this._persistGrayscaleState(coordinated);

    setTimeout(() => {
      this._evaluateGrayscaleStage(coordinated);
    }, stage.observationMs);
  }

  /**
   * Evaluate current grayscale stage metrics and decide next step
   */
  _evaluateGrayscaleStage(coordinated) {
    // Check if metrics have degraded from baseline
    const currentMetrics = this._captureBaseline(coordinated.targetSystem);
    const baseline = coordinated.grayscaleBaseline;

    const degraded = this._isDegraded(baseline, currentMetrics);

    if (degraded) {
      // Metrics degraded, rollback the grayscale
      console.warn(
        `[EvolutionCoordinator] Grayscale degraded, rolling back: ${coordinated.id}, ` +
        `stage: ${GRAYSCALE_STAGES[coordinated.grayscaleStage].name}`
      );

      coordinated.status = COORDINATION_STATE.FAILED;
      coordinated.completedAt = Date.now();
      coordinated.error = 'grayscale_degradation_detected';

      this.emit('proposal:grayscale_rollback', {
        id: coordinated.id,
        stage: GRAYSCALE_STAGES[coordinated.grayscaleStage].name,
        baseline,
        current: currentMetrics,
      });

      // Persist failure to log
      this._log.push({
        id: coordinated.id,
        targetSystem: coordinated.targetSystem,
        status: coordinated.status,
        startedAt: coordinated.startedAt,
        completedAt: coordinated.completedAt,
        error: coordinated.error,
      });
      this._trimLog();
      this._saveLog();

      this._running.delete(coordinated.id);
      this._scheduleProcessing();
      return;
    }

    // Advance to next stage
    coordinated.grayscaleStage++;

    if (coordinated.grayscaleStage >= GRAYSCALE_STAGES.length) {
      // All stages passed, complete
      this._completeGrayscale(coordinated);
      return;
    }

    const nextStage = GRAYSCALE_STAGES[coordinated.grayscaleStage];
    this.emit('proposal:grayscale_advanced', {
      id: coordinated.id,
      stage: nextStage.name,
      percent: nextStage.percent,
    });

    console.log(
      `[EvolutionCoordinator] Grayscale advanced: ${coordinated.id}, ` +
      `stage: ${nextStage.name} (${nextStage.percent}%)`
    );

    this._startGrayscaleObservation(coordinated);
  }

  /**
   * Complete grayscale rollout successfully
   */
  _completeGrayscale(coordinated) {
    coordinated.status = COORDINATION_STATE.COMPLETED;
    coordinated.completedAt = Date.now();

    // Clear persisted grayscale state file
    this._clearGrayscaleState();

    this.emit('proposal:completed', {
      id: coordinated.id,
      result: coordinated.result,
      grayscaleStages: coordinated.grayscaleStage + 1,
    });

    console.log(`[EvolutionCoordinator] Grayscale completed: ${coordinated.id}`);

    // Persist to log
    this._log.push({
      id: coordinated.id,
      targetSystem: coordinated.targetSystem,
      status: coordinated.status,
      startedAt: coordinated.startedAt,
      completedAt: coordinated.completedAt,
      grayscaleStages: coordinated.grayscaleStage + 1,
    });
    this._trimLog();
    this._saveLog();

    this._running.delete(coordinated.id);

    // Trigger dependent proposals that may now be ready
    this._triggerDependents(coordinated);
    this._scheduleProcessing();
  }

  /**
   * Run full system evolution across all registered engines
   * Can be called from evolution-system.js or coordinator.evolve()
   */
  async evolve() {
    if (this._isEvolving) {
      console.log('[EvolutionCoordinator] Already evolving, skipping');
      return { skipped: true };
    }
    this._isEvolving = true;
    console.log('[EvolutionCoordinator] Starting system evolution...');

    const results = [];
    const startedAt = Date.now();
    try {
      for (const [system, engine] of this._engines) {
        const engineStart = Date.now();
        try {
          console.log(`[EvolutionCoordinator] Evolving ${system} ...`);
          let result = await this._withTimeout(engine.evolve(), system);

          // 诚实化（P1）：注册引擎若为 stats 壳（improvement 恒 0、无真实进化动作，
          // server.js 此前注册的就是该壳），补跑真实进化路径——SkillEvolutionEngine.evolve()
          // （analyze → identifyOpportunities → improve：每轮经 processSuggestion 桥接到
          // 门禁 SkillEvolver 写 SKILL.md，汇总 improvement）。真实引擎已产出
          // improvement > 0 时跳过，避免双跑。heartbeat 每日触发不再空转。
          if (system === TARGET_SYSTEMS.SKILL && !(result && result.improvement > 0)) {
            try {
              const realResult = await this._runRealSkillEvolution();
              if (realResult) {
                result = {
                  ...result,
                  improvement: realResult.improvement || 0,
                  details: { ...(result?.details || {}), realEngine: 'SkillEvolutionEngine', realResult },
                };
              }
            } catch (realErr) {
              console.warn(`[EvolutionCoordinator] 真实技能进化路径失败: ${realErr.message}`);
            }
          }

          const entry = {
            module: system,
            success: true,
            improvement: result?.improvement || 0,
            durationMs: Date.now() - engineStart,
            details: result,
          };
          results.push(entry);
          this._appendEvolutionLog(entry);
        } catch (err) {
          console.error(`[EvolutionCoordinator] ${system} failed:`, err.message);
          const entry = {
            module: system,
            success: false,
            error: err.message,
            durationMs: Date.now() - engineStart,
          };
          results.push(entry);
          this._appendEvolutionLog(entry);
        }
      }
    } finally {
      this._isEvolving = false;
    }

    const summary = {
      results,
      timestamp: Date.now(),
      totalDurationMs: Date.now() - startedAt,
      successCount: results.filter(r => r.success).length,
      totalCount: results.length,
    };
    console.log(`[EvolutionCoordinator] System evolution: ${summary.successCount}/${summary.totalCount} succeeded (${summary.totalDurationMs}ms)`);
    return summary;
  }

  /**
   * Append an entry to the evolution log and persist to coordination-log.json
   */
  _appendEvolutionLog(entry) {
    this._log.push({
      id: `evo_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`,
      ts: Date.now(),
      iso: new Date().toISOString(),
      ...entry,
    });
    this._trimLog();
    this._saveLog();
  }

  /**
   * Get evolution log entries, optionally filtered
   */
  getEvolutionLog(filter = {}) {
    let logs = [...this._log];
    if (filter.module) logs = logs.filter(l => l.module === filter.module);
    if (filter.since) logs = logs.filter(l => l.ts >= filter.since);
    if (filter.success !== undefined) logs = logs.filter(l => l.success === filter.success);
    if (filter.limit) logs = logs.slice(-filter.limit);
    return logs;
  }

  /**
   * Get coordinator status report
   */
  getReport() {
    return {
      engines: Array.from(this._engines.keys()),
      proposals: this._proposals.length,
      pending: this._queue.filter(p => p.status === COORDINATION_STATE.PENDING).length,
      running: this._running.size,
      initialized: this._initialized,
      grayscaleEnabled: this.grayscaleEnabled,
    };
  }

  /**
   * Capture current metrics baseline for a target system
   * Uses MetricsPipeline to collect key metrics
   */
  _captureBaseline(targetSystem) {
    const baseline = {
      timestamp: Date.now(),
      system: targetSystem,
    };

    try {
      const { getMetricsPipeline } = require('../perception/metrics-pipeline');
      const pipeline = getMetricsPipeline();
      const since = Date.now() - 3600000; // Last 1 hour

      // Collect metrics from pipeline
      const successQuery = pipeline.query(`${targetSystem}.success_rate`, { since, aggregation: 'avg' });
      const latencyQuery = pipeline.query(`${targetSystem}.latency`, { since, aggregation: 'avg' });
      const errorQuery = pipeline.query(`${targetSystem}.error_rate`, { since, aggregation: 'avg' });

      baseline.successRate = successQuery.value ?? 0;
      baseline.avgLatency = latencyQuery.value ?? 0;
      baseline.errorRate = errorQuery.value ?? 0;
    } catch (e) {
      console.warn('[EvolutionCoordinator] 基线指标采集失败，使用零基线:', e.message);
    }

    return baseline;
  }

  /**
   * Determine if metrics have degraded relative to baseline
   * Uses EvolutionScore evaluator when available
   */
  _isDegraded(baseline, current) {
    if (!baseline || !current) return false;

    try {
      const { getEvolutionScore } = require('./evolution-score');
      const scorer = getEvolutionScore();
      const result = scorer.evaluate(baseline, current);
      return result.decision === 'rollback';
    } catch {
      // Fallback: simple success rate comparison when EvolutionScore unavailable
      if (baseline.successRate != null && current.successRate != null) {
        return current.successRate < baseline.successRate - 0.1;
      }
      return false;
    }
  }



  /**
   * 真实技能进化路径（诚实化）：SkillEvolutionEngine.evolve()
   * analyze → identifyOpportunities → improve（processSuggestion 桥接真实
   * SKILL.md 写入）→ validate → apply。供 evolve() 对 stats 壳引擎补跑。
   * 注意：SkillEvolver.processSuggestion 内部会经 _coordinator.submit 提交提案，
   * 但 submit 走 _executeProposal（壳引擎），不会回调本方法——无递归。
   */
  async _runRealSkillEvolution() {
    const { getSkillEvolutionEngine } = require('./skill-evolution');
    const engine = await getSkillEvolutionEngine();
    if (!engine || typeof engine.evolve !== 'function') {
      return { improvement: 0, details: { reason: 'skill_evolution_engine_unavailable' } };
    }
    return await this._withTimeout(engine.evolve(), 'skill_real');
  }

  _withTimeout(promise, id) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout for ${id}`)), this.config.timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Trigger dependent proposals that may now be ready
   */
  _triggerDependents(coordinated) {
    const node = this._dependencyGraph.get(coordinated.id);
    if (!node) return;

    for (const dependentId of node.dependents) {
      const dependent = this._queue.find(p => p.id === dependentId);
      if (dependent && dependent.status === COORDINATION_STATE.PENDING) {
        // Check if all dependencies are now satisfied
        if (this._areDependenciesMet(dependent)) {
          this.emit('dependency:ready', { id: dependentId });
        }
      }
    }
  }

  /**
   * Check running tasks for completion（P1-9: 原为占位实现，现做真实兜底清理）
   *
   * _withTimeout 正常情况下会在 timeoutMs 内 reject，此方法兜底处理
   * 引擎既不 resolve 也不 reject 的僵尸任务：状态仍为 RUNNING 且运行时长
   * 超过 2×timeoutMs 时标记失败并释放目标系统。
   */
  async _checkRunningTasks() {
    const now = Date.now();
    const staleAfterMs = this.config.timeoutMs * 2;
    for (const [id, coordinated] of [...this._running]) {
      if (coordinated.status !== COORDINATION_STATE.RUNNING) continue;
      if (!coordinated.startedAt || now - coordinated.startedAt <= staleAfterMs) continue;

      console.warn(`[EvolutionCoordinator] Stale running proposal ${id} (${coordinated.targetSystem}) detected, marking failed`);
      coordinated.status = COORDINATION_STATE.FAILED;
      coordinated.error = 'stale_running_timeout';
      coordinated.completedAt = now;
      this._running.delete(id);
      this._log.push({
        id,
        targetSystem: coordinated.targetSystem,
        status: coordinated.status,
        startedAt: coordinated.startedAt,
        completedAt: now,
        error: coordinated.error,
      });
      this._trimLog();
      this._saveLog();
      this.emit('proposal:failed', { id, error: coordinated.error });
      this._scheduleProcessing();
    }
  }

  // ========== Status Queries ==========

  /**
   * Get queue status summary
   */
  getQueueStatus() {
    return {
      pending: this._queue.filter(p => p.status === COORDINATION_STATE.PENDING).length,
      running: this._running.size,
      engines: Array.from(this._engines.keys()),
    };
  }

  /**
   * Cancel a pending proposal by ID
   */
  cancel(proposalId) {
    const coordinated = this._queue.find(p => p.id === proposalId);
    if (coordinated) {
      coordinated.status = COORDINATION_STATE.CANCELLED;
      const index = this._queue.indexOf(coordinated);
      if (index >= 0) {
        this._queue.splice(index, 1);
      }
      this.emit('proposal:cancelled', { id: proposalId });
      return true;
    }
    return false;
  }

  // ========== Log Persistence ==========

  _loadLog() {
    const logFile = _getLogFilePath();
    if (fs.existsSync(logFile)) {
      try {
        this._log = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      } catch (e) {
        console.error('[EvolutionCoordinator] Log load failed:', e.message);
      }
    }
  }

  _saveLog() {
    fs.writeFileSync(_getLogFilePath(), JSON.stringify(this._log.slice(-500), null, 2));
  }

  _trimLog() {
    if (this._log.length > 500) {
      this._log = this._log.slice(-500);
    }
  }

  // ========== Grayscale State Persistence ==========

  /**
   * Persist grayscale state to disk (survives restarts)
   */
  _persistGrayscaleState(coordinated) {
    try {
      const state = {
        id: coordinated.id,
        targetSystem: coordinated.targetSystem,
        grayscaleStage: coordinated.grayscaleStage,
        grayscaleStartedAt: coordinated.grayscaleStartedAt,
        grayscaleBaseline: coordinated.grayscaleBaseline,
        proposal: coordinated.proposal,
        result: coordinated.result,
        savedAt: Date.now(),
      };
      fs.writeFileSync(_getGrayscaleFilePath(), JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[EvolutionCoordinator] Grayscale state persist failed:', e.message);
    }
  }

  /**
   * Recover incomplete grayscale state after restart
   * Incomplete grayscale is treated as failed on recovery
   */
  _recoverGrayscaleState() {
    if (!fs.existsSync(_getGrayscaleFilePath())) return;

    try {
      const state = JSON.parse(fs.readFileSync(_getGrayscaleFilePath(), 'utf-8'));
      const elapsed = Date.now() - (state.savedAt || 0);

      // If older than 1 hour, treat as stale
      if (elapsed > 3600000) {
        console.warn(`[EvolutionCoordinator] Stale grayscale state expired (${state.id})`);
        this._clearGrayscaleState();
        return;
      }

      // Recovery: mark in-flight grayscale proposal as failed
      console.warn(
        `[EvolutionCoordinator] Incomplete grayscale state recovered: ${state.id}, ` +
        `stage: ${GRAYSCALE_STAGES[state.grayscaleStage]?.name || 'unknown'}, marking as failed`
      );

      this._log.push({
        id: state.id,
        targetSystem: state.targetSystem,
        status: COORDINATION_STATE.FAILED,
        error: 'grayscale_interrupted_by_restart',
        grayscaleStage: state.grayscaleStage,
      });
      this._trimLog();
      this._saveLog();

      this._clearGrayscaleState();
    } catch (e) {
      console.warn('[EvolutionCoordinator] Grayscale state recovery failed:', e.message);
      this._clearGrayscaleState();
    }
  }

  /**
   * Clear grayscale state file from disk
   */
  _clearGrayscaleState() {
    try {
      const fp = _getGrayscaleFilePath();
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
      }
    } catch (e) {
      console.warn('[EvolutionCoordinator] 灰度状态文件清理失败:', e.message);
    }
  }
}

// ========== Singleton Export ==========

let _instance = null;

function getEvolutionCoordinator(config = {}) {
  if (!_instance) {
    _instance = new EvolutionCoordinator(config);
  }
  return _instance;
}

module.exports = {
  EvolutionCoordinator,
  TARGET_SYSTEMS,
  COORDINATION_STATE,
  GRAYSCALE_STAGES,
  CoordinatedProposal,
  getEvolutionCoordinator,
};
