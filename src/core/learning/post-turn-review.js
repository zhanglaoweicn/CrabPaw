/**
 * PostTurnReview — 后对话自动学习引擎
 *
 * 每次对话的 tool_call 达到阈值后，在后台 fork 一个 review 流程：
 * 1. 检测学习信号（规则预过滤，无需 LLM）
 * 2. 如果有信号 → 调用 LLM 分析对话
 * 3. LLM 判断是否需要创建/更新技能或保存记忆
 * 4. 通过 SkillManage / MemorySave 工具执行
 *
 * 轻量级设计：默认 10 次 tool_call 触发，可用较小模型，不阻塞主对话。
 */

const { EventEmitter } = require('events');
const { detectLearningSignals, SKILL_REVIEW_PROMPT, MEMORY_REVIEW_PROMPT } = require('./review-prompts');

class PostTurnReview extends EventEmitter {
  constructor(config = {}) {
    super();
    this._enabled = config.enabled !== false;
    this._nudgeInterval = config.nudgeInterval || 10; // 每 N 次 tool_call 触发
    this._cooldownMs = config.cooldownMs || 60000;    // 至少间隔 60 秒
    this._lastReviewAt = 0;
    this._toolCallCount = 0;
    this._running = false;
    this._llmClient = null;
    this._totalReviews = 0;
    this._totalSignals = 0;
  }

  /**
   * 注入 LLM 客户端
   */
  setLLMClient(client) {
    this._llmClient = client;
  }

  /**
   * 每次工具调用后调用
   * @param {object} ctx - { messages, sessionId, userId }
   */
  async onToolCall(ctx = {}) {
    if (!this._enabled) return;
    this._toolCallCount++;

    if (this._toolCallCount >= this._nudgeInterval) {
      this._toolCallCount = 0;
      await this._triggerReview(ctx);
    }
  }

  /**
   * 强制触发 review（外部可调用）
   */
  async trigger(ctx = {}) {
    await this._triggerReview(ctx);
  }

  async _triggerReview(ctx) {
    // 冷却期检查
    if (Date.now() - this._lastReviewAt < this._cooldownMs) return;
    if (this._running) return;

    const messages = ctx.messages || [];

    // 规则预过滤
    const signals = detectLearningSignals(messages);
    if (!signals.hasSignal) {
      console.debug('[PostTurnReview] 无学习信号，跳过 review');
      return;
    }

    this._totalSignals++;
    this._running = true;
    this._lastReviewAt = Date.now();

    console.log(`[PostTurnReview] 检测到学习信号，开始 review (toolCalls=${this._toolCallCount})`);

    try {
      await this._runLLMReview(messages);
      this._totalReviews++;
      this.emit('review_completed', { total: this._totalReviews });
    } catch (e) {
      console.warn('[PostTurnReview] review 失败:', e.message);
    } finally {
      this._running = false;
    }
  }

  async _runLLMReview(messages) {
    if (!this._llmClient) {
      console.debug('[PostTurnReview] 无 LLM 客户端，跳过 LLM review');
      return;
    }

    const recentMessages = messages.slice(-20); // 最多分析 20 条消息
    const conversationText = recentMessages
      .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n\n');

    const skillReviewMessages = [
      { role: 'system', content: SKILL_REVIEW_PROMPT },
      { role: 'user', content: `## 对话记录\n\n${conversationText}\n\n请分析是否需要创建或更新技能。` },
    ];

    const memoryReviewMessages = [
      { role: 'system', content: MEMORY_REVIEW_PROMPT },
      { role: 'user', content: `## 对话记录\n\n${conversationText}\n\n请分析是否需要保存用户信息。` },
    ];

    // 并行执行 skill review 和 memory review
    const results = await Promise.allSettled([
      this._callLLM(skillReviewMessages),
      this._callLLM(memoryReviewMessages),
    ]);

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        console.log(`[PostTurnReview] LLM 响应: ${String(result.value).substring(0, 200)}`);
      }
    }
  }

  async _callLLM(messages) {
    if (!this._llmClient) return null;
    try {
      if (typeof this._llmClient.chat === 'function') {
        return await this._llmClient.chat({
          messages,
          temperature: 0.3,
          max_tokens: 500,
        });
      }
      if (typeof this._llmClient.fetchCompletion === 'function') {
        return await this._llmClient.fetchCompletion({ messages, temperature: 0.3, max_tokens: 500 });
      }
      return null;
    } catch (e) {
      console.warn('[PostTurnReview] LLM 调用失败:', e.message);
      return null;
    }
  }

  /**
   * 获取统计
   */
  getStats() {
    return {
      enabled: this._enabled,
      nudgeInterval: this._nudgeInterval,
      totalReviews: this._totalReviews,
      totalSignals: this._totalSignals,
      running: this._running,
      lastReviewAt: this._lastReviewAt,
    };
  }
}

module.exports = { PostTurnReview };
