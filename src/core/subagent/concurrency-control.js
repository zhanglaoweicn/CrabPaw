const crypto = require('crypto');
/**
 * SubAgent Concurrency Control - 子代理并发控制器
 * 
 * 解决问题：
 * - 缺乏并发控制：多任务同时访问资源
 * - 缺乏防递归：子代理可能递归调用
 * - 缺乏任务协调：各自独立执行
 * 
 * 功能：
 * - 资源锁机制：防止并发冲突
 * - 递归检测：防止无限嵌套
 * - 任务协调：依赖管理和优先级队列
 * - 通信总线：子代理间通信
 */

const { EventEmitter } = require('events');

const MAX_DEPTH = 3;
const MAX_CONCURRENT = 5;
const DEFAULT_TIMEOUT = 120000;
const LOCK_TIMEOUT = 30000;

class ResourceLock {
  constructor(name, timeout = LOCK_TIMEOUT) {
    this.name = name;
    this.timeout = timeout;
    this._locked = false;
    this._owner = null;
    this._queue = [];
    this._acquiredAt = null;
  }

  async acquire(ownerId) {
    if (!this._locked) {
      this._locked = true;
      this._owner = ownerId;
      this._acquiredAt = Date.now();
      return true;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this._queue.findIndex(q => q.ownerId === ownerId);
        if (index >= 0) {
          this._queue.splice(index, 1);
          reject(new Error(`获取锁 ${this.name} 超时`));
        }
      }, this.timeout);

