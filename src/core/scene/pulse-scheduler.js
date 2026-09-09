'use strict';

/**
 * PulseScheduler — Agent 脉动调度器
 *
 * 核心理念:
 *   时间感 = 当前时间 + 脉动节奏 + 时间戳历史 + 任务方向 + 未来触发 + 可打断恢复
 *
 * 功能:
 *   1. 周期性脉动注入 — Agent 空闲时按节奏苏醒，维护记忆/检查提醒/推进任务
 *   2. 自适应调速 — 空闲慢 pulse，有任务快 pulse，用户消息立刻打断
 *   3. 状态感知 — 区分 user-message / pulse / reminder / task-resume
 *   4. 克制策略 — 无任务无提醒时，Agent 保持安静，不制造噪音
 *
 * 事件:
 *   'pulse' — { turnType: 'pulse', context: {...}, reason: 'idle'|'task'|'awakening' }
 *   'message' — 用户消息到达时通知
 *   'idle' — 进入空闲状态
 *   'busy' — 进入忙碌状态
 */

const { EventEmitter } = require('events');

// ── 节奏常量 ──────────────────────────────────────────────

const DEFAULT_INTERVALS = {
  idle: 10 * 60 * 1000,        // 空闲: 10 分钟
  active: 5 * 60 * 1000,        // 活跃(有近期对话): 5 分钟
  task: 60 * 1000,              // 有任务时: 60 秒
  awakening: 30 * 1000,         // 觉醒期: 30 秒
  fast: 30 * 1000,              // 快速(Agent自行调速): 30 秒
  min: 15 * 1000,               // 最小间隔(防止疯跑)
  max: 30 * 60 * 1000,          // 最大间隔
};

const AWAKENING_PULSE_COUNT = 8;
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;   // 活跃窗口: 30分钟内有对话

// ── PulseScheduler ─────────────────────────────────────────

class PulseScheduler extends EventEmitter {
  constructor(options = {}) {
    super();
    this.setMaxListeners(50);

    this._intervals = { ...DEFAULT_INTERVALS, ...options.intervals };

    this._timer = null;
    this._nextPulse = null;
    this._running = false;
    this._paused = false;
    this._destroyed = false;

    // 状态
    this._pulseCount = 0;
    this._lastUserMessage = 0;
    this._lastPulse = 0;
    this._lastActivity = Date.now();
    this._isBusy = false;
    this._currentInterval = this._intervals.idle;
    this._currentIntervalName = 'idle';

    // Agent 自调速（有边界）
    this._agentRequestedInterval = null;
    this._agentRequestedUntil = 0;
    this._agentRequestedReason = '';

    // 任务状态
    this._activeTask = null;
    this._taskStepCount = 0;
    this._taskCompletedSteps = 0;

    // 觉醒期
    this._isAwakening = true;
    this._awakeningPulse = 0;

    // 统计
    this._stats = {
      totalPulses: 0,
      idlePulses: 0,
      taskPulses: 0,
      awakeningPulses: 0,
      messages: 0,
      startTime: Date.now(),
    };

    console.log('[pulse] PulseScheduler initialized (intervals:', Object.entries(this._intervals).map(([k, v]) => `${k}=${v / 1000}s`).join(', '), ')');
  }

  // ── Public API ───────────────────────────────────────────

  /** 启动脉冲循环 */
  start() {
    if (this._running || this._destroyed) return;
    this._running = true;
    this._paused = false;
    this._stats.startTime = Date.now();
    this._lastActivity = Date.now();
    this._scheduleNext();
    console.log('[pulse] Scheduler started');
    this.emit('started');
  }

  /** 停止脉冲循环 */
  stop() {
    if (!this._running) return;
    this._running = false;
    this._clearTimer();
    console.log('[pulse] Scheduler stopped');
    this.emit('stopped');
  }

  /** 暂停（保持状态但不触发 pulse） */
  pause() {
    if (this._paused) return;
    this._paused = true;
    this._clearTimer();
  }

