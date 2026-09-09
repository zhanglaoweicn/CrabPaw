/**
 * event-bridge.js — harness EventBus ↔ Cordis ctx.events 双向桥
 * (Phase 1 P1-c 正向同步镜像, 2026-08-25; D7 B5 反向桥, 2026-08-27)
 *
 * 模式①正向（同步镜像, 默认）：所有 harness 类型化事件 → Cordis `ctx.events.emit('harness:<cat>:<type>', payload)`，
 * 树内插件/服务可统一以 ctx.on 观察；harness 侧订阅方不变（向后兼容）。
 *
 * 模式②反向（D7 B5）：树插件经 `ctx.events.emit('<cat>:<type>', payload)` 发出的事件 →
 * harness EventBus.publish（防环: 仅转发非 harness: 前缀、≥2 段名, 与正向镜像姿势一致）。
 *
 * 通配符结论（实现依据, 2026-08-27 核实 vendor/cordis/dist/cordis.cjs）：
 *   EventsService 为精确名匹配（`this._hooks[name] ||= []`），无 '*' 通配语义；且 Context
 *   不暴露 ctx.on 快捷（仅 ctx.events）。故 `ctx.events.on('*', handler)` 只会登记在字面
 *   键 '*' 下、永不触发——反向桥按 brief 的 fallback 声明实现为 ctx.events.emit 包装
 *   （覆盖式转发）。限制：插件侧经 parallel/serial/bail/waterfall 触发的事件不经过 emit
 *   包装、不被转发（见 .superpowers/sdd/task-B5-report.md）。
 */
const { getEventBus } = require('../events');

/** 纯函数：HarnessEvent → 桥载荷（可单测） */
function toBridgePayload(event) {
  if (!event) return null;
  const json = typeof event.toJSON === 'function' ? event.toJSON() : event;
  return {
    category: event.category,
    type: event.type,
    route: event.route,
    payload: json,
  };
}

/**
 * 安装反向桥（cordis → harness; 受保护, 返回卸载函数）。
 * 实现 = ctx.events.emit 包装（cordis 无通配符, 见文件头结论）; 失败 warn 不阻塞。
 * @param {object} ctx Cordis Context
 * @returns {(() => void) | null} 卸载函数（还原原 emit）
 */
function installReverseBridge(ctx) {
  try {
    const target = ctx && (ctx.events || ctx);
    if (!target || typeof target.emit !== 'function') return null;
    const bus = getEventBus();
    const originalEmit = target.emit.bind(target);
    const wrappedEmit = function (...args) {
      // cordis EventsService.dispatch 语义: emit 首参若为对象/函数则视为 thisArg, 事件名在其后
      const idx = args.length && (typeof args[0] === 'object' || typeof args[0] === 'function') ? 1 : 0;
      const name = args[idx];
      if (typeof name === 'string' && !name.startsWith('harness:') && !name.startsWith('internal/')) {
        const parts = name.split(':');
        if (parts.length >= 2) {
          try {
            bus.publish(parts[0], parts.slice(1).join(':'), args[idx + 1], { source: 'cordis' });
          } catch (e) {
            console.warn('[cordis-bridge] 反向镜像失败(不阻塞):', e.message);
          }
        }
      }
      return originalEmit(...args);
    };
    target.emit = wrappedEmit;
    return () => {
      if (target.emit === wrappedEmit) target.emit = originalEmit;
    };
  } catch (e) {
    console.warn('[cordis-bridge] 反向桥安装失败(不阻塞):', e.message);
    return null;
  }
}

/**
 * 安装双向同步镜像桥（受保护；返回组合卸载函数）。
 * @param {object} ctx Cordis Context
 * @returns {() => void} 卸载函数（fiber 卸载时由调用方/effect 管理）
 */
function installHarnessEventBridge(ctx) {
  const bus = getEventBus();
  const unsub = bus.subscribe('*', (event) => {
    try {
      const p = toBridgePayload(event);
      if (p) ctx.events.emit(`harness:${p.category}:${p.type}`, p);
    } catch (e) {
      console.warn('[cordis-bridge] 事件镜像失败(不阻塞):', e.message);
    }
  });
  const unsubReverse = installReverseBridge(ctx) || (() => {});
  return () => {
    unsub();
    unsubReverse();
  };
}

module.exports = { installHarnessEventBridge, installReverseBridge, toBridgePayload };
