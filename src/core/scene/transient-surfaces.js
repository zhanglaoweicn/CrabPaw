const { getSceneStore } = require('./scene-store');

const TRANSIENT_TTL_MS = 20 * 1000;

const timers = new Map();

function scheduleSceneSurfaceRemoval(id, { kind = null, ttlMs = TRANSIENT_TTL_MS } = {}) {
  if (!id || typeof id !== 'string') return;
  cancelSceneSurfaceRemoval(id);
  const timer = setTimeout(() => {
    timers.delete(id);
    const store = getSceneStore();
    const current = store.getSurface(id);
    if (!current) return;
    if (kind && current.kind !== kind) return;
    store.removeSurface(id);
  }, ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(id, timer);
}

function cancelSceneSurfaceRemoval(id) {
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  timers.delete(id);
}

module.exports = {
  scheduleSceneSurfaceRemoval,
  cancelSceneSurfaceRemoval,
  TRANSIENT_TTL_MS,
};
