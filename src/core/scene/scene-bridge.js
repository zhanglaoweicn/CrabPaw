'use strict';

/**
 * SceneBridge — 自动将业务数据变化投影到 SceneStore
 *
 * 这是"Agent 驱动 UI"架构的关键连接器：
 * - 监听 memory-system 的 memory:added / memory:updated / memory:removed
 * - 监听 session 创建/更新/删除
 * - 监听 memory-graph 面板数据刷新
 * - 自动调用 globalSceneStore.ui_set() 推送 surface
 *
 * 业务页面（Home / Memory / Skills 等）从 SceneStore 订阅，**不再直接 fetch**。
 * Agent 也能通过 SceneGet 看到当前显示的内容。
 */

const { EventEmitter } = require('events');
const { getSceneStore } = require('./scene-store');

function store() { return getSceneStore(); }

class SceneBridge extends EventEmitter {
  constructor() {
    super();
    this._mounted = false;
    this._lastGraphRev = 0;
    this._lastSessionsRev = 0;
    this._lastMemoryCount = 0;
    this._listeners = [];
    this._debug = process.env.SCENE_BRIDGE_DEBUG === '1';
  }

  /**
   * 挂载：注册所有业务事件监听
   */
  mount() {
    if (this._mounted) return;
    this._mounted = true;
    console.log('[scene-bridge] Mounting…');

    // 1. 监听 memory-system 事件
    try {
      const { memoryManager } = require('../memory-system');
      if (memoryManager && typeof memoryManager.on === 'function') {
        const onAdd = () => this._onMemoryChanged('add');
        const onUpdate = () => this._onMemoryChanged('update');
        const onRemove = () => this._onMemoryChanged('remove');
        memoryManager.on('memory:added', onAdd);
        memoryManager.on('memory:updated', onUpdate);
        memoryManager.on('memory:removed', onRemove);
        this._listeners.push(() => {
          memoryManager.off('memory:added', onAdd);
          memoryManager.off('memory:updated', onUpdate);
          memoryManager.off('memory:removed', onRemove);
        });
      }
    } catch (e) {
      console.warn('[scene-bridge] memory-system listener failed:', e.message);
    }

    // 2. 监听 session 变化（通过文件系统 polling + event bus）
    try {
      const eventBus = require('../event-bus');
      if (eventBus) {
        const onSession = () => this._refreshSessionSurface();
        eventBus.on?.('session:created', onSession);
        eventBus.on?.('session:updated', onSession);
        eventBus.on?.('session:removed', onSession);
        this._listeners.push(() => {
          eventBus.off?.('session:created', onSession);
          eventBus.off?.('session:updated', onSession);
          eventBus.off?.('session:removed', onSession);
        });
      }
    } catch (e) {
      /* event bus 可选 */
      console.warn('[scene-bridge.js] 空 catch 补日志:', e && e.message);
 }

    // 3. 立即做一次全量初始投影
    setImmediate(() => {
      this._refreshGraphSurface();
      this._refreshSessionSurface();
      this._refreshMemoryStatsSurface();
    });

    // 4. 定时轮询（兜底：捕捉所有通过文件系统变化的场景）
    this._pollTimer = setInterval(() => {
      this._refreshGraphSurface();
      this._refreshSessionSurface();
      this._refreshMemoryStatsSurface();
    }, 30000); // 2026-08-25: 8s→30s 对齐 memory-graph 缓存 TTL——之前每 8s 全量重建图谱(800 节点实体提取)卡死 GUI

    console.log('[scene-bridge] Mounted');
  }

  /**
   * 卸载
   */
  unmount() {
    if (!this._mounted) return;
    this._mounted = false;
    for (const off of this._listeners) { try { off() } catch (e) {
      /* noop */
      console.warn('[scene-bridge.js] 空 catch 补日志:', e && e.message);
 } }
    this._listeners = [];
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
    console.log('[scene-bridge] Unmounted');
  }

  // ── 内部：事件处理器 ──

  async _onMemoryChanged(_kind) {
    // 节流：避免短时间内大量 memory 添加导致 SceneStore 抖动
    if (this._memThrottle) return;
    this._memThrottle = setTimeout(() => {
      this._memThrottle = null;
      this._refreshMemoryStatsSurface();
      this._refreshGraphSurface();
    }, 1000);
  }

