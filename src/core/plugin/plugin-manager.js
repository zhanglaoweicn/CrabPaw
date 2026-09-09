/**
 * Plugin Manager v3 — 贡献转接器模式
 *
 * 职责：不是"独立的平行注册表"，而是"通往已有注册表的桥梁"。
 * 插件加载时，将 manifest 中的 contributions 按类型注册到对应的系统注册表。
 *
 * 设计原则：
 * - 不做自己的注册表——复用 ToolRegistry、EventBus、ServiceRegistry、UIRegistry
 * - 来源追踪——所有注册都带 source 字段，禁用/卸载时批量清理
 * - 生命周期管理——只有 "code plugin" 有 lifecycle（onLoad/onUnload）
 * - 技能（skill）是插件的子集——无 lifecycle，由 SkillLoader 管理
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
// eslint-disable-next-line no-unused-vars
const { readManifest, validateManifest, hasManifestSync } = require('./manifest');
const { getUIRegistry } = require('./ui-registry');
const config = require('../config');

const { getLogger } = require('../logger');
const log = getLogger('plugin-manager');

// 插件搜索目录
const BUILTIN_PLUGINS_DIR = path.join(__dirname, '..', '..', '..', 'plugins');
const USER_PLUGINS_DIR = path.join(config.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', '.crabpaw'), 'plugins');
const BUNDLED_PLUGINS_DIR = path.join(BUILTIN_PLUGINS_DIR, 'bundled');

// S-1a 安全(2026-08-28): 插件名合法字符集（与 manifest name 校验同族）——
// 反斜杠/点/路径分隔符全拒，堵死 enable(name) 的 ../ 与 Windows \ 目录穿越。
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * S-1a 安全: dir 必须落在 baseDir 内（resolve 后比较，双端归一化）。
 * 堵死 config 键 '../x' 使 baseDir 外插件以 source='builtin' 装载的穿越。
 */
function isWithinDir(baseDir, dir) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedDir = path.resolve(dir);
  return resolvedDir === resolvedBase || resolvedDir.startsWith(resolvedBase + path.sep);
}

const getPluginStatesPath = () => {
  const dataDir = config.DATA_DIR || path.join(__dirname, '..', '..', '..', 'data', '.crabpaw');
  return path.join(dataDir, 'plugin-states.json');
};

/**
 * provider 反查语义（topo 与装配共用，须一致）: provides[0] 优先, 未声明回退插件名。
 * inject 名 → 该名对应的提供者。
 */
function provideOf(p) {
  return Array.isArray(p.provides) && p.provides.length ? p.provides[0] : p.name;
}

/**
 * 2026-08-27 B2-2 C2: 依赖拓扑排序(Kahn)。
 * inject 引用 provides 名（插件未声明 provides 时回退插件名）；注入列表外服务不算图内边；
 * 环 → throw（错误点名完整回路）。稳定序: 原列表序为并列依据。
 * @param {Array<{name: string, inject?: string[], provides?: string[]}>} plugins
 * @returns {Array<string>} 拓扑序插件名列表
 */
function topoSortPlugins(plugins) {
  // provides 名/插件名 → 插件（重名提供者后者覆盖，与装配清单声明序一致）
  const byProvide = new Map();
  for (const p of plugins) byProvide.set(provideOf(p), p);

  const indeg = new Map();
  const adj = new Map();
  for (const p of plugins) { indeg.set(p.name, 0); adj.set(p.name, []); }
  for (const p of plugins) {
    const injects = Array.isArray(p.inject) ? p.inject : [];
    for (const dep of injects) {
      const provider = byProvide.get(dep);
      if (!provider || provider.name === p.name) continue; // 外部服务/自供服务不算图内边
      adj.get(provider.name).push(p.name);
      indeg.set(p.name, indeg.get(p.name) + 1);
    }
  }

  // 稳定序: 按原列表序入队
  const queue = plugins.filter((p) => indeg.get(p.name) === 0).map((p) => p.name);
  const order = [];
  while (queue.length) {
    const n = queue.shift();
    order.push(n);
    for (const next of adj.get(n) || []) {
      const d = indeg.get(next) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length !== plugins.length) {
    // 环 → fail-loud: Kahn 剩余节点必处环中（每个剩余节点都有环内入边），
    // 沿 inject 反向走一遍，点出完整回路
    const remaining = new Set(plugins.filter((p) => !order.includes(p.name)).map((p) => p.name));
    const chain = [];
    const seen = new Set();
    let cur = plugins.find((p) => remaining.has(p.name));
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name);
      chain.push(cur.name);
      const next = (Array.isArray(cur.inject) ? cur.inject : [])
        .map((d) => byProvide.get(d))
        .find((q) => q && remaining.has(q.name));
      cur = next || null;
    }
    const cycleNames = cur ? [...chain.slice(chain.indexOf(cur.name)), cur.name] : [...remaining];
    throw new Error(`插件依赖环: ${cycleNames.join(' → ')}`);
  }
  return order;
}

class PluginManager {
  constructor() {
    this.loaded = new Map();          // name → { manifest, source, dir }
    this._knownPlugins = new Map();   // name → { dir, source, manifest }
    this._states = {};                // name → { enabled, disabledAt, enabledAt }
    this._toolRegistry = null;
    this._eventBus = null;
    this._serviceRegistry = null;
    this._uiRegistry = getUIRegistry();
    this._skillLoader = null;
    this._harnessHooks = null;
    this._dataSourcesRegistry = null; // 2026-08-26 数据源托管
    this._initialized = false;
  }

