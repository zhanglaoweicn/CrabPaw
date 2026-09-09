/**
 * knowledge-feed.test.js — 图谱实喂（会话/文档实体 → EntityCoOccurrenceGraph.indexEntities）
 */
const { UnifiedMemoryStore } = require('../core/memory/unified-store');
const { EntityCoOccurrenceGraph } = require('../core/memory/entity-graph');
const { setGraph, setStore, feedConversationMessage, feedChunkEntities } = require('../core/memory/knowledge-feed');

describe('knowledge-feed 图谱实喂', () => {
  let store, graph;
  beforeEach(() => {
    store = new UnifiedMemoryStore({ dbPath: ':memory:' });
    store.initialize();
    graph = new EntityCoOccurrenceGraph(store);
    setGraph(graph);
    setStore(store);
  });

  test('会话消息抽取实体并喂入 graph（内存态 + entity_index）', () => {
    feedConversationMessage({ messageId: 'msg1', text: '请分析"铁血丹心"这首歌的歌词' });
    expect(graph._entityIndex.has('msg1')).toBe(true);
    expect(graph.getNodesForEntity('铁血丹心')).toContain('msg1');
    const row = store.get('SELECT * FROM entity_index WHERE entity_id = ?', ['铁血丹心']);
    expect(row).not.toBeNull();
  });

  test('feedChunkEntities 直接喂入', () => {
    feedChunkEntities({ nodeId: 'chunk1', entities: ['台风摩羯'] });
    expect(graph._entityIndex.has('chunk1')).toBe(true);
    expect(graph.getNodesForEntity('台风摩羯')).toContain('chunk1');
  });

  test('热词来自既有实体库（无 store 时降级空表）', () => {
    store.upsertEntity({ id: 'e1', name: '股票', kind: 'concept' });
    feedConversationMessage({ messageId: 'msg2', text: '今天股票走势怎么样' });
    expect(graph.getNodesForEntity('股票')).toContain('msg2');
  });

  test('无 graph / 无 store 不抛异常（best-effort 铁律）', () => {
    setGraph(null);
    setStore(null);
    expect(() => feedConversationMessage({ messageId: 'm', text: 'x' })).not.toThrow();
    expect(() => feedChunkEntities({ nodeId: 'c', entities: ['y'] })).not.toThrow();
  });
});
