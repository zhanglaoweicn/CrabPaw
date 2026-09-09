/**
 * assembly-view.js — 「插件」页聚合视图（2026-08-25）
 *
 * 装配/信任/生态注册表一次性聚合（每 section try/catch 独立降级——任何一个
 * 子系统异常不拖垮整页；树未建时 tree 段返回 null 前端显示"--"）。
 */
const { listPanels } = require('../panels/panel-registry');
const { listSources } = require('../data-sources/registry');
const { listProviderMeta } = require('../providers/meta-registry');

async function safe(fn, fallback = null) {
  try { return await fn(); } catch { return fallback; }
}

/**
 * @returns {{
 *   assembly: {loaded: number, known: number, disabled: Array<string>, loadedList: Array<{name, version, source}>},
 *   tree: {summary: string|null, ok: boolean|null},
 *   panels: Array,
 *   sources: Array,
 *   providers: {llm: Array, tts: Array, docEngine: Array},
 * }}
 */
async function buildAssemblyView() {
  const assembly = await safe(async () => {
    const { getPluginManager } = require('./plugin-manager');
    const pm = await getPluginManager();
    const loadedList = Array.from(pm.loaded.entries()).map(([name, r]) => ({
      name, version: r?.manifest?.version || '?', source: r?.source || '?',
      trust: r?.manifest?.signatureX509 ? 'signed' : r?.manifest?.signature ? 'hash' : 'unsigned',
    }));
    const disabled = Object.entries(pm._states || {})
      .filter(([, s]) => s && s.enabled === false)
      .map(([name]) => name);
    return { loaded: pm.loaded.size, known: pm._knownPlugins ? pm._knownPlugins.size : 0, disabled, loadedList };
  }, { loaded: 0, known: 0, disabled: [], loadedList: [] });

  const tree = await safe(() => {
    const { getHarnessTree } = require('../cordis/boot');
    const { auditHarnessTree } = require('../cordis/audit');
    const t = getHarnessTree();
    if (!t) return { summary: null, ok: null };
    const r = auditHarnessTree(t);
    return { summary: r.summary, ok: r.ok };
  }, { summary: null, ok: null });

  const panels = await safe(() => listPanels(), []);
  const sources = await safe(() => listSources(), []);
  const providers = await safe(() => ({
    llm: listProviderMeta('llm'),
    tts: listProviderMeta('tts'),
    docEngine: listProviderMeta('doc-engine'),
  }), { llm: [], tts: [], docEngine: [] });

  return { assembly, tree, panels, sources, providers };
}

module.exports = { buildAssemblyView };