  /**
   * 绑定系统注册表引用
   */
  bindRegistries({ toolRegistry, eventBus, serviceRegistry, skillLoader, harnessHooks, dataSourcesRegistry } = {}) {
    this._toolRegistry = toolRegistry;
    this._eventBus = eventBus;
    this._serviceRegistry = serviceRegistry;
    this._skillLoader = skillLoader;
    this._dataSourcesRegistry = dataSourcesRegistry || null;
    this._harnessHooks = harnessHooks;
  }

  /**
   * 获取插件模型提供商（2026-08-01 补方法——adapter-registry.js:110 调用
   * 但此前不存在，TypeError 被上层 try/catch 静默吞掉，插件模型提供商注册失效）。
   * 当前项目无 model-provider 插件，返回空数组；未来插件声明 kind=model-provider
   * 时按此契约提供 getAdapter()。
   * @returns {Array<{id: string, plugin: {getAdapter: Function}}>}
   */
  getModelProviders() {
    const providers = [];
    for (const [name, entry] of this.loaded) {
      if (entry.manifest?.kind === 'model-provider') {
        providers.push({
          id: name,
          plugin: {
            getAdapter: () => {
              try {
                const instance = entry.instance;
                return instance && typeof instance.getAdapter === 'function' ? instance.getAdapter() : null;
              } catch (e) {
                log.warn(`[${name}] getAdapter 失败: ${e.message}`);
                return null;
              }
            },
          },
        });
      }
    }
    return providers;
  }

  async initialize() {
    if (this._initialized) return;
    await this._loadStates();
    this._initialized = true;
    log.info('[PluginManager] 已初始化');
  }

  // ═══════════════════════════════════════════════
  //  插件加载
  // ═══════════════════════════════════════════════

  async load(pluginDir, options = {}) {
    const manifest = await readManifest(pluginDir);
    if (!manifest) throw new Error(`[PluginManager] ${pluginDir} 中未找到插件清单`);

    const validation = validateManifest(manifest);
    if (!validation.valid) throw new Error(`[PluginManager] 插件 ${manifest.name} 清单验证失败: ${validation.errors.join('; ')}`);
    for (const w of validation.warnings) log.warn(`[${manifest.name}] ${w}`);

    // 2026-08-25 Phase4a: 信任门禁（fail-closed）——requiresHarness 主版本/signature 校验失败即拒载；
    // permissions 解析入 runtime（安全域消费）；warnings 记录不阻塞。
    const { checkPluginTrust } = require('./trust-check');
    const trust = checkPluginTrust(manifest);
    for (const w of trust.warnings) log.warn(`[${manifest.name} 信任: ${w}`);
    if (!trust.ok) {
      throw new Error(`插件 ${manifest.name} 信任校验失败: ${trust.errors.join('; ')}`);
    }

    const source = options.source || 'user';
    const sourceTag = `plugin:${manifest.name}`;
    const pluginConfig = options.config || {};

    // 2026-08-25 Cordis Stage1：同一实例贯穿 load/start/stop/unload——
    // 此前每个 phase 重新 require 入口（require.cache 被删），模块级状态（定时器等）
    // 在 phase 间丢失，stop 也永远没有实例可调。runtime 同时作为 loaded 条目存储。
    // B2-2 三态机: 加载中=pending，贡献注册+生命周期完成后 → active
    // 2026-08-27 B3-1: layer=装配来源(builtin/bundled/user)——权限执行域权威信任标记
    // (entry.layer 优先于目录推断; source 字符串不再作为信任判据, 名字可被仿冒)
    const runtime = { manifest, source: sourceTag, dir: pluginDir, pluginConfig, permissions: trust.permissions, layer: source, state: 'pending' };

    await this._loadContributions(manifest, pluginDir, sourceTag, pluginConfig);

    if (manifest.kind !== 'skill') {
      await this._executeLifecycle(manifest, pluginDir, 'load', pluginConfig, runtime);
      // 执行生命周期 start phase
      await this._executeLifecycle(manifest, pluginDir, 'start', pluginConfig, runtime);
    }

    runtime.state = 'active';
    this.loaded.set(manifest.name, runtime);
    this._knownPlugins.set(manifest.name, { dir: pluginDir, source: sourceTag, manifest, config: pluginConfig, layer: source });

    log.info(`✅ 插件已加载: ${manifest.name} v${manifest.version} [${manifest.kind || 'plugin'}] (${source})`);
    return manifest;
  }

  /**
   * 解析贡献：兼容两种格式
   * - 新格式: manifest.contributes.ui.{routes,settings,sidebar}
   * - 旧格式: manifest.contributions.{routes,settings,sidebar,tools,events,services,skills,middleware}
   */
  _resolveContribs(manifest) {
    // 2026-08-28 S-1d 口径统一: 顶层 contributes.tools 为权威(与 dataSources 同款),
    // contributes.ui.tools(迁移期) / contributions.tools(旧格式) 仅兼容兜底。
    // 优先级裁定: 顶层非空优先, 否则 ui.tools, 否则 contributions.tools（第一个非空）。
    const topTools = Array.isArray(manifest.contributes?.tools) ? manifest.contributes.tools : null;
    // 新格式: contributes.ui.{routes/routes, settings, sidebar}
    const newStyle = manifest.contributes?.ui;
    if (newStyle) {
      return {
        routes: newStyle.routes || [],
        settings: newStyle.settings || [],
        sidebar: newStyle.sidebar || [],
        tools: topTools || newStyle.tools || [],
        events: newStyle.events || [],
        services: newStyle.services || [],
        skills: newStyle.skills || [],
        middleware: newStyle.middleware || [],
        // 2026-08-26 数据源托管: 插件可声明数据源贡献→enable 注册/disable 注销
        dataSources: manifest.contributes?.dataSources || [],
      };
    }
    // 旧格式: contributions.{routes,settings,...}
    return {
      ...(manifest.contributions || {}),
      tools: topTools || manifest.contributions?.tools || [],
      dataSources: manifest.contributes?.dataSources || [],
    };
  }

