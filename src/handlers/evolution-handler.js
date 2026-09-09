/**
 * 进化系统 API 处理器
 * 提供进化系统的所有 API 接口
 */

const { getToolEvolutionEngine } = require('../core/evolution/tool-evolution');
const { getSkillEvolutionEngine } = require('../core/evolution/skill-evolution');
const { getMemoryEvolutionEngine } = require('../core/evolution/memory-evolution');
const { getConfigEvolutionEngine } = require('../core/evolution/config-evolution');
const { getTTSEvolutionEngine } = require('../core/evolution/tts-evolution');
const { getTestEvolutionEngine } = require('../core/evolution/test-evolution');
const { getToolEvolutionBridge } = require('../core/tool-evolution-bridge');

class EvolutionHandler {
  constructor() {
    this.engines = {};
  }

  async init() {
    this.engines = {
      tools: await getToolEvolutionEngine(),
      skills: await getSkillEvolutionEngine(),
      memory: await getMemoryEvolutionEngine(),
      config: await getConfigEvolutionEngine(),
      tts: await getTTSEvolutionEngine(),
      tests: await getTestEvolutionEngine(),
    };

    // 检测空壳引擎并标记
    this._inactiveEngines = new Set();
    for (const [name, engine] of Object.entries(this.engines)) {
      if (!engine || typeof engine.evolve !== 'function') {
        this._inactiveEngines.add(name);
        console.warn(`[EvolutionHandler] 引擎 '${name}' 不可用（缺少 evolve 方法），已跳过`);
      }
    }
    // config-evolution 和 test-evolution 目前为空壳实现，标记为 inactive
    for (const name of ['config', 'tests']) {
      const report = this.engines[name]?.getReport?.() || {};
      if (!report.effective || report.status === 'stub') {
        this._inactiveEngines.add(name);
      }
    }
    if (this._inactiveEngines.size > 0) {
      console.warn(`[EvolutionHandler] ${this._inactiveEngines.size} 个引擎处于 inactive 状态: ${[...this._inactiveEngines].join(', ')}`);
    }
    console.log('📡 进化系统 API 已初始化');
  }

  /**
   * 获取进化系统总览
   */
  async getOverview() {
    const reports = {};
    for (const [name, engine] of Object.entries(this.engines)) {
      try {
        reports[name] = engine.getReport();
      } catch (err) {
        reports[name] = { error: err.message };
      }
    }
    return {
      timestamp: new Date().toISOString(),
      engines: Object.keys(this.engines),
      reports
    };
  }

  /**
   * 触发指定模块进化
   */
  async triggerEvolution(moduleName) {
    const engine = this.engines[moduleName];
    if (!engine) throw new Error(`未知的进化模块: ${moduleName}`);
    return await engine.evolve();
  }

  /**
   * 触发全部模块进化
   */
  async triggerAllEvolution() {
    const results = {};
    for (const [name, engine] of Object.entries(this.engines)) {
      try {
        results[name] = await engine.evolve();
      } catch (err) {
        results[name] = { error: err.message };
      }
    }
    return results;
  }

  /**
   * 获取工具进化报告
   */
  async getToolReport() {
    return this.engines.tools.getPerformanceReport();
  }

  /**
   * 记录工具调用
   */
  async recordToolCall(toolName, executionTime, success, userSatisfaction) {
    return await this.engines.tools.recordToolCall(toolName, executionTime, success, userSatisfaction);
  }

  /**
   * 获取技能进化报告
   */
  async getSkillReport() {
    return this.engines.skills.getSkillReport();
  }

  /**
   * 自动创建技能
   */
  async autoCreateSkill(experience) {
    return await this.engines.skills.autoCreateSkill(experience);
  }

  /**
   * 存储记忆
   */
  async storeMemory(memory) {
    return await this.engines.memory.store(memory);
  }

  /**
   * 检索记忆
   */
  async retrieveMemory(query, limit) {
    return await this.engines.memory.retrieve(query, limit);
  }

  /**
   * 获取用户画像
   */
  async getUserProfile() {
    return this.engines.memory.getUserProfile();
  }

  /**
   * 获取记忆报告
   */
  async getMemoryReport() {
    return this.engines.memory.getReport();
  }

  /**
   * 记录 TTS 合成
   */
  async recordTTSSynthesis(duration, quality, scene = 'casual', options = {}) {
    return await this.engines.tts.recordSynthesis(duration, quality, scene, options);
  }

  /**
   * 记录测试结果
   */
  async recordTestResult(module, passed, duration) {
    return await this.engines.tests.recordTestResult(module, passed, duration);
  }

  /**
   * 获取内置工具进化桥报告
   */
  async getToolBridgeReport() {
    const bridge = getToolEvolutionBridge();
    return {
      toolReports: bridge.getAllToolReports(),
      sourceRanking: bridge.getSourceRanking(),
    };
  }

  /**
   * 获取进化日志（从 EvolutionCoordinator 持久化日志）
   */
  async getEvolutionLog(filter = {}) {
    const { getEvolutionLog } = require('../core/evolution-system');
    return await getEvolutionLog(filter);
  }

  /**
   * 处理 IPC 消息
   */
  async handleIPCMessage(channel, ...args) {
    switch (channel) {
      case 'evolution:overview': return await this.getOverview();
      case 'evolution:trigger': return await this.triggerEvolution(args[0]);
      case 'evolution:trigger-all': return await this.triggerAllEvolution();
      case 'evolution:tool-report': return await this.getToolReport();
      case 'evolution:skill-report': return await this.getSkillReport();
      case 'evolution:memory-report': return await this.getMemoryReport();
      case 'evolution:record-tool-call': return await this.recordToolCall(...args);
      case 'evolution:auto-create-skill': return await this.autoCreateSkill(args[0]);
      case 'evolution:store-memory': return await this.storeMemory(args[0]);
      case 'evolution:retrieve-memory': return await this.retrieveMemory(args[0], args[1]);
      case 'evolution:user-profile': return await this.getUserProfile();
      case 'evolution:record-tts': return await this.recordTTSSynthesis(args[0], args[1]);
      case 'evolution:record-test': return await this.recordTestResult(args[0], args[1], args[2]);
      case 'evolution:tool-bridge-report': return await this.getToolBridgeReport();
      case 'evolution:log': return await this.getEvolutionLog(args[0] || {});
      default: throw new Error(`未知的进化 API: ${channel}`);
    }
  }
}

let handler = null;
async function getEvolutionHandler() {
  if (!handler) {
    handler = new EvolutionHandler();
    await handler.init();
  }
  return handler;
}

module.exports = { EvolutionHandler, getEvolutionHandler };
