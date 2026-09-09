/**
 * TaskFlow Bridge — connects ai.js conversation layer to taskflow runtime
 *
 * Single entry point: start(message, session, options) → flowId + progress SSE
 * Integrates with Harness hooks, metrics, progress reporter, agent contracts.
 */

const { EventEmitter } = require('events');


class TaskFlowBridge extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(30);
    this._activeFlows = new Map(); // flowId → { sessionId, startedAt, options }
    this._initialized = false;
  }

  async _ensureInitialized() {
    if (this._initialized) return;
    try {
      const { initializeTaskFlow } = require('../taskflow');
      await initializeTaskFlow();
      this._initialized = true;
    } catch (e) {
      console.warn('[taskflow-bridge] Init failed, will retry:', e.message);
    }
  }

  /**
   * Start a workflow from user message. Returns immediately with flow metadata;
   * actual execution happens asynchronously with SSE progress pushes.
   *
   * @param {string} message - user input
   * @param {object} session - { userId, sessionId, channel, ... }
   * @param {object} options - { flowId?, template?, dryRun?, autoApprove? }
   * @returns {{flowId, status, stages, message}}
   */
  async start(message, session, options = {}) {
    await this._ensureInitialized();

    const taskflow = require('../taskflow');
    const { globalHooks } = require('./harness-hooks');
    const { broadcastEvent: sseBroadcast } = require('./sse-broadcast');
    // eslint-disable-next-line no-unused-vars
    const { globalProgressReporter } = require('./progress-reporter');

    // 1. Intent analysis for workflow matching
    let suggestedFlowId = options.flowId || null;
    let intentResult = null;
    try {
      const { getIntentAnalyzer } = require('../taskflow/intent-analyzer');
      const analyzer = getIntentAnalyzer();
      intentResult = analyzer.analyze(message, { sessionId: session.sessionId });
      if (intentResult && intentResult.type !== 'unknown') {
        suggestedFlowId = suggestedFlowId || intentResult.suggestedWorkflow || null;
      }
    } catch (e) {
      console.debug('[taskflow-bridge] Intent analysis skipped:', e.message);
    }

    // 2. Template selection (if no explicit flowId)
    if (!suggestedFlowId) {
      try {
        const { selectTemplate } = require('./template-selector');
        suggestedFlowId = selectTemplate(message, intentResult);
      } catch (_) { console.warn('[taskflow-bridge] Template selection failed'); }
    }

    // 3. Create flow
    const flowParams = {
      name: options.title || message.substring(0, 60),
      template: suggestedFlowId || 'default_task',
      input: message,
      goal: options.title || message.substring(0, 200),
      sessionId: session.sessionId || 'default',
      ...options.flowParams,
    };

    let flow;
    try {
      flow = await taskflow.createFlow(flowParams);
    } catch (e) {
      console.error('[taskflow-bridge] createFlow failed:', e.message);
      return { error: 'Failed to create workflow: ' + e.message };
    }

    const flowId = flow.id || flow.flowId;
    this._activeFlows.set(flowId, {
      sessionId: session.sessionId,
      startedAt: Date.now(),
      options,
      intentResult,
    });

    // 4. Emit lifecycle events
    this.emit('flow:started', { flowId, sessionId: session.sessionId, suggestedFlowId, name: flowParams?.name || flow?.name || '任务', steps: (flow?.steps || []).map(s => typeof s === 'string' ? s : (s.name || s)) });

    // Harness: trigger pre-execution hook
    try {
      await globalHooks.triggerPreToolUse('taskflow:start', { flowId, params: flowParams }, session);
      globalHooks.emit('taskflow:start', { flowId, params: flowParams });
    } catch (_) { console.warn('[taskflow-bridge] Failed to trigger pre-execution hook'); }

    // 5. Async execute (non-blocking)
    setImmediate(async () => {
      try {
        await taskflow.executeFlow(flowId, {
          originalMessage: message,
          session,
          intentResult,
          ...options.executeContext,
        });
        this.emit('flow:completed', { flowId, sessionId: session.sessionId });
        sseBroadcast('workflow:complete', { flowId, status: 'completed' });
      } catch (e) {
        this.emit('flow:error', { flowId, error: e.message });
        sseBroadcast('workflow:error', { flowId, error: e.message });
      } finally {
        this._activeFlows.delete(flowId);
      }
    });

    // 6. Return immediate metadata
    const status = await taskflow.getFlowStatus(flowId).catch(() => ({ status: 'running' }));

    return {
      flowId,
      status: status.status || 'running',
      stages: status.stages || (flow.steps || []).map(s => typeof s === 'string' ? s : s.name),
      message: `Workflow "${flowParams.name}" started with ${(flow.steps || []).length} stages.`,
    };
  }

  /**
   * Get progress for an active flow
   */
  async getProgress(flowId) {
    const taskflow = require('../taskflow');
    try {
      const status = await taskflow.getFlowStatus(flowId);
      return {
        flowId,
        status: status.status,
        currentStep: status.currentStep,
        completedSteps: status.completedSteps || [],
        progress: status.progress || 0,
        startedAt: status.startedAt,
      };
    } catch (e) {
      return { flowId, status: 'unknown', error: e.message };
    }
  }

  /**
   * Get deliverables (files, reports) from completed stages
   */
  async getDeliverables(flowId) {
    const taskflow = require('../taskflow');
    try {
      const flow = await taskflow.getFlow(flowId);
      const deliverables = [];
      if (flow && flow.steps) {
        for (const step of flow.steps) {
          if (step.result && step.result.files) {
            deliverables.push(...step.result.files);
          }
        }
      }
      return { flowId, deliverables };
    } catch (e) {
      return { flowId, deliverables: [], error: e.message };
    }
  }

  /**
   * Cancel an active flow
   */
  async cancel(flowId) {
    const taskflow = require('../taskflow');
    try {
      await taskflow.cancelFlow(flowId);
      this._activeFlows.delete(flowId);
      this.emit('flow:cancelled', { flowId });
      return { flowId, status: 'cancelled' };
    } catch (e) {
      return { flowId, error: e.message };
    }
  }

  /**
   * Resume a paused flow with approval token
   */
  async resume(flowId, resumeToken, approvalResult) {
    const taskflow = require('../taskflow');
    try {
      const result = await taskflow.resumeFlow(resumeToken, approvalResult);
      return { flowId, status: 'resumed', result };
    } catch (e) {
      return { flowId, error: e.message };
    }
  }

  /**
   * List active flows
   */
  getActiveFlows() {
    const result = [];
    for (const [flowId, meta] of this._activeFlows) {
      result.push({ flowId, ...meta });
    }
    return result;
  }

  /**
   * Get bridge status
   */
  getStatus() {
    return {
      initialized: this._initialized,
      activeFlowCount: this._activeFlows.size,
      activeFlows: this.getActiveFlows().map(f => f.flowId),
    };
  }
}

// Singleton
const taskflowBridge = new TaskFlowBridge();

module.exports = { TaskFlowBridge, taskflowBridge };