  async _loadContributions(manifest, pluginDir, sourceTag, _pluginConfig) {
    const contribs = this._resolveContribs(manifest);
    if (!Object.keys(contribs).length) return;

    // 1. 工具注册
    if (contribs.tools && this._toolRegistry) {
      for (const t of contribs.tools) {
        const handlerPath = path.resolve(pluginDir, t.handler);
        try {
          const mod = require(handlerPath);
          const handler = mod.default || mod;
          const handlerFn = typeof handler === 'function' ? handler : mod.handler || mod.execute;
          if (!handlerFn && typeof handler !== 'function') { log.warn(`[${manifest.name}] 工具 ${t.name} handler 不可用`); continue; }
          this._toolRegistry.register({
            name: t.name, handler: handlerFn, category: t.category || manifest.name,
            description: t.description || '', isDangerous: t.riskLevel === 'high',
            isReadOnly: t.riskLevel === 'low', source: sourceTag,
            // S-1b 安全接线(2026-08-28): 透传 manifest contributes.tools[].fileParams →
            // registry 条目非空 → permission-enforce filesGate 真实触发（此前恒空永不拦）
            fileParams: Array.isArray(t.fileParams) ? t.fileParams : [],
          });
        } catch (err) { log.error(`[${manifest.name}] 注册工具 ${t.name} 失败: ${err.message}`); }
      }
    }

    // 2. 事件订阅（带 source——disable 时 unsubscribeBySource 才能清干净）
    if (contribs.events && this._eventBus) {
      for (const e of contribs.events) {
        const handlerPath = path.resolve(pluginDir, e.handler);
        try {
          const mod = require(handlerPath);
          const handler = mod.default || mod;
          const handlerFn = typeof handler === 'function' ? handler : mod.handle;
          if (typeof handlerFn !== 'function') { log.warn(`[${manifest.name}] 事件 ${e.on} handler 不可用`); continue; }
          this._eventBus.subscribeWithSource(sourceTag, e.on, handlerFn);
        } catch (err) { log.error(`[${manifest.name}] 订阅事件 ${e.on} 失败: ${err.message}`); }
      }
    }

    // 3. 服务注册（source 已由 ServiceRegistry 支持——2026-08-25 固化）
    if (contribs.services && this._serviceRegistry) {
      for (const s of contribs.services) {
        const svcPath = path.resolve(pluginDir, s.path);
        try {
          const svc = require(svcPath);
          this._serviceRegistry.register(s.name, svc, { source: sourceTag });
        } catch (err) { log.error(`[${manifest.name}] 注册服务 ${s.name} 失败: ${err.message}`); }
      }
    }

    // 3.5 数据源贡献（2026-08-26: 数据源插件托管——enable 时注册, disable 时按
    // sourceTag 注销; 与工具/事件/服务同纪律）
    if (contribs.dataSources && this._dataSourcesRegistry) {
      for (const ds of contribs.dataSources) {
        const dsPath = path.resolve(pluginDir, ds.handler);
        try {
          const mod = require(dsPath);
          const factory = mod.default || mod;
          const fetchFn = typeof factory === 'function' ? factory : mod.fetch || mod.handler;
          if (typeof fetchFn !== 'function') { log.warn(`[${manifest.name}] 数据源 ${ds.name} handler 不可用`); continue; }
          const r = this._dataSourcesRegistry.registerSource({
            name: ds.name,
            description: ds.description || '',
            fetch: fetchFn,
            tag: sourceTag,
          }, { replace: true }); // 接管 builtin 同名源——disable 后随插件摘除(托管语义)
          if (!r.ok) log.warn(`[${manifest.name}] 数据源 ${ds.name} 注册失败: ${r.error}`);
          else log.info(`[${manifest.name}] 数据源已注册: ${ds.name}`);
        } catch (err) { log.error(`[${manifest.name}] 注册数据源 ${ds.name} 失败: ${err.message}`); }
      }
    }

    // 4. UI 贡献：2026-08-25 弃用（PluginBridge 已随 6a1d730 删除，前端无消费者，
    // 注册即死链）。保留 manifest 校验以兼容旧插件，此处拒绝注册并告警。
    if ((contribs.routes || contribs.sidebar || contribs.settings) && this._uiRegistry) {
      log.warn(`[${manifest.name}] UI 贡献（routes/sidebar/settings）已弃用：前端 PluginBridge 已移除，注册将被忽略`);
    }

    // 5. 技能与中间件贡献（2026-08-01 明确废弃）：
    // 技能体系以 skills.js（SKILL.md 提示词）为主入口，插件代码技能与其架构不兼容；
    // 中间件需 harnessHooks 注册接口（不存在）。manifest 校验层已告警，此处不再处理。
    // 若未来接入，需先确定 skillLoader/harnessHooks 的注册接口。
  }

