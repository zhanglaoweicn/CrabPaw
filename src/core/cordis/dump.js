/**
 * dump.js — 装配可寻址（P0-②, dsh 对标机制⑥, 2026-09-03）
 *
 * 背景：dsh 以 --dump-config 提供"装配可寻址"——运行中的装配面可被打印、
 * 被人与工具审视，而不是散落在启动日志里。Phase 1 树已登记服务引用面 +
 * 制度插件面 + 业务插件面（见 boot.js），本模块把它整理成稳定形状的 JSON。
 *
 * 纯函数：接受 createHarnessTree() 返回值，不 require 任何重服务模块
 * （单测直接喂合成树）。消费方：server.js --dump-harness（树建成后打印
 * 一行 HARNESS_DUMP_JSON 并退出）。
 */
const fs = require('fs');
const path = require('path');

function readCordisVersion() {
  try {
    const pkgPath = path.join(__dirname, '../../../vendor/cordis/package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
  } catch (e) {
    console.warn('[cordis-dump] vendor/cordis 版本读取失败:', e.message);
    return null;
  }
}

/**
 * 把 harness 树整理成可寻址装配面。
 * @param {{ ctx: object, fiber: object, inventory: object } | null | undefined} tree
 * @param {Date} [now] 注入时钟（测试用）
 */
function formatHarnessDump(tree, now = new Date()) {
  const inv = (tree && tree.inventory) || {};
  const services = Array.isArray(inv.services) ? inv.services : [];
  const guardPlugins = Array.isArray(inv.guardPlugins) ? inv.guardPlugins : [];
  const businessPlugins = Array.isArray(inv.plugins) ? inv.plugins : [];
  return {
    generatedAt: now.toISOString(),
    cordisVersion: readCordisVersion(),
    profile: inv.profile || 'boss',
    counts: {
      services: services.length,
      guardPlugins: guardPlugins.length,
      businessPlugins: businessPlugins.length,
    },
    services,
    guardPlugins,
    businessPlugins,
    eventBridge: inv.bridge === true ? 'bidirectional-mirror' : 'not-installed',
    note: '装配面=引用现有单例(引用即真理,无副本); 制度插件为登记薄壳, 行为由既有模块执行; profile 语义见 boot.js PROFILES',
  };
}

module.exports = { formatHarnessDump };
