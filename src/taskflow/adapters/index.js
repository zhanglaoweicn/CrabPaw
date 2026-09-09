const { WorkflowEngineAdapter } = require('./workflow-engine-adapter');
const { SkillFlowAdapter } = require('./skillflow-adapter');
const { TaskWorkflowAdapter } = require('./task-workflow-adapter');

class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
    this._registerDefaultAdapters();
  }

  _registerDefaultAdapters() {
    this.registerAdapter('workflow-engine', new WorkflowEngineAdapter());
    this.registerAdapter('skill-flow', new SkillFlowAdapter());
    this.registerAdapter('task-workflow', new TaskWorkflowAdapter());
  }

  registerAdapter(type, adapter) {
    if (!adapter || typeof adapter.convertToTaskFlow !== 'function') {
      throw new Error('适配器必须实现 convertToTaskFlow 方法');
    }

    this.adapters.set(type, adapter);
    console.log(`✅ 注册适配器: ${type}`);
  }

  getAdapter(type) {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`未找到适配器类型: ${type}`);
    }
    return adapter;
  }

  convertToTaskFlow(source, type) {
    const adapter = this.getAdapter(type);
    return adapter.convertToTaskFlow(source);
  }

  convertFromTaskFlow(taskflow, type) {
    const adapter = this.getAdapter(type);
    return adapter.convertFromTaskFlow(taskflow);
  }

  listAdapters() {
    return Array.from(this.adapters.keys());
  }

  hasAdapter(type) {
    return this.adapters.has(type);
  }
}

let adapterRegistry = null;

function getAdapterRegistry() {
  if (!adapterRegistry) {
    adapterRegistry = new AdapterRegistry();
  }
  return adapterRegistry;
}

module.exports = {
  AdapterRegistry,
  getAdapterRegistry,
  WorkflowEngineAdapter,
  SkillFlowAdapter,
  TaskWorkflowAdapter
};