  /**
   * 生命周期执行（2026-08-25 Cordis Stage1 重写）：
   * - 阶段：load（init/onLoad）→ start（start/onStart）→ stop（stop/onStop）→ unload（unload/onUnload）
   * - 实例缓存：同一 runtime 内只 require 一次入口、只实例化一次；
   *   此前每 phase 删 require.cache 重 require，模块级状态丢失且 stop 无实例可调
   *   （P2：禁用后定时器泄漏、onUnload 被当文件路径 require 必 ENOENT）。
   * - 方法名优先：lifecycle.* 一律视为实例方法名；旧式"onUnload: 文件路径"
   *   （含 '/' 或 '.js' 结尾）走路径 require 回退。
   * @param {object} manifest
   * @param {string} pluginDir
   * @param {'load'|'start'|'stop'|'unload'} phase
   * @param {object} pluginConfig
   * @param {object} [runtime] 与 loaded 条目共享的运行时对象（含 instance）
   */
  async _executeLifecycle(manifest, pluginDir, phase, pluginConfig, runtime = {}) {
    if (manifest.kind === 'skill') return;

    const lc = manifest.lifecycle || {};

    // 1. 尝试加载入口文件 (plugin.js → index.js)
    if (phase !== 'stop' && phase !== 'unload' && !runtime.instance && !runtime.entryPath) {
      // 仅首次解析入口；stop 阶段复用已缓存实例
    }
    const entryFiles = [path.join(pluginDir, 'plugin.js'), path.join(pluginDir, 'index.js')];
    let entryPath = null;
    for (const fp of entryFiles) {
      if (fsSync.existsSync(fp)) { entryPath = fp; break; }
    }
    if (!entryPath) return; // 纯声明式插件

    // 复用/创建实例（同一 runtime 只构造一次）
    let instance = runtime.instance;
    if (!instance) {
      try {
        // 仅 load 阶段清理旧缓存：stop 阶段是同一实例的收尾
        const resolved = require.resolve(entryPath);
        if (phase === 'load' && require.cache[resolved]) delete require.cache[resolved];
        const mod = require(entryPath);
        const isClass = typeof mod === 'function' && /^\s*class\s/.test(mod.toString());
        instance = isClass ? new mod(manifest) : (typeof mod === 'function' ? mod(manifest) : mod);
        runtime.instance = instance;
        runtime.entryPath = entryPath;
      } catch (err) {
        log.warn(`[${manifest.name}] 生命周期 ${phase} 执行失败: ${err.message}`);
        return;
      }
    }

    // 各阶段方法解析：方法名优先，旧式路径回退（仅 stop/unload 兼容旧 onUnload: "index.js" 形态）
    const METHOD_KEYS = {
      load: lc.init || lc.onLoad,
      start: lc.start,
      stop: lc.stop || lc.onStop,
      unload: lc.unload || lc.onUnload,
    };
    const methodKey = METHOD_KEYS[phase];
    if (!methodKey) return; // 未声明该阶段

    if (typeof instance[methodKey] === 'function') {
      try {
        await instance[methodKey]({ manifest, pluginConfig, pluginDir });
        return;
      } catch (err) {
        log.warn(`[${manifest.name}] 生命周期 ${phase} 执行失败: ${err.message}`);
        return;
      }
    }

    // 旧式：lifecycle.onUnload: "文件名.js" → require 后调用 stop/unload 函数
    if ((phase === 'stop' || phase === 'unload') &&
        typeof methodKey === 'string' && (methodKey.includes('/') || methodKey.endsWith('.js'))) {
      const legacyPath = path.resolve(pluginDir, methodKey);
      try {
        delete require.cache[require.resolve(legacyPath)];
        const mod = require(legacyPath);
        if (typeof mod.stop === 'function') await mod.stop();
        if (typeof mod.unload === 'function') await mod.unload();
      } catch (err) {
        log.warn(`[${manifest.name}] 旧式卸载脚本执行失败: ${err.message}`);
      }
      return;
    }
  }

  // ═══════════════════════════════════════════════
  //  插件禁用/卸载
  // ═══════════════════════════════════════════════