  // ── 内部：Surface 投影 ──

  /**
   * 投影 memory graph（首页节点图）
   */
  async _refreshGraphSurface() {
    try {
      const { globalMemoryGraph } = require('../panels/memory-graph');
      if (!globalMemoryGraph) {
        if (this._debug) console.log('[scene-bridge] globalMemoryGraph is null');
        return;
      }
      const data = await globalMemoryGraph.getGraphData({ maxNodes: 800, maxEdges: 2000 });
      if (!data || !data.nodes) {
        if (this._debug) console.log('[scene-bridge] globalMemoryGraph.getData returned no nodes');
        return;
      }
      const rev = (data.stats && data.stats.rev) || 0;
      // 避免重复 push
      if (rev === this._lastGraphRev && this._lastGraphRev > 0) return;
      this._lastGraphRev = rev;

      store().upsertSurface('home.memory_graph', {
        kind: 'memory_graph',
        data: {
          nodes: (data.nodes || []).slice(0, 500),
          edges: (data.edges || []).slice(0, 1000),
          stats: data.stats || {},
          nodeCount: data.nodes?.length || 0,
          edgeCount: data.edges?.length || 0,
        },
        intent: 'inform',
        order: 100,
      });
      if (this._debug) console.log(`[scene-bridge] memory_graph: ${data.nodes.length} nodes, ${data.edges?.length || 0} edges, rev=${rev}`);
    } catch (e) {
      if (this._debug) console.log('[scene-bridge] _refreshGraphSurface error:', e.message);
    }
  }

  /**
   * 投影 session 列表
   */
  async _refreshSessionSurface() {
    try {
      const path = require('path');
      const fs = require('fs');
      const { getDataDir } = require('../config');
      const indexPath = path.join(getDataDir(), 'memory', 'sessions', 'user-sessions-index.json');
      if (!fs.existsSync(indexPath)) return;

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const all = [];
      for (const userSessions of Object.values(index)) {
        if (Array.isArray(userSessions)) all.push(...userSessions);
      }
      all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

      // 算 rev（基于数量 + 最早 lastAccessed）作为去重 key
      const rev = all.length + '_' + (all[0]?.lastAccessed || 0);
      if (rev === this._lastSessionsRev && this._lastSessionsRev) return;
      this._lastSessionsRev = rev;

      store().upsertSurface('home.session_list', {
        kind: 'session_list',
        data: {
          sessions: all.slice(0, 30).map(s => ({
            sessionId: s.sessionId,
            title: s.title || (s.summary?.firstMessage || '').slice(0, 20),
            messageCount: s.messageCount || 0,
            lastAccessed: s.lastAccessed,
          })),
          total: all.length,
        },
        intent: 'inform',
        order: 200,
      });
    } catch (e) {

      // 静默

      console.warn('[scene-bridge.js] 空 catch 补日志:', e && e.message);
 }
  }

  /**
   * 投影 memory 统计（顶部数字）
   */
  async _refreshMemoryStatsSurface() {
      try {
      const { getUnifiedStore } = require('../memory/unified-store');
      // 2026-08-16 实机修复: 局部变量遮蔽模块级 store() 函数——
      // const store = getUnifiedStore() 后, store() 变成"对象当函数调" →
      // TypeError 被空 catch 吞 → home.memory_stats surface 永不更新。
      // 改名 unifiedStore 消除遮蔽。
      const unifiedStore = getUnifiedStore();
      if (!unifiedStore) return;
      const c = unifiedStore.get('SELECT COUNT(*) as c FROM memories') || {};
      const total = c.c || 0;
      if (total === this._lastMemoryCount && this._lastMemoryCount > 0) return;
      this._lastMemoryCount = total;
      store().upsertSurface('home.memory_stats', {
      kind: 'metric',
      data: {
      value: total,
      label: '记忆总数',
      unit: '条',
      },
      intent: 'ambient',
      order: 50,
      });
      } catch (e) {
        // 静默
        console.warn('[scene-bridge.js] 空 catch 补日志:', e && e.message);
    }
  }
}

// 单例
let _instance = null;
function getSceneBridge() {
  if (!_instance) _instance = new SceneBridge();
  return _instance;
}

module.exports = { SceneBridge, getSceneBridge };
