'use strict';

/**
 * permission-enforce.js — D8 权限执行域强制（2026-08-27）。
 * 设计: 工具执行前按「工具所属插件(registry source)→其 manifest permissions」判定。
 *  - exec 类(Bash/ShellExec/Cmd/PowerShell): 需 permissions.exec === true
 *  - network 类(WebFetch/WebSearch/HttpRequest/FetchUrl): 需 permissions.network === true
 *  - files 类(F1): none 类工具按 fileParams 注解校验 permissions.files 声明
 *    （相对插件目录展开，未声明 fail-closed；非字符串参数不校验）
 *  - 层(layer)权威标记: entry.layer(装配来源 builtin/bundled/user) 优先, 目录推断兜底;
 *    builtin/bundled 层豁免。B3-1 起不再从 source 字符串前缀判信任——
 *    source 是 plugin:<name>, 名字可被仿冒(builtin-evil 前缀绕过已封)。
 *  - 未签名外部(user)插件高权(exec/network)默认拒绝(HARD)——即使声明了权限,
 *    仍需签名(manifest.signature/signatureX509)方在声明内工作。
 * 拦截面: tools/registry.js 的 _preExecuteHooks——hook 收 (name, params, context, toolMeta)，
 * 由 registry 在调用时注入 toolMeta = { source }（老 hook 忽略第 4 参，向前兼容）。
 */
const path = require('path');

const EXEC_TOOLS = new Set(['Bash', 'ShellExec', 'Cmd', 'PowerShell']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch', 'HttpRequest', 'FetchUrl']);

function classifyTool(name) {
  if (EXEC_TOOLS.has(name)) return 'exec';
  if (NETWORK_TOOLS.has(name)) return 'network';
  return 'none';
}

/**
 * 信号优先级: entry.layer(权威) > 目录推断 > 'user'。
 * 目录边界用 path.sep 收紧(plugins-evil 前缀目录不误判入 builtin 树)。
 * plugin-manager 为惰性 require——本模块在 registry 链上, 避免加载期环依赖。
 */
function resolveLayer(pm, pluginName, entry) {
  if (entry && typeof entry.layer === 'string' && entry.layer) return entry.layer;
  if (entry && typeof entry.dir === 'string') {
    const { BUILTIN_PLUGINS_DIR, BUNDLED_PLUGINS_DIR, USER_PLUGINS_DIR } = require('./plugin-manager');
    if (entry.dir === BUILTIN_PLUGINS_DIR || entry.dir.startsWith(BUILTIN_PLUGINS_DIR + path.sep)) return 'builtin';
    // 兜底路径中 plugins/bundled 在 builtin 树内, 此分支仅 entry.layer='bundled' 权威路径可达——若未来分层降权须先重排 (B3-1 复审)
    if (entry.dir === BUNDLED_PLUGINS_DIR || entry.dir.startsWith(BUNDLED_PLUGINS_DIR + path.sep)) return 'bundled';
    if (entry.dir === USER_PLUGINS_DIR || entry.dir.startsWith(USER_PLUGINS_DIR + path.sep)) return 'user';
  }
  return 'user';
}

// 存在性检查——信任由 load 门禁 fail-closed 保证(声明签名无效即拒载, entry 不可能带无效签名) (B3-1 复审)
function isSigned(entry) { const m = entry && entry.manifest; return !!(m && (m.signature || m.signatureX509)); }

function isTrustedLayer(layer) { return layer === 'builtin' || layer === 'bundled'; }

/** B3 files 接线 (2026-08-27 F1): 声明路径相对插件目录展开
 *  （安全语义=插件文件工具只许触及自己包附近）。
 *  @param {object} entry 插件加载条目（dir 为插件目录）
 *  @param {string[]} declaredFiles permissions.files 声明（相对插件目录或绝对）
 *  @returns {string[]} 归一为绝对路径的放行清单 */
function resolvePluginFileAllowlist(entry, declaredFiles) {
  const base = entry && entry.dir ? entry.dir : process.cwd();
  return (declaredFiles || []).filter((p) => typeof p === 'string').map((p) => path.resolve(base, p));
}

/** files 分支裁决: 返回 null=放行, 其余=拦截决策（未声明默认拒 fail-closed / 越界拦）。
 *  非字符串/空值参数不校验（登记边界: URL 注解责任、用户侧文件权限归 path-rules 正交域）。 */
function filesGate(toolMeta, params, entry) {
  const perms = entry.permissions || { files: [] };
  const declared = Array.isArray(perms.files) ? perms.files : [];
  if (declared.length === 0) {
    return { blocked: true, reason: `插件 ${entry.manifest.name} 的文件访问未声明（permissions.files 为空），工具 ${(toolMeta.source || '').replace(/^plugin:/, '')} 的文件参数被拦截` };
  }
  const allowlist = resolvePluginFileAllowlist(entry, declared);
  const { checkPluginBasePath } = require('../permissions/path-rules');
  for (const pname of toolMeta.fileParams || []) {
    const v = params ? params[pname] : undefined;
    if (typeof v !== 'string' || !v) continue;   // 非字符串不校验（登记边界）
    const r = checkPluginBasePath(allowlist, v);
    if (!r.ok) {
      return { blocked: true, reason: `插件 ${entry.manifest.name} 的文件访问超出声明路径: ${v}（声明相对插件目录），参数 ${pname} 被拦截` };
    }
  }
  return null;
}

/**
 * 构建权限钩子(给 registry.addPreExecuteHook)。
 * 真值表(B3-1): 非插件注册→null | cls=none→null | 官方层→null |
 *   声明内+签名→null | 声明内未签名→拒(HARD 默认拒) | 未声明→拒
 * @param {object} pm PluginManager(loaded map 为权限真源)
 * @returns {(name, params, context, toolMeta) => {blocked, reason}?|null}
 */
function buildPluginPermissionHook(pm) {
  return (name, _params, _context, toolMeta = {}) => {
    const pluginName = (toolMeta.source || '').replace(/^plugin:/, '');
    const entry = pm.loaded.get(pluginName);
    if (!entry) return null;                       // 非插件注册(核心工具) → 不归本钩子
    const layer = resolveLayer(pm, pluginName, entry);
    const cls = classifyTool(name);
    // 2026-08-27 B3 files 接线 (F1): none 类工具按 fileParams 注解走 files 分支——
    // 无注解 → 放行(既有语义不变: Read 等无 fileParams 不受影响); 官方层豁免。
    if (cls === 'none') {
      const params = _params || {};
      if (!Array.isArray(toolMeta.fileParams) || toolMeta.fileParams.length === 0) return null;
      if (isTrustedLayer(layer)) return null;
      return filesGate(toolMeta, params, entry);
    }
    if (isTrustedLayer(layer)) return null;        // 官方层豁免
    const perms = entry.permissions || { files: [], network: false, exec: false };
    const declared = cls === 'exec' ? perms.exec === true : cls === 'network' ? perms.network === true : true;
    if (declared && isSigned(entry)) return null;  // signed/hash-pin 在声明内工作
    if (declared && !isSigned(entry)) return { blocked: true, reason: `插件 ${pluginName} 未验证署名：高风险权限（${cls}）需签名插件方可使用，工具 ${name} 被安全策略拦截` };
    return { blocked: true, reason: `插件 ${pluginName} 未声明 ${cls} 权限（permissions.${cls}），工具 ${name} 被安全策略拦截` };
  };
}

module.exports = { classifyTool, resolveLayer, isTrustedLayer, isSigned, buildPluginPermissionHook, resolvePluginFileAllowlist, filesGate };
