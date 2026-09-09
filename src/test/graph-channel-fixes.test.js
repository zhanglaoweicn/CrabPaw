/**
 * graph-channel-fixes.test.js — 图谱落库列修正 + 检索图谱通道激活
 */
const { UnifiedMemoryStore } = require('../core/memory/unified-store');
const { EntityCoOccurrenceGraph } = require('../core/memory/entity-graph');
const { HybridRetrievalEngine } = require('../core/memory/hybrid-retrieval');

describe('addTypedRelation 落库列修正', () => {
  test('TypedRelation 真实写入 relations 表（source_entity/target_entity + metadata.source）', () => {
    const store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    store.initialize();
    store.upsertEntity({ id: 'e1', name: '台风摩羯', kind: 'concept' });
    store.upsertEntity({ id: 'e2', name: '出行', kind: 'concept' });
    const graph = new EntityCoOccurrenceGraph(store);
    graph.addTypedRelation({ subject: 'e1', relationType: 'affects', object: 'e2', confidence: 0.9, source: 'auto_discovery' });
    const row = store.get('SELECT * FROM relations WHERE source_entity = ? AND target_entity = ?', ['e1', 'e2']);
    expect(row).not.toBeNull();
    expect(row.relation_type).toBe('affects');
    expect(JSON.parse(row.metadata).source).toBe('auto_discovery');
  });
});

describe('getNodesForEntity 反向索引', () => {
  test('store 路径返回 node_id 列表', () => {
    const store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    store.initialize();
    const graph = new EntityCoOccurrenceGraph(store);
    graph.indexEntities('chunkA', [{ id: '台风摩羯', kind: 'concept' }]);
    expect(graph.getNodesForEntity('台风摩羯')).toContain('chunkA');
  });

  test('无 store 时回退内存反向索引', () => {
    const graph = new EntityCoOccurrenceGraph(null);
    graph.indexEntities('chunkB', ['股票']);
    expect(graph.getNodesForEntity('股票')).toContain('chunkB');
  });

  test('clearNode 同步清理反向索引（无残留 nodeId）', () => {
    const graph = new EntityCoOccurrenceGraph(null);
    graph.indexEntities('chunkC', ['行情']);
    graph.clearNode('chunkC');
    expect(graph.getNodesForEntity('行情')).not.toContain('chunkC');
    expect(graph._entityReverseIndex.has('行情')).toBe(false);
  });
});

describe('extractEntities 委托', () => {
  test('graph.extractEntities 委托 entity-extractor', () => {
    const graph = new EntityCoOccurrenceGraph(null);
    expect(graph.extractEntities('分析"铁血丹心"', ['铁血丹心'])).toContain('铁血丹心');
  });
});

describe('hybrid-retrieval 图谱通道', () => {
  test('种子图 + store → graph 通道返回结果（_source=graph）', async () => {
    const store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    store.initialize();
    store.upsertEntity({ id: 'e1', name: '台风', kind: 'concept' });
    store.addMemory({ id: 'm1', content: '台风摩羯登陆路径', title: '台风记录', namespace: 'global' });
    const graph = new EntityCoOccurrenceGraph(store);
    graph.indexEntities('m1', [{ id: '台风', kind: 'concept' }]);
    const engine = new HybridRetrievalEngine({ store, entityGraph: graph, useRRF: false });
    // 引号包裹：pattern 抽取器对裸词不提取，必须带引号/书名号等标记
    const results = await engine._searchGraph('"台风"', 'global', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]._source).toBe('graph');
  });
});
