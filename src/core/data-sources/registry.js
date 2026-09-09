/**
 * registry.js — 数据源注册表（Phase 3b 卡片数据解耦, 2026-08-25）
 *
 * 卡片插件化承上启下：panel-registry 声明「这张卡用哪个数据源」(dataSource 字段)，
 * 本表把「源名 → 取数函数」统一收口：卡片/工具只认源名，不写死实现。
 * 源实现保持原样（委托引用——不复制/不改写取数逻辑），注册即发现。
 *
 * 注册契约：{ name, fetch: (params) => Promise<data>, health?: () => Promise<'ok'|'degraded'|'down'>, description? }
 * 三态源（主/备/降级链）由实现方内部管理——注册表只给“声明+发现+鉴权面”。
 */
const _sources = new Map(); // name → source

/** 注册（重名拒绝；source.tag 可标记托管来源——插件贡献注销用。
 *  options.replace: 接管同名源（插件托管 builtin 时用——disable 后源随插件摘除） */
function registerSource(source, options = {}) {
  if (!source || typeof source.name !== 'string' || !source.name.trim()) {
    return { ok: false, error: 'source.name 必填' };
  }
  if (typeof source.fetch !== 'function') {
    return { ok: false, error: `source(${source.name}).fetch 必须为函数` };
  }
  if (_sources.has(source.name)) {
    if (!options.replace) return { ok: false, error: `重复注册数据源: ${source.name}` };
    _sources.delete(source.name);
  }
  _sources.set(source.name, source);
  return { ok: true };
}

/** 注销单个源（插件 disable 时按 name 摘除——数据源托管反注册） */
function unregisterSource(name) {
  if (!name) return { ok: false, error: 'unregisterSource 需 name' };
  const ex = _sources.get(name);
  if (!ex) return { ok: false, error: `数据源未注册: ${name}` };
  _sources.delete(name);
  return { ok: true };
}

/** 按来源标记批量注销（插件 disable: tag = 'plugin:<name>'） */
function unregisterBySource(tag) {
  if (!tag) return { ok: false, error: 'unregisterBySource 需 tag' };
  let removed = 0;
  for (const [name, src] of _sources) {
    if (src.tag === tag) { _sources.delete(name); removed += 1; }
  }
  return { ok: true, removed };
}

/** 取源（未注册返回 null——调用方按无此源处理/降级） */
function getSource(name) {
  return _sources.get(name) || null;
}

/** 源列表（卡片/工具声明校验用） */
function listSources() {
  return Array.from(_sources.values()).map((s) => ({
    name: s.name,
    description: s.description || '',
    hasHealth: typeof s.health === 'function',
  }));
}

/** 统一取数（源不可用/未注册 → 抛可读错误, 由调用方降级链兜底） */
async function fetchFromSource(name, params = {}) {
  const src = getSource(name);
  if (!src) throw new Error(`数据源未注册: ${name}`);
  return src.fetch(params);
}

// ── 内置默认注册（委托现有实现——零改写的引用式接入） ──
function installBuiltinSources() {
  const results = [];
  const tryReg = (source) => {
    const r = registerSource({ ...source, tag: source.tag || 'builtin' });
    results.push({ name: source.name, ok: r.ok, error: r.error });
  };

  try {
    const { getStockDataSourceManager } = require('../stock-data-source-manager');
    tryReg({
      name: 'stock',
      description: '股票行情/资讯(AKShare 多源+降级链)',
      fetch: (params = {}) => getStockDataSourceManager().fetchWithRedundancy(params.code, params.capabilities || ['quote']),
      health: () => getStockDataSourceManager().healthCheck(),
    });
  } catch (e) { results.push({ name: 'stock', ok: false, error: e.message }); }

  try {
    const { globalTyphoonPanel } = require('../panels/typhoon');
    tryReg({
      name: 'typhoon',
      description: '台风路径/历史台风(主源+备源)',
      fetch: (params = {}) => globalTyphoonPanel.getTyphoon(params),
    });
  } catch (e) { results.push({ name: 'typhoon', ok: false, error: e.message }); }

  try {
    const { globalWeatherPanel } = require('../panels/weather');
    tryReg({
      name: 'weather',
      description: '天气(城市查询)',
      fetch: (params = {}) => globalWeatherPanel.getWeather(params.city || '北京', params),
    });
  } catch (e) { results.push({ name: 'weather', ok: false, error: e.message }); }

  try {
    const { listTables } = require('../business-data-registry');
    tryReg({
      name: 'business',
      description: '经营数据(导入表 registry: 表清单/角色/行数/时间)',
      fetch: () => Promise.resolve({ tables: listTables() }),
    });
  } catch (e) { results.push({ name: 'business', ok: false, error: e.message }); }

  try {
    const { commoditySearch } = require('../commodity/commodity-service');
    tryReg({
      name: 'commodity',
      description: '商品查询(浏览器导航+多模态截图解析, 免登录源优先)',
      fetch: (p = {}) => commoditySearch(p.query || '', p),
    });
  } catch (e) { results.push({ name: 'commodity', ok: false, error: e.message }); }

  // lark-bitable 源由 src/tools/lark-tools.js 自注册（tools→core 方向合法；
  // 此处若 require tools 会构成 R1 core→upper 层违规）

  return results;
}

module.exports = {
  registerSource, unregisterSource, unregisterBySource,
  getSource, listSources, fetchFromSource, installBuiltinSources,
  // 2026-08-26 插件托管对齐: 与 services/registry 同款 getter 语义(plugin-manager 绑定用)
  getDataSourcesRegistry: () => require('./registry'),
};
