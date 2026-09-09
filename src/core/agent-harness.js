/**
 * AgentHarness - 可插拔 Agent 运行时框架
 *
 * - 支持注册多种 Agent 运行时（如 Codex、Claude Code）
 * - 运行时选择策略（auto/forced/fallback）
 * - 统一的生命周期管理（attempt/compact/reset/classify）
 * - 工具结果中间件链
 * - 结果分类和错误恢复
 *
 * 使用方式：
 *   const { getHarnessRegistry } = require('./agent-harness');
 *   getHarnessRegistry().register({
 *     id: 'my-agent',
 *     label: 'My Agent Runtime',
 *     attempt: async (params) => { ... },
 *   });
 */

// ============================================================================
// Harness 类型
// ============================================================================

/**
 * @typedef {Object} AgentHarness
 * @property {string} id - 唯一标识符
 * @property {string} label - 显示名称
 * @property {string} [pluginId] - 所属插件
 * @property {Function} [attempt] - 执行 Agent 运行
 * @property {Function} [compact] - 压缩会话
 * @property {Function} [reset] - 重置会话状态
 * @property {Function} [classify] - 分类运行结果
 * @property {string[]} [supportedProviders] - 支持的 provider 列表
 * @property {number} [priority] - 优先级（越高越优先）
 */

/**
 * @typedef {Object} HarnessAttemptParams
 * @property {string} sessionId
 * @property {string} provider
 * @property {string} modelId
 * @property {Array} messages
 * @property {Object} tools
 * @property {Object} config
 */

/**
 * @typedef {Object} HarnessAttemptResult
 * @property {boolean} success
 * @property {string} [error]
 * @property {boolean} [aborted]
 * @property {boolean} [timedOut]
 * @property {string} [agentHarnessResultClassification]
 */

// ============================================================================
// HarnessRegistry 类
// ============================================================================

class HarnessRegistry {
  constructor() {
    this._harnesses = new Map();
  }

  /**
   * 注册 Agent 运行时
   * @param {AgentHarness} harness
   * @param {Object} [options]
   * @param {string} [options.ownerPluginId]
   */
  register(harness, options = {}) {
    if (!harness.id || typeof harness.id !== 'string') {
      throw new Error('Agent harness must have a string id');
    }
    const id = harness.id.trim();
    if (!id) throw new Error('Agent harness id cannot be empty');

    this._harnesses.set(id, {
      harness: {
        ...harness,
        id,
        pluginId: harness.pluginId || options.ownerPluginId,
      },
      ownerPluginId: options.ownerPluginId,
      registeredAt: Date.now(),
    });

    return this;
  }

  /**
   * 注销运行时
   */
  unregister(id) {
    return this._harnesses.delete(id.trim());
  }

  /**
   * 获取运行时
   */
  get(id) {
    return this._harnesses.get(id.trim())?.harness || null;
  }

  /**
   * 列出所有已注册的运行时 ID
   */
  listIds() {
    return [...this._harnesses.keys()];
  }

  /**
   * 列出所有已注册的运行时
   */
  listAll() {
    return Array.from(this._harnesses.values()).map(e => e.harness);
  }

  /**
   * 选择最适合的运行时
   * @param {Object} params
   * @param {string} [params.preferredHarnessId] - 指定的运行时 ID
   * @param {string} [params.provider] - 当前 provider
   * @param {string} [params.modelId] - 当前 model
   * @param {'auto'|'forced'} [params.policy='auto'] - 选择策略
   * @returns {{ harness: AgentHarness, reason: string } | null}
   */
  select(params = {}) {
    // eslint-disable-next-line no-unused-vars
    const { preferredHarnessId, provider, modelId, policy = 'auto' } = params;

    // 强制指定
    if (preferredHarnessId) {
      const harness = this.get(preferredHarnessId);
      if (harness) {
        return { harness, reason: 'forced' };
      }
    }

    // 自动选择：按优先级和支持能力排序
    const candidates = this.listAll()
      .filter(h => {
        if (h.supportedProviders && h.supportedProviders.length > 0) {
          return !provider || h.supportedProviders.includes(provider);
        }
        return true; // 无限制的运行时总是候选
      })
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    if (candidates.length > 0) {
      return {
        harness: candidates[0],
        reason: policy === 'forced' && preferredHarnessId ? 'forced_fallback' : 'auto',
      };
    }

    return null;
  }

