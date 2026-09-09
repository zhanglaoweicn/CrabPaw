/**
 * audit.js — fail-loud 树审计（Phase 1 P1-d, 2026-08-25）
 *
 * assertHarnessTree(tree)：启动末审计——
 *  ① 服务面完整性（缺哪个点名）② 制度插件 6/6 且 protected（制度不可摘除）
 *  ③ 业务插件面空壳点名（inventory.plugins 每插件贡献条目数 0=空壳；制度薄壳不计入此面）。
 * 输出单行摘要「🌳 Harness 树审计」；CORDIS_AUDIT_STRICT=1 时非绿即 raise（启动可见失败）。
 * 接入点：src/cli/server.js 启动日志段（printProfile 之后）。
 */

const EXPECTED_SERVICES = ['tools', 'eventBus', 'serviceRegistry', 'config', 'mcp', 'scheduler', 'pluginManager', 'logger'];
const EXPECTED_GUARDS = 6;

// P2-③(2026-09-03): profile 感知审计——boss 全量期望, minimal 只要求桥(无服务/制度壳)。
// 期望集随 boot.PROFILES 对齐; 未知 profile 按 boss 处理(保守)。
const PROFILE_EXPECTATIONS = {
  boss: { services: EXPECTED_SERVICES, guards: EXPECTED_GUARDS },
  minimal: { services: [], guards: 0 },
};

/**
 * @param {{inventory: {profile?: string, services: string[], guardPlugins: Array<{id,name,protected}>}, ctx: object}} tree
 * @param {{profile?: string}} [options]
 * @returns {{ok: boolean, summary: string, problems: string[]}}
 */
function auditHarnessTree(tree, options = {}) {
  const problems = [];
  if (!tree || !tree.inventory) return { ok: false, summary: '🌳 Harness 树审计: 树不存在', problems: ['tree==null'] };

  const profile = tree.inventory.profile || options.profile || 'boss';
  const expectations = PROFILE_EXPECTATIONS[profile] || PROFILE_EXPECTATIONS.boss;

  for (const name of expectations.services) {
    if (!tree.inventory.services.includes(name)) {
      problems.push(`缺服务: ${name}`);
    } else if (tree.ctx[name] === undefined) {
      problems.push(`服务不可解析: ${name}`);
    }
  }

  const guards = tree.inventory.guardPlugins || [];
  if (guards.length !== expectations.guards) {
    problems.push(`制度插件 ${guards.length}/${expectations.guards}`);
  }
  const unProtected = guards.filter((g) => !g.protected);
  if (unProtected.length > 0) {
    problems.push(`未受保护(可被摘除): ${unProtected.map((g) => g.id).join(',')}`);
  }

  // 2026-08-27 B1-4: 真实现空壳点名——按每插件登记的贡献条目数判定空壳(0 贡献=空壳)。
  // 数据源: 业务插件面(inventory.plugins, createHarnessTree 登记; 兼容旧树顶层 tree.plugins)。
  // 制度薄壳(guardPlugins)是制度登记面, 不在此列——避免 6 个制度薄壳被点名成空壳。
  // 面为空数组(当前树真实状态: 业务插件走 plugin-manager 不经过树)=空壳 0, 诚实起点不伪报。
  const pluginRecords = Array.isArray(tree.plugins) ? tree.plugins : (tree.inventory?.plugins || []);
  const shells = pluginRecords
    .map((p) => ({ id: p.id, contribs: p.contributes ? Object.values(p.contributes).filter(Boolean).length : 0 }))
    .filter((p) => p.contribs === 0)
    .map((p) => p.id);
  if (shells.length > 0) {
    problems.push(`空壳: ${shells.join(',')}`);
  }

  const ok = problems.length === 0;
  const summary = ok
    ? `🌳 Harness 树审计[${profile}]: 服务${tree.inventory.services.length} 插件${guards.length} 空壳0 ✓`
    : `🌳 Harness 树审计[${profile}]: ⚠ ${problems.join('; ')}`;
  return { ok, summary, problems, profile };
}

/**
 * 审计 + 输出；strict 模式(env CORDIS_AUDIT_STRICT=1)非绿 raise。
 * @returns {{ok: boolean, summary: string, profile: string}}
 */
function assertHarnessTree(tree, options = {}) {
  const r = auditHarnessTree(tree, options);
  if (r.ok) {
    console.log(r.summary);
  } else {
    console.warn('⚠️ ' + r.summary);
  }
  if (!r.ok && process.env.CORDIS_AUDIT_STRICT === '1') {
    throw new Error(`[cordis-audit] ${r.problems.join('; ')}`);
  }
  return r;
}

module.exports = { auditHarnessTree, assertHarnessTree, EXPECTED_SERVICES, EXPECTED_GUARDS };
