/**
 * Path Rule Engine — structured read/write/execute deny lists with workspace-aware path resolution
 *
 * Complements existing file-safety.js (isWriteDenied, isReadSensitive).
 * Provides structured deny lists that can be registered as PreToolUse hooks.
 */

const path = require('path');
const fs = require('fs');

class PathRuleEngine {
  constructor(opts = {}) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot || process.cwd());
    this.writableRoots = (opts.writableRoots || [this.workspaceRoot]).map(p => path.resolve(p));
    this._deniedReadPaths = new Set(opts.deniedPaths || []);
    this._deniedWritePaths = new Set(opts.deniedWritePaths || []);
    this._allowedOutsideWorkspace = opts.allowedOutsideWorkspace || false;
  }

  addDeniedRead(absPath) { this._deniedReadPaths.add(path.resolve(absPath)); }
  addDeniedWrite(absPath) { this._deniedWritePaths.add(path.resolve(absPath)); }
  removeDeniedRead(absPath) { this._deniedReadPaths.delete(path.resolve(absPath)); }
  removeDeniedWrite(absPath) { this._deniedWritePaths.delete(path.resolve(absPath)); }

  _resolve(targetPath) {
    if (!targetPath) return null;
    try {
      return path.resolve(targetPath);
    } catch (_) { return null; }
  }

  _isUnderWorkspace(resolved) {
    const sep = path.sep;
    const wsNorm = this.workspaceRoot.endsWith(sep) ? this.workspaceRoot : this.workspaceRoot + sep;
    return resolved === this.workspaceRoot || resolved.startsWith(wsNorm);
  }

  _isUnderWritable(resolved) {
    for (const root of this.writableRoots) {
      const sep = path.sep;
      const rNorm = root.endsWith(sep) ? root : root + sep;
      if (resolved === root || resolved.startsWith(rNorm)) return true;
    }
    return false;
  }

  canRead(targetPath) {
    const resolved = this._resolve(targetPath);
    if (!resolved) return false;
    if (this._deniedReadPaths.has(resolved)) return false;
    if (!this._allowedOutsideWorkspace && !this._isUnderWorkspace(resolved)) return false;
    if (!fs.existsSync(resolved)) return true; // file doesn't exist — allow read check to proceed
    try { fs.accessSync(resolved, fs.constants.R_OK); return true; } catch (_) { return false; }
  }

  canWrite(targetPath) {
    const resolved = this._resolve(targetPath);
    if (!resolved) return false;
    if (this._deniedWritePaths.has(resolved)) return false;
    if (!this._isUnderWritable(resolved)) return false;
    return true;
  }

  canExecute(targetPath) {
    const resolved = this._resolve(targetPath);
    if (!resolved) return false;
    if (!this._isUnderWritable(resolved)) return false;
    try { fs.accessSync(resolved, fs.constants.X_OK); return true; } catch (_) { return false; }
  }

  inspect(targetPath) {
    const resolved = this._resolve(targetPath);
    if (!resolved) return { valid: false, reason: 'invalid_path' };
    return {
      valid: true,
      resolved,
      readable: this.canRead(targetPath),
      writable: this.canWrite(targetPath),
      executable: this.canExecute(targetPath),
      underWorkspace: this._isUnderWorkspace(resolved),
    };
  }

  getDeniedReadPaths() { return Array.from(this._deniedReadPaths); }
  getDeniedWritePaths() { return Array.from(this._deniedWritePaths); }

  // ── 多模式语义 (2026-08-15 P1-1 权限接线) ──
  // DEFAULT: 保持接线前现状 —— 现状读取一律放行(仅 isReadSensitive 提示不拦截),
  //   写入按 file-safety.isWriteDenied 保护清单拦截(与 ai.js 接线前的既有拦截同源,
  //   保证接线前后净效果不变);工作区外路径不再额外收紧(现状允许工作区外读写)。
  // PLAN: 只读 —— 全部写入拦截;读取与 DEFAULT 一致(现状语义)。
  // FULL_AUTO: 全部放行(含工作区外)。
  canReadWithMode(targetPath) {
    if (_globalPermissionMode === PERMISSION_MODE.FULL_AUTO) return true;
    const resolved = this._resolve(targetPath);
    if (!resolved) return false;
    if (this._deniedReadPaths.has(resolved)) return false;
    return true;
  }

  canWriteWithMode(targetPath) {
    if (_globalPermissionMode === PERMISSION_MODE.PLAN) return false;
    if (_globalPermissionMode === PERMISSION_MODE.FULL_AUTO) return true;
    const resolved = this._resolve(targetPath);
    if (!resolved) return false;
    if (this._deniedWritePaths.has(resolved)) return false;
    // DEFAULT: 放行集合 = file-safety.isWriteDenied(接线前 ai.js:413 的既有拦截),不收紧
    try {
      const { isWriteDenied } = require('../file-safety');
      const check = isWriteDenied(targetPath);
      if (check && check.denied) return false;
    } catch (e) {
      console.warn('[path-rules] file-safety 检查失败(放行兜底,由 file-safety 自身兜底):', e?.message || e);
    }
    return true;
  }

  setAgentContext(agentCtx) { this._agentContext = agentCtx; }
  getAgentContext() { return this._agentContext; }
}

