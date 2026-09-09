/**
 * decision-feed.test.js — SSE 决策旁路接线（折叠 → 落库，失败不阻断）
 */
const { UnifiedMemoryStore } = require('../core/memory/unified-store');
const { createFeed, installDecisionFeed } = require('../core/memory/decision-feed');

describe('decision-feed 接线', () => {
  let store, feed;
  beforeEach(() => {
    store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    store.initialize();
    feed = createFeed({ store });
  });

  test('脚本化事件序列 → decisions 落库（含意图/结论/证据）', () => {
    feed.feed('run:start', { roundId: 'r1', userInput: '台风路径' });
    feed.feed('tool_call', { toolName: 'KbSearch', toolId: 't1', toolArgs: '{"query":"a"}', roundId: 'r1' });
    feed.feed('tool_result', { toolName: 'KbSearch', toolId: 't1', success: true, result: '{"total":1}', roundId: 'r1' });
    feed.feed('gui_reply', { roundId: 'r1', content: '答案是 A', timestamp: 1 });
    feed.feed('run:finished', { roundId: 'r1', status: 'ok', ts: 2 });
    const row = store.get('SELECT * FROM decisions WHERE run_id = ?', ['r1']);
    expect(row).not.toBeNull();
    expect(row.user_intent).toBe('台风路径');
    expect(row.conclusion).toBe('答案是 A');
    expect(row.verdict).toBe('success');
    expect(JSON.parse(row.evidence_refs).length).toBe(1);
  });

  test('error 收尾 → verdict failed', () => {
    feed.feed('run:start', { roundId: 'r2' });
    feed.feed('run:error', { roundId: 'r2', ts: 1 });
    expect(store.get('SELECT verdict FROM decisions WHERE run_id = ?', ['r2']).verdict).toBe('failed');
  });

  test('落库失败不抛出（旁路铁律）', () => {
    // 注入一个 transaction 即抛错的 store，验证旁路吞异常
    const failingStore = new Proxy(store, {
      get(t, k) {
        if (k === 'transaction') return () => { throw new Error('db down'); };
        return t[k];
      },
    });
    const badFeed = createFeed({ store: failingStore });
    expect(() => {
      badFeed.feed('run:start', { roundId: 'r9' });
      badFeed.feed('run:finished', { roundId: 'r9', ts: 1 });
    }).not.toThrow();
  });

  test('installDecisionFeed 挂 global.__decisionFeed 并可复取', () => {
    const inst = installDecisionFeed({ store });
    expect(typeof global.__decisionFeed).toBe('function');
    global.__decisionFeed('run:start', { roundId: 'r5' });
    global.__decisionFeed('run:finished', { roundId: 'r5', ts: 1 });
    expect(store.get('SELECT COUNT(*) AS c FROM decisions').c).toBe(1);
    delete global.__decisionFeed;
  });
});
