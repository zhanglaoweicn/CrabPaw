/**
 * Activity State — AI 活动状态机
 *
 * 基于事件总线的实时状态推导。消费来自 Tool Orchestrator / LLM / TTS 的事件，
 * 推导出单一的 AI 活动状态，供终端 UI、Dashboard、HTTP API 消费。
 *
 * 状态定义：
 * idle — 空闲，等待用户输入
 * thinking — 模型正在推理/生成回复
 * tooling — 正在执行工具（read/write/bash/search 等）
 * speaking — TTS 正在播放语音
 * error — 当前操作出错
 *
 * 设计原则（voice-continuous.js 的 onFrame 状态机）：
 * - 单一状态来源，任何子系统不得直接覆盖 activity 状态
 * - 事件驱动，状态变化即时广播
 * - 每帧最多一次状态更新，无轮询
 */

const { EventEmitter } = require('events');

// ─── 状态枚举 ───
const STATES = {
 IDLE: 'idle', // ⚪ 空闲
 THINKING: 'thinking', // 🧠 推理中
 TOOLING: 'tooling', // 🔧 工具执行中
 SPEAKING: 'speaking', // 🔊 TTS 播放中
 ERROR: 'error', // ❌ 出错
};

// ─── 状态元信息（供 UI 渲染） ───
const STATE_META = {
 [STATES.IDLE]: { icon: '⚪', label: '空闲', color: 'gray' },
 [STATES.THINKING]: { icon: '🧠', label: '思考中', color: 'purple' },
 [STATES.TOOLING]: { icon: '🔧', label: '执行中', color: 'blue' },
 [STATES.SPEAKING]: { icon: '🔊', label: '说话中', color: 'cyan' },
 [STATES.ERROR]: { icon: '❌', label: '出错', color: 'red' },
};

// ─── 事件 → 状态映射规则 ───
// 优先级高的状态覆盖优先级低的，同优先级按最后事件胜出
const EVENT_STATE_MAP = {
 // LLM 事件
 'llm:start': STATES.THINKING,
 'llm:chunk': STATES.THINKING,
 'llm:end': STATES.IDLE,
 'llm:error': STATES.ERROR,

 // 工具事件
 'tool:preparing': STATES.TOOLING,
 'tool:executing': STATES.TOOLING,
 'tool:result': STATES.IDLE, // 单工具完成后回到等待态
 'tool:error': STATES.ERROR,

 // TTS 事件
 'tts:start': STATES.SPEAKING,
 'tts:chunk': STATES.SPEAKING,
 'tts:end': STATES.IDLE,
 'tts:error': STATES.ERROR,

 // 心跳 / 恢复
 'system:idle': STATES.IDLE,
 'system:error': STATES.ERROR,
 'system:reset': STATES.IDLE,
};

// ─── 状态优先级（数值越大优先级越高） ───
const STATE_PRIORITY = {
 [STATES.ERROR]: 100,
 [STATES.TOOLING]: 80,
 [STATES.SPEAKING]: 70,
 [STATES.THINKING]: 60,
 [STATES.IDLE]: 10,
};

class ActivityState extends EventEmitter {
 constructor() {
 super();
 this._current = STATES.IDLE;
 this._history = [];
 this._historyMax = 100;
 this._context = {}; // 当前状态的补充上下文（工具名、消息等）
 this._duration = 0; // 当前状态已持续时间(ms)
 this._enteredAt = Date.now();
 this._toolStack = []; // 嵌套工具调用栈
 }

 /** 获取当前状态 */
 get state() { return this._current; }

 /** 获取当前状态元信息 */
 get meta() { return STATE_META[this._current] || STATE_META[STATES.IDLE]; }

 /** 获取格式化单行状态摘要 */
 get summary() {
 const ctx = this._context.toolName
 ? ` (${this._context.toolName})`
 : this._context.message
 ? ` (${this._context.message})`
 : '';
 return `${this.meta.icon} ${this.meta.label}${ctx}`;
 }

 /** 获取状态历史 */
 get history() { return [...this._history]; }

 /** 获取持续时间 */
 get elapsed() { return Date.now() - this._enteredAt; }

 /**
 * 消费一个事件，推导状态
 * @param {string} eventName 事件名（如 'tool:executing'）
 * @param {object} payload 事件载荷
 * @returns {string} 当前状态
 */
 consume(eventName, payload = {}) {
 const targetState = EVENT_STATE_MAP[eventName];

 if (!targetState) return this._current;

 // Tool 事件的特殊处理：维护工具调用栈
 if (eventName === 'tool:preparing' || eventName === 'tool:executing') {
 this._toolStack.push(payload.toolName || 'unknown');
 this._context.toolName = payload.toolName || payload.tool || 'unknown';
 if (payload.description) this._context.message = payload.description;
 } else if (eventName === 'tool:result' || eventName === 'tool:error') {
 this._toolStack.pop();
 this._context.toolName = this._toolStack.length > 0
 ? this._toolStack[this._toolStack.length - 1]
 : undefined;
 }

 this._setState(targetState, payload);
 return this._current;
 }

 /**
 * 重置到空闲态
 */
 reset() {
 this._setState(STATES.IDLE, { message: 'reset' });
 this._toolStack = [];
 this._context = {};
 }

 /**
 * 获取状态机诊断信息
 */
 getDiagnostics() {
 return {
 current: this._current,
 elapsed: this.elapsed,
 toolStack: this._toolStack,
 context: this._context,
 historyCount: this._history.length,
 recentHistory: this._history.slice(-10),
 };
 }

 // ─── 内部 ───

 _setState(newState, payload = {}) {
 const previous = this._current;

 // 同状态只更新上下文，不触发额外事件
 if (newState === previous) {
 if (payload.toolName) this._context.toolName = payload.toolName;
 if (payload.message) this._context.message = payload.message;
 return;
 }

 // 检查优先级：低优先级状态不能覆盖高优先级（除非是结束事件）
 const isEndEvent = /:(end|result|error)$/.test(
 Object.keys(EVENT_STATE_MAP).find(k => EVENT_STATE_MAP[k] === newState) || ''
 );
 if (!isEndEvent && STATE_PRIORITY[previous] > STATE_PRIORITY[newState]) {
 return; // 低优先级不覆盖高优先级
 }

 const now = Date.now();
 const previousDuration = now - this._enteredAt;

 // 记录状态切换
 if (previous !== newState) {
 this._history.push({
 from: previous,
 to: newState,
 at: now,
 duration: previousDuration,
 context: { ...this._context },
 });
 if (this._history.length > this._historyMax) {
 this._history = this._history.slice(-this._historyMax);
 }
 }

 this._current = newState;
 this._enteredAt = now;
 this._duration = 0;

 if (payload.toolName) this._context.toolName = payload.toolName;
 if (payload.message) this._context.message = payload.message;

 this.emit('changed', {
 previous,
 current: newState,
 meta: STATE_META[newState],
 elapsed: previousDuration,
 context: { ...this._context },
 timestamp: now,
 });
 }
}

// ─── 全局单例 ───
const globalActivityState = new ActivityState();

module.exports = {
 ActivityState,
 globalActivityState,
 STATES,
 STATE_META,
 EVENT_STATE_MAP,
};