// ── Multi-mode Permission System (OpenHarness pattern) ──
const PERMISSION_MODE = Object.freeze({
  DEFAULT: 'default',
  PLAN: 'plan',
  FULL_AUTO: 'full_auto',
});
let _globalPermissionMode = PERMISSION_MODE.DEFAULT;
function setPermissionMode(mode) {
  if (!Object.values(PERMISSION_MODE).includes(mode)) throw new Error('Invalid permission mode: ' + mode);
  _globalPermissionMode = mode;
}
function getPermissionMode() { return _globalPermissionMode; }
function isWriteMode() { return _globalPermissionMode !== PERMISSION_MODE.PLAN; }

// ── 生成器产物写入门控 (2026-08-28 M1 发布必修) ──
// 生成类工具(MarkdownToWord/Excel/PPT/PDF/HTML、图片/视频编辑、TTS 等 output_path
// 可由模型指定)此前不过任何权限门——PLAN 模式"只读"对它们失效, 系统保护目录可被
// 任意落盘(发布安全终审 M1 缺口)。与 Write 工具同源语义: PLAN 全拦 / DEFAULT 委托
// file-safety.isWriteDenied(保护清单+CRABPAW_WRITE_SAFE_ROOT) / FULL_AUTO 放行。
// 模块级实现即可(实例级 denied 列表无运行时注册者, 语义等价 canWriteWithMode)。
function canWriteGeneratorOutput(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (_globalPermissionMode === PERMISSION_MODE.PLAN) return false;
  if (_globalPermissionMode === PERMISSION_MODE.FULL_AUTO) return true;
  try {
    const { isWriteDenied } = require('../file-safety');
    const check = isWriteDenied(targetPath);
    if (check && check.denied) return false;
  } catch (e) {
    console.warn('[path-rules] file-safety 检查失败(放行兜底,由 file-safety 自身兜底):', e?.message || e);
  }
  return true;
}

// ── 插件 files 域检查面 (2026-08-27 B3-2) ──
// 工具属主与文件路径的关联需 checkFn 级扩展(后续轮次), 本函数仅建检查面, 无接线。
/** 插件 files 权限判定——allowedPaths 清单与规则层取交集。
 *  @param {string[]} pluginAllowedPaths 插件声明路径(相对仓库根或绝对)
 *  @param {string} targetPath 目标路径
 *  @returns {{ok: boolean, reason?: string}} */
function checkPluginBasePath(pluginAllowedPaths, targetPath) {
  if (!Array.isArray(pluginAllowedPaths) || pluginAllowedPaths.length === 0) {
    return { ok: false, reason: '插件未声明 files 权限路径' };
  }
  const norm = (p) => path.resolve(p).toLowerCase();
  const t = norm(targetPath);
  for (const p of pluginAllowedPaths) {
    if (typeof p !== 'string' || !p.trim()) continue; // B3-2 审查: 空串条目 path.resolve('')=cwd → 会授整个 cwd 子树(fail-open)
    const base = norm(p);
    const sepPrefix = base.endsWith(path.sep) ? base : base + path.sep;
    if (t === base || t.startsWith(sepPrefix)) return { ok: true };
  }
  return { ok: false, reason: `插件文件访问超出声明路径: ${targetPath}` };
}
module.exports = { PathRuleEngine, PERMISSION_MODE, setPermissionMode, getPermissionMode, isWriteMode, canWriteGeneratorOutput, checkPluginBasePath };