  async disable(name) {
    const entry = this.loaded.get(name);
    if (!entry) {
      log.warn(`[PluginManager] 插件 ${name} 未加载，记录禁用状态`);
      this._states[name] = { enabled: false, disabledAt: new Date().toISOString() };
      await this._saveStates();
      return;
    }

    const sourceTag = entry.source;
    const manifest = entry.manifest;

    // B2-2 三态机: 卸载中=disposing
    entry.state = 'disposing';

    // 2026-08-25 Cordis Stage1：禁用 = 停（逆序）。先生命周期 stop→unload
    // （复用 load/start 同一实例，模块级资源得以释放——P2 定时器泄漏根因），
    // 再按贡献顺序逆向反注册；保持"注册可逆"纪律。
    if (manifest.kind !== 'skill') {
      await this._executeLifecycle(manifest, entry.dir, 'stop', entry.pluginConfig, entry);
      await this._executeLifecycle(manifest, entry.dir, 'unload', entry.pluginConfig, entry);
    }

    const contribs = this._resolveContribs(manifest);
    const hasContribs = Object.keys(contribs).length > 0 || manifest.contributes?.ui;
    if (hasContribs && this._uiRegistry) this._uiRegistry.unregisterBySource(sourceTag);
    if (contribs.services && this._serviceRegistry) this._serviceRegistry.unregisterBySource(sourceTag);
    if (contribs.events && this._eventBus) this._eventBus.unsubscribeBySource(sourceTag);
    if (contribs.tools && this._toolRegistry) this._toolRegistry.unregisterBySource(sourceTag);
    // 2026-08-26 数据源托管反注册（disable 时摘除插件贡献的源——启停真实生效）
    if (contribs.dataSources && this._dataSourcesRegistry) {
      const r = this._dataSourcesRegistry.unregisterBySource(sourceTag);
      log.info(`[${manifest.name}] 数据源反注册完成 (${(r || {}).removed ?? 0} 个)`);
    }

    // P7 修复（顺带）：二次 enable 顶层代码重复执行——禁用后清入口缓存
    if (entry.entryPath) {
      try { delete require.cache[require.resolve(entry.entryPath)]; } catch (e) { log.warn('[PluginManager] 清入口缓存失败(无害):', e && e.message); }
    }

    entry.state = 'disposed';
    this.loaded.delete(name);
    this._states[name] = { enabled: false, disabledAt: new Date().toISOString() };
    await this._saveStates();
    log.info(`✅ 插件已禁用: ${name}`);
  }

  async enable(name) {
    // S-1a 安全: 名字白名单校验——../、反斜杠、点、分隔符全拒,
    // 堵死 /api/plugin-manager/<name>/enable 的目录穿越授 'builtin' 层。
    if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) {
      throw new Error(`插件名非法: ${name}`);
    }
    if (this.loaded.has(name)) { log.warn(`[PluginManager] 插件 ${name} 已加载`); return; }

    const known = this._knownPlugins.get(name);
    if (known) {
      const layer = known.layer || known.source.replace('plugin:', '');
      await this.load(known.dir, { source: layer, config: known.config || {} });
      this._states[name] = { enabled: true, enabledAt: new Date().toISOString() };
      await this._saveStates();
      return;
    }

    const bundledDir = path.join(BUNDLED_PLUGINS_DIR, name);
    try {
      await fs.access(bundledDir);
      await this.load(bundledDir, { source: 'bundled' });
      this._states[name] = { enabled: true, enabledAt: new Date().toISOString() };
      await this._saveStates();
      return;
    } catch (e) {
      /* bundled 目录也不存在 */
      console.warn('[plugin-manager.js] 空 catch 补日志:', e && e.message);
    }


