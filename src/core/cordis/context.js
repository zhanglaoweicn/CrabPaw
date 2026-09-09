/**
 * context.js — 全局 harness 上下文面（Phase C 主纲 P1-e, 2026-08-27）。
 * getHarnessContext(): 树建立后的上下文(服务/插件面)访问点——插件与存量模块
 * 经同一对象取服务(引用即真理)。树未创建时返回 null(调用方必须 null-safe)。
 */
let _ctx = null;

function getHarnessContext() {
  return _ctx;
}

function setHarnessContext(tree) {
  _ctx = tree;
  return tree;
}

module.exports = { getHarnessContext, setHarnessContext };
