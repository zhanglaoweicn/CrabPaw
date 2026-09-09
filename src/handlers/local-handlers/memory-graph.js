// memory-graph.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { sendJson } = require('../http-utils');

// Override handleMemoryGraph from sub-module: use globalMemoryGraph as primary source
async function handleMemoryGraph(req, res, ctx) {
  try {
    // 1. Try globalMemoryGraph from panels/memory-graph.js
    try {
      const { globalMemoryGraph } = require('../../core/panels/memory-graph');
      const data = await globalMemoryGraph.getGraphData();
      if (data && data.nodes) {
        const transformed = {
          nodes: data.nodes.map(n => ({
            id: n.id,
            label: n.label,
            type: n.type,
            trustScore: n.salience || 0.5,
            size: n.size || 3,
          })),
          edges: (data.edges || []).map(e => ({
            source: e.source,
            target: e.target,
            weight: e.weight,
          })),
        };
        return sendJson(res, 200, { success: true, data: transformed });
      }
    } catch (e) {

      // globalMemoryGraph unavailable, fall through

      console.warn('[memory-graph.js] 空 catch 补日志:', e && e.message);
    }


    // 2. Fallback: EntityCoOccurrenceGraph from entity-graph.js
    try {
      const { EntityCoOccurrenceGraph } = require('../../core/memory/entity-graph');
      // Try to find an existing instance from server context
      let entityGraph = ctx._entityGraph || ctx.entityGraph;
      if (!entityGraph) {
        entityGraph = new EntityCoOccurrenceGraph(null);
      }
      const stats = entityGraph.getEntityStats();
      if (stats && stats.entityCount > 0) {
        const nodes = [];
        const edges = [];
        const seenEntities = new Set();

        // Extract nodes from edge cache
        for (const [key, entry] of entityGraph._edgeCache || []) {
          const [a, b] = key.split('|');
          if (!a || !b) continue;
          if (!seenEntities.has(a)) {
            seenEntities.add(a);
            nodes.push({ id: a, label: a, type: 'entity', trustScore: 0.5, size: 3 });
          }
          if (!seenEntities.has(b)) {
            seenEntities.add(b);
            nodes.push({ id: b, label: b, type: 'entity', trustScore: 0.5, size: 3 });
          }
          edges.push({ source: a, target: b, weight: entry.weight || 1 });
        }

        if (nodes.length > 0 || edges.length > 0) {
          return sendJson(res, 200, { success: true, data: { nodes, edges } });
        }
      }
    } catch (e) {

      // EntityCoOccurrenceGraph unavailable, fall through

      console.warn('[memory-graph.js] 空 catch 补日志:', e && e.message);
    }


    // 3. Last resort: empty graph
    return sendJson(res, 200, { success: true, data: { nodes: [], edges: [] } });
  } catch (e) {
    return sendJson(res, 200, { success: true, data: { nodes: [], edges: [] } });
  }
}

module.exports = {
  handleMemoryGraph,
};