    for (const searchDir of [BUILTIN_PLUGINS_DIR, USER_PLUGINS_DIR]) {
      const candidate = path.join(searchDir, name);
      try {
      await fs.access(candidate);
      const hasMan = await this._hasManifest(candidate);
      if (hasMan) {
      await this.load(candidate, { source: searchDir === BUILTIN_PLUGINS_DIR ? 'builtin' : 'user' });
      this._states[name] = { enabled: true, enabledAt: new Date().toISOString() };
      await this._saveStates();
      return;
      }
      } catch (e) {
        /* not found */
        console.warn('[plugin-manager.js] 空 catch 补日志:', e && e.message);
      }

    }
    throw new Error(`插件 ${name} 未找到，无法启用`);
  }

  // ═══════════════════════════════════════════════
  //  批量加载
  // ═══════════════════════════════════════════════

  async loadBundle(name, pluginConfig = {}) {
    const dir = path.join(BUNDLED_PLUGINS_DIR, name);
    try { await fs.access(dir); } catch (e) { log.warn(`[PluginManager] bundled 插件 ${name} 不存在`); return null; }
    return await this.load(dir, { source: 'bundled', config: pluginConfig });
  }

  async loadFromConfig(pluginConfigs, source = 'bundled', baseDir = BUNDLED_PLUGINS_DIR) {
    if (!pluginConfigs || typeof pluginConfigs !== 'object') { log.warn('[PluginManager] 无效的插件配置'); return []; }

    await this._loadStates();
    const loaded = [];

    const entries = Object.entries(pluginConfigs);
    const manifestScan = {};

    // 预登记: 读 manifest 入 _knownPlugins（与 B2-2 之前完全一致）
    for (const [name, cfg] of entries) {
      const dir = path.join(baseDir, name);
      // S-1a: 键名越界（../ 穿越）→ warn+跳过, 不入 known 不参与装配
      if (!isWithinDir(baseDir, dir)) {
        log.warn(`[PluginManager] 插件键名越界（目录穿越，已跳过）: ${name}`);
        continue;
      }
      try {
        await fs.access(dir);
        const manifest = await readManifest(dir);
        if (manifest) {
          manifestScan[name] = manifest;
          this._knownPlugins.set(name, { dir, source: `plugin:${source}`, manifest, config: typeof cfg === 'object' ? cfg : {}, layer: source });
        }
      } catch (e) {
        /* 目录不存在 */
        console.warn('[plugin-manager.js] 空 catch 补日志:', e && e.message);
      }
    }

    // 2026-08-27 B2-2 C2: 拓扑装配——仅持有 manifest 的配置项参与排序；
    // 无 manifest 的配置项不参与排序, 保持原位按原序加载容错(load 失败 warn, 与旧行为一致)；
    // 环 → topoSortPlugins 抛错点名回路（fail-loud, 装配中止）。
    const pluginObjs = entries
      .filter(([name]) => manifestScan[name])
      .map(([name]) => {
        const m = manifestScan[name];
        return { name, inject: m.inject || [], provides: m.provides || [] };
      });
    const topoOrder = topoSortPlugins(pluginObjs);
    log.info(`📦 插件装配: 拓扑校验 ok (${topoOrder.length} 项)`);

    // 原循环体原样保留（状态跳过 → load）: 跳过判定在每个插件 load 前执行, 与旧行为一致
    const dirMap = new Map(entries);

    // C3 (2026-08-27): 禁用=合法操作（warn+跳过）≠ 环（抛错）——两口径保持区分,
    // 不改变 topoSortPlugins。禁用判定语义提取复用（state.enabled===false ∥ cfg.enabled===false）。
    const isEffectivelyDisabled = (name, cfg) => {
      const state = this._states[name];
      if (state && state.enabled === false) return true;
      if (cfg && typeof cfg === 'object' && cfg.enabled === false) return true;
      return false;
    };
    // provider 反查（与 topoSortPlugins 共用 provideOf 语义）: providedName → 插件名;
    // 外部/树服务名不在 byProvide → 反查得 undefined, 不参与判定。
    const provideBy = new Map();
    for (const p of pluginObjs) provideBy.set(provideOf(p), p.name);
    // 已禁用/已跳过/加载失败 的插件名累计——依赖者据此传递跳过
    const skipped = new Set();

    const attemptLoad = async (name, cfg) => {
      const state = this._states[name];
      if (state && state.enabled === false) { log.info(`[PluginManager] 插件 ${name} 已被用户禁用，跳过加载`); skipped.add(name); return; }
      if (cfg && cfg.enabled === false) { log.info(`[PluginManager] 插件 ${name} 配置为禁用，跳过`); skipped.add(name); return; }

      // C3: inject 目标被禁用/跳过 → 依赖者 warn+跳过（skipped 累积使传递覆盖下游）。
      const manifestOf = manifestScan[name];
      const injected = manifestOf && Array.isArray(manifestOf.inject) ? manifestOf.inject : [];
      const depMissing = injected
        .map((dep) => provideBy.get(dep))
        .filter((depName) => depName && depName !== name
          && (skipped.has(depName) || isEffectivelyDisabled(depName, dirMap.get(depName))));
      if (depMissing.length > 0) {
        log.warn(`[PluginManager] 插件 ${name} 的依赖 ${depMissing.join('、')} 已被禁用或跳过，${name} 跳过加载`);
        skipped.add(name);
        return;
      }

      const dir = path.join(baseDir, name);
      // S-1a: 键名越界（../ 穿越）→ warn+跳过（防 baseDir 外插件以本层 source 装载）
      if (!isWithinDir(baseDir, dir)) {
        skipped.add(name);
        log.warn(`[PluginManager] 插件键名越界（目录穿越，已跳过）: ${name}`);
        return;
      }
      try {
        await fs.access(dir);
        const manifest = await this.load(dir, { source, config: typeof cfg === 'object' ? cfg : {} });
        loaded.push(manifest);
      } catch (err) {
        skipped.add(name); // 加载失败=依赖不可用, 下游依赖者同样跳过（传递）
        log.warn(`[PluginManager] 加载插件 ${name} 失败: ${err.message}`);
      }
    };

    // 按拓扑序加载; 无 manifest 的配置项随后按原序加载
    for (const name of topoOrder) await attemptLoad(name, dirMap.get(name));
    for (const [name, cfg] of entries) {
      if (manifestScan[name]) continue; // 已按拓扑序加载
      await attemptLoad(name, cfg);
    }

    log.info(`[PluginManager] 已加载 ${loaded.length}/${Object.keys(pluginConfigs).length} 个插件 (${source})`);

    // 2026-08-27 B1-6: 双发现合一——only baseDir 扫描(builtin 目录即 plugins/ 根, 与
    // defaultManifestFromDirs 同源); bundled 子目录由 loadFromConfig('bundled') 那次管理。
    if (source !== 'builtin') await this._discoverPlugins(baseDir, source);

    return loaded;
  }

  /** Phase2 装配清单：扫描目录生成"全启用"默认清单（无 config 时行为=旧全量，无行为突变） */
  async defaultManifestFromDirs() {
    const scan = async (dir) => {
      const out = {};
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
      for (const e of entries) if (e.isDirectory()) out[e.name] = {};
      return out;
    };
    return {
      builtin: await scan(BUILTIN_PLUGINS_DIR),
      bundled: await scan(BUNDLED_PLUGINS_DIR),
      user: await scan(USER_PLUGINS_DIR),
    };
  }

  async _discoverPlugins(dir, source) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (this._knownPlugins.has(name)) continue;
      const pluginDir = path.join(dir, name);
      const manifest = await readManifest(pluginDir);
      if (manifest) {
        this._knownPlugins.set(name, { dir: pluginDir, source: `plugin:${source}`, manifest, config: {}, layer: source });
      } else {
        // 递归扫描子目录（支持 sub-plugins/ 嵌套结构）
        const subEntries = fsSync.readdirSync(pluginDir, { withFileTypes: true });
        for (const sub of subEntries) {
          if (!sub.isDirectory()) continue;
          const subName = sub.name;
          if (this._knownPlugins.has(subName)) continue;
          const subPluginDir = path.join(pluginDir, subName);
          const subManifest = await readManifest(subPluginDir);
          if (subManifest) this._knownPlugins.set(subName, { dir: subPluginDir, source: `plugin:${source}`, manifest: subManifest, config: {}, layer: source });
        }
      }
    }
  }

  async autoLoad() {
    for (const { dir, source } of [{ dir: BUILTIN_PLUGINS_DIR, source: 'builtin' }, { dir: USER_PLUGINS_DIR, source: 'user' }]) {
      await this._loadFromDir(dir, source);
    }
    return this.loaded.size;
  }

  async autoLoadPlugins() {
    log.info('[PluginManager] [兼容] autoLoadPlugins 调用 → 委托给 autoLoad');
    await this.autoLoad();
  }

  async _loadFromDir(dir, source, depth = 0) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(dir, entry.name);
      const hasMan = await this._hasManifest(subDir);
      if (hasMan) {
        try { await this.load(subDir, { source }); } catch (err) { log.warn(`[PluginManager] 加载 ${entry.name} 失败: ${err.message}`); }
      } else if (depth < 1) {
        await this._loadFromDir(subDir, source, depth + 1);
      }
    }
  }

  async _hasManifest(dir) {
    try {
      const { hasManifest } = require('./manifest');
      return await hasManifest(dir);
    } catch {
      const MANIFEST_FILES = ['manifest.yaml', 'manifest.yml', 'plugin.yaml', 'plugin.yml', 'plugin.json'];
      for (const f of MANIFEST_FILES) {
        try { await fs.access(path.join(dir, f)); return true; } catch { continue; }
      }
      return false;
    }
  }

  // ═══════════════════════════════════════════════
  //  状态持久化
  // ═══════════════════════════════════════════════

  async _loadStates() {
    try {
      const statesPath = getPluginStatesPath();
      const data = await fs.readFile(statesPath, 'utf-8');
      this._states = JSON.parse(data);
    } catch (e) { this._states = {}; }
  }

  async _saveStates() {
    try {
      const statesPath = getPluginStatesPath();
      const dir = path.dirname(statesPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(statesPath, JSON.stringify(this._states, null, 2));
    } catch (e) { log.warn(`[PluginManager] 保存状态失败: ${e.message}`); }
  }

  // ═══════════════════════════════════════════════
  //  查询
  // ═══════════════════════════════════════════════

  getAll() {
    return [...this.loaded.entries()].map(([name, entry]) => {
      const contribs = this._resolveContribs(entry.manifest);
      // 2026-08-26: 贡献展示合并新旧格式; dataSources 是注册的自持名字(新贡献点)
      const dataSourceNames = (contribs.dataSources || []).map((ds) => ds.name || 'dataSource');
      return {
        name, version: entry.manifest.version, kind: entry.manifest.kind || 'plugin',
        source: entry.source, description: entry.manifest.description || '',
        contributions: [...Object.keys(entry.manifest.contributions || {}), ...dataSourceNames],
      };
    });
  }

  listAll() {
    // 2026-08-26: 贡献展示合并新旧格式——旧 contributions 键 + 新 contributes.dataSources 名
    const contribNames = (manifest) => {
      const c = this._resolveContribs(manifest);
      return [...Object.keys(manifest?.contributions || {}),
        ...(c.dataSources || []).map((ds) => ds.name || 'dataSource')];
    };
    const all = new Map();

    for (const [name, known] of this._knownPlugins) {
      const state = this._states[name] || {};
      const loadedEntry = this.loaded.get(name);
      all.set(name, {
        name, version: known.manifest?.version || '0.0.0', kind: known.manifest?.kind || 'plugin',
        source: known.source, description: known.manifest?.description || '',
        enabled: this.loaded.has(name), manuallyDisabled: state.enabled === false,
        // B2-2 三态机: active(已加载) / disposed(用户禁用) / pending(已知未加载)
        state: loadedEntry?.state || (state.enabled === false ? 'disposed' : 'pending'),
        contributions: contribNames(known.manifest),
      });
    }

    for (const [name, entry] of this.loaded) {
      if (!all.has(name)) {
        all.set(name, {
          name, version: entry.manifest.version, kind: entry.manifest.kind || 'plugin',
          source: entry.source, description: entry.manifest.description || '',
          enabled: true, manuallyDisabled: false,
          state: entry.state || 'active',
          contributions: contribNames(entry.manifest),
        });
      }
    }

    if (all.size === 0) this._lazyDiscoverPluginsSync(all);

    return [...all.values()];
  }

  _lazyDiscoverPluginsSync(all) {
    const dirs = [
      { dir: BUNDLED_PLUGINS_DIR, source: 'plugin:bundled' },
      { dir: path.join(BUNDLED_PLUGINS_DIR, '..'), source: 'plugin:builtin' },
    ];
    for (const { dir, source } of dirs) {
      let entries;
      try { entries = fsSync.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (all.has(name) || name === 'bundled' || name === 'sub-plugins') continue;
        const pluginDir = path.join(dir, name);
        let manifest;
        try {
          const files = ['manifest.yaml', 'manifest.yml', 'plugin.yaml', 'plugin.yml', 'plugin.json'];
          for (const f of files) {
            const fp = path.join(pluginDir, f);
            if (fsSync.existsSync(fp)) {
              const content = fsSync.readFileSync(fp, 'utf-8');
              if (f.endsWith('.json')) { manifest = JSON.parse(content); }
              else { manifest = require('js-yaml').load(content); }
              if (manifest && manifest.name) break;
            }
          }
        } catch (e) {
          /* ignore */
          console.warn('[plugin-manager.js] 空 catch 补日志:', e && e.message);
        }

        all.set(name, {
          name, version: manifest?.version || '0.0.0', kind: manifest?.kind || 'plugin',
          source, description: manifest?.description || '', enabled: this.loaded.has(name),
          manuallyDisabled: false, state: this.loaded.has(name) ? 'active' : 'pending',
          contributions: Object.keys(manifest?.contributions || {}),
        });
        // 扫描子目录中的子插件
        if (!manifest) {
          let subEntries;
          try { subEntries = fsSync.readdirSync(pluginDir, { withFileTypes: true }); } catch (e) { continue; }
          for (const sub of subEntries) {
            if (!sub.isDirectory()) continue;
            const subName = sub.name;
            if (all.has(subName)) continue;
            const subDir = path.join(pluginDir, subName);
            let subManifest;
            try {
              const files = ['manifest.yaml', 'manifest.yml', 'plugin.yaml', 'plugin.yml', 'plugin.json'];
              for (const f of files) {
                const fp = path.join(subDir, f);
                if (fsSync.existsSync(fp)) {
                  const content = fsSync.readFileSync(fp, 'utf-8');
                  if (f.endsWith('.json')) { subManifest = JSON.parse(content); }
                  else { subManifest = require('js-yaml').load(content); }
                  if (subManifest && subManifest.name) break;
                }
              }
            } catch (e) {
              /* ignore */
              console.warn('[plugin-manager.js] 空 catch 补日志:', e && e.message);
            }

            all.set(subName, {
              name: subName, version: subManifest?.version || '0.0.0', kind: subManifest?.kind || 'plugin',
              source, description: subManifest?.description || '', enabled: this.loaded.has(subName),
              manuallyDisabled: false, state: this.loaded.has(subName) ? 'active' : 'pending',
              contributions: Object.keys(subManifest?.contributions || {}),
            });
          }
        }
      }
    }
  }

  get(name) {
    const entry = this.loaded.get(name);
    if (!entry) return null;
    return { name, version: entry.manifest.version, kind: entry.manifest.kind || 'plugin', source: entry.source, description: entry.manifest.description || '', contributions: entry.manifest.contributions, lifecycle: entry.manifest.lifecycle };
  }

  isLoaded(name) { return this.loaded.has(name); }

  getStats() {
    const byKind = {}; const bySource = {};
    for (const [_, entry] of this.loaded) {
      const kind = entry.manifest.kind || 'plugin'; byKind[kind] = (byKind[kind] || 0) + 1;
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    }
    return { total: this.loaded.size, active: this.loaded.size, byKind, bySource };
  }

  // ─── 兼容旧接口 ───

  getPluginInfo(pluginId) { return this.get(pluginId); }
  getAllPlugins() { return this.getAll(); }
}