  /** 恢复 */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._scheduleNext();
  }

  /**
   * 通知有用户消息到达 → 立刻重新计算节奏
   */
  onUserMessage() {
    this._stats.messages++;
    this._lastUserMessage = Date.now();
    this._lastActivity = Date.now();
    this._clearTimer();
    this._recalcInterval();
    this._scheduleNext();
    this.emit('message', { time: Date.now() });
  }

  /**
   * 通知 Agent 进入忙碌（处理中）
   */
  onBusy() {
    this._isBusy = true;
    this._lastActivity = Date.now();
    this.emit('busy');
  }

  /**
   * 通知 Agent 空闲 → 重新计时
   */
  onIdle() {
    this._isBusy = false;
    this._lastActivity = Date.now();
    this._clearTimer();
    this._recalcInterval();
    this._scheduleNext();
    this.emit('idle');
  }

  /**
   * Agent 自调速: 请求接下来 N 轮使用指定间隔
   * 有严格边界: min≤interval≤max, maxRounds≤20
   *
   * @param {number} intervalMs 请求间隔(ms)
   * @param {number} [rounds=1] 持续轮数
   * @param {string} [reason=''] 原因
   */
  requestAgentInterval(intervalMs, rounds = 1, reason = '') {
    const clamped = Math.max(this._intervals.min, Math.min(this._intervals.max, Number(intervalMs) || this._intervals.active));
    const maxRounds = Math.min(20, Math.max(1, Number(rounds) || 1));

    this._agentRequestedInterval = clamped;
    this._agentRequestedUntil = this._pulseCount + maxRounds;
    this._agentRequestedReason = reason;

    this._clearTimer();
    this._recalcInterval();
    this._scheduleNext();

    console.log(`[pulse] Agent requested interval: ${clamped / 1000}s x${maxRounds} (reason: ${reason || 'unspecified'})`);
  }

  /**
   * 设置当前任务状态（影响节奏）
   */
  setTask(task) {
    this._activeTask = task;
    this._taskStepCount = task?.steps?.length || task?.totalSteps || 0;
    this._taskCompletedSteps = task?.completedSteps || 0;
    this._clearTimer();
    this._recalcInterval();
    this._scheduleNext();
  }

  /** 清除任务 */
  clearTask() {
    this._activeTask = null;
    this._clearTimer();
    this._recalcInterval();
    this._scheduleNext();
  }

  /**
   * 强制立刻触发一次 pulse（用于提醒到期等场景）
   */
  poke(reason = 'poke') {
    this._clearTimer();
    this._doPulse(reason);
  }

  /** 获取统计信息 */
  getStats() {
    const now = Date.now();
    return {
      ...this._stats,
      running: this._running,
      paused: this._paused,
      busy: this._isBusy,
      awakening: this._isAwakening && this._awakeningPulse < AWAKENING_PULSE_COUNT,
      pulseCount: this._pulseCount,
      interval: this._currentInterval,
      intervalName: this._currentIntervalName,
      activeTask: this._activeTask ? { id: this._activeTask.id, title: this._activeTask.title || 'untitled' } : null,
      lastUserMessage: this._lastUserMessage,
      lastPulse: this._lastPulse,
      lastActivity: this._lastActivity,
      uptime: now - this._stats.startTime,
      nextPulseIn: this._nextPulse ? this._nextPulse - now : null,
    };
  }

  /** 是否在觉醒期 */
  get isAwakening() {
    return this._isAwakening && this._awakeningPulse < AWAKENING_PULSE_COUNT;
  }

  /** 当前 pulse 序号 */
  get pulseCount() {
    return this._pulseCount;
  }

  // ── Internal ─────────────────────────────────────────────

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._nextPulse = null;
  }

  _scheduleNext() {
    if (!this._running || this._paused || this._isBusy || this._destroyed) return;

    this._recalcInterval();
    const delay = this._currentInterval;

    this._nextPulse = Date.now() + delay;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._isBusy) {
        // 忙碌中跳过，重新调度
        this._scheduleNext();
        return;
      }
      this._doPulse('schedule');
    }, delay);

    if (typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
  }

  _recalcInterval() {
    const now = Date.now();

    // 1. 觉醒期 → 快速 pulse
    if (this._isAwakening && this._awakeningPulse < AWAKENING_PULSE_COUNT) {
      this._currentInterval = this._intervals.awakening;
      this._currentIntervalName = 'awakening';
      return;
    }

    // 2. Agent 自调速 → 使用请求间隔(在有效期内)
    if (this._agentRequestedInterval && this._pulseCount < this._agentRequestedUntil) {
      this._currentInterval = this._agentRequestedInterval;
      this._currentIntervalName = 'agent';
      return;
    }
    // 过期清除
    if (this._agentRequestedInterval && this._pulseCount >= this._agentRequestedUntil) {
      this._agentRequestedInterval = null;
      this._agentRequestedUntil = 0;
    }

    // 3. 有活动任务 → task 节奏
    if (this._activeTask) {
      this._currentInterval = this._intervals.task;
      this._currentIntervalName = 'task';
      return;
    }

    // 4. 近期有用户消息(活跃窗口内) → active 节奏
    if (now - this._lastUserMessage < ACTIVE_WINDOW_MS) {
      this._currentInterval = this._intervals.active;
      this._currentIntervalName = 'active';
      return;
    }

    // 5. 默认 → idle 节奏
    this._currentInterval = this._intervals.idle;
    this._currentIntervalName = 'idle';
  }

  _doPulse(reason) {
    if (this._destroyed) return;
    if (this._isBusy) {
      // 跳过这次 pulse，等 onIdle 重新调度
      this._scheduleNext();
      return;
    }

    this._pulseCount++;
    this._lastPulse = Date.now();
    this._lastActivity = Date.now();
    this._stats.totalPulses++;

    // 觉醒期计数
    if (this._isAwakening) {
      this._awakeningPulse++;
      this._stats.awakeningPulses++;
      if (this._awakeningPulse >= AWAKENING_PULSE_COUNT) {
        this._isAwakening = false;
        console.log('[pulse] Awakening phase complete');
      }
    } else if (this._activeTask) {
      this._stats.taskPulses++;
    } else {
      this._stats.idlePulses++;
    }

    const turnType = this._isAwakening && this._awakeningPulse <= AWAKENING_PULSE_COUNT
      ? 'awakening'
      : this._activeTask
        ? 'task'
        : 'pulse';

    // 构建 pulse 上下文，注入 Agent
    const context = {
      turnType,
      pulseNumber: this._pulseCount,
      timestamp: Date.now(),
      reason,
      isAwakening: this._isAwakening && this._awakeningPulse < AWAKENING_PULSE_COUNT,
      awakeningProgress: this._isAwakening ? { current: this._awakeningPulse, total: AWAKENING_PULSE_COUNT } : null,
      activeTask: this._activeTask
        ? { id: this._activeTask.id, title: this._activeTask.title || 'untitled', stepCount: this._taskStepCount, completedSteps: this._taskCompletedSteps }
        : null,
      lastUserMessage: this._lastUserMessage,
      interval: this._currentInterval,
      intervalName: this._currentIntervalName,
    };

    this.emit('pulse', context);

    // 通过 SSE 广播 pulse 事件，让前端 ActivityStream 感知
    try {
      const { broadcastEvent } = require('../sse-broadcast');
      broadcastEvent('pulse', context);
    } catch (_) {
      /* SSE unavailable */
      console.warn('[pulse-scheduler.js] 空 catch 补日志:', _ && _.message);
    }


    // 调度下一次
    if (!this._isBusy) {
      this._scheduleNext();
    }
  }

  /** 销毁 */
  destroy() {
    this._destroyed = true;
    this._clearTimer();
    this._running = false;
    this.removeAllListeners();
    console.log('[pulse] Scheduler destroyed');
  }
}

// ── Singleton ──────────────────────────────────────────────

let _instance = null;

function getPulseScheduler(options) {
  if (!_instance) {
    _instance = new PulseScheduler(options);
  }
  return _instance;
}

function hasPulseScheduler() {
  return _instance !== null && !_instance._destroyed;
}

module.exports = {
  PulseScheduler,
  getPulseScheduler,
  hasPulseScheduler,
  DEFAULT_INTERVALS,
};
