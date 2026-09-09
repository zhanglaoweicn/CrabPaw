const { EventEmitter } = require('events');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { CRABPAW_HOME } = require('../path-utils');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const HEARTBEAT_FILE = 'HEARTBEAT.md';
const HEARTBEAT_STATE_FILE = 'heartbeat-state.json';

const AGENT_STATES = {
  IDLE: 'idle',
  THINKING: 'thinking',
  ACTING: 'acting',
  REFLECTING: 'reflecting',
};

class HeartbeatAgentLoop extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      intervalMs: config.intervalMs || DEFAULT_INTERVAL_MS,
      dataDir: config.dataDir || CRABPAW_HOME,
      enabled: config.enabled !== false,
      maxActionsPerBeat: config.maxActionsPerBeat || 5,
      reflectionInterval: config.reflectionInterval || 7,
    };

    this._timer = null;
    this._state = AGENT_STATES.IDLE;
    this._beatCount = 0;
    this._lastBeatTime = null;
    this._actionHistory = [];
    this._heartbeatTasks = [];
    this._stateData = this._loadState();
    this._aiClient = null;
    this._memorySystem = null;
  }

  setAIClient(client) {
    this._aiClient = client;
  }

  setMemorySystem(memorySystem) {
    this._memorySystem = memorySystem;
  }

  get state() {
    return this._state;
  }

  get beatCount() {
    return this._beatCount;
  }

  get lastBeatTime() {
    return this._lastBeatTime;
  }

  _loadState() {
    const statePath = path.join(this.config.dataDir, HEARTBEAT_STATE_FILE);
    try {
      if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      }
    } catch (e) {

      // ignore

      console.warn('[heartbeat-loop.js] 空 catch 补日志:', e && e.message);
    }

    return {
      lastMemoryMaintenance: 0,
      lastSkillReview: 0,
      lastProactiveCheck: 0,
      completedActions: 0,
      skippedBeats: 0,
    };
  }

  async _saveState() {
    const statePath = path.join(this.config.dataDir, HEARTBEAT_STATE_FILE);
    try {
      await fsPromises.mkdir(path.dirname(statePath), { recursive: true });
      await fsPromises.writeFile(statePath, JSON.stringify(this._stateData, null, 2), 'utf-8');
    } catch (e) {

      // ignore

      console.warn('[heartbeat-loop.js] 空 catch 补日志:', e && e.message);
    }

  }

  loadHeartbeatTasks() {
      const hbPath = path.join(this.config.dataDir, HEARTBEAT_FILE);
      try {
      if (fs.existsSync(hbPath)) {
      const content = fs.readFileSync(hbPath, 'utf-8');
      this._heartbeatTasks = this._parseHeartbeatFile(content);
      return this._heartbeatTasks;
      }
      } catch (e) {
        // ignore
        console.warn('[heartbeat-loop.js] 空 catch 补日志:', e && e.message);
      }


    this._heartbeatTasks = this._getDefaultTasks();
    this._saveHeartbeatFile();
    return this._heartbeatTasks;
  }

  _parseHeartbeatFile(content) {
    const tasks = [];
    const lines = content.split('\n');
    for (const line of lines) {
      const checkedMatch = line.match(/^[-*]\s*\[x\]\s*(.+)/i);
      const uncheckedMatch = line.match(/^[-*]\s*\[\s*\]\s*(.+)/);
      if (checkedMatch) {
        tasks.push({ text: checkedMatch[1].trim(), completed: true });
      } else if (uncheckedMatch) {
        tasks.push({ text: uncheckedMatch[1].trim(), completed: false });
      }
    }
    return tasks.length > 0 ? tasks : this._getDefaultTasks();
  }

  _getDefaultTasks() {
    return [
      { text: '检查未完成的待办任务', completed: false },
      { text: '审查近期记忆质量', completed: false },
      { text: '检查定时任务执行状态', completed: false },
      { text: '整理和归档过期记忆', completed: false },
    ];
  }

  async _saveHeartbeatFile() {
    const hbPath = path.join(this.config.dataDir, HEARTBEAT_FILE);
    const lines = [
      '# Heartbeat 任务清单',
      '',
      '> 智能体在每次心跳时自动检查以下任务',
      '> 修改此文件可自定义智能体的主动行为',
      '',
    ];
    for (const task of this._heartbeatTasks) {
      const check = task.completed ? '[x]' : '[ ]';
      lines.push(`- ${check} ${task.text}`);
    }
    lines.push('');
    try {
      await fsPromises.mkdir(path.dirname(hbPath), { recursive: true });
      await fsPromises.writeFile(hbPath, lines.join('\n'), 'utf-8');
    } catch (e) {

      // ignore

      console.warn('[heartbeat-loop.js] 空 catch 补日志:', e && e.message);
    }

  }

  start() {
    if (!this.config.enabled) {
      console.log('💓 Heartbeat 主动循环已禁用');
      return;
    }

    if (this._timer) return;

    this.loadHeartbeatTasks();

    const delay = Math.random() * 30000;
    setTimeout(() => {
      this._runBeat().catch(e => {
        console.warn('💓 Heartbeat 首次执行失败:', e.message);
      });

      this._timer = setInterval(() => {
        this._runBeat().catch(e => {
          console.warn('💓 Heartbeat 执行失败:', e.message);
        });
      }, this.config.intervalMs);

      if (this._timer.unref) {
        this._timer.unref();
      }
    }, delay);

    console.log(`💓 Heartbeat 主动循环已启动 (间隔: ${this.config.intervalMs / 1000}s)`);
    this.emit('started');
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._state = AGENT_STATES.IDLE;
    console.log('💓 Heartbeat 主动循环已停止');
    this.emit('stopped');
  }

  async _runBeat() {
    this._beatCount++;
    this._lastBeatTime = Date.now();
    const beatId = `beat_${this._beatCount}`;

    this.emit('beat:start', { beatId, beatCount: this._beatCount });

    try {
      await this._phaseObserve(beatId);
      await this._phaseThink(beatId);
      await this._phaseAct(beatId);
      await this._phaseReflect(beatId);
    } catch (e) {
      this.emit('beat:error', { beatId, error: e.message });
    }

    this._state = AGENT_STATES.IDLE;
    this.emit('beat:complete', { beatId, beatCount: this._beatCount });
  }

  async _phaseObserve(beatId) {
    this._state = AGENT_STATES.THINKING;
    this.emit('beat:phase', { beatId, phase: 'observe' });

    const observations = {
      pendingTasks: [],
      memoryHealth: null,
      schedulerStatus: null,
      recentActivity: [],
    };

    if (this._memorySystem) {
      try {
        observations.memoryHealth = await this._checkMemoryHealth();
      } catch (e) {
        observations.memoryHealth = { status: 'error', detail: e.message };
      }
    }

    try {
      const { globalHeartbeatPatrol } = require('../heartbeat-patrol');
      const patrolStatus = globalHeartbeatPatrol.getStatus();
      observations.systemHealth = patrolStatus.overallStatus;
    } catch (e) {

      // ignore

      console.warn('[heartbeat-loop.js] 空 catch 补日志:', e && e.message);
    }


    this._currentObservations = observations;
    this.emit('beat:observed', { beatId, observations });
    return observations;
  }

  async _phaseThink(beatId) {
    this._state = AGENT_STATES.THINKING;
    this.emit('beat:phase', { beatId, phase: 'think' });

    const actions = [];

    if (this._memorySystem) {
      const now = Date.now();
      const daysSinceMaintenance = (now - this._stateData.lastMemoryMaintenance) / (24 * 60 * 60 * 1000);
      if (daysSinceMaintenance >= this.config.reflectionInterval) {
        actions.push({ type: 'memory_maintenance', priority: 'high' });
      }

      if (this._currentObservations?.memoryHealth?.status === 'degraded') {
        actions.push({ type: 'memory_cleanup', priority: 'critical' });
      }
    }

    for (const task of this._heartbeatTasks) {
      if (!task.completed) {
        actions.push({ type: 'heartbeat_task', task: task.text, priority: 'medium' });
      }
    }

    actions.sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3);
    });

    this._currentActions = actions.slice(0, this.config.maxActionsPerBeat);
    this.emit('beat:planned', { beatId, actions: this._currentActions });
    return this._currentActions;
  }

  async _phaseAct(beatId) {
    this._state = AGENT_STATES.ACTING;
    this.emit('beat:phase', { beatId, phase: 'act' });

    const results = [];

    for (const action of this._currentActions) {
      try {
        const result = await this._executeAction(action);
        results.push({ action, result, success: true });
        this._actionHistory.push({
          beatId,
          action: action.type,
          result,
          timestamp: Date.now(),
          success: true,
        });
      } catch (e) {
        results.push({ action, error: e.message, success: false });
        this._actionHistory.push({
          beatId,
          action: action.type,
          error: e.message,
          timestamp: Date.now(),
          success: false,
        });
      }
    }

    if (this._actionHistory.length > 200) {
      this._actionHistory = this._actionHistory.slice(-200);
    }

    this.emit('beat:acted', { beatId, results });
    return results;
  }

  async _phaseReflect(beatId) {
    this._state = AGENT_STATES.REFLECTING;
    this.emit('beat:phase', { beatId, phase: 'reflect' });

    const reflection = {
      beatId,
      beatCount: this._beatCount,
      actionsTaken: this._currentActions?.length || 0,
      successfulActions: this._actionHistory.filter(a => a.beatId === beatId && a.success).length,
      failedActions: this._actionHistory.filter(a => a.beatId === beatId && !a.success).length,
      timestamp: Date.now(),
    };

    this._stateData.completedActions += reflection.successfulActions;
    await this._saveState();

    this.emit('beat:reflected', { beatId, reflection });
    return reflection;
  }

  async _executeAction(action) {
    switch (action.type) {
      case 'memory_maintenance':
        return await this._executeMemoryMaintenance();
      case 'memory_cleanup':
        return await this._executeMemoryCleanup();
      case 'heartbeat_task':
        return await this._executeHeartbeatTask(action.task);
      default:
        return { status: 'skipped', reason: 'unknown_action_type' };
    }
  }

  async _executeMemoryMaintenance() {
    if (!this._memorySystem) return { status: 'skipped', reason: 'no_memory_system' };

    const results = {};

    try {
      if (typeof this._memorySystem.triggerDream === 'function') {
        results.dream = await this._memorySystem.triggerDream();
      }
    } catch (e) {
      results.dreamError = e.message;
    }

    try {
      if (typeof this._memorySystem.runArchiveCycle === 'function') {
        results.archive = await this._memorySystem.runArchiveCycle();
      } else if (this._memorySystem.memoryArchiver && typeof this._memorySystem.memoryArchiver.runArchiveCycle === 'function') {
        results.archive = await this._memorySystem.memoryArchiver.runArchiveCycle();
      }
    } catch (e) {
      results.archiveError = e.message;
    }

    this._stateData.lastMemoryMaintenance = Date.now();
    await this._saveState();

    return { status: 'completed', results };
  }

  async _executeMemoryCleanup() {
    if (!this._memorySystem) return { status: 'skipped', reason: 'no_memory_system' };

    const results = {};

    try {
      if (typeof this._memorySystem.cleanLowTrust === 'function') {
        results.cleanLowTrust = await this._memorySystem.cleanLowTrust();
      }
    } catch (e) {
      results.cleanError = e.message;
    }

    return { status: 'completed', results };
  }

  async _executeHeartbeatTask(taskText) {
    if (!this._aiClient) {
      const taskIndex = this._heartbeatTasks.findIndex(t => t.text === taskText);
      if (taskIndex !== -1) {
        this._heartbeatTasks[taskIndex].completed = true;
        await this._saveHeartbeatFile();
      }
      return { status: 'marked_complete', task: taskText };
    }

    try {
      const prompt = `你是一个主动式AI助手的心跳循环。当前任务是: "${taskText}"。
请简要分析是否需要执行操作，如果需要，给出具体建议。如果不需要，回复 NOOP。

当前时间: ${new Date().toLocaleString('zh-CN')}
记忆系统状态: ${this._currentObservations?.memoryHealth?.status || 'unknown'}`;

      const response = await this._aiClient.chat([{ role: 'user', content: prompt }], { userId: 'heartbeat' });
      const needsAction = response && !response.toLowerCase().includes('noop');

      if (needsAction) {
        this.emit('heartbeat:action_suggested', { task: taskText, suggestion: response });
      }

      return { status: 'analyzed', task: taskText, needsAction, suggestion: response };
    } catch (e) {
      return { status: 'error', task: taskText, error: e.message };
    }
  }

  async _checkMemoryHealth() {
    if (!this._memorySystem) return { status: 'unknown' };

    try {
      const stats = typeof this._memorySystem.getStats === 'function'
        ? await this._memorySystem.getStats()
        : null;

      if (!stats) return { status: 'unknown' };

      const totalFacts = stats.notebook?.enhancedFactCount || stats.notebook?.totalMemories || 0;
      const entityCount = stats.notebook?.enhancedEntityCount || stats.sessions?.active || 0;

      let status = 'healthy';
      if (totalFacts > 10000) status = 'degraded';
      if (totalFacts > 50000) status = 'critical';

      return {
        status,
        totalFacts,
        entityCount,
        sessions: stats.sessions,
      };
    } catch (e) {
      return { status: 'error', detail: e.message };
    }
  }

  getStatus() {
    return {
      running: !!this._timer,
      enabled: this.config.enabled,
      state: this._state,
      beatCount: this._beatCount,
      lastBeatTime: this._lastBeatTime,
      intervalMs: this.config.intervalMs,
      pendingTasks: this._heartbeatTasks.filter(t => !t.completed).length,
      totalTasks: this._heartbeatTasks.length,
      recentActions: this._actionHistory.slice(-10),
    };
  }

  getHistory(limit = 20) {
    return this._actionHistory.slice(-limit);
  }
}

const globalHeartbeatLoop = new HeartbeatAgentLoop();

module.exports = {
  HeartbeatAgentLoop,
  globalHeartbeatLoop,
  AGENT_STATES,
  DEFAULT_INTERVAL_MS,
};