let pluginManagerInstance = null;

/**
 * D4 profile 三层装配(2026-08-27): active profile 决定装配清单.
 * 优先级: 显式 options.profile > env CRABPAW_PROFILE > 'server'(默认全量, 兼容现状)。
 */
function resolveActiveProfile(options = {}) {
  if (options.profile) return options.profile;
  if (process.env.CRABPAW_PROFILE) return process.env.CRABPAW_PROFILE;
  return 'server';
}

/**
 * D4 profile 三层装配(2026-08-27): 按 profile 取清单。
 * 只缩编不增编——config.plugins.profiles.<profile> 未键控的层保持现有优先级
 * (pluginCfg 显式对象 > fullManifest 默认, 即 defaultManifestFromDirs 全量);
 * 键控的层仅保留清单内插件名(覆盖), 引用不存在插件名 → throw 点名。
 * config 兼容两种形态: 完整 appConfig(config.plugins.profiles) 或 pluginCfg(config.profiles)。
 */
function profileManifest(config, profile, fullManifest) {
  const cfg = config?.plugins || config || {};
  const profiles = cfg.profiles || {};
  const pick = profiles[profile];
  const out = { builtin: {}, bundled: {}, user: {}, ...fullManifest };
  // 现有优先级: pluginCfg 显式层 > defaultManifest(与 profile 是否配置无关也保留, 兼容现状)
  for (const layer of ['builtin', 'bundled', 'user']) {
    const explicit = typeof cfg[layer] === 'object' && cfg[layer] ? cfg[layer] : null;
    if (explicit && !(pick && Object.prototype.hasOwnProperty.call(pick, layer))) out[layer] = explicit;
  }
  if (!pick || typeof pick !== 'object') return out;
  for (const [layer, names] of Object.entries(pick)) {
    if (!Array.isArray(names)) continue;
    const known = new Set(Object.keys(out[layer] || {}));
    const missing = names.filter((n) => !known.has(n));
    if (missing.length) throw new Error(`profile ${profile} 引用了不存在的 ${layer} 插件: ${missing.join(',')}`);
    const layerObjects = {};
    for (const n of names) layerObjects[n] = (out[layer] && out[layer][n]) || {};
    out[layer] = layerObjects;
  }
  return out;
}

async function getPluginManager() {
  if (!pluginManagerInstance) {
    pluginManagerInstance = new PluginManager();
    await pluginManagerInstance.initialize();
  }
  return pluginManagerInstance;
}

module.exports = { PluginManager, getPluginManager, topoSortPlugins, resolveActiveProfile, profileManifest, BUILTIN_PLUGINS_DIR, USER_PLUGINS_DIR, BUNDLED_PLUGINS_DIR };
