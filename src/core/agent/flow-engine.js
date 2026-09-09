/**
 * FlowEngine — 工作流引擎桥接模块
 *
 * 提供 FlowEngine 类，适配 sub-agent-orchestrator 等消费方的接口。
 * 实际工作流执行委托给 src/core/workflow-engine.js 的 WorkflowEngine。
 *
 * 这是缺失模块补丁，解决启动时 MODULE_NOT_FOUND 崩溃。
 */

const { WorkflowEngine } = require('../workflow-engine');

class FlowEngine {
  constructor(options = {}) {
    this._engine = options.engine || new WorkflowEngine(options);
  }

  /**
   * 获取工作流实例（适配 sub-agent-orchestrator 的 flowEngine.get 调用）
   * @param {string} flowId
   * @returns {object|null} 工作流实例
   */
  get(flowId) {
    if (!flowId) return null;
    try {
      return this._engine.getWorkflow ? this._engine.getWorkflow(flowId) : null;
    } catch {
      return null;
    }
  }

  /**
   * 初始化引擎
   */
  async initialize() {
    if (this._engine.initialize) {
      await this._engine.initialize();
    }
  }

  /**
   * 获取底层引擎实例
   */
  getEngine() {
    return this._engine;
  }
}

module.exports = { FlowEngine };
