/**
 * Memory Graph — 记忆图谱可视化
 *
 * 将 CrabPaw 的记忆系统（entity-graph + memory-relations + memory-tree）
 * 转化为 D3 兼容的图谱数据，供可视化展示。
 *
 * 记忆节点图（Brain UI 中的 D3 force-directed graph）：
 * 节点 = 实体/记忆条目，逻辑 = 关联/关系，节点大小 = salience/重要性
 *
 * 输出格式兼容：
 * { nodes: [{ id, label, group, size, type }],
 * edges: [{ source, target, weight, label }] }
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

// 中文停用词（精简版，常见词）
const STOP_WORDS_CN = new Set([
 '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '一个', '一些',
 '和', '与', '或', '但', '而', '也', '都', '就', '不', '没', '有', '为', '以', '及',
 '把', '被', '给', '让', '从', '到', '向', '对', '于', '上', '下', '里', '中', '外',
 '前', '后', '时', '候', '间', '日', '月', '年', '次', '种', '样', '个', '本', '该',
 '我们', '你们', '他们', '它们', '自己', '因为', '所以', '如果', '虽然', '然后', '但是',
 '什么', '怎么', '为什么', '可以', '可能', '应该', '需要', '通过', '使用', '进行',
 '不是', '就是', '只是', '还是', '现在', '之前', '之后', '这样', '那样', '已经', '正在',
 '这个', '那个', '这些', '那些', '一个', '一些', '所有', '每个', '其他', '另外',
]);

// 简易字符串哈希（用于 nodeId）
function hashId(str) {
 let h = 0;
 for (let i = 0; i < str.length; i++) {
 h = ((h << 5) - h) + str.charCodeAt(i);
 h = h & 0x7fffffff;
 }
 return h.toString(36);
}

class MemoryGraph extends EventEmitter {
 constructor() {
 super();
 this._cache = null;
 this._cacheTs = 0;
 this._cacheTtl = 30000; // 30s cache
 }

 /**
 * 获取完整图谱数据（D3 格式）
 * @param {object} options
 * @param {boolean} options.forceRefresh 强制刷新缓存
 * @param {number} options.maxNodes 最大节点数（默认 200）
 * @param {number} options.maxEdges 最大边数（默认 500）
 * @returns {object} { nodes, edges, stats }
 */
 async getGraphData(options = {}) {
 const now = Date.now();
 console.log('[MEMORY-GRAPH] getGraphData called, forceRefresh:', options.forceRefresh, 'cache:', !!this._cache);
 
 // 2026-08-25 场景轮询风暴修复：TTL 内绝不重建——forceRefresh 不再无条件绕过缓存。
 // scene-bridge 每 8s 轮询×全量重建(800 节点实体提取)曾把 GUI renderer 拖死(输入框无响应)。
 // 新鲜度由 clearCache(记忆写入)与 TTL 过期共同保证；forceRefresh 仅在 TTL 外才生效。
 if (this._cache && now - this._cacheTs < this._cacheTtl) {
 console.log('[MEMORY-GRAPH] Returning cached data');
 return this._cache;
 }

 const maxNodes = options.maxNodes || 2000;
 const maxEdges = options.maxEdges || 5000;

 const nodes = [];
 const edges = [];
 const nodeMap = new Map(); // id → node
 const edgeSet = new Set(); // "source|target" → boolean

 // 1. 从 EntityCoOccurrenceGraph 获取实体/关系数据
 try {
 await this._extractEntityGraphData(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges);
 console.log('[MEMORY-GRAPH] After entity-graph: nodes=', nodes.length, 'edges=', edges.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting entity-graph:', e.message);
 }

 // 2. 从 MemoryTree 获取记忆树节点
 try {
 await this._extractMemoryTreeData(nodeMap, edgeSet, nodes, edges, maxNodes);
 console.log('[MEMORY-GRAPH] After memory-tree: nodes=', nodes.length, 'edges=', edges.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting memory-tree:', e.message);
 }

 // 3. 从 memory-system 获取笔记数据（fallback，确保总有内容展示）
 try {
 await this._extractMemoryNotesData(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges);
 console.log('[MEMORY-GRAPH] After memory-notes: nodes=', nodes.length, 'edges=', edges.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting memory-notes:', e.message);
 }

 // 3.5 从 content/title 提取关键词作为额外节点（风格：实体+关系）
 try {
 await this._extractContentEntities(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges);
 console.log('[MEMORY-GRAPH] After content-entities: nodes=', nodes.length, 'edges=', edges.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting content entities:', e.message);
 }

 // 3. 从 documents 表读取对话消息（1260 条数据，节点图最大来源）
 try {
 await this._extractDocuments(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges);
 console.log('[MEMORY-GRAPH] After documents: nodes=', nodes.length, 'edges=', edges.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting documents:', e.message);
 }

 // 4. 从 skill 系统读取技能节点
 try {
 await this._extractSkills(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges);
 console.log('[MEMORY-GRAPH] After skills: nodes=', nodes.length, 'edges=', edges.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting skills:', e.message);
 }

 // 4.5 添加会话数据作为节点（风格：每个 session 都是有意义的实体）
 try {
 await this._extractSessionData(nodeMap, edgeSet, nodes, edges, maxNodes);
 console.log('[MEMORY-GRAPH] After sessions: nodes=', nodes.length, 'edges=', edges.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting sessions:', e.message);
 }

 console.log('[MEMORY-GRAPH] Final result - nodes:', nodes.length, 'edges:', edges.length);

 // 7. 从 memory-system 获取记忆统计
 let memoryStats = { total: 0, byType: {} };
 try {
 const ms = require('../memory-system');
 if (ms.getStats) memoryStats = ms.getStats();
 } catch (e) {
   /* noop */
   console.warn('[memory-graph.js] 空 catch 补日志:', e && e.message);
 }

 // 8. 最终校验：过滤掉 source/target 不在 nodeMap 中的孤儿边
 // 防御性：多轮提取（entity-graph/memory-tree/documents/skills/sessions）可能产生
 // 引用缺失节点的边（如 entity-graph 的 subject 拼写差异、documents 限流后 id 漂移）
 // 这些孤儿边会令 d3-forceLink 抛 "node not found" 异常并导致整张图崩溃
 const nodeIdSet = new Set(nodes.map(n => String(n.id)));
 const validEdges = [];
 let orphanCount = 0;
 for (const e of edges) {
 const s = typeof e.source === 'object' ? (e.source && e.source.id) : e.source;
 const t = typeof e.target === 'object' ? (e.target && e.target.id) : e.target;
 if (s == null || t == null) { orphanCount++; continue; }
 const sOk = nodeIdSet.has(String(s));
 const tOk = nodeIdSet.has(String(t));
 if (!sOk || !tOk) {
 orphanCount++;
 if (typeof console !== 'undefined' && console.debug) {
 console.debug('[MEMORY-GRAPH] drop orphan edge:', s, '->', t);
 }
 continue;
 }
 validEdges.push(e);
 }
 if (orphanCount > 0) {
 console.log('[MEMORY-GRAPH] dropped orphan edges:', orphanCount, '/', edges.length);
 }

 // 限制总数
 const result = {
 nodes: nodes.slice(0, maxNodes),
 edges: validEdges.slice(0, maxEdges),
 stats: {
 nodes: Math.min(nodes.length, maxNodes),
 edges: Math.min(validEdges.length, maxEdges),
 totalNodes: nodes.length,
 totalEdges: validEdges.length,
 orphanEdges: orphanCount,
 memoryTotal: memoryStats.total || 0,
 byType: memoryStats.byType || {},
 generatedAt: Date.now(),
 },
 };

 this._cache = result;
 this._cacheTs = now;
 return result;
 }

 /**
 * 获取紧凑文本摘要（注入 prompt 用）
 */
 async renderCompact() {
 const data = await this.getGraphData({ maxNodes: 50 });
 const s = data.stats;
 return `[记忆图谱] ${s.nodes} 节点 / ${s.edges} 条关系 | 记忆总数 ${s.memoryTotal} | ${Object.entries(s.byType).map(([k,v]) => `${k}:${v}`).join(' ')}`;
 }

 /**
 * 清除缓存
 */
 clearCache() { this._cache = null; this._cacheTs = 0; }

 // ─── 内部数据提取 ───

  async _extractEntityGraphData(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges) {
    const { getUnifiedStore } = require('../memory/unified-store');
    const store = this._store || getUnifiedStore();
    try {
      const entityRows = store.all('SELECT id, name, kind FROM entities ORDER BY mention_count DESC, created_at DESC LIMIT ?', [maxNodes || 500]);
      for (const row of entityRows || []) {
        const id = String(row.id);
        if (!nodeMap.has(id)) {
          const node = this._createNode(id, row.kind || 'entity', row.name || id, 6);
          nodeMap.set(id, node);
          nodes.push(node);
        }
      }
      const relRows = store.all(
        'SELECT source_entity, target_entity, relation_type, confidence FROM relations WHERE relation_type != ? ORDER BY created_at DESC LIMIT ?',
        ['co_occurrence', maxEdges || 1000]
      );
      for (const r of relRows || []) {
        if (!nodeMap.has(String(r.source_entity)) || !nodeMap.has(String(r.target_entity))) continue;
        const key = `${r.source_entity}|${r.target_entity}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        edges.push({ source: String(r.source_entity), target: String(r.target_entity), weight: r.confidence || 0.5, label: r.relation_type });
      }
    } catch (e) {
      console.error('[memory-graph] 实体图提取失败（降级为空）:', e.message);
    }
  }
 async _extractMemoryTreeData(nodeMap, edgeSet, nodes, edges, maxNodes) {
 try {
 const { getMemoryTreeOrchestrator } = require('../memory/memory-tree-v2');
 const orch = getMemoryTreeOrchestrator();
 
 if (!orch._trees || orch._trees.size === 0) {
 console.log('[MEMORY-GRAPH] Memory tree has no data, skipping');
 return;
 }

 console.log('[MEMORY-GRAPH] Memory tree count:', orch._trees.size);

 let treeIndex = 0;
 for (const [, tree] of orch._trees) {
 if (nodes.length >= maxNodes) break;
 if (treeIndex >= 10) break;
 
 const rootId = tree.id || `tree_${treeIndex}`;
 if (!nodeMap.has(rootId)) {
 const node = this._createNode(rootId, 'tree', tree.namespace || '记忆树');
 node.size = tree._nodes?.size || tree.leaves?.length || 1;
 nodeMap.set(rootId, node);
 nodes.push(node);
 }

 const children = tree.leaves || [];
 for (const child of children.slice(0, 10)) {
 if (nodes.length >= maxNodes) break;
 const childId = child.id || `leaf_${crypto.randomBytes(4).toString('hex')}`;
 if (!nodeMap.has(childId)) {
 const node = this._createNode(childId, 'memory', (child.summary || child.content || '').slice(0, 20) || '记忆');
 node.size = 3;
 nodeMap.set(childId, node);
 nodes.push(node);
 }
 const edgeKey = `${rootId}|${childId}`;
 if (!edgeSet.has(edgeKey)) {
 edgeSet.add(edgeKey);
 edges.push({ source: rootId, target: childId, weight: 1, label: '包含' });
 }
 }
 
 treeIndex++;
 }

 console.log('[MEMORY-GRAPH] Extracted memory tree: nodes=', nodes.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting memory tree data:', e);
 }
 }

 async _extractMemoryNotesData(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges) {
 try {
 // 风格：直接读 SQLite，绕过 memory-system.getNotes() 的过滤
 // 原 bug: memory-system.getNotes 只过滤 ['note','general','user','feedback','project','reference']
 // 但 DB 中 200 条都是 type='fact'，全部被过滤掉！
 // 修复: 直接查 memories 表（不过滤 type），取所有记忆
 const { getUnifiedStore } = require('../memory/unified-store');
 const store = getUnifiedStore();
 if (!store) return;

 const rows = store.all(`SELECT id, type, title, content, tags, importance, namespace, created_at, updated_at
 FROM memories
 ORDER BY created_at DESC
 LIMIT ?`, [maxNodes]);
 if (!rows || rows.length === 0) return;

 const notes = rows.map(r => ({
 id: r.id,
 type: r.type,
 title: r.title,
 content: r.content,
 tags: (() => { try { return JSON.parse(r.tags || '[]') } catch { return [] } })(),
 importance: r.importance,
 namespace: r.namespace,
 created_at: r.created_at,
 updated_at: r.updated_at,
 }));

 console.log('[MEMORY-GRAPH] Loaded notes from DB:', notes.length);

 const tagMap = new Map();
 const nsMap = new Map();
 notes.forEach(note => {
 // 标签聚合
 if (note.tags) {
 note.tags.forEach(tag => {
 if (!tagMap.has(tag)) tagMap.set(tag, []);
 tagMap.get(tag).push(note);
 });
 }
 // 命名空间聚合
 const ns = note.namespace || 'default';
 if (!nsMap.has(ns)) nsMap.set(ns, []);
 nsMap.get(ns).push(note);
 });

 notes.forEach((note, index) => {
 if (nodes.length >= maxNodes) return;
 const nodeId = `note_${note.id || index}`;
 if (nodeMap.has(nodeId)) return;
 // 优先级：title > content 前 30 字符 > 截断的 id
 const label = note.title || (note.content ? String(note.content).slice(0, 30) : '未命名') || '未命名';
 // 根据 importance 决定大小
 const size = 4 + (note.importance || 0.5) * 6;
 const node = this._createNode(nodeId, note.type || 'memory', label, size);
 node.metadata = {
 type: note.type,
 tags: note.tags,
 namespace: note.namespace,
 importance: note.importance,
 created_at: note.created_at,
 };
 nodeMap.set(nodeId, node);
 nodes.push(node);
 });

 // 1. 基于 tags 建边（同类标签聚合）
 tagMap.forEach((tagNotes, tag) => {
 if (tagNotes.length < 2) return;
 // 大群组只连前 30 个（避免 O(n²) 爆炸）
 const limited = tagNotes.slice(0, 30);
 for (let i = 0; i < limited.length; i++) {
 for (let j = i + 1; j < limited.length; j++) {
 if (edges.length >= maxEdges) return;
 const id1 = `note_${limited[i].id || i}`;
 const id2 = `note_${limited[j].id || j}`;
 const edgeKey = id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 if (nodeMap.has(id1) && nodeMap.has(id2)) {
 edges.push({ source: id1, target: id2, weight: 0.6, label: `标签:${tag}` });
 }
 }
 }
 });

 // 2. 基于 namespace 建边（同域关联）
 nsMap.forEach((nsNotes, ns) => {
 if (nsNotes.length < 2) return;
 const limited = nsNotes.slice(0, 15);
 for (let i = 0; i < limited.length; i++) {
 for (let j = i + 1; j < limited.length; j++) {
 if (edges.length >= maxEdges) return;
 const id1 = `note_${limited[i].id || i}`;
 const id2 = `note_${limited[j].id || j}`;
 const edgeKey = id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 if (nodeMap.has(id1) && nodeMap.has(id2)) {
 edges.push({ source: id1, target: id2, weight: 0.4, label: `域:${ns}` });
 }
 }
 }
 });

 // 3. 时间相邻建边（风格：相邻记忆间建立视觉连接）
 for (let i = 0; i < Math.min(notes.length, 50) - 1; i++) {
 if (edges.length >= maxEdges) break;
 const id1 = `note_${notes[i].id || i}`;
 const id2 = `note_${notes[i + 1].id || i + 1}`;
 if (!nodeMap.has(id1) || !nodeMap.has(id2)) continue;
 const edgeKey = id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 edges.push({ source: id1, target: id2, weight: 0.3, label: '时序' });
 }
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting memory notes:', e.message);
 }
 }

 /**
 * 从 memory content/title 提取关键词作为额外节点
 * 风格：实体+关系+事件共同构成图谱
 * 启发式：提取 #tag、Markdown 标题、英文专有名词
 */
 async _extractContentEntities(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges) {
 try {
 const { getUnifiedStore } = require('../memory/unified-store');
 const store = getUnifiedStore();
 if (!store) return;

 const rows = store.all(`SELECT id, title, content, tags FROM memories LIMIT ?`, [Math.min(500, maxNodes)]);
 if (!rows || rows.length === 0) return;

 // 1. 提取 #tag 形式
 const tagEntityMap = new Map();
 const headingEntityMap = new Map();
 const wordEntityMap = new Map();
 // 中文/英文专有名词正则
 const reTag = /#([\w\u4e00-\u9fa5-]+)/g;
 const reHeading = /^#{1,3}\s+(.+?)$/gm;
 // 简单高频词：2-15 字符的中文词
 const reCnWord = /[\u4e00-\u9fa5]{2,8}/g;
 // 英文专有名词：连续大小写混合

 for (const row of rows) {
 const text = (row.title || '') + '\n' + (row.content || '');
 // #tag
 let m;
 while ((m = reTag.exec(text)) !== null) {
 const t = m[1];
 if (t.length < 2) continue;
 if (!tagEntityMap.has(t)) tagEntityMap.set(t, []);
 tagEntityMap.get(t).push(row.id);
 }
 // 标题
 while ((m = reHeading.exec(text)) !== null) {
 const h = m[1].trim();
 if (h.length < 2 || h.length > 40) continue;
 if (!headingEntityMap.has(h)) headingEntityMap.set(h, []);
 headingEntityMap.get(h).push(row.id);
 }
 // 中文高频词
 const cnWords = text.match(reCnWord) || [];
 for (const w of cnWords) {
 // 过滤停用词
 if (STOP_WORDS_CN.has(w)) continue;
 if (!wordEntityMap.has(w)) wordEntityMap.set(w, 0);
 wordEntityMap.set(w, wordEntityMap.get(w) + 1);
 }
 }

 let entityCount = 0;
 const MAX_ENTITIES = 800; // 实体上限

 // 创建 #tag 实体节点
 for (const [tag, memoryIds] of tagEntityMap.entries()) {
 if (nodes.length >= maxNodes || entityCount >= MAX_ENTITIES) break;
 if (memoryIds.length < 1) continue;
 const nodeId = `tag_${tag}`;
 if (nodeMap.has(nodeId)) continue;
 const node = this._createNode(nodeId, 'tag', `#${tag}`, 3 + Math.min(8, memoryIds.length));
 node.metadata = { kind: 'tag', refCount: memoryIds.length };
 nodeMap.set(nodeId, node);
 nodes.push(node);
 entityCount++;
 // 与每个 memory 节点建边
 for (const mid of memoryIds) {
 if (edges.length >= maxEdges) break;
 const memoryNodeId = `note_${mid}`;
 if (!nodeMap.has(memoryNodeId)) continue;
 const edgeKey = memoryNodeId < nodeId ? `${memoryNodeId}|${nodeId}` : `${nodeId}|${memoryNodeId}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 edges.push({ source: memoryNodeId, target: nodeId, weight: 0.7, label: '标签' });
 }
 }

 // 创建 标题 实体节点
 for (const [heading, memoryIds] of headingEntityMap.entries()) {
 if (nodes.length >= maxNodes || entityCount >= MAX_ENTITIES) break;
 if (memoryIds.length < 1) continue;
 const nodeId = `head_${hashId(heading)}`;
 if (nodeMap.has(nodeId)) continue;
 const node = this._createNode(nodeId, 'heading', heading.length > 18 ? heading.slice(0, 18) + '…' : heading, 3 + Math.min(5, memoryIds.length));
 node.metadata = { kind: 'heading', fullTitle: heading };
 nodeMap.set(nodeId, node);
 nodes.push(node);
 entityCount++;
 for (const mid of memoryIds.slice(0, 5)) {
 if (edges.length >= maxEdges) break;
 const memoryNodeId = `note_${mid}`;
 if (!nodeMap.has(memoryNodeId)) continue;
 const edgeKey = memoryNodeId < nodeId ? `${memoryNodeId}|${nodeId}` : `${nodeId}|${memoryNodeId}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 edges.push({ source: memoryNodeId, target: nodeId, weight: 0.5, label: '主题' });
 }
 }

 // 创建 高频词 实体节点（仅出现 >=3 次的）
 const topWords = Array.from(wordEntityMap.entries())
 .filter(([w, c]) => c >= 3 && w.length >= 2)
 .sort((a, b) => b[1] - a[1])
 .slice(0, 200); // 最多 200 个高频词
 for (const [word, count] of topWords) {
 if (nodes.length >= maxNodes || entityCount >= MAX_ENTITIES) break;
 const nodeId = `word_${word}`;
 if (nodeMap.has(nodeId)) continue;
 const node = this._createNode(nodeId, 'word', word, 2 + Math.min(6, Math.log2(count + 1)));
 node.metadata = { kind: 'word', frequency: count };
 nodeMap.set(nodeId, node);
 nodes.push(node);
 entityCount++;
 }

 console.log('[MEMORY-GRAPH] Extracted entities - tags:', tagEntityMap.size, 'headings:', headingEntityMap.size, 'words:', topWords.length);
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting content entities:', e.message);
 }
 }

 async _extractSessionData(nodeMap, edgeSet, nodes, edges, maxNodes) {
 try {
 // 直接读 user-sessions-index.json（不依赖 SQLite sessions 表）
 const path = require('path');
 const fs2 = require('fs');
 const { getDataDir } = require('../config');
 const indexPath = path.join(getDataDir(), 'memory', 'sessions', 'user-sessions-index.json');

 if (!fs2.existsSync(indexPath)) return;

 const index = JSON.parse(fs2.readFileSync(indexPath, 'utf-8'));
 const allSessions = [];
 for (const userSessions of Object.values(index)) {
 if (Array.isArray(userSessions)) {
 allSessions.push(...userSessions);
 }
 }
 // 按时间倒序
 allSessions.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
 if (allSessions.length === 0) return;

 console.log('[MEMORY-GRAPH] Found sessions (from JSON):', allSessions.length);

 let addedCount = 0;
 for (const session of allSessions) {
 if (nodes.length >= maxNodes || addedCount >= 80) break;
 const sessionId = session.sessionId;
 if (!sessionId) continue;
 const nodeId = `session_${sessionId}`;
 if (nodeMap.has(nodeId)) continue;

 // 标题：session.title || summary.firstMessage 前 20 字符
 const title = session.title
 || (session.summary?.firstMessage || '').slice(0, 20)
 || `会话 ${addedCount + 1}`;
 const msgCount = session.messageCount || session.summary?.messageCount || 0;
 const node = this._createNode(nodeId, 'session', title, 4 + Math.min(8, Math.log2(msgCount + 2)));
 node.metadata = {
 kind: 'session',
 messageCount: msgCount,
 createdAt: session.createdAt,
 lastAccessed: session.lastAccessed,
 };
 nodeMap.set(nodeId, node);
 nodes.push(node);
 addedCount++;
 }

 // 时序边：相邻 session 连接
 const sessionNodes = allSessions.slice(0, 80).map(s => `session_${s.sessionId}`).filter(id => nodeMap.has(id));
 for (let i = 0; i < sessionNodes.length - 1; i++) {
 const id1 = sessionNodes[i];
 const id2 = sessionNodes[i + 1];
 const edgeKey = id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 edges.push({ source: id1, target: id2, weight: 0.4, label: '会话时序' });
 }
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting session data:', e.message);
 }
 }

 /**
 * 从 documents 表读取对话消息（最大数据源，1260+ 条）
 * 风格：每条消息都是有意义的"事件"节点
 */
 async _extractDocuments(nodeMap, edgeSet, nodes, edges, maxNodes, maxEdges) {
 try {
 const { getUnifiedStore } = require('../memory/unified-store');
 const store = getUnifiedStore();
 if (!store) return;

 // documents 表：id, namespace, title, content, metadata, created_at, updated_at
 // 按 namespace 分组，优先读取 gui_user 对话
 const rows = store.all(`SELECT id, namespace, title, content, metadata, created_at
 FROM documents
 WHERE content IS NOT NULL AND length(content) > 0
 ORDER BY created_at DESC
 LIMIT ?`, [maxNodes]);
 if (!rows || rows.length === 0) return;

 console.log('[MEMORY-GRAPH] Found documents:', rows.length);

 // 解析 metadata 中的 role
 const parseMeta = (m) => { try { return JSON.parse(m) } catch { return {} } };

 for (const doc of rows) {
 if (nodes.length >= maxNodes) break;
 const nodeId = `doc_${doc.id}`;
 if (nodeMap.has(nodeId)) continue;

 const meta = parseMeta(doc.metadata);
 const role = meta.role || 'unknown';
 const content = String(doc.content || '').slice(0, 30);
 const label = content || doc.title || doc.id.slice(-8);

 // role 决定节点类型
 const type = role === 'user' ? 'message_user' : role === 'assistant' ? 'message_ai' : 'message';
 const node = this._createNode(nodeId, type, label, 3 + Math.min(4, Math.floor((content || '').length / 10)));
 node.metadata = {
 kind: 'document',
 role,
 namespace: doc.namespace,
 created_at: doc.created_at,
 type: meta.type,
 };
 nodeMap.set(nodeId, node);
 nodes.push(node);
 }

 // 时序边：相邻 message 连接（风格：相邻事件连成线）
 const sortedByTime = rows
 .filter(d => nodeMap.has(`doc_${d.id}`))
 .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
 const limit = Math.min(800, sortedByTime.length);
 for (let i = 0; i < limit - 1; i++) {
 if (edges.length >= maxEdges) break;
 const id1 = `doc_${sortedByTime[i].id}`;
 const id2 = `doc_${sortedByTime[i + 1].id}`;
 const edgeKey = id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 edges.push({ source: id1, target: id2, weight: 0.25, label: '对话' });
 }

 // user ↔ assistant 边（风格：问答对关联）
 const byUser = new Map();
 for (const d of sortedByTime.slice(0, 800)) {
 const meta = parseMeta(d.metadata);
 const ns = d.namespace || 'default';
 if (!byUser.has(ns)) byUser.set(ns, []);
 byUser.get(ns).push({ id: d.id, role: meta.role });
 }
 // eslint-disable-next-line no-unused-vars
 for (const [ns, msgs] of byUser.entries()) {
 for (let i = 0; i < msgs.length - 1; i++) {
 if (msgs[i].role === 'user' && msgs[i + 1].role === 'assistant') {
 if (edges.length >= maxEdges) break;
 const id1 = `doc_${msgs[i].id}`;
 const id2 = `doc_${msgs[i + 1].id}`;
 if (!nodeMap.has(id1) || !nodeMap.has(id2)) continue;
 const edgeKey = id1 < id2 ? `${id1}|${id2}` : `${id2}|${id1}`;
 if (edgeSet.has(edgeKey)) continue;
 edgeSet.add(edgeKey);
 edges.push({ source: id1, target: id2, weight: 0.7, label: '问答' });
 }
 }
 }
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting documents:', e.message);
 }
 }

 /**
 * 从 skill 系统读取技能节点
 */
 async _extractSkills(nodeMap, edgeSet, nodes, edges, maxNodes, _maxEdges) {
 try {
 const path = require('path');
 const { getDataDir } = require('../config');
 const dbPath = path.join(getDataDir(), 'skill-versions.db');
 const fs = require('fs');
 if (!fs.existsSync(dbPath)) return;

 // 直接读 SQLite（不依赖 crabpaw 内部模块）
 const Database = require('better-sqlite3');
 const db = new Database(dbPath, { readonly: true });
 const rows = db.prepare(`SELECT skill_id, skill_name, description, created_at FROM skill_records LIMIT 50`).all();
 db.close();

 if (!rows.length) return;
 console.log('[MEMORY-GRAPH] Found skills:', rows.length);

 for (const r of rows) {
 if (nodes.length >= maxNodes) break;
 const nodeId = `skill_${r.skill_id}`;
 if (nodeMap.has(nodeId)) continue;
 const node = this._createNode(nodeId, 'skill', r.skill_name || r.skill_id, 5);
 node.metadata = { kind: 'skill', description: r.description, created_at: r.created_at };
 nodeMap.set(nodeId, node);
 nodes.push(node);
 }
 } catch (e) {
 console.error('[MEMORY-GRAPH] Error extracting skills:', e.message);
 }
 }

 _createNode(id, type = 'entity', label = null, size = null) {
 const defaultSize = type === 'entity' ? 5 : type === 'tree' ? 8 : type === 'session' ? 6 : 3
 return {
 id,
 label: label || id,
 group: type === 'entity' ? 1 : type === 'tree' ? 2 : type === 'session' ? 4 : 3,
 type,
 size: size != null ? size : defaultSize,
 salience: 0.5,
 }
 }
}

// 全局单例
const globalMemoryGraph = new MemoryGraph();

module.exports = {
 MemoryGraph,
 globalMemoryGraph,
};
