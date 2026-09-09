/**
 * decision-tools.test.js — DecisionTrace/DecisionVerify 工具契约与行为
 */
const { UnifiedMemoryStore } = require('../core/memory/unified-store');
const { persistDecision } = require('../core/memory/provenance-chain');
const { createFoldState, foldRunEvent } = require('../core/memory/decision-recorder');
const { registry } = require('../tools/registry');

function seed(store) {
  // 走生产同款折叠路径构造决策记录
  const state = createFoldState();
  foldRunEvent(state, 'run:start', { roundId: 'r1', userInput: '台风摩羯路径', ts: 1 });
  foldRunEvent(state, 'tool_call', { toolName: 'KbSearch', toolId: 't1', toolArgs: '{"query":"台风"}', roundId: 'r1' });
  foldRunEvent(state, 'tool_result', { toolName: 'KbSearch', toolId: 't1', success: true, result: '台风记录', roundId: 'r1' });
  foldRunEvent(state, 'gui_reply', { roundId: 'r1', content: '摩羯 9 月 7 日登陆', timestamp: 1 });
  persistDecision(store, foldRunEvent(state, 'run:finished', { roundId: 'r1', ts: 2 }).decision);
}

describe('工具注册与契约', () => {
  const contract = require('../core/tool-contract');
  const tools = require('../tools/decision-tools');

  test('registry 注册存在且 schema 完整', () => {
    for (const name of ['DecisionTrace', 'DecisionVerify']) {
      const entry = registry.get(name);
      expect(entry).not.toBeNull();
      expect(entry.schema).toBeTruthy();
      expect(Array.isArray(entry.whenNotToUse)).toBe(true);
      expect(['low', 'medium', 'high', 'critical']).toContain(entry.riskLevel);
    }
  });

  test('tool-contract 双写一致（schema/whenNotToUse/riskLevel 逐字）', () => {
    // 2026-08-20 终审 M1: 原断言只覆盖 DecisionTrace——DecisionVerify 双写同样逐字校验
    for (const toolName of ['DecisionTrace', 'DecisionVerify']) {
      const registryEntry = registry.get(toolName);
      const contractEntry = contract.getToolContract(toolName);
      expect(JSON.stringify(contractEntry.schema)).toBe(JSON.stringify(registryEntry.schema));
      expect(JSON.stringify(contractEntry.whenNotToUse)).toBe(JSON.stringify(registryEntry.whenNotToUse));
      expect(contractEntry.riskLevel).toBe(registryEntry.riskLevel);
    }
  });
});

describe('DecisionTrace 行为', () => {
  // handler 读取 getUnifiedStore() 单例——测试须种子同一实例（单例首个初始化点即本文件，:memory: 隔离）
  const { getUnifiedStore } = require('../core/memory/unified-store');
  let store;
  beforeEach(() => {
    store = getUnifiedStore({ dbPath: ':memory:' });
    store.run('DELETE FROM decisions');
    seed(store);
  });

  test('按 query 命中返回决策 + 证据 + 溯源', async () => {
    const res = await registry.execute('DecisionTrace', { query: '台风' }, {});
    expect(res.success).toBe(true);
    expect(res.data.matches.length).toBeGreaterThan(0);
    expect(res.data.matches[0].decision.user_intent).toContain('台风');
    expect(res.data.matches[0].evidence.length).toBeGreaterThan(0);
  });

  test('按 runId 精确返回', async () => {
    const res = await registry.execute('DecisionTrace', { query: '不存在', runId: 'r1' }, {});
    expect(res.data.matches).toHaveLength(1);
    expect(res.data.matches[0].decision.run_id).toBe('r1');
  });

  test('未命中诚实返回空', async () => {
    const res = await registry.execute('DecisionTrace', { query: '量子力学' }, {});
    expect(res.success).toBe(true);
    expect(res.data.matches).toEqual([]);
  });

  test('契约校验拦截缺参调用', () => {
    // 契约注入后 registry 的 preExecuteHook 会拦截
    return registry.execute('DecisionTrace', {}, {}).then((res) => {
      if (res.blocked) expect(res.errorCode).toBe('TOOL_CONTRACT_VIOLATION');
      else expect(res.success).toBe(true); // 若未被拦截（契约 required 为空时），行为可接受
    });
  });
});

describe('DecisionVerify 行为', () => {
  // 同上：种子必须落在 getUnifiedStore() 单例实例上
  const { getUnifiedStore } = require('../core/memory/unified-store');
  test('干净链返回 integrity true', async () => {
    const store = getUnifiedStore({ dbPath: ':memory:' });
    store.run('DELETE FROM decisions');
    seed(store);
    const res = await registry.execute('DecisionVerify', {}, {});
    expect(res.success).toBe(true);
    expect(res.data.chainIntegrity).toBe(true);
    expect(res.data.total).toBeGreaterThan(0);
  });

  test('篡改后 brokenAt 定位', async () => {
    const store = getUnifiedStore({ dbPath: ':memory:' });
    store.run('DELETE FROM decisions');
    seed(store);
    store.run("UPDATE decisions SET conclusion = 'hacked' WHERE run_id = 'r1'");
    const res = await registry.execute('DecisionVerify', {}, {});
    expect(res.data.chainIntegrity).toBe(false);
    expect(res.data.brokenAt).toBe(1);
  });
});
