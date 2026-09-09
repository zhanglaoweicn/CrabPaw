/**
 * memory-graph-honest.test.js — 图谱诚实化：无伪造默认节点/随机视觉边，实体图读真实 store 数据
 */
const { UnifiedMemoryStore } = require('../core/memory/unified-store');
const { MemoryGraph } = require('../core/panels/memory-graph');

const FAKE_IDS = ['welcome', 'knowledge', 'notes', 'chat', 'skills', 'tools', 'api', 'database', 'workflow', 'evolution', 'dashboard', 'search'];

describe('memory-graph 诚实化', () => {
  test('空图不注入伪造默认节点/视觉边', async () => {
    const graph = new MemoryGraph();
    graph._store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    graph._store.initialize();
    const data = await graph.getGraphData({ forceRefresh: true });
    expect(data.nodes.some((n) => FAKE_IDS.includes(n.id))).toBe(false);
    expect(data.edges.some((e) => e.label === '包含' || e.label === '关联')).toBe(false);
  });

  test('真实 entities/relations（含 decision 与 based_on）进入图谱', async () => {
    const store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    store.initialize();
    store.upsertEntity({ id: 'e1', name: '台风摩羯', kind: 'concept' });
    store.upsertEntity({ id: 'decision:r1', name: '台风摩羯路径', kind: 'decision' });
    store.upsertRelation({
      id: 'rel1', source_entity: 'decision:r1', target_entity: 'e1',
      relation_type: 'based_on', namespace: 'decision', confidence: 1.0,
      metadata: { source: 'decision' }, created_at: 1, updated_at: 1,
    });
    const graph = new MemoryGraph();
    graph._store = store;
    const nodeMap = new Map(); const edgeSet = new Set(); const nodes = []; const edges = [];
    await graph._extractEntityGraphData(nodeMap, edgeSet, nodes, edges, 100, 500);
    expect(nodes.some((n) => n.id === 'decision:r1')).toBe(true);
    expect(edges.some((e) => e.label === 'based_on')).toBe(true);
  });
});
