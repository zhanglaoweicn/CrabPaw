/**
 * Eval 数据目录隔离（2026-08-31 Eval 隔离轮 Task 2）
 *
 * 目的：eval 全程读写 mkdtemp 临时数据根，不再触碰真实 data/.crabpaw
 * （251MB 记忆库）——根治 mem_008/collab 环境态红与用户数据污染。
 *
 * 前提（Task 1 已落地）：16 个数据模块路径统一读 config.DATA_DIR，
 * config 单例在 require 期读取 CRABPAW_DATA_DIR env 固化。因此本安装
 * 必须发生在 **config 首次 require 之前**——evals/index.js 在顶部、
 * 任何套件 require 之前调用；regression-check.js 在 runEval 惰性
 * require 套件之前调用。
 *
 * 宿主进程防线：本模块被 regression-guard 插件在服务端进程内 require 时，
 * config 早已加载（DATA_DIR 已固化为真实库）。此时安装 env 既无效
 * （已缓存模块路径不变）又有害（eval 窗口内惰性 require 的新模块会
 * 被冻结到临时目录，宿主后续写生产数据静默丢失）——故检测到 config
 * 已加载即跳过并 warn，宿主内 eval 维持既有行为（未隔离，如实告警）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_MODULE = '../src/core/config';

/** @type {{ dir: string } | null} 已安装的隔离目录（幂等缓存） */
let _installed = null;

/**
 * config 单例是否已在本进程加载（DATA_DIR 已固化、env 重定向失效）。
 */
function isConfigAlreadyLoaded() {
  try {
    return !!require.cache[require.resolve(CONFIG_MODULE)];
  } catch {
    return false; // 模块路径解析失败按未加载处理（不影响安装安全性：resolve 失败=未缓存）
  }
}

/**
 * 安装隔离数据目录：mkdtemp 临时根 + 设 CRABPAW_DATA_DIR。
 *
 * 幂等：二次调用返回同一目录对象（不再新建）。
 *
 * @param {{ reason?: string }} [options] 用途标记（写入临时目录名，便于排查）
 * @returns {{ dir: string } | null} 成功返回 { dir }；config 已加载（宿主进程）返回 null
 */
function installIsolatedDataDir(options = {}) {
  const reason = options.reason || 'eval';
  if (_installed) return _installed;

  if (isConfigAlreadyLoaded()) {
    console.warn(
      `[isolated-data-dir] config 单例已加载（宿主进程内运行 eval），` +
        `DATA_DIR 已固化为真实库——跳过隔离以避免半重定向数据分裂（reason=${reason}）`
    );
    return null;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `crabpaw-eval-data-${reason}-`));
  process.env.CRABPAW_DATA_DIR = dir;
  _installed = { dir };
  console.log(`[isolated-data-dir] eval 数据目录已隔离: ${dir}`);
  return _installed;
}

/**
 * 当前已安装的隔离目录（未安装返回 null）。
 */
function getInstalledDir() {
  return _installed ? _installed.dir : null;
}

module.exports = {
  installIsolatedDataDir,
  getInstalledDir,
  isConfigAlreadyLoaded,
};
