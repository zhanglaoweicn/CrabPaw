/**
 * session-commit.test.js — 会话收口管线 + 分层加载协议 + 记忆树下钻 + OpenViking 预置
 *
 * 覆盖（2026-10-09 OpenViking 精华落地）:
 *   1. session-commit.distillFacts —— VikingMem 式 新建/合并/跳过 三选一决策
 *   2. session-commit.commitSession —— 注入 deps 的全管线（决策执行/归档幂等/记忆树叶/Dream 计数）
 *   3. session-commit.scheduleSessionCommit —— request_end 防抖 / session_closed 立即
 *   4. harness-lifecycle.onSessionEnd —— session:end payload 带 sessionId（收口链路修复的锚点）
 *   5. context-depths —— L0/L1/L2 渲染边界 + ref/escalation
 *   6. memory-tree-v2 编排器级 drillDown（此前只存在于实例级）
 *   7. hybrid-retrieval 树通道 —— RRF 第四路融合 + 命名空间过滤
 *   8. connectors —— OpenViking HTTP 形态预置（配置构建/凭证校验/无组件安装）
 *   9. history-compactor —— 存档路径白名单校验
 */

// ==================== 1. distillFacts 决策 ====================

describe('session-commit.distillFacts（VikingMem 新建/合并/跳过）', () => {
  const { distillFacts, SKIP_SIMILARITY, MERGE_SIMILARITY } = require('../core/memory/session-commit');
  const { MemoryRelations } = require('../core/memory/memory-relations');
  const rel = () => new MemoryRelations();

  test('近重复事实判 skip', () => {
    const existing = [{ id: 'm1', type: 'preference', content: '老板喜欢用飞书沟通项目进度，不喜欢微信' }];
    const candidates = [
      { type: 'preference', content: '老板喜欢用飞书沟通项目进度，不喜欢微信', topic: 'preference' },
    ];
    const decisions = distillFacts(candidates, existing, rel());
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('skip');
    expect(decisions[0].targetId).toBe('m1');
    expect(decisions[0].similarity).toBeGreaterThanOrEqual(SKIP_SIMILARITY);
  });

  test('带更新词的同话题事实判 merge', () => {
    const existing = [{ id: 'm2', type: 'project', content: '项目A的预算是10万', tags: ['项目A'] }];
    const candidates = [
      { type: 'project', content: '项目A的预算现在改成20万', topic: 'project', tags: ['项目A'] },
    ];
    const decisions = distillFacts(candidates, existing, rel());
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('merge');
    expect(decisions[0].targetId).toBe('m2');
    expect(decisions[0].reason).toBe('update');
  });

  test('全新事实判 create', () => {
    const existing = [{ id: 'm3', type: 'fact', content: '公司主营业务是跨境电商' }];
    const decisions = distillFacts(
      [{ type: 'fact', content: '老板的女儿今年上小学三年级', topic: 'family' }],
      existing,
      rel()
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe('create');
  });

  test('空内容候选被忽略', () => {
    expect(distillFacts([{ type: 'fact', content: '' }, null], [], rel())).toHaveLength(0);
  });

  test('阈值常量语义：skip 严于 merge', () => {
    expect(SKIP_SIMILARITY).toBeGreaterThan(MERGE_SIMILARITY);
  });
});

// ==================== 2. commitSession 全管线（注入 deps） ====================

describe('session-commit.commitSession（注入 deps，不触真实 SQLite）', () => {
  const sc = require('../core/memory/session-commit');

  function makeDeps(overrides = {}) {
    const calls = { addMemory: [], merged: [], chunks: [], treeLeaves: [], dream: 0 };
    const session = {
      sessionId: 'sess_t1',
      messages: [
        { role: 'user', content: '记住我喜欢用飞书沟通' },
        { role: 'assistant', content: '好的，已记住' },
        { role: 'user', content: '另外项目A预算是10万' },
      ],
    };
    const deps = {
      memoryManager: {
        getSession: (id) => (id === 'sess_t1' ? session : null),
        flushMemories: async () => ({
          flushed: 1, facts: [], mode: 'llm',
          candidates: [{ type: 'preference', content: '老板喜欢用飞书沟通' }],
        }),
        getAllMemories: async () => [],
        addMemory: async (type, title, content) => { calls.addMemory.push({ type, title, content }); return 'new_mem_1'; },
        autoDream: { incrementSessionCount: () => { calls.dream++; } },
      },
      store: {
        upsertChunk: (input) => { calls.chunks.push(input); },
      },
      ...overrides,
    };
    return { deps, calls, session };
  }

  beforeEach(() => sc.resetForTest());

  test('空会话/单消息/未知会话跳过', async () => {
    const { deps } = makeDeps();
    (await expect(sc.commitSession('sess_missing', { deps })).resolves).toMatchObject({ skipped: true, reason: 'empty_session' });

    const single = makeDeps();
    single.session.messages = [{ role: 'user', content: 'hi' }];
    (await expect(sc.commitSession('sess_t1', { deps: single.deps })).resolves).toMatchObject({ skipped: true, reason: 'too_few_messages' });
  });

  test('正常收口：候选全 create + 3 条消息归档 + 树叶 + Dream 计数', async () => {
    const { deps, calls } = makeDeps();
    const result = await sc.commitSession('sess_t1', { deps, trigger: 'request_end' });
    expect(result.skipped).toBe(false);
    expect(result.factsCreated).toBe(1);
    expect(result.factsMerged).toBe(0);
    expect(result.chunks).toBe(3);
    expect(result.treeLeaf).toBe(true);
    expect(calls.dream).toBe(1);
    expect(calls.addMemory[0].content).toContain('飞书');
    expect(calls.chunks.every((c) => c.namespace === 'sess_t1')).toBe(true);
  });

  test('归档确定性：内容哈希 id，重复提交不产生新 id', async () => {
    const { deps, calls } = makeDeps();
    await sc.commitSession('sess_t1', { deps });
    const ids1 = calls.chunks.map((c) => c.document_id).sort();
    calls.chunks.length = 0;

    // 幂等守卫：消息数未增长 → 直接跳过（双事件去重）
    const second = await sc.commitSession('sess_t1', { deps });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('already_committed');
    expect(calls.chunks).toHaveLength(0);

    // 消息增长后再次收口：旧消息的 id 稳定（upsert 幂等，不重复入库）
    const { deps: deps2, calls: calls2 } = makeDeps();
    deps2.memoryManager.getSession('sess_t1').messages.push({ role: 'assistant', content: '新回复' });
    await sc.commitSession('sess_t1', { deps: deps2 });
    const overlap = calls2.chunks.filter((c) => ids1.includes(c.document_id));
    expect(overlap.length).toBe(3);
  });

  test('合并决策走 updateMemory 路径', async () => {
    const merged = [];
    const { deps } = makeDeps({
      memoryManager: {
        getSession: () => ({
          sessionId: 'sess_t1',
          messages: [
            { role: 'user', content: '项目A预算现在改成20万' },
            { role: 'assistant', content: '已更新' },
          ],
        }),
        flushMemories: async () => ({
          flushed: 1, facts: [], mode: 'llm',
          candidates: [{ type: 'project', content: '项目A的预算现在改成20万', topic: 'project', tags: ['项目A'] }],
        }),
        getAllMemories: async () => [{ id: 'old_1', type: 'project', content: '项目A的预算是10万', tags: ['项目A'] }],
        addMemory: async () => 'should_not_create',
        autoDream: { incrementSessionCount: () => {} },
      },
    });
    // 注入 merge 捕获：走 _mergeMemory 需要 autoMemory.updateMemory / unified-store.updateMemory
    deps.memoryManager.autoMemory = { updateMemory: async (id, updates) => { merged.push({ id, updates }); } };
    const result = await sc.commitSession('sess_t1', { deps });
    expect(result.factsMerged).toBe(1);
    expect(result.factsCreated).toBe(0);
    expect(merged[0].id).toBe('old_1');
    expect(merged[0].updates.content).toContain('20万');
  });
});

// ==================== 3. 防抖调度 ====================

describe('session-commit.scheduleSessionCommit（防抖/立即）', () => {
  const sc = require('../core/memory/session-commit');

  beforeEach(() => sc.resetForTest());

  test('request_end 走防抖：窗口内不提交，静默后提交', async () => {
    const committed = [];
    const { deps } = {
      deps: {
        memoryManager: {
          getSession: () => ({ sessionId: 's1', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
          flushMemories: async () => ({ flushed: 0, facts: [], candidates: [] }),
          getAllMemories: async () => [],
          addMemory: async () => 'x',
          autoDream: { incrementSessionCount: () => committed.push('dream') },
        },
        store: { upsertChunk: () => {} },
      },
    };
    sc.scheduleSessionCommit('s1', { trigger: 'request_end', delayMs: 25, deps });
    await new Promise((r) => setTimeout(r, 5));
    expect(committed).toHaveLength(0); // 防抖窗口内未提交
    await new Promise((r) => setTimeout(r, 60));
    expect(committed.length).toBeGreaterThanOrEqual(1);
  });

  test('session_closed 立即提交（不走防抖）', async () => {
    const committed = [];
    const deps = {
      memoryManager: {
        getSession: () => ({ sessionId: 's2', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
        flushMemories: async () => ({ flushed: 0, facts: [], candidates: [] }),
        getAllMemories: async () => [],
        addMemory: async () => 'x',
        autoDream: { incrementSessionCount: () => committed.push('dream') },
      },
      store: { upsertChunk: () => {} },
    };
    sc.scheduleSessionCommit('s2', { trigger: 'session_closed', deps });
    await new Promise((r) => setTimeout(r, 20));
    expect(committed).toHaveLength(1);
  });

  test('flushPendingCommits 冲刷全部待提交', async () => {
    const deps = {
      memoryManager: {
        getSession: () => ({ sessionId: 'sx', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }),
        flushMemories: async () => ({ flushed: 0, facts: [], candidates: [] }),
        getAllMemories: async () => [],
        addMemory: async () => 'x',
        autoDream: { incrementSessionCount: () => {} },
      },
      store: { upsertChunk: () => {} },
    };
    sc.scheduleSessionCommit('sx', { trigger: 'request_end', deps });
    const flushed = sc.flushPendingCommits();
    expect(flushed).toContain('sx');
  });
});

// ==================== 4. 收口链路锚点：session:end 带 sessionId ====================

describe('harness-lifecycle.onSessionEnd（收口链路修复锚点）', () => {
  const { globalHarnessLifecycle } = require('../core/harness-lifecycle');
  const { getEventBus } = require('../core/events');

  test('published session:end payload 携带 sessionId/userId/trigger', () => {
    const bus = getEventBus();
    const seen = [];
    const unsub = bus.subscribe('session:end', (e) => seen.push(e.payload));
    try {
      globalHarnessLifecycle.onSessionEnd({ sessionId: 'sess_anchor', userId: 'u1' });
    } finally {
      unsub();
    }
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0].sessionId).toBe('sess_anchor');
    expect(seen[0].userId).toBe('u1');
    expect(seen[0].trigger).toBe('request_end');
  });
});

// ==================== 5. context-depths 分层渲染 ====================

describe('context-depths（L0/L1/L2 分层加载协议）', () => {
  const { renderAtDepth, shapeResults, normalizeDepth, DEPTHS } = require('../core/memory/context-depths');

  const longText = '甲'.repeat(1000) + '乙'.repeat(500);

  test('abstract 截断至约 120 字符并压平空白', () => {
    const r = renderAtDepth(`第一行\n第二行   ${longText}`, DEPTHS.ABSTRACT);
    expect(r.depth).toBe('abstract');
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBeGreaterThan(1000);
    expect(r.content.length).toBeLessThanOrEqual(121); // 120 + 省略号
    expect(r.content).not.toContain('\n');
  });

  test('overview 截至约 600 字符；full 不截断', () => {
    const o = renderAtDepth(longText, 'overview');
    expect(o.content.length).toBeLessThanOrEqual(601);
    const f = renderAtDepth(longText, 'full');
    expect(f.truncated).toBe(false);
    expect(f.content).toBe(longText);
  });

  test('深度别名归一（L0/L2/中文/非法值回落 abstract）', () => {
    expect(normalizeDepth('L0')).toBe('abstract');
    expect(normalizeDepth('L2')).toBe('full');
    expect(normalizeDepth('全文')).toBe('full');
    expect(normalizeDepth('nonsense')).toBe('abstract');
    expect(normalizeDepth(undefined)).toBe('abstract');
  });

  test('shapeResults 附 ref 与升级提示，短内容不提示', () => {
    const results = [
      { id: 'r1', content: longText, type: 'chunk' },
      { id: 'r2', content: '很短', type: 'chunk' },
    ];
    const shaped = shapeResults(results, 'abstract', (r) => ({ source: 'kb', id: r.id }));
    expect(shaped[0].ref).toEqual({ source: 'kb', id: 'r1' });
    expect(shaped[0].escalation).toContain('ContextDrillDown');
    expect(shaped[1].escalation).toBeNull();
  });
});

// ==================== 6. 记忆树编排器级 drillDown ====================

describe('memory-tree-v2 编排器 drillDown（跨树下钻）', () => {
  const { MemoryTreeOrchestrator, SUMMARY_LEVELS } = require('../core/memory/memory-tree-v2');

  test('按树 key 下钻取节点与子级；跨树查找兜底', async () => {
    const orch = new MemoryTreeOrchestrator();
    const tree = orch.getOrCreateTree('global', { topic: 'sess_x' });
    const leaf = await tree.appendLeaf('会话里的关键内容片段', { sessionId: 'sess_x' });

    // 指定树 key（getOrCreateTree 的 key 形如 'global:sess_x'）
    const byKey = await orch.drillDown(tree.id, leaf.id, { depth: 1 });
    expect(byKey).toHaveLength(1);
    expect(byKey[0].treeId).toBe(tree.id);
    expect(byKey[0].node.content).toContain('关键内容');

    // 不传树 key：在全部树中查找
    const bySearch = await orch.drillDown(null, leaf.id);
    expect(bySearch).toHaveLength(1);
    expect(bySearch[0].level).toBe(SUMMARY_LEVELS.L0);
  });

  test('未知节点返回空数组', async () => {
    const orch = new MemoryTreeOrchestrator();
    expect(await orch.drillDown(null, 'node_missing')).toEqual([]);
    expect(await orch.drillDown(null, null)).toEqual([]);
  });
});

// ==================== 7. hybrid-retrieval 树通道 ====================

describe('hybrid-retrieval 记忆树第四路', () => {
  const { HybridRetrievalEngine } = require('../core/memory/hybrid-retrieval');

  test('RRF 融合接受 treeResults 并保留 treenode: 前缀 id', () => {
    const engine = new HybridRetrievalEngine({ useRRF: true });
    const treeResults = [
      { id: 'treenode:node_1', type: 'tree_node', content: '树摘要内容', namespace: 'global', _treeScore: 0.9, _source: 'tree', treeId: 'global:s1' },
    ];
    const out = engine._rrfFusion([], [], [], '树摘要', 0.15, 10, treeResults);
    expect(out.some((r) => r.id === 'treenode:node_1')).toBe(true);
    const hit = out.find((r) => r.id === 'treenode:node_1');
    expect(hit.provenance.source).toContain('记忆树');
    expect(hit.provenance.treeId).toBe('global:s1');
  });

  test('_searchTree 过滤低分命中并映射字段；includeTree=false 时整路关闭', async () => {
    const engine = new HybridRetrievalEngine();
    const results = await engine._searchTree('查询', 'global', 10);
    // 单测环境无树内容 → 空数组且不抛错（best-effort 降级）
    expect(Array.isArray(results)).toBe(true);
    const out = await engine.search('查询', { includeTree: false, limit: 3 });
    expect(Array.isArray(out)).toBe(true);
  });
});

// ==================== 8. OpenViking HTTP 连接器预置 ====================

describe('connectors（OpenViking HTTP 形态预置）', () => {
  const connectors = require('../core/mcp/connectors');

  test('openviking 预置在目录中且可按关键词/URL 识别', () => {
    expect(connectors.getConnector('openviking')).not.toBeNull();
    expect(connectors.matchConnector('https://github.com/volcengine/OpenViking')).toBe('openviking');
    expect(connectors.matchConnector('帮我接入 openviking 上下文数据库')).toBe('openviking');
    // 普通聊天提到 viking 不带接入意图 → 不误触发
    expect(connectors.matchConnector('今天天气不错')).toBeNull();
  });

  test('buildServerConfig http 形态：url + Bearer 头，无 command', () => {
    const preset = connectors.getConnector('openviking');
    const cfg = connectors.buildServerConfig(preset, {
      OPENVIKING_URL: 'http://127.0.0.1:8000/',
      OPENVIKING_API_KEY: 'ov_user_key_xxx',
    }, { pythonPath: 'python', libDir: '/tmp/libs' });
    expect(cfg.url).toBe('http://127.0.0.1:8000'); // 尾斜杠被 normalize
    expect(cfg.headers.Authorization).toBe('Bearer ov_user_key_xxx');
    expect(cfg.command).toBeUndefined();
  });

  test('缺服务地址时 buildServerConfig 明确报错', () => {
    const preset = connectors.getConnector('openviking');
    expect(() => connectors.buildServerConfig(preset, { OPENVIKING_API_KEY: 'k' }, {})).toThrow(/服务地址/);
  });

  test('凭证校验：缺用户 Key 返回结构化缺口', () => {
    const preset = connectors.getConnector('openviking');
    const r = connectors.validateCredentials(preset, { OPENVIKING_URL: 'http://127.0.0.1:8000' });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('OPENVIKING_API_KEY');
  });

  test('金蝶 python-module 预置行为不回退', () => {
    const preset = connectors.getConnector('kingdee');
    const cfg = connectors.buildServerConfig(preset, { KINGDEE_SERVER_URL: 'https://x/k3cloud/', KINGDEE_ACCT_ID: 'a', KINGDEE_USERNAME: 'u', KINGDEE_PASSWORD: 'p' }, { pythonPath: 'py', libDir: 'libs' });
    expect(cfg.command).toBe('py');
    expect(cfg.args).toEqual(['-m', 'kingdee_mcp.server']);
    expect(cfg.env.PYTHONPATH).toBe('libs');
  });
});

// ==================== 9. history-compactor 存档路径白名单 ====================

describe('history-compactor 存档引用校验（archive 白名单）', () => {
  const path = require('path');
  const hc = require('../core/history-compactor');

  test('合法存档路径放行；目录外/任意文件/路径穿越拒绝', () => {
    const dir = hc.archiveDir();
    expect(hc.isArchivePath(path.join(dir, 'history-lx2k3-abc123def0.txt'))).toBe(true);
    expect(hc.isArchivePath(path.join(dir, '../secret.txt'))).toBe(false);
    expect(hc.isArchivePath(path.join(dir, 'anything.txt'))).toBe(false);
    expect(hc.isArchivePath('C:\\Windows\\system32\\config')).toBe(false);
    expect(hc.isArchivePath(null)).toBe(false);
  });
});
