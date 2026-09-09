/**
 * BudgetedEvolutionClient 测试 — P1-3 技能自进化激活（LLM client 注入+预算安全）
 *
 * 覆盖：
 *  - CATEGORY_BUDGETS.evolution 定义（dailyLimit 20）
 *  - checkRequest 允许 → 委托 adapter + recordUsage（真实 usage 透传）
 *  - checkRequest 拒绝 → 返回 null 且不调 adapter、不记账
 *  - adapter 失败 → 不记账
 *  - usage 缺失 → 估算记账（4000）
 *  - checkRequest 异常 → fail-open 放行（对齐 ai.js 语义）
 */

const mockEnforcer = {
  checkRequest: jest.fn(),
  recordUsage: jest.fn(),
};

jest.mock('../core/evolution/llm-adapter', () => {
  return {
    EvolutionLlmAdapter: jest.fn().mockImplementation(function () {
      this._resolveProvider = jest.fn(() => ({
        provider: 'deepseek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'test-key',
      }));
      this.chat = jest.fn();
      this.fetchCompletion = jest.fn();
    }),
  };
});

jest.mock('../core/budget-enforcer', () => ({
  getBudgetEnforcer: jest.fn(() => mockEnforcer),
}));

const { BudgetedEvolutionClient, createBudgetedEvolutionClient } = require('../core/evolution/budgeted-evolution-client');
const { EvolutionLlmAdapter } = require('../core/evolution/llm-adapter');
// 真实模块仅用于常量断言（包装器行为走 mock）
const { CATEGORY_BUDGETS } = jest.requireActual('../core/budget-enforcer');

describe('CATEGORY_BUDGETS.evolution', () => {
  test('defines evolution category with dailyLimit 20', () => {
    expect(CATEGORY_BUDGETS.evolution).toBeDefined();
    expect(CATEGORY_BUDGETS.evolution.label).toBe('技能自进化');
    expect(CATEGORY_BUDGETS.evolution.dailyLimit).toBe(20);
  });
});

describe('BudgetedEvolutionClient', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = createBudgetedEvolutionClient();
  });

  const allowAll = () => mockEnforcer.checkRequest.mockReturnValue({ allowed: true, degradation: 'NONE' });
  const deny = (reason) => mockEnforcer.checkRequest.mockReturnValue({ allowed: false, reason });

  test('checkRequest allowed → delegates to adapter.chat and records real usage', async () => {
    allowAll();
    const openAiResp = {
      choices: [{ message: { content: 'review ok' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    };
    client._adapter.chat.mockResolvedValue(openAiResp);

    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 2000 });

    expect(result).toBe(openAiResp);
    expect(client._adapter.chat).toHaveBeenCalledTimes(1);
    expect(mockEnforcer.checkRequest).toHaveBeenCalledWith({
      model: 'deepseek-chat',
      estimatedTokens: 4000,
      userId: 'evolution',
      category: 'evolution',
    });
    expect(mockEnforcer.recordUsage).toHaveBeenCalledTimes(1);
    const [provider, model, usage, cost, userId, options] = mockEnforcer.recordUsage.mock.calls[0];
    expect(provider).toBe('deepseek');
    expect(model).toBe('deepseek-chat');
    expect(usage).toEqual(openAiResp.usage);
    expect(cost).toBeNull();
    expect(userId).toBe('evolution');
    expect(options).toEqual({ category: 'evolution' });
  });

  test('checkRequest denied → returns null, adapter NOT called, no recordUsage', async () => {
    deny('category_budget_exceeded: evolution (20/20)');

    const result = await client.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(result).toBeNull();
    expect(client._adapter.chat).not.toHaveBeenCalled();
    expect(mockEnforcer.recordUsage).not.toHaveBeenCalled();
  });

  test('adapter failure (null) → no recordUsage', async () => {
    allowAll();
    client._adapter.chat.mockResolvedValue(null);

    const result = await client.chat({ messages: [] });

    expect(result).toBeNull();
    expect(mockEnforcer.recordUsage).not.toHaveBeenCalled();
  });

  test('response without usage field → records estimated usage (4000 prompt tokens)', async () => {
    allowAll();
    client._adapter.chat.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });

    await client.chat({ messages: [] });

    expect(mockEnforcer.recordUsage).toHaveBeenCalledTimes(1);
    expect(mockEnforcer.recordUsage.mock.calls[0][2]).toEqual({ prompt_tokens: 4000 });
  });

  test('checkRequest throws → fail-open and still calls adapter', async () => {
    mockEnforcer.checkRequest.mockImplementation(() => { throw new Error('enforcer broken'); });
    client._adapter.chat.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });

    const result = await client.chat({ messages: [] });

    expect(result).not.toBeNull();
    expect(client._adapter.chat).toHaveBeenCalledTimes(1);
    expect(mockEnforcer.recordUsage).toHaveBeenCalledTimes(1);
  });

  test('fetchCompletion allowed → delegates and records estimated usage (no usage in {content} shape)', async () => {
    allowAll();
    client._adapter.fetchCompletion.mockResolvedValue({ content: 'summary' });

    const result = await client.fetchCompletion({ messages: [], max_tokens: 2000 });

    expect(result).toEqual({ content: 'summary' });
    expect(client._adapter.fetchCompletion).toHaveBeenCalledTimes(1);
    expect(mockEnforcer.recordUsage).toHaveBeenCalledTimes(1);
    expect(mockEnforcer.recordUsage.mock.calls[0][2]).toEqual({ prompt_tokens: 4000 });
  });

  test('fetchCompletion denied → null and adapter NOT called', async () => {
    deny('category_budget_exceeded: evolution (20/20)');

    const result = await client.fetchCompletion({ messages: [] });

    expect(result).toBeNull();
    expect(client._adapter.fetchCompletion).not.toHaveBeenCalled();
    expect(mockEnforcer.recordUsage).not.toHaveBeenCalled();
  });

  test('_resolveProvider returns null (no API key) → checkRequest still uses fallback model', async () => {
    allowAll();
    client._adapter._resolveProvider.mockReturnValue(null);
    client._adapter.chat.mockResolvedValue({ choices: [{ message: { content: 'ok' } }] });

    await client.chat({ messages: [] });

    expect(mockEnforcer.checkRequest).toHaveBeenCalledWith({
      model: 'deepseek-chat',
      estimatedTokens: 4000,
      userId: 'evolution',
      category: 'evolution',
    });
  });
});

describe('BudgetedEvolutionClient factory', () => {
  test('createBudgetedEvolutionClient returns wrapper instance with adapter', () => {
    const c = createBudgetedEvolutionClient({ models: {} });
    expect(c).toBeInstanceOf(BudgetedEvolutionClient);
    expect(c._adapter).toBeInstanceOf(EvolutionLlmAdapter);
  });
});