  /**
   * 重置所有运行时的会话状态
   */
  async resetAll(params) {
    const results = [];
    for (const entry of this._harnesses.values()) {
      if (typeof entry.harness.reset === 'function') {
        try {
          await entry.harness.reset(params);
          results.push({ id: entry.harness.id, success: true });
        } catch (e) {
          results.push({ id: entry.harness.id, success: false, error: e.message });
        }
      }
    }
    return results;
  }

  /**
   * 清空注册表
   */
  clear() {
    this._harnesses.clear();
  }
}

// ============================================================================
// ToolResultMiddleware - 工具结果中间件
// ============================================================================

class ToolResultMiddleware {
  constructor() {
    this._middleware = [];
  }

  /**
   * 添加中间件
   * @param {Function} middleware - async (toolName, result, context) => result
   */
  use(middleware) {
    if (typeof middleware !== 'function') {
      throw new Error('Middleware must be a function');
    }
    this._middleware.push(middleware);
    return this;
  }

  /**
   * 执行中间件链
   */
  async execute(toolName, result, context) {
    let currentResult = result;
    for (const middleware of this._middleware) {
      try {
        currentResult = await middleware(toolName, currentResult, context);
      } catch (e) {
        console.warn(`[ToolResultMiddleware] ${toolName} middleware error:`, e.message);
      }
    }
    return currentResult;
  }

  /**
   * 清空中间件
   */
  clear() {
    this._middleware.length = 0;
  }
}

// ============================================================================
// ResultClassifier - 运行结果分类器
// ============================================================================

const RESULT_CLASSIFICATIONS = {
  OK: 'ok',
  ERROR: 'error',
  ABORTED: 'aborted',
  BLOCKED: 'blocked',
  TIMED_OUT: 'timed_out',
  IDLE_TIMED_OUT: 'idle_timed_out',
  COMPACTION_TIMED_OUT: 'compaction_timed_out',
};

function classifyResult(result) {
  if (!result) return RESULT_CLASSIFICATIONS.ERROR;
  if (result.promptError) return RESULT_CLASSIFICATIONS.ERROR;
  if (result.externalAbort || result.aborted) return RESULT_CLASSIFICATIONS.ABORTED;
  if (result.timedOut) return RESULT_CLASSIFICATIONS.TIMED_OUT;
  if (result.idleTimedOut) return RESULT_CLASSIFICATIONS.IDLE_TIMED_OUT;
  if (result.timedOutDuringCompaction) return RESULT_CLASSIFICATIONS.COMPACTION_TIMED_OUT;
  return RESULT_CLASSIFICATIONS.OK;
}

// ============================================================================
// 全局单例
// ============================================================================

let _globalRegistry = null;
let _globalMiddleware = null;

function getHarnessRegistry() {
  if (!_globalRegistry) {
    _globalRegistry = new HarnessRegistry();
  }
  return _globalRegistry;
}

function getToolResultMiddleware() {
  if (!_globalMiddleware) {
    _globalMiddleware = new ToolResultMiddleware();
  }
  return _globalMiddleware;
}

function resetHarnessRegistry() {
  if (_globalRegistry) _globalRegistry.clear();
  _globalRegistry = null;
  if (_globalMiddleware) _globalMiddleware.clear();
  _globalMiddleware = null;
}

module.exports = {
  HarnessRegistry,
  ToolResultMiddleware,
  RESULT_CLASSIFICATIONS,
  classifyResult,
  getHarnessRegistry,
  getToolResultMiddleware,
  resetHarnessRegistry,
};
