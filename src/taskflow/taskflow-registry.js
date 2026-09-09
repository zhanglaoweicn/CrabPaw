const crypto = require('crypto');
const { EventEmitter } = require('events');
const { getTaskFlowStore } = require('./taskflow-store');
const {
  TASKFLOW_SYNC_MODE,
  TASKFLOW_STATUS,
  TASKFLOW_NOTIFY_POLICY
} = require('./taskflow-types');

const LOST_FLOW_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const LOST_FLOW_THRESHOLD_MS = 10 * 60 * 1000;

class TaskFlowRegistry extends EventEmitter {
  constructor() {
    super();
    this.store = getTaskFlowStore();
    this.initialized = false;
    this._lostFlowCheckTimer = null;
    this._activeFlowSet = new Set();
  }

  async initialize() {
    if (this.initialized) return;

    await this.store.initialize();
    this.initialized = true;
    this._startLostFlowCheck();
    console.log('✅ TaskFlow Registry 初始化完成');
  }

  async createFlow(params) {
    await this._ensureInitialized();

    const flow = {
      flowId: this._generateFlowId(),
      syncMode: params.syncMode || TASKFLOW_SYNC_MODE.MANAGED,
      ownerKey: params.ownerKey || 'default',
      controllerId: params.controllerId || null,
      revision: 0,
      status: params.status || TASKFLOW_STATUS.QUEUED,
      notifyPolicy: params.notifyPolicy || TASKFLOW_NOTIFY_POLICY.ON_FAILURE,
      goal: params.goal || '',
      currentStep: params.currentStep || null,
      blockedTaskId: params.blockedTaskId || null,
      blockedSummary: params.blockedSummary || null,
      stateJson: params.stateJson || null,
      waitJson: params.waitJson || null,
      cancelRequestedAt: params.cancelRequestedAt || null,
      triggerType: params.triggerType || null,
      triggerConfig: params.triggerConfig || null,
      errorCategory: params.errorCategory || null,
      errorStrategy: params.errorStrategy || null,
      createdAt: params.createdAt || Date.now(),
      updatedAt: Date.now(),
      endedAt: params.endedAt || null
    };

    await this.store.saveFlow(flow);

    await this.store.addHistory(flow.flowId, 'created', {
      goal: flow.goal,
      ownerKey: flow.ownerKey,
      triggerType: flow.triggerType
    });

    this.emit('flow_created', { flowId: flow.flowId, flow });

    console.log(`📝 创建 TaskFlow: ${flow.flowId} - ${flow.goal}`);

    return flow;
  }

  async updateFlow(flowId, updates) {
    await this._ensureInitialized();

    const flow = await this.getFlow(flowId);
    if (!flow) {
      return { applied: false, reason: 'not_found' };
    }

    const newRevision = flow.revision + 1;
    const updatedFlow = {
      ...flow,
      ...updates,
      flowId,
      revision: newRevision,
      updatedAt: Date.now()
    };

    await this.store.saveFlow(updatedFlow);

    await this.store.addHistory(flowId, 'updated', {
      previousStatus: flow.status,
      newStatus: updatedFlow.status,
      revision: newRevision
    });

    this.emit('flow_updated', { flowId, previousFlow: flow, updatedFlow });

    return { applied: true, flow: updatedFlow };
  }

  async updateFlowWithExpectedRevision(flowId, updates, expectedRevision) {
    await this._ensureInitialized();

    const casResult = await this.store.casUpdateFlow(flowId, updates, expectedRevision);

    if (!casResult.applied) {
      const currentFlow = await this.getFlow(flowId);
      if (!currentFlow) {
        return { applied: false, reason: 'not_found' };
      }

      this.emit('flow_revision_conflict', {
        flowId,
        expectedRevision,
        actualRevision: currentFlow.revision
      });
      return { applied: false, reason: 'revision_conflict', current: currentFlow };
    }

    const updatedFlow = await this.getFlow(flowId);

    await this.store.addHistory(flowId, 'updated', {
      previousRevision: expectedRevision,
      newRevision: updatedFlow.revision,
      newStatus: updatedFlow.status
    });

    this.emit('flow_updated', { flowId, updatedFlow });

    return { applied: true, flow: updatedFlow };
  }

  async casUpdateFlow(flowId, updates, expectedRevision) {
    return await this.updateFlowWithExpectedRevision(flowId, updates, expectedRevision);
  }

  async getFlow(flowId) {
    await this._ensureInitialized();
    return await this.store.getFlow(flowId);
  }

  async listFlows(filter = {}) {
    await this._ensureInitialized();
    return await this.store.listFlows(filter);
  }

  async deleteFlow(flowId) {
    await this._ensureInitialized();

    const flow = await this.getFlow(flowId);
    if (!flow) {
      return { success: false, error: 'Flow not found' };
    }

    await this.store.addHistory(flowId, 'deleted', {
      goal: flow.goal,
      status: flow.status
    });

    await this.store.deleteFlow(flowId);

    this.emit('flow_deleted', { flowId, flow });

    console.log(`🗑️  删除 TaskFlow: ${flowId}`);

    return { success: true };
  }

  async setFlowWaiting(flowId, waitJson) {
    return await this.updateFlow(flowId, {
      status: TASKFLOW_STATUS.WAITING,
      waitJson
    });
  }

  async resumeFlow(flowId, stateJson = null) {
    const updates = {
      status: TASKFLOW_STATUS.RUNNING,
      waitJson: null
    };

    if (stateJson) {
      updates.stateJson = stateJson;
    }

    return await this.updateFlow(flowId, updates);
  }

