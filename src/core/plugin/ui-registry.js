/**
 * UI Registry — 前端扩展点注册表
 *
 * 允许插件动态注册：
 * - 路由（独立页面）
 * - 侧边栏入口
 * - 设置面板
 *
 * 通过 IPC 将变更广播到渲染进程，前端的 PluginBridge 接收后动态更新。
 */

const { EventEmitter } = require('events');

class UIRegistry extends EventEmitter {
  constructor() {
    super();
    this.routes = new Map();          // path → { component, source, sidebar, lazy }
    this.settings = new Map();        // id → { icon, label, component, source, group }
    this.sidebarItems = new Map();    // label → { icon, path, source }
    this.bridges = new Set();         // IPC 桥接器回调
  }

  // ─── 路由注册 ───

  registerRoute(path, component, meta = {}) {
    if (this.routes.has(path)) {
      console.warn(`[UIRegistry] 路由 ${path} 已存在，将被覆盖`);
    }
    this.routes.set(path, {
      component,
      source: meta.source || 'core',
      sidebar: meta.sidebar || null,
      lazy: meta.lazy !== false,
    });
    if (meta.sidebar) {
      this.registerSidebarItem(meta.sidebar.label, meta.sidebar.icon, path, { source: meta.source });
    }
    this._broadcast();
    this.emit('route:registered', { path, source: meta.source });
  }

  unregisterRoute(path) {
    const entry = this.routes.get(path);
    if (entry) {
      if (entry.sidebar) this.unregisterSidebarItem(entry.sidebar.label);
      this.routes.delete(path);
      this._broadcast();
      this.emit('route:unregistered', { path });
    }
  }

  // ─── 设置面板注册 ───

  registerSettingsPanel(id, icon, label, component, meta = {}) {
    this.settings.set(id, {
      icon, label, component,
      source: meta.source || 'core',
      group: meta.group || 'plugin',
    });
    this._broadcast();
    this.emit('settings:registered', { id, source: meta.source });
  }

  unregisterSettingsPanel(id) {
    this.settings.delete(id);
    this._broadcast();
    this.emit('settings:unregistered', { id });
  }

  // ─── 侧边栏注册 ───

  registerSidebarItem(label, icon, path, meta = {}) {
    this.sidebarItems.set(label, { icon, path, source: meta.source || 'core' });
    this._broadcast();
    this.emit('sidebar:registered', { label, source: meta.source });
  }

  unregisterSidebarItem(label) {
    this.sidebarItems.delete(label);
    this._broadcast();
    this.emit('sidebar:unregistered', { label });
  }

  // ─── 批量注销（按来源） ───

  unregisterBySource(source) {
    let routeCount = 0, settingCount = 0, sidebarCount = 0;
    for (const [path, r] of this.routes) { if (r.source === source) { this.routes.delete(path); routeCount++; } }
    for (const [id, s] of this.settings) { if (s.source === source) { this.settings.delete(id); settingCount++; } }
    for (const [label, s] of this.sidebarItems) { if (s.source === source) { this.sidebarItems.delete(label); sidebarCount++; } }
    if (routeCount + settingCount + sidebarCount > 0) {
      this._broadcast();
      console.log(`[UIRegistry] 已清除来源 [${source}] (路由: ${routeCount}, 设置: ${settingCount}, 侧边栏: ${sidebarCount})`);
    }
    return { routes: routeCount, settings: settingCount, sidebars: sidebarCount };
  }

  // ─── 广播 ───

  _broadcast() {
    const payload = this.getSnapshot();
    for (const bridge of this.bridges) {
      try { bridge(payload); } catch (e) { console.error('[UIRegistry] 桥接器推送失败:', e.message); }
    }
    this.emit('broadcast', payload);
  }

  attachBridge(bridgeFn) {
    if (typeof bridgeFn !== 'function') throw new Error('[UIRegistry] bridge 必须是函数');
    this.bridges.add(bridgeFn);
    setImmediate(() => { try { bridgeFn(this.getSnapshot()); } catch (e) {
      /* ignore */
      console.warn('[ui-registry.js] 空 catch 补日志:', e && e.message);
 } });
    return () => this.bridges.delete(bridgeFn);
  }

  // ─── 查询 ───

  getSnapshot() {
    return {
      routes: [...this.routes.entries()].map(([path, r]) => ({ path, component: r.component, sidebar: r.sidebar, lazy: r.lazy })),
      settings: [...this.settings.entries()].map(([id, s]) => ({ id, icon: s.icon, label: s.label, component: s.component, group: s.group })),
      sidebars: [...this.sidebarItems.entries()].map(([label, s]) => ({ label, icon: s.icon, path: s.path })),
    };
  }

  getRoutes() { return this.getSnapshot().routes; }
  getSettingsPanels() { return this.getSnapshot().settings; }
  getSidebarItems() { return this.getSnapshot().sidebars; }

  getStats() {
    return { routes: this.routes.size, settings: this.settings.size, sidebars: this.sidebarItems.size, bridges: this.bridges.size };
  }

  toJSON() { return this.getSnapshot(); }
}

let instance = null;
function getUIRegistry() {
  if (!instance) instance = new UIRegistry();
  return instance;
}
function resetUIRegistry() { instance = null; }

module.exports = { UIRegistry, getUIRegistry, resetUIRegistry };
