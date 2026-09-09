/**
 * BudgetedEvolutionClient — 进化系统专用 LLM 客户端（预算包装）
 *
 * 包装 EvolutionLlmAdapter，为 ConversationReviewFork / SkillCurator / SkillEvolver
 * 的统一 LLM 入口加预算门（evolution 分类 dailyLimit 20，见 budget-enforcer.js
 * CATEGORY_BUDGETS）。P1-3 技能自进化激活。
 *
 * 接口（与引擎期望逐字吻合，adapter 已有实现，本包装只加预算）:
 *   chat({ messages, temperature, max_tokens, tools })
 *     → OpenAI 兼容响应（choices[].message.content/tool_calls + usage）| null
 *   fetchCompletion({ messages, temperature, max_tokens })
 *     → { content } | null
 *
 * null 路径 = 优雅降级：引擎侧已有「client 无结果即跳过 review」语义。
 *
 * 预算语义（对齐 ai.js:1443-1452 允许判定）:
 *   - checkRequest 返回 allowed:false（分类配额耗尽/全局封锁/模型限制）→ 返回 null，不调 adapter；
 *   - checkRequest 自身异常 → 记 warn 后放行（fail-open，与 ai.js 同语义）；
 *   - 调用成功才 recordUsage（provider/model 取主模型配置，category='evolution'）；
 *   - usage 优先取 adapter 响应透传的 usage 字段（OpenAI 形 {prompt_tokens, ...}），
 *     缺失时（如 fetchCompletion 只回 {content}）按 estimatedTokens=4000 记账。
 */

const { EvolutionLlmAdapter } = require('./llm-adapter');
const { getBudgetEnforcer } = require('../budget-enforcer');

const EVOLUTION_USER_ID = 'evolution';
const EVOLUTION_CATEGORY = 'evolution';
const DEFAULT_ESTIMATED_TOKENS = 4000;

class BudgetedEvolutionClient {
  constructor(config) {
    this._adapter = new EvolutionLlmAdapter(config);
  }

  /** 解析 provider/model（委托 adapter，同 loadConfig 主模型语义，adapter 内部有缓存） */
  _providerInfo() {
    const resolved = this._adapter._resolveProvider();
    return {
      provider: resolved?.provider || 'unknown',
      model: resolved?.model || 'deepseek-chat',
    };
  }

  /**
   * 预算预检。放行返回 { provider, model }，拦截返回 null。
   */
  _checkBudget() {
    const { provider, model } = this._providerInfo();
    let req = { allowed: true };
    try {
      const budget = getBudgetEnforcer();
      req = budget.checkRequest({
        model,
        estimatedTokens: DEFAULT_ESTIMATED_TOKENS,
        userId: EVOLUTION_USER_ID,
        category: EVOLUTION_CATEGORY,
      });
    } catch (e) {
      // 预算检查异常 → 放行（对齐 ai.js:1452 fail-open 语义），记账侧单独兜底
      console.warn('[BudgetedEvolutionClient] 预算检查异常, 放行:', e.message);
    }
    if (!req.allowed) {
      console.warn(`💰 [BudgetedEvolutionClient] 预算拦截: ${req.reason}`);
      return null;
    }
    return { provider, model };
  }

  /** 调用成功后记账（evolution 分类计数，失败只 warn 不影响响应路径） */
  _recordUsage(provider, model, usage) {
    try {
      const budget = getBudgetEnforcer();
      budget.recordUsage(
        provider,
        model,
        usage || { prompt_tokens: DEFAULT_ESTIMATED_TOKENS },
        null,
        EVOLUTION_USER_ID,
        { category: EVOLUTION_CATEGORY }
      );
    } catch (e) {
      console.warn('[BudgetedEvolutionClient] 记账失败:', e.message);
    }
  }

  /**
   * OpenAI 兼容 chat 接口（带工具支持）。
   * @param {object} params - { messages, temperature, max_tokens, tools }
   * @returns {Promise<object|null>}
   */
  async chat(params = {}) {
    const ctx = this._checkBudget();
    if (!ctx) return null; // 预算拦截 → 优雅降级

    const result = await this._adapter.chat(params);
    if (!result) return null; // adapter 失败 → 不记账

    this._recordUsage(ctx.provider, ctx.model, result.usage);
    return result;
  }

  /**
   * 简化 completion 接口（无工具调用）。
   * 注意：adapter.fetchCompletion 返回 {content} 无 usage 字段 → 按估算记账。
   * @param {object} params - { messages, temperature, max_tokens }
   * @returns {Promise<object|null>}
   */
  async fetchCompletion(params = {}) {
    const ctx = this._checkBudget();
    if (!ctx) return null;

    const result = await this._adapter.fetchCompletion(params);
    if (!result) return null;

    this._recordUsage(ctx.provider, ctx.model, null);
    return result;
  }
}

function createBudgetedEvolutionClient(config) {
  return new BudgetedEvolutionClient(config);
}

module.exports = { BudgetedEvolutionClient, createBudgetedEvolutionClient };
