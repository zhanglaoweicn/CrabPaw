const { BudgetEnforcer, CATEGORY_BUDGETS, DEGRADATION_LEVELS } = require("../../src/core/budget-enforcer");

module.exports = {
  name: "Budget Enforcer",
  cases: [
    {
      id: "be_001",
      name: "CATEGORY_BUDGETS defines known categories",
      category: "budget_enforcer",
      run: () => {
        // 2026-08-18: reasoning 30→60（silent 内部任务独立 internal 分类后用户请求配额）
        // 2026-08-28 发布: tool_call 20→200（多轮工具循环单任务 10-20 次调用, 20/日即触顶）
        return CATEGORY_BUDGETS.reasoning?.dailyLimit === 60
          && CATEGORY_BUDGETS.tool_call?.dailyLimit === 200;
      },
    },
    {
      id: "be_002",
      name: "checkRequest allows valid category usage",
      category: "budget_enforcer",
      run: () => {
        const be = new BudgetEnforcer({ dailyLimit: 1000 });
        const result = be.checkRequest({ category: 'reasoning' });
        return result.allowed === true;
      },
    },
    {
      id: "be_003",
      name: "checkRequest blocks when category budget exceeded",
      category: "budget_enforcer",
      run: () => {
        const be = new BudgetEnforcer({ dailyLimit: 1000 });
        // 2026-08-18: reasoning 配额 60（见 be_001）
        for (let i = 0; i < 61; i++) {
          be.checkRequest({ category: 'reasoning' });
          be.recordUsage('test', 'gpt-4', { prompt_tokens: 0, completion_tokens: 0 }, 0, null, { category: 'reasoning' });
        }
        const result = be.checkRequest({ category: 'reasoning' });
        return result.allowed === false
          && result.reason.includes('category_budget_exceeded');
      },
    },
    {
      id: "be_004",
      name: "checkRequest returns degradation actions",
      category: "budget_enforcer",
      run: () => {
        const be = new BudgetEnforcer({ dailyLimit: 1000 });
        const result = be.checkRequest({ model: 'gpt-4', estimatedTokens: 1000 });
        return result.degradation === DEGRADATION_LEVELS.NONE
          && result.actions.maxTokensPerRequest === Infinity;
      },
    },
    {
      id: "be_005",
      name: "recordUsage tracks category usage count",
      category: "budget_enforcer",
      run: () => {
        const be = new BudgetEnforcer({ dailyLimit: 1000 });
        be.recordUsage('test', 'gpt-4', { prompt_tokens: 100, completion_tokens: 50 }, 1, null, { category: 'reasoning' });
        const status = be.getStatus();
        return status.daily.requests === 1 && status.daily.tokens === 150;
      },
    },
    {
      id: "be_006",
      name: "forceDegradation changes level",
      category: "budget_enforcer",
      run: () => {
        const be = new BudgetEnforcer({ dailyLimit: 1000 });
        const ok = be.forceDegradation('HEAVY');
        const result = be.checkRequest({ requiresToolCall: true });
        return ok && result.allowed === false
          && result.reason === 'tool_calls_blocked_by_budget';
      },
    },
    {
      id: "be_007",
      name: "getStatus returns daily/monthly/session breakdown",
      category: "budget_enforcer",
      run: () => {
        const be = new BudgetEnforcer({ dailyLimit: 100 });
        be.recordUsage('test', 'gpt-4', { prompt_tokens: 10, completion_tokens: 10 }, 5);
        const s = be.getStatus();
        return s.daily.spent === 5
          && s.daily.tokens === 20
          && s.daily.requests === 1;
      },
    },
  ],
};
