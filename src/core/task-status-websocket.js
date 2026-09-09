/**
 * TaskStatusWebSocket — real-time workflow progress via SSE broadcast
 *
 * Listens to taskflow-runtime EventEmitter events and pushes progress
 * updates through the existing sse-broadcast infrastructure.
 */

const { EventEmitter } = require('events');

class TaskStatusWebSocket extends EventEmitter {
  constructor() {
    super();
    this._listening = false;
    this._runtime = null;
    this._listeners = [];
    this.setMaxListeners(30);
  }

  /**
   * Start listening to taskflow runtime events and broadcasting via SSE
   */
  start() {
    if (this._listening) return;

    try {
      const { getTaskFlowRuntime } = require('../taskflow/taskflow-runtime');
      this._runtime = getTaskFlowRuntime();
    } catch (e) {
      console.warn('[task-status-ws] TaskFlowRuntime not available, retrying later');
      // Schedule a retry once taskflow is initialized
      setTimeout(() => this.start(), 5000);
      return;
    }

    if (!this._runtime) return;

    const { broadcastEvent } = require('./sse-broadcast');

    // ── Runtime-level events ──
    const onFlowActivated = (data) => {
      broadcastEvent('workflow:activated', data);
    };
    this._runtime.on('flow:activated', onFlowActivated);
    this._listeners.push({ event: 'flow:activated', fn: onFlowActivated });

    const onFlowDeactivated = (data) => {
      broadcastEvent('workflow:deactivated', data);
    };
    this._runtime.on('flow:deactivated', onFlowDeactivated);
    this._listeners.push({ event: 'flow:deactivated', fn: onFlowDeactivated });

    // ── Step-level events (from taskflow-runtime FlowEngine) ──
    const stepEvents = [
      'step:start',
      'step:progress',
      'step:complete',
      'step:error',
      'step:skip',
      'step:approval_required',
      'flow:complete',
      'flow:error',
    ];

    for (const eventName of stepEvents) {
      const handler = (data) => {
        broadcastEvent('workflow:progress', {
          event: eventName,
          flowId: data.flowId,
          stepId: data.stepId || data.step,
          stepName: data.stepName || '',
          status: eventName.replace('step:', '').replace('flow:', ''),
          progress: data.progress,
          result: data.result ? String(data.result).substring(0, 200) : null,
          error: data.error || null,
          timestamp: Date.now(),
        });
        this.emit('progress', { eventName, data });
      };
      try { this._runtime.on(eventName, handler); } catch (_) { console.warn('[task-status-ws] Failed to register runtime event listener'); }
      this._listeners.push({ event: eventName, fn: handler });
    }

    // ── Listen to TaskFlowBridge for high-level flow events ──
    let bridge = null;
    try {
      const { taskflowBridge } = require('./taskflow-bridge');
      bridge = taskflowBridge;
    } catch (_) { console.warn('[task-status-ws] Failed to load taskflow-bridge'); }

    if (bridge) {
      const onFlowStarted = (data) => {
        broadcastEvent('workflow:started', data);
      };
      bridge.on('flow:started', onFlowStarted);
      this._listeners.push({ event: 'flow:started', fn: onFlowStarted, source: bridge });

      const onFlowCompleted = (data) => {
        broadcastEvent('workflow:complete', data);
      };
      bridge.on('flow:completed', onFlowCompleted);
      this._listeners.push({ event: 'flow:completed', fn: onFlowCompleted, source: bridge });

      const onFlowError = (data) => {
        broadcastEvent('workflow:error', data);
      };
      bridge.on('flow:error', onFlowError);
      this._listeners.push({ event: 'flow:error', fn: onFlowError, source: bridge });

      const onFlowCancelled = (data) => {
        broadcastEvent('workflow:cancelled', data);
      };
      bridge.on('flow:cancelled', onFlowCancelled);
      this._listeners.push({ event: 'flow:cancelled', fn: onFlowCancelled, source: bridge });
    }

    this._listening = true;
    console.log('[task-status-ws] Listening for workflow progress events');
  }

  /**
   * Stop listening and clean up
   */
  stop() {
    for (const { event, fn, source } of this._listeners) {
      try { (source || this._runtime).removeListener(event, fn); } catch (_) { console.warn('[task-status-ws] Failed to remove listener'); }
    }
    this._listeners = [];
    this._listening = false;
  }

  /**
   * Get client status
   */
  getStatus() {
    const { getSSEClientCount } = require('./sse-broadcast');
    return {
      listening: this._listening,
      listenerCount: this._listeners.length,
      sseClientCount: getSSEClientCount(),
    };
  }
}

// Singleton
const taskStatusWebSocket = new TaskStatusWebSocket();

module.exports = { TaskStatusWebSocket, taskStatusWebSocket };
