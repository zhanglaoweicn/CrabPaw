/**
 * Middleware System - 中间件基类
 *
 * 2026-08-30 死代码收口：MiddlewareChain/MiddlewareContext 仅被已删除的
 * middleware/index.js 链工厂消费（createDefaultMiddlewareChain 全仓零消费方，
 * 循环检测实际走 ai.js 直接实例化 LoopDetectionMiddleware 的手动守卫路径）。
 * 本文件仅保留 LoopDetectionMiddleware 继承所需的 Middleware 基类。
 */

class Middleware {
  constructor(config = {}) {
    this.name = config.name || this.constructor.name;
    this.enabled = config.enabled !== false;
    this.priority = config.priority || 0;
    this.config = config;
  }

  async beforeModel(_context) {
    return null;
  }

  async afterModel(context, response) {
    return response;
  }

  async beforeToolCall(context, toolCall) {
    return toolCall;
  }

  async afterToolCall(context, toolCall, result) {
    return result;
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }
}

module.exports = {
  Middleware
};
