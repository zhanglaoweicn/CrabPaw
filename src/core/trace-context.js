/**
 * Trace Context Manager — 集中式 traceId 管理
 *
 * 使用 AsyncLocalStorage 在异步调用链中自动传播 traceId，
 * 消除各子系统各自生成 traceId 的碎片化问题。
 *
 * 用法:
 *   const { globalTraceContext } = require('./trace-context');
 *
 *   // 在入口点设置根 traceId
 *   globalTraceContext.setRootTraceId();
 *
 *   // 在异步上下文中自动获取
 *   const traceId = globalTraceContext.getTraceId();
 *
 *   // 生成子 traceId（保持 parent 前缀）
 *   const childId = globalTraceContext.createChildTraceId();
 */

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

class TraceContextManager {
  constructor() {
    this._als = new AsyncLocalStorage();
    this._fallbackTraceId = null;
  }

  /**
   * 在指定的 trace 上下文中执行异步函数
   * @param {string} [traceId] — 未提供时自动生成
   * @param {Function} fn — 要执行的异步函数
   * @returns {Promise<any>}
   */
  run(traceId, fn) {
    const effectiveTraceId = traceId || this._generateId();
    return this._als.run({ traceId: effectiveTraceId }, fn);
  }

  /**
   * C2(Runtime差距分析): 以 run 上下文执行异步函数——traceId 自动生成/复用,
   * runId 随 AsyncLocalStorage 传播,工具执行内的审计条目自动关联本次 run。
   * @param {string} runId
   * @param {Function} fn
   */
  runWithRunId(runId, fn) {
    const traceId = this.getTraceId() || this._generateId();
    return this._als.run({ traceId, runId: runId || null }, fn);
  }

  /** 获取当前异步调用链中的 runId(未设置返回 null) */
  getRunId() {
    const store = this._als.getStore();
    return store ? (store.runId || null) : null;
  }

  /**
   * 获取当前异步调用链中的 traceId
   * @returns {string|null}
   */
  getTraceId() {
    const store = this._als.getStore();
    return store ? store.traceId : (this._fallbackTraceId || null);
  }

  /**
   * 在非异步上下文入口设置根 traceId
   * @param {string} [traceId] — 未提供时自动生成
   * @returns {string}
   */
  setRootTraceId(traceId) {
    this._fallbackTraceId = traceId || this._generateId();
    return this._fallbackTraceId;
  }

  /**
   * 生成子 traceId，关联到父 trace
   * @param {string} [parentTraceId] — 未提供时从当前上下文获取
   * @returns {string}
   */
  createChildTraceId(parentTraceId) {
    const parent = parentTraceId || this.getTraceId();
    if (parent) {
      return parent + '-' + this._generateShortId();
    }
    return this._generateId();
  }

  reset() {
    this._fallbackTraceId = null;
  }

  _generateId() {
    return crypto.randomUUID().slice(0, 12);
  }

  _generateShortId() {
    return crypto.randomUUID().slice(0, 6);
  }
}

/** 全局单例 */
const globalTraceContext = new TraceContextManager();

module.exports = {
  TraceContextManager,
  globalTraceContext,
};
