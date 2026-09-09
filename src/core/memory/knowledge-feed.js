/**
 * knowledge-feed.js — 图谱实喂：会话消息/文档实体 → EntityCoOccurrenceGraph。
 * best-effort 铁律：无 graph/store/抽取失败均不抛，只记日志。
 */
const { extractEntities } = require('./entity-extractor');

let _graph = null;
let _store = null;

function setGraph(graph) { _graph = graph || null; }
function setStore(store) { _store = store || null; }
function getGraph() { return _graph; }

function loadHotwords() {
  if (!_store || typeof _store.all !== 'function') return [];
  try {
    const rows = _store.all('SELECT name FROM entities LIMIT 200');
    return (rows || []).map((r) => r.name).filter(Boolean);
  } catch (e) {
    console.warn('[knowledge-feed] 热词加载失败（降级空表）:', e.message);
    return [];
  }
}

function feedConversationMessage({ messageId, text }) {
  if (!_graph || !messageId || !text) return;
  try {
    const entities = extractEntities(text, loadHotwords());
    if (entities.length > 0) _graph.indexEntities(messageId, entities);
  } catch (e) {
    console.error('[knowledge-feed] 会话消息实体喂入失败（已忽略）:', e.message);
  }
}

function feedChunkEntities({ nodeId, entities }) {
  if (!_graph || !nodeId || !entities || entities.length === 0) return;
  try {
    _graph.indexEntities(nodeId, entities);
  } catch (e) {
    console.error('[knowledge-feed] 文档实体喂入失败（已忽略）:', e.message);
  }
}

module.exports = { setGraph, setStore, getGraph, feedConversationMessage, feedChunkEntities };
