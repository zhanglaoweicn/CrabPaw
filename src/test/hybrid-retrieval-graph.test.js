/**
 * hybrid-retrieval-graph.test.js — _searchGraph 图谱通道回归（Task 6「rename 无专用
 * 回归测试」补账）。旧守卫（_entityGraph 恒为 null）掩盖了 coOccurringEntities 返回
 * GraphEdge 对象却被当字符串传 getNodesForEntity 的分支损坏（I2）：store 路径绑定
 * 抛错被外层 catch 吞掉、内存回退路径字符串 vs 对象比对恒空。
 */
const { HybridRetrievalEngine } = require('../core/memory/hybrid-retrieval');

/**
 * 构造与真实 EntityCoOccurrenceGraph 同款契约的 mock：
 * - neighbors 返回实体名字符串数组（真实实现为 edges.map(e => e.object)）
 * - coOccurringEntities 返回 GraphEdge 同形状对象数组（负向验证用）
 * - getNodesForEntity 按字符串 key 查对象（真实内存回退路径语义：传对象恒 miss）
 */
function makeGraphMock() {
  const getNodesCalls = [];
  const nodeMap = { 台风: ['m1'], 天气: ['m2'] };
  const graph = {
    extractEntities: () => ['台风'],
    getNodesForEntity: (entity) => {
      getNodesCalls.push(entity);
      return nodeMap[entity] || [];
    },
    neighbors: (entity) => (entity === '台风' ? ['天气'] : []),
    coOccurringEntities: (entity) => (entity === '台风'
      ? [{ subject: '台风', object: '天气', weight: 2 }]
      : []),
  };
  return { graph, getNodesCalls };
}

describe('_searchGraph 图谱通道（I2 回归）', () => {
  test('neighbors 映射后扩展节点进入结果，getNodesForEntity 收到的全是字符串', async () => {
    const { graph, getNodesCalls } = makeGraphMock();
    const store = {
      getMemory: (id) => ({ id, content: `${id} 内容` }),
    };
    const engine = new HybridRetrievalEngine({ store, entityGraph: graph, useRRF: false });
    const results = await engine._searchGraph('"台风" 影响', 'global', 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.id)).toContain('m1');
    // 共现实体「天气」的节点 m2 必须经 neighbors 扩展进入结果（旧实现走
    // coOccurringEntities 传对象 → nodeMap[GraphEdge] 恒 miss → m2 永不出现）
    expect(results.map((r) => r.id)).toContain('m2');
    expect(results.every((r) => r._source === 'graph')).toBe(true);
    expect(getNodesCalls.length).toBeGreaterThan(0);
    for (const arg of getNodesCalls) {
      expect(typeof arg).toBe('string');
    }
  });

  test('_searchGraph 不抛错且不产生 console.warn', async () => {
    const { graph } = makeGraphMock();
    const store = { getMemory: (id) => ({ id, content: 'c' }) };
    const engine = new HybridRetrievalEngine({ store, entityGraph: graph, useRRF: false });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const results = await engine._searchGraph('"台风"', 'global', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('无实体提取时诚实返回空', async () => {
    const { graph } = makeGraphMock();
    graph.extractEntities = () => [];
    const engine = new HybridRetrievalEngine({ store: { getMemory: () => null }, entityGraph: graph, useRRF: false });
    expect(await engine._searchGraph('无实体查询', 'global', 10)).toEqual([]);
  });

  test('未接线图谱时返回空（守卫不回归）', async () => {
    const engine = new HybridRetrievalEngine({ store: {}, useRRF: false });
    expect(await engine._searchGraph('任意', 'global', 10)).toEqual([]);
  });
});