      this._queue.push({
        ownerId,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  release(ownerId) {
    if (this._owner !== ownerId) {
      return false;
    }

    this._locked = false;
    this._owner = null;
    this._acquiredAt = null;

    if (this._queue.length > 0) {
      const next = this._queue.shift();
      this._locked = true;
      this._owner = next.ownerId;
      this._acquiredAt = Date.now();
      next.resolve(true);
    }

    return true;
  }

  isLocked() {
    return this._locked;
  }

  getOwner() {
    return this._owner;
  }

  getQueueLength() {
    return this._queue.length;
  }
}

class LockManager {
  constructor() {
    this._locks = new Map();
    this._ownerLocks = new Map();
    this._waitGraph = new Map();
  }

  _detectDeadlock(ownerId, resourceId) {
    const waitingFor = this._locks.get(resourceId)?.getOwner();
    if (!waitingFor || waitingFor === ownerId) return false;

    this._waitGraph.set(ownerId, waitingFor);

    let current = waitingFor;
    const visited = new Set();
    while (current) {
      if (current === ownerId) {
        this._waitGraph.delete(ownerId);
        return true;
      }
      if (visited.has(current)) break;
      visited.add(current);
      current = this._waitGraph.get(current);
    }
    return false;
  }

  getLock(resourceId) {
    if (!this._locks.has(resourceId)) {
      this._locks.set(resourceId, new ResourceLock(resourceId));
    }
    return this._locks.get(resourceId);
  }

  async acquire(resourceId, ownerId) {
    if (this._detectDeadlock(ownerId, resourceId)) {
      this._waitGraph.delete(ownerId);
      throw new Error(`检测到死锁: ${ownerId} ↔ ${resourceId}，已拒绝获取锁请求`);
    }

    const lock = this.getLock(resourceId);
    const acquired = await lock.acquire(ownerId);

    if (acquired) {
      this._waitGraph.delete(ownerId);
      if (!this._ownerLocks.has(ownerId)) {
        this._ownerLocks.set(ownerId, new Set());
      }
      this._ownerLocks.get(ownerId).add(resourceId);
    }

    return acquired;
  }

  release(resourceId, ownerId) {
    const lock = this._locks.get(resourceId);
    if (!lock) return false;

    const released = lock.release(ownerId);

    if (released && this._ownerLocks.has(ownerId)) {
      this._ownerLocks.get(ownerId).delete(resourceId);
    }

    return released;
  }

  releaseAll(ownerId) {
    const resources = this._ownerLocks.get(ownerId);
    if (!resources) return;

    for (const resourceId of resources) {
      const lock = this._locks.get(resourceId);
      if (lock) {
        lock.release(ownerId);
      }
    }

    this._ownerLocks.delete(ownerId);
  }

  getStats() {
    const stats = {
      totalLocks: this._locks.size,
      lockedResources: [],
      totalOwners: this._ownerLocks.size,
    };

    for (const [resourceId, lock] of this._locks) {
      if (lock.isLocked()) {
        stats.lockedResources.push({
          resourceId,
          owner: lock.getOwner(),
          queueLength: lock.getQueueLength(),
        });
      }
    }

    return stats;
  }
}

class RecursionDetector {
  constructor(maxDepth = MAX_DEPTH) {
    this._maxDepth = maxDepth;
    this._callStack = new Map();
    this._callHistory = [];
  }

  pushCall(agentId, parentId = null) {
    const depth = this._getDepth(parentId);

    if (depth >= this._maxDepth) {
      throw new Error(`递归深度超过限制: ${depth} >= ${this._maxDepth}`);
    }

    if (!this._callStack.has(agentId)) {
      this._callStack.set(agentId, {
        parentId,
        depth,
        children: new Set(),
        startedAt: Date.now(),
      });
    }

    if (parentId && this._callStack.has(parentId)) {
      this._callStack.get(parentId).children.add(agentId);
    }

    this._callHistory.push({
      agentId,
      parentId,
      depth,
      timestamp: Date.now(),
    });

    return depth;
  }

  popCall(agentId) {
    const info = this._callStack.get(agentId);
    if (!info) return;

    if (info.parentId && this._callStack.has(info.parentId)) {
      this._callStack.get(info.parentId).children.delete(agentId);
    }

    this._callStack.delete(agentId);
  }

  _getDepth(parentId) {
    if (!parentId) return 0;

    let depth = 0;
    let current = parentId;

    while (current && depth < this._maxDepth + 1) {
      const info = this._callStack.get(current);
      if (!info) break;

      depth++;
      current = info.parentId;
    }

    return depth;
  }

  getDepth(agentId) {
    const info = this._callStack.get(agentId);
    return info ? info.depth : 0;
  }

  getCallChain(agentId) {
    const chain = [agentId];
    let current = agentId;

    while (current) {
      const info = this._callStack.get(current);
      if (!info || !info.parentId) break;

      chain.unshift(info.parentId);
      current = info.parentId;
    }

    return chain;
  }

  detectCycle(agentId) {
    const chain = this.getCallChain(agentId);
    const seen = new Set();

    for (const id of chain) {
      if (seen.has(id)) {
        return true;
      }
      seen.add(id);
    }

    return false;
  }

  getStats() {
    return {
      maxDepth: this._maxDepth,
      activeCalls: this._callStack.size,
      historyLength: this._callHistory.length,
    };
  }
}

class TaskCoordinator extends EventEmitter {
  constructor(config = {}) {
    super();
    this.maxConcurrent = config.maxConcurrent || MAX_CONCURRENT;
    this.defaultTimeout = config.defaultTimeout || DEFAULT_TIMEOUT;
    
    this._activeTasks = new Map();
    this._pendingQueue = [];
    this._completedTasks = [];
    this._dependencies = new Map();
    this._lockManager = new LockManager();
    this._recursionDetector = new RecursionDetector(config.maxDepth);
  }

  async submitTask(task) {
    const taskId = task.id || `task_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;

    const enrichedTask = {
      ...task,
      id: taskId,
      submittedAt: Date.now(),
      status: 'pending',
      priority: task.priority || 0,
      dependencies: task.dependencies || [],
      requiredResources: task.requiredResources || [],
    };

    if (enrichedTask.dependencies.length > 0) {
      this._dependencies.set(taskId, {
        task: enrichedTask,
        waitingFor: new Set(enrichedTask.dependencies),
      });
      
      this._checkDependencies();
      return taskId;
    }

    if (this._activeTasks.size >= this.maxConcurrent) {
      this._pendingQueue.push(enrichedTask);
      this._sortQueue();
      return taskId;
    }

    await this._startTask(enrichedTask);
    return taskId;
  }

  _sortQueue() {
    this._pendingQueue.sort((a, b) => b.priority - a.priority);
  }

  _checkDependencies() {
    for (const [taskId, depInfo] of this._dependencies) {
      const completed = [...depInfo.waitingFor].filter(depId => 
        this._completedTasks.some(t => t.id === depId)
      );

      for (const depId of completed) {
        depInfo.waitingFor.delete(depId);
      }

      if (depInfo.waitingFor.size === 0) {
        this._dependencies.delete(taskId);

        if (this._activeTasks.size >= this.maxConcurrent) {
          this._pendingQueue.push(depInfo.task);
          this._sortQueue();
        } else {
          this._startTask(depInfo.task);
        }
      }
    }
  }

  async _startTask(task) {
    const agentId = task.id;
    const parentId = task.parentId || null;

    try {
      this._recursionDetector.pushCall(agentId, parentId);
    } catch (e) {
      this.emit('task:rejected', { taskId: agentId, reason: e.message });
      throw e;
    }

    for (const resource of task.requiredResources) {
      await this._lockManager.acquire(resource, agentId);
    }

    task.status = 'running';
    task.startedAt = Date.now();
    this._activeTasks.set(agentId, task);

    this.emit('task:started', { taskId: agentId, task });

    const timeout = task.timeout || this.defaultTimeout;
    const timer = setTimeout(() => {
      this._handleTimeout(agentId);
    }, timeout);

    task._timer = timer;
  }

  _handleTimeout(taskId) {
    const task = this._activeTasks.get(taskId);
    if (!task || task.status !== 'running') return;

    task.status = 'timeout';
    task.error = new Error(`任务超时 (${task.timeout || this.defaultTimeout}ms)`);
    task.completedAt = Date.now();

    this._completeTask(taskId, false);
  }

  async completeTask(taskId, result) {
    const task = this._activeTasks.get(taskId);
    if (!task) return;

    if (task._timer) {
      clearTimeout(task._timer);
    }

    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();

    this._completeTask(taskId, true);
  }

  failTask(taskId, error) {
    const task = this._activeTasks.get(taskId);
    if (!task) return;

    if (task._timer) {
      clearTimeout(task._timer);
    }

    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();

    this._completeTask(taskId, false);
  }

  _completeTask(taskId, success) {
    const task = this._activeTasks.get(taskId);
    if (!task) return;

    this._lockManager.releaseAll(taskId);
    this._recursionDetector.popCall(taskId);

    this._activeTasks.delete(taskId);
    this._completedTasks.push(task);

    if (this._completedTasks.length > 100) {
      this._completedTasks = this._completedTasks.slice(-100);
    }

    this.emit(success ? 'task:completed' : 'task:failed', { taskId, task });

    this._checkDependencies();

    if (this._pendingQueue.length > 0 && this._activeTasks.size < this.maxConcurrent) {
      const nextTask = this._pendingQueue.shift();
      this._startTask(nextTask);
    }
  }

  cancelTask(taskId) {
    const task = this._activeTasks.get(taskId);
    if (!task) return false;

    if (task._timer) {
      clearTimeout(task._timer);
    }

    task.status = 'cancelled';
    task.completedAt = Date.now();

    this._completeTask(taskId, false);
    return true;
  }

  getTaskStatus(taskId) {
    const active = this._activeTasks.get(taskId);
    if (active) return active;

    const completed = this._completedTasks.find(t => t.id === taskId);
    if (completed) return completed;

    const pending = this._pendingQueue.find(t => t.id === taskId);
    if (pending) return pending;

    const depInfo = this._dependencies.get(taskId);
    if (depInfo) return { ...depInfo.task, status: 'waiting_dependencies' };

    return null;
  }

  getStats() {
    return {
      active: this._activeTasks.size,
      pending: this._pendingQueue.length,
      completed: this._completedTasks.length,
      waitingDependencies: this._dependencies.size,
      maxConcurrent: this.maxConcurrent,
      locks: this._lockManager.getStats(),
      recursion: this._recursionDetector.getStats(),
    };
  }
}

class MessageBus extends EventEmitter {
  constructor() {
    super();
    this._channels = new Map();
    this._subscribers = new Map();
    this._messageHistory = [];
    this._maxHistory = 1000;
  }

  subscribe(agentId, channel, callback) {
    const key = `${channel}:${agentId}`;

    if (!this._channels.has(channel)) {
      this._channels.set(channel, new Set());
    }
    this._channels.get(channel).add(agentId);

    if (!this._subscribers.has(agentId)) {
      this._subscribers.set(agentId, new Map());
    }
    this._subscribers.get(agentId).set(channel, callback);

    this.on(key, callback);

    return () => this.unsubscribe(agentId, channel);
  }

  unsubscribe(agentId, channel) {
    const key = `${channel}:${agentId}`;

    this.off(key, this._subscribers.get(agentId)?.get(channel));

    if (this._channels.has(channel)) {
      this._channels.get(channel).delete(agentId);
    }

    if (this._subscribers.has(agentId)) {
      this._subscribers.get(agentId).delete(channel);
    }
  }

  publish(channel, message, fromAgentId = null) {
    const subscribers = this._channels.get(channel);
    if (!subscribers || subscribers.size === 0) return;

    const enrichedMessage = {
      ...message,
      channel,
      fromAgentId,
      timestamp: Date.now(),
    };

    this._messageHistory.push(enrichedMessage);
    if (this._messageHistory.length > this._maxHistory) {
      this._messageHistory = this._messageHistory.slice(-this._maxHistory);
    }

    for (const agentId of subscribers) {
      if (agentId !== fromAgentId) {
        this.emit(`${channel}:${agentId}`, enrichedMessage);
      }
    }
  }

  sendTo(targetAgentId, message, fromAgentId = null) {
    const enrichedMessage = {
      ...message,
      targetAgentId,
      fromAgentId,
      timestamp: Date.now(),
      direct: true,
    };

    this._messageHistory.push(enrichedMessage);
    this.emit(`direct:${targetAgentId}`, enrichedMessage);
  }

  getHistory(channel = null, limit = 100) {
    let history = this._messageHistory;

    if (channel) {
      history = history.filter(m => m.channel === channel);
    }

    return history.slice(-limit);
  }

  getStats() {
    return {
      channels: this._channels.size,
      subscribers: this._subscribers.size,
      historyLength: this._messageHistory.length,
    };
  }
}

class SubAgentConcurrencyManager {
  constructor(config = {}) {
    this.coordinator = new TaskCoordinator(config);
    this.messageBus = new MessageBus();
    this._agentRegistry = new Map();
  }

  registerAgent(agentId, config = {}) {
    this._agentRegistry.set(agentId, {
      id: agentId,
      config,
      registeredAt: Date.now(),
      status: 'idle',
    });

    this.coordinator.emit('agent:registered', { agentId });
  }

  unregisterAgent(agentId) {
    this._agentRegistry.delete(agentId);
    this.coordinator._lockManager.releaseAll(agentId);

    this.coordinator.emit('agent:unregistered', { agentId });
  }

  async executeTask(task) {
    return this.coordinator.submitTask(task);
  }

  getTaskStatus(taskId) {
    return this.coordinator.getTaskStatus(taskId);
  }

  subscribe(agentId, channel, callback) {
    return this.messageBus.subscribe(agentId, channel, callback);
  }

  publish(channel, message, fromAgentId) {
    this.messageBus.publish(channel, message, fromAgentId);
  }

  sendTo(targetAgentId, message, fromAgentId) {
    this.messageBus.sendTo(targetAgentId, message, fromAgentId);
  }

  getStats() {
    return {
      coordinator: this.coordinator.getStats(),
      messageBus: this.messageBus.getStats(),
      agents: this._agentRegistry.size,
    };
  }
}

const CommandLane = {
  Main: 'main',
  Cron: 'cron',
  CronNested: 'cron-nested',
  Subagent: 'subagent',
  Nested: 'nested',
};

class LaneManager {
  constructor(config = {}) {
    this._maxConcurrent = {
      main: config.mainConcurrency || 3,
      cron: config.cronConcurrency || 2,
      'cron-nested': config.cronNestedConcurrency || 1,
      subagent: config.subagentConcurrency || 4,
      nested: config.nestedConcurrency || 2,
    };
    this._running = new Map();
    this._queue = new Map();
    for (const lane of Object.keys(this._maxConcurrent)) {
      this._running.set(lane, new Set());
      this._queue.set(lane, []);
    }
  }

  resolveLane(context = {}) {
    const { isCron, isSubagent, isNested, sessionKey } = context;
    if (isCron && isNested) return CommandLane.CronNested;
    if (isCron) return CommandLane.Cron;
    if (isSubagent) return CommandLane.Subagent;
    if (isNested) {
      if (sessionKey) return `${CommandLane.Nested}:${sessionKey}`;
      return CommandLane.Nested;
    }
    return CommandLane.Main;
  }

  async acquire(lane, taskId) {
    const baseLane = this._getBaseLane(lane);
    if (!this._running.has(baseLane)) {
      this._running.set(baseLane, new Set());
      this._queue.set(baseLane, []);
      this._maxConcurrent[baseLane] = this._maxConcurrent.nested || 2;
    }

    if (this._running.get(baseLane).size < this._maxConcurrent[baseLane]) {
      this._running.get(baseLane).add(taskId);
      return true;
    }

    return new Promise((resolve) => {
      this._queue.get(baseLane).push({ taskId, resolve });
    });
  }

  release(lane, taskId) {
    const baseLane = this._getBaseLane(lane);
    const running = this._running.get(baseLane);
    if (!running) return;
    running.delete(taskId);

    const queue = this._queue.get(baseLane);
    if (queue && queue.length > 0 && running.size < (this._maxConcurrent[baseLane] || 2)) {
      const next = queue.shift();
      running.add(next.taskId);
      next.resolve(true);
    }
  }

  _getBaseLane(lane) {
    if (!lane) return CommandLane.Main;
    if (lane.startsWith(`${CommandLane.Nested}:`)) return lane;
    return lane;
  }

  getStats() {
    const stats = {};
    for (const [lane, running] of this._running) {
      stats[lane] = {
        running: running.size,
        max: this._maxConcurrent[lane] || 0,
        queued: this._queue.get(lane)?.length || 0,
      };
    }
    return stats;
  }
}

module.exports = {
  ResourceLock,
  LockManager,
  RecursionDetector,
  TaskCoordinator,
  MessageBus,
  SubAgentConcurrencyManager,
  LaneManager,
  CommandLane,
  MAX_DEPTH,
  MAX_CONCURRENT,
  DEFAULT_TIMEOUT,
};
