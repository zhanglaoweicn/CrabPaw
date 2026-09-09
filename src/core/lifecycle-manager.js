/**
 * 生命周期管理器
 * 
 * 统一管理全局定时器和 Map/Set 状态，解决以下问题：
 * - setInterval 返回值未保存，无法在进程退出时清理
 * - 全局 Map 无上限控制，长时间运行可能内存泄漏
 * - 定时器未与 Bootstrap 生命周期绑定
 */

const timers = [];
const managedMaps = new Map(); // name -> { map, maxSize, onEvict }

/**
 * 注册一个受管理的 setInterval，确保进程退出时可清理
 * @param {string} name - 定时器名称（用于日志和调试）
 * @param {Function} callback - 回调函数
 * @param {number} intervalMs - 间隔毫秒数
 * @returns {NodeJS.Timeout} 定时器ID
 */
function registerInterval(name, callback, intervalMs) {
  const id = setInterval(callback, intervalMs);
  if (id.unref) {
    id.unref();
  }
  timers.push({ name, id, intervalMs, createdAt: Date.now() });
  console.log(`⏱️ [lifecycle] 注册定时器: ${name} (间隔 ${intervalMs}ms)`);
  return id;
}

/**
 * 注册一个受管理的 Map，带容量上限和淘汰策略
 * @param {string} name - Map名称
 * @param {number} maxSize - 最大条目数
 * @param {Function} [onEvict] - 淘汰回调 (key, value) => void
 * @returns {Map} 受管理的 Map 实例
 */
function registerMap(name, maxSize, onEvict) {
  const map = new Map();
  managedMaps.set(name, { map, maxSize, onEvict });
  console.log(`🗺️ [lifecycle] 注册Map: ${name} (最大 ${maxSize} 条目)`);
  return map;
}

/**
 * 向受管理的 Map 中设置条目，超限时自动淘汰
 */
function managedSet(mapName, key, value) {
  const entry = managedMaps.get(mapName);
  if (!entry) {
    console.warn(`⚠️ [lifecycle] 未注册的Map: ${mapName}`);
    return;
  }
  const { map, maxSize, onEvict } = entry;
  if (map.size >= maxSize && !map.has(key)) {
    // 淘汰最早的条目（FIFO）
    const oldestKey = map.keys().next().value;
    const oldestValue = map.get(oldestKey);
    if (onEvict) onEvict(oldestKey, oldestValue);
    map.delete(oldestKey);
  }
  map.set(key, value);
}

/**
 * 清理所有注册的定时器
 */
function clearAllTimers() {
  console.log(`🛑 [lifecycle] 清理 ${timers.length} 个定时器...`);
  for (const { name, id } of timers) {
    clearInterval(id);
    console.log(`⏱️ [lifecycle] 已清理定时器: ${name}`);
  }
  timers.length = 0;
}

/**
 * 清理所有受管理的 Map
 */
function clearAllMaps() {
  console.log(`🛑 [lifecycle] 清理 ${managedMaps.size} 个Map...`);
  for (const [name, { map }] of managedMaps) {
    map.clear();
    console.log(`🗺️ [lifecycle] 已清理Map: ${name}`);
  }
  managedMaps.clear();
}

/**
 * 完整清理（定时器 + Map），用于进程退出
 */
function shutdown() {
  console.log('🛑 [lifecycle] 执行完整生命周期清理...');
  clearAllTimers();
  clearAllMaps();
  console.log('✅ [lifecycle] 生命周期清理完成');
}

/**
 * 获取当前生命周期状态（用于监控和调试）
 */
function getStatus() {
  return {
    timers: timers.map(t => ({ name: t.name, intervalMs: t.intervalMs, createdAt: t.createdAt })),
    maps: Array.from(managedMaps.entries()).map(([name, { map, maxSize }]) => ({
      name,
      size: map.size,
      maxSize,
      usagePercent: ((map.size / maxSize) * 100).toFixed(1) + '%',
    })),
  };
}

module.exports = {
  registerInterval,
  registerMap,
  managedSet,
  clearAllTimers,
  clearAllMaps,
  shutdown,
  getStatus,
};
