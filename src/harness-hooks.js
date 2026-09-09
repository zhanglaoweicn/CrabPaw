/**
 * @deprecated 2026-08-15 (P1-3): 本文件原为 40 行 no-op 存根(dry-run 就绪检查
 * 曾引用此路径导致钩子计数恒 0)。现改为转发 src/core/harness-hooks.js ——
 * 唯一真实实现。新代码请直接 require('./core/harness-hooks')。
 * 保留此转发仅为兼容旧引用路径(已知历史消费方仅 dry-run-inspector,已改走新路径)。
 */
module.exports = require('./core/harness-hooks');
