/**
 * Budget Enforcer 测试 — 覆盖 5 级降级、分类预算、持久化、模型降级
 */
const {
  BudgetEnforcer,
  DEGRADATION_LEVELS,
  CATEGORY_BUDGETS,
} = require('../core/budget-enforcer');

describe('BudgetEnforcer', () => {
  let enforcer;

  beforeEach(() => {
    enforcer = new BudgetEnforcer({
      dailyLimit: 100,
      monthlyLimit: 1000,
      perSessionLimit: 200,
      perUserDailyLimit: 30,
      warningThreshold: 0.8,
      criticalThreshold: 0.95,
    });
  });

  // ── 初始状态测试 ────────────────────────────────────────────────
  describe('initial state', () => {
    test('should start with NONE degradation level', () => {
      expect(enforcer.getStatus().degradation).toBe(DEGRADATION_LEVELS.NONE);
    });

    test('should not be blocked initially', () => {
      expect(enforcer.getStatus().blocked).toBe(false);
    });

    test('should allow requests at NONE level', () => {
      const result = enforcer.checkRequest({});
      expect(result.allowed).toBe(true);
    });

    test('should report zero spending initially', () => {
      const status = enforcer.getStatus();
      expect(status.daily.spent).toBe(0);
      expect(status.monthly.spent).toBe(0);
      expect(status.session.spent).toBe(0);
    });
  });

  // ── checkRequest 测试 ───────────────────────────────────────────
  describe('checkRequest', () => {
    test('should allow request without restrictions', () => {
      const result = enforcer.checkRequest({
        model: 'deepseek-chat',
        estimatedTokens: 1000,
      });
      expect(result.allowed).toBe(true);
    });

    test('should return actions for current degradation level', () => {
      const result = enforcer.checkRequest({});
      expect(result.actions).toBeDefined();
      expect(result.actions.allowStreaming).toBe(true);
      expect(result.actions.allowToolCalls).toBe(true);
    });

    test('should report degradation level in result', () => {
      const result = enforcer.checkRequest({});
      expect(result.degradation).toBe(DEGRADATION_LEVELS.NONE);
    });
  });

  // ── Category Budget 测试 ────────────────────────────────────────
  describe('category budgets', () => {
    test('should track reasoning category', () => {
      // reasoning dailyLimit is 30, should pass first request
      const result = enforcer.checkRequest({ category: 'reasoning' });
      expect(result.allowed).toBe(true);
    });

    test('should track tool_call category', () => {
      const result = enforcer.checkRequest({ category: 'tool_call' });
      expect(result.allowed).toBe(true);
    });

    test('should track memory category', () => {
      const result = enforcer.checkRequest({ category: 'memory' });
      expect(result.allowed).toBe(true);
    });

    test('should record category usage on recordUsage', () => {
      enforcer.checkRequest({ category: 'reasoning' });
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 100, completionTokens: 50 }, 0.001, null, { category: 'reasoning' });
      // Should not throw — verifies the internal tracking doesn't crash
      expect(true).toBe(true);
    });
  });

  // ── 模型降级测试 ────────────────────────────────────────────────
  describe('model downgrade', () => {
    test('should downgrade expensive model when not allowed', () => {
      // Force moderate degradation which blocks expensive models
      enforcer.forceDegradation('moderate');
      const result = enforcer.checkRequest({
        model: 'deepseek-reasoner',
        estimatedTokens: 1000,
      });
      expect(result.degraded).toBe(true);
      expect(result.suggestedModel).toBeDefined();
    });

    test('should allow cheap model at moderate degradation', () => {
      enforcer.forceDegradation('moderate');
      const result = enforcer.checkRequest({
        model: 'deepseek-chat',
        estimatedTokens: 1000,
      });
      expect(result.allowed).toBe(true);
    });

    test('should block tool calls at heavy degradation', () => {
      enforcer.forceDegradation('heavy');
      const result = enforcer.checkRequest({
        requiresToolCall: true,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('tool_calls_blocked');
    });
  });

  // ── 降级级别转换测试 ────────────────────────────────────────────
  describe('degradation transitions', () => {
    test('forceDegradation to moderate works', () => {
      const ok = enforcer.forceDegradation('moderate');
      expect(ok).toBe(true);
      expect(enforcer.getStatus().degradation).toBe(DEGRADATION_LEVELS.MODERATE);
    });

    test('forceDegradation to heavy works', () => {
      enforcer.forceDegradation('heavy');
      const status = enforcer.getStatus();
      expect(status.degradation).toBe(DEGRADATION_LEVELS.HEAVY);
      expect(status.blocked).toBe(false); // heavy is not blocked
    });

    test('forceDegradation to blocked sets blocked flag', () => {
      enforcer.forceDegradation('blocked');
      const status = enforcer.getStatus();
      expect(status.degradation).toBe(DEGRADATION_LEVELS.BLOCKED);
      expect(status.blocked).toBe(true);
    });

    test('blocked state rejects all requests', () => {
      enforcer.forceDegradation('blocked');
      const result = enforcer.checkRequest({ model: 'deepseek-chat' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    test('releaseBlock clears blocked state', () => {
      enforcer.forceDegradation('blocked');
      enforcer.releaseBlock();
      expect(enforcer.getStatus().blocked).toBe(false);
    });

    test('releaseBlock recalculates degradation', () => {
      enforcer.forceDegradation('blocked');
      enforcer.releaseBlock();
      expect(enforcer.getStatus().degradation).toBe(DEGRADATION_LEVELS.NONE);
    });

    test('invalid degradation level returns false', () => {
      const ok = enforcer.forceDegradation('invalid_level');
      expect(ok).toBe(false);
    });
  });

  // ── recordUsage / 消费跟踪测试 ───────────────────────────────────
  describe('recordUsage', () => {
    test('should increment daily spending', () => {
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 100, completionTokens: 50 }, 0.002);
      const status = enforcer.getStatus();
      expect(status.daily.requests).toBe(1);
      expect(status.daily.tokens).toBe(150);
    });

    test('should increment session spending', () => {
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 100, completionTokens: 50 }, 0.002);
      const status = enforcer.getStatus();
      expect(status.session.requests).toBe(1);
    });

    test('should increment monthly spending', () => {
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 1000 }, 0.01);
      const status = enforcer.getStatus();
      expect(status.monthly.requests).toBe(1);
    });

    test('should track per-user spending', () => {
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 500 }, 0.005, 'user123');
      const status = enforcer.getStatus();
      expect(status.userCount).toBe(1);
    });
  });

  // ── resetSession 测试 ────────────────────────────────────────────
  describe('resetSession', () => {
    test('should reset session counters', () => {
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 100 }, 0.001);
      enforcer.resetSession();
      const status = enforcer.getStatus();
      expect(status.session.spent).toBe(0);
      expect(status.session.requests).toBe(0);
    });

    test('resetSession should not affect daily counters', () => {
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 100 }, 0.001);
      const beforeDaily = enforcer.getStatus().daily.requests;
      enforcer.resetSession();
      expect(enforcer.getStatus().daily.requests).toBe(beforeDaily);
    });
  });

  // ── context window scaling 测试 ──────────────────────────────────
  describe('context window scaling', () => {
    test('should return 1.0 at NONE degradation', () => {
      expect(enforcer.getContextWindowScale()).toBe(1.0);
    });

    test('should return 0.7 at MODERATE degradation', () => {
      enforcer.forceDegradation('moderate');
      expect(enforcer.getContextWindowScale()).toBe(0.7);
    });

    test('should return 0.5 at HEAVY degradation', () => {
      enforcer.forceDegradation('heavy');
      expect(enforcer.getContextWindowScale()).toBe(0.5);
    });
  });

  // ── CATEGORY_BUDGETS 常量测试 ────────────────────────────────────
  describe('CATEGORY_BUDGETS constants', () => {
    test('should have required categories defined', () => {
      expect(CATEGORY_BUDGETS.reasoning).toBeDefined();
      expect(CATEGORY_BUDGETS.tool_call).toBeDefined();
      expect(CATEGORY_BUDGETS.memory).toBeDefined();
      expect(CATEGORY_BUDGETS.streaming).toBeDefined();
      expect(CATEGORY_BUDGETS.tool_validation).toBeDefined();
      expect(CATEGORY_BUDGETS.observability).toBeDefined();
    });

    test('all dailyLimits should be positive integers >= 1 (or Infinity for uncapped)', () => {
      // eslint-disable-next-line no-unused-vars -- 数组解构 [name, budget] 中 name 未使用
      for (const [name, budget] of Object.entries(CATEGORY_BUDGETS)) {
        if (budget.dailyLimit === Infinity) continue; // internal: 只统计不拦截
        expect(budget.dailyLimit).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(budget.dailyLimit)).toBe(true);
      }
    });

    test('each category should have a label and color', () => {
      for (const budget of Object.values(CATEGORY_BUDGETS)) {
        expect(budget.label).toBeDefined();
        expect(typeof budget.label).toBe('string');
        expect(budget.color).toBeDefined();
      }
    });
  });

  // ── 每用户限制测试 ──────────────────────────────────────────────
  describe('per-user limits', () => {
    test('should track separate users independently', () => {
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 100 }, 0.001, 'userA');
      enforcer.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 200 }, 0.002, 'userB');
      expect(enforcer.getStatus().userCount).toBe(2);
    });
  });

  // ── 建议模式测试 ──────────────────────────────────────────────────
  describe('advisory mode', () => {
    test('should never block in advisory mode even at blocked state', () => {
      const advisory = new BudgetEnforcer({
        dailyLimit: 100,
        advisoryMode: true,
      });
      advisory.forceDegradation('blocked');
      const result = advisory.checkRequest({ model: 'deepseek-reasoner' });
      expect(result.allowed).toBe(true);
      expect(result.advisoryBudget).toBeDefined();
      expect(result.advisoryBudget.warnings.length).toBeGreaterThan(0);
    });

    test('should emit warnings for blocked state in advisory mode', () => {
      const advisory = new BudgetEnforcer({
        dailyLimit: 100,
        advisoryMode: true,
      });
      advisory.forceDegradation('blocked');
      const result = advisory.checkRequest({ model: 'deepseek-chat' });
      const hasBlockedWarning = result.advisoryBudget.warnings.some(w => w.type === 'blocked');
      expect(hasBlockedWarning).toBe(true);
    });

    test('should emit model downgrade warning in advisory mode', () => {
      const advisory = new BudgetEnforcer({
        dailyLimit: 100,
        advisoryMode: true,
      });
      advisory.forceDegradation('moderate');
      const result = advisory.checkRequest({ model: 'deepseek-reasoner' });
      expect(result.allowed).toBe(true);
      const hasDowngradeWarning = result.advisoryBudget.warnings.some(w => w.type === 'model_downgrade');
      expect(hasDowngradeWarning).toBe(true);
      const warn = result.advisoryBudget.warnings.find(w => w.type === 'model_downgrade');
      expect(warn.suggestedModel).toBeDefined();
      expect(warn.originalModel).toBe('deepseek-reasoner');
    });

    test('advisory mode should still record usage', () => {
      const advisory = new BudgetEnforcer({
        dailyLimit: 100,
        advisoryMode: true,
      });
      advisory.recordUsage('deepseek', 'deepseek-chat', { promptTokens: 100 }, 0.001);
      expect(advisory.getStatus().daily.requests).toBe(1);
    });
  });

  // ── 预算上下文测试 ────────────────────────────────────────────────
  describe('getBudgetContext', () => {
    test('should return short format string', () => {
      const ctx = enforcer.getBudgetContext('short');
      expect(typeof ctx).toBe('string');
      expect(ctx).toContain('预算');
      expect(ctx).toContain('今日');
      expect(ctx).toContain('本月');
    });

    test('should return prompt format with section markers', () => {
      const ctx = enforcer.getBudgetContext('prompt');
      expect(ctx).toContain('--- 预算上下文 ---');
      expect(ctx).toContain('--- 预算上下文结束 ---');
      expect(ctx).toContain('当前预算级别');
    });

    test('should return status object for unknown format', () => {
      const ctx = enforcer.getBudgetContext('full');
      expect(ctx.degradation).toBeDefined();
      expect(ctx.daily).toBeDefined();
    });

    test('prompt format should include model advisory when degraded', () => {
      enforcer.forceDegradation('moderate');
      const ctx = enforcer.getBudgetContext('prompt');
      expect(ctx).toContain('经济型');
    });
  });

  // ── getAdvisorySuggestion 测试 ────────────────────────────────────
  describe('getAdvisorySuggestion', () => {
    test('should return suggestion without affecting enforcement mode', () => {
      const result = enforcer.getAdvisorySuggestion({ model: 'deepseek-chat' });
      expect(result.wouldAllow).toBe(true);
      expect(result.wouldBlock).toBe(false);
      expect(result.currentDegradation).toBe(DEGRADATION_LEVELS.NONE);
      // Verify enforcer still in enforcement mode
      const check = enforcer.checkRequest({});
      expect(check.allowed).toBe(true);
    });

    test('should predict blocked state correctly', () => {
      enforcer.forceDegradation('blocked');
      const result = enforcer.getAdvisorySuggestion({ model: 'deepseek-chat' });
      expect(result.wouldAllow).toBe(false);
      expect(result.wouldBlock).toBe(true);
    });
  });
});