  async blockFlow(flowId, blockedTaskId, blockedSummary) {
    return await this.updateFlow(flowId, {
      status: TASKFLOW_STATUS.BLOCKED,
      blockedTaskId,
      blockedSummary
    });
  }

  async unblockFlow(flowId) {
    return await this.updateFlow(flowId, {
      status: TASKFLOW_STATUS.RUNNING,
      blockedTaskId: null,
      blockedSummary: null
    });
  }

  async finishFlow(flowId) {
    this._activeFlowSet.delete(flowId);
    return await this.updateFlow(flowId, {
      status: TASKFLOW_STATUS.SUCCEEDED,
      endedAt: Date.now()
    });
  }

  async failFlow(flowId, error, errorCategory = null, errorStrategy = null) {
    this._activeFlowSet.delete(flowId);
    const updates = {
      status: TASKFLOW_STATUS.FAILED,
      endedAt: Date.now()
    };

    if (error) {
      updates.blockedSummary = typeof error === 'string' ? error : error.message;
    }

    if (errorCategory) {
      updates.errorCategory = errorCategory;
    }

    if (errorStrategy) {
      updates.errorStrategy = errorStrategy;
    }

    return await this.updateFlow(flowId, updates);
  }

  async requestFlowCancel(flowId) {
    return await this.updateFlow(flowId, {
      cancelRequestedAt: Date.now()
    });
  }

  async cancelFlow(flowId) {
    this._activeFlowSet.delete(flowId);
    return await this.updateFlow(flowId, {
      status: TASKFLOW_STATUS.CANCELLED,
      endedAt: Date.now()
    });
  }

  markFlowActive(flowId) {
    this._activeFlowSet.add(flowId);
  }

  markFlowInactive(flowId) {
    this._activeFlowSet.delete(flowId);
  }

  isFlowActive(flowId) {
    return this._activeFlowSet.has(flowId);
  }

  async detectLostFlows() {
    await this._ensureInitialized();

    const runningFlows = await this.listFlows({
      status: [TASKFLOW_STATUS.RUNNING, TASKFLOW_STATUS.QUEUED]
    });

    const lostFlows = [];
    const now = Date.now();

    for (const flow of runningFlows) {
      if (this._activeFlowSet.has(flow.flowId)) continue;

      const timeSinceUpdate = now - (flow.updatedAt || flow.createdAt);
      if (timeSinceUpdate > LOST_FLOW_THRESHOLD_MS) {
        lostFlows.push(flow);
      }
    }

    return lostFlows;
  }

  async markLostFlows() {
    const lostFlows = await this.detectLostFlows();

    for (const flow of lostFlows) {
      await this.updateFlow(flow.flowId, {
        status: TASKFLOW_STATUS.LOST
      });

      await this.store.addHistory(flow.flowId, 'marked_lost', {
        previousStatus: TASKFLOW_STATUS.RUNNING,
        lastUpdate: flow.updatedAt
      });

      this.emit('flow_lost', { flowId: flow.flowId, flow });
    }

    if (lostFlows.length > 0) {
      console.log(`⚠️ 标记 ${lostFlows.length} 个丢失的 TaskFlow`);
    }

    return lostFlows;
  }

  async recoverLostFlow(flowId) {
    await this._ensureInitialized();

    const flow = await this.getFlow(flowId);
    if (!flow || flow.status !== TASKFLOW_STATUS.LOST) {
      return { recovered: false, reason: 'not_lost' };
    }

    const result = await this.updateFlow(flowId, {
      status: TASKFLOW_STATUS.QUEUED
    });

    await this.store.addHistory(flowId, 'recovery_requested', {
      previousStatus: TASKFLOW_STATUS.LOST
    });

    this.emit('flow_recovery_requested', { flowId, flow });

    console.log(`🔄 请求恢复丢失的 TaskFlow: ${flowId}`);

    return { recovered: true, flow: result.flow };
  }

  async getFlowTasks(flowId) {
    await this._ensureInitialized();
    return await this.store.getTasksByFlow(flowId);
  }

  async getFlowHistory(flowId, limit = 100) {
    await this._ensureInitialized();
    return await this.store.getHistory(flowId, limit);
  }

  async getStats() {
    await this._ensureInitialized();
    return await this.store.getStats();
  }

  async cleanOldHistory(daysToKeep = 30) {
    await this._ensureInitialized();
    return await this.store.cleanOldHistory(daysToKeep);
  }

  _generateFlowId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString("hex").slice(0, 8);
    return `flow_${timestamp}_${random}`;
  }

  _startLostFlowCheck() {
    if (this._lostFlowCheckTimer) return;

    this._lostFlowCheckTimer = setInterval(async () => {
      try {
        await this.markLostFlows();
      } catch (e) {
        console.warn('⚠️ 丢失流程检测失败:', e.message);
      }
    }, LOST_FLOW_CHECK_INTERVAL_MS);

    if (this._lostFlowCheckTimer.unref) {
      this._lostFlowCheckTimer.unref();
    }
  }

  stopLostFlowCheck() {
    if (this._lostFlowCheckTimer) {
      clearInterval(this._lostFlowCheckTimer);
      this._lostFlowCheckTimer = null;
    }
  }

  async _ensureInitialized() {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  async close() {
    this.stopLostFlowCheck();
    await this.store.close();
    this.initialized = false;
  }
}

let registryInstance = null;

function getTaskFlowRegistry() {
  if (!registryInstance) {
    registryInstance = new TaskFlowRegistry();
  }
  return registryInstance;
}

module.exports = {
  TaskFlowRegistry,
  getTaskFlowRegistry
};
