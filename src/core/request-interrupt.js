/**
 * RequestInterrupt — 请求中断管理器
 *
 *   - API 请求在后台执行，主线程监控中断事件
 *   - 用户可随时取消正在进行的请求
 *   - 中断后不将部分响应注入对话历史
 *
 * 使用方式：
 *   1. 发起请求前注册 AbortController
 *   2. 请求完成后注销
 *   3. 用户取消时调用 abort(userId) 中断请求
 */

class RequestInterruptManager {
  constructor() {
    // userId -> { controller: AbortController, startTime: number, description: string }
    this._activeRequests = new Map();
  }

  /**
   * 注册一个可中断的请求
   * @param {string} userId - 用户/会话 ID
   * @param {string} description - 请求描述（用于日志）
   * @returns {AbortController} 可用于 fetch 的 signal
   */
  register(userId, description = '') {
    // 如果已有活跃请求，先中断
    if (this._activeRequests.has(userId)) {
      this.abort(userId);
    }

    const controller = new AbortController();
    this._activeRequests.set(userId, {
      controller,
      startTime: Date.now(),
      description,
    });

    return controller;
  }

  /**
   * 注销请求（请求正常完成后调用）
   * @param {string} userId
   * @param {AbortController} [controller] - 所有权校验:B4 断连解耦后,旧 run 可能
   *   与新 run 短暂并存(旧 run 延续至新 run 注册之后才进入 finally)。传入注册时
   *   返回的 controller,仅当仍是当前持有者才删除,防止旧 run 误删新 run 的注册。
   */
  unregister(userId, controller = null) {
    if (controller) {
      const entry = this._activeRequests.get(userId);
      if (entry && entry.controller !== controller) return;
    }
    this._activeRequests.delete(userId);
  }

  /**
   * 中断指定用户的请求
   * @param {string} userId
   * @returns {boolean} 是否成功中断
   */
  abort(userId) {
    const entry = this._activeRequests.get(userId);
    if (!entry) return false;

    const elapsed = Date.now() - entry.startTime;
    console.log(`🛑 中断请求: ${userId} (${entry.description}, 已运行 ${elapsed}ms)`);

    entry.controller.abort();
    this._activeRequests.delete(userId);
    return true;
  }

  /**
   * 中断所有活跃请求
   */
  abortAll() {
    for (const [userId] of this._activeRequests) {
      this.abort(userId);
    }
  }

  /**
   * 检查用户是否有活跃请求
   */
  isActive(userId) {
    return this._activeRequests.has(userId);
  }

  /**
   * 获取指定用户的请求信息
   */
  getRequestInfo(userId) {
    const entry = this._activeRequests.get(userId);
    if (!entry) return null;
    return {
      description: entry.description,
      elapsed: Date.now() - entry.startTime,
      startTime: entry.startTime,
    };
  }

  /**
   * 获取所有活跃请求
   */
  getActiveRequests() {
    const result = {};
    for (const [userId, entry] of this._activeRequests) {
      result[userId] = {
        description: entry.description,
        elapsed: Date.now() - entry.startTime,
      };
    }
    return result;
  }

  /**
   * 获取活跃请求数量
   */
  getActiveCount() {
    return this._activeRequests.size;
  }
}

// 全局单例
const globalRequestInterrupt = new RequestInterruptManager();

module.exports = { RequestInterruptManager, globalRequestInterrupt };
