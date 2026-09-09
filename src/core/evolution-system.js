/**
 * Evolution System Bridge — 向后兼容桥接层
 *
 * 此文件为旧版调用方提供向后兼容的 API，内部委托给 src/core/evolution/index.js 的 EvolutionSystem。
 *
 * 调用方（旧版路径）:
 *   - src/handlers/evolution-handler.js  → getEvolutionLog()
 *   - src/handlers/skill-handler.js      → getEvolutionSystemStatus(), triggerEvolution()
 *   - src/cli/request-handler.js         → getEvolutionSystemStatus(), collectFeedback(), getEvolutionLog(), triggerEvolution()
 *   - src/cli/index.js                   → initEvolutionSystem()
 *   - src/core/heartbeat-patrol.js       → triggerEvolution()
 *
 * 新代码请直接使用:
 *   const { getEvolutionSystem } = require('./evolution');
 */

let _bridge = null;

function _getBridge() {
  if (!_bridge) {
    try {
      _bridge = require('./evolution');
    } catch (e) {
      console.warn('[evolution-system] evolution/ 模块加载失败，使用 stub:', e.message);
      _bridge = null;
    }
  }
  return _bridge;
}

/**
 * 初始化进化系统
 */
async function initEvolutionSystem(config = {}) {
  const evolution = _getBridge();
  if (evolution) {
    try {
      const system = evolution.getEvolutionSystem(config);
      system.initialize();
      system.start();
      return { initialized: true, status: 'started' };
    } catch (e) {
      console.error('[evolution-system] initEvolutionSystem 失败:', e.message);
      return { initialized: false, error: e.message };
    }
  }
  // 退化到旧版 EvolutionCoordinator
  try {
    const { getEvolutionCoordinator } = require('./evolution/evolution-coordinator');
    const coordinator = getEvolutionCoordinator();
    coordinator.initialize();
    return { initialized: true, status: 'coordinator_only' };
  } catch (e) {
    return { initialized: false, reason: 'stub', error: e.message };
  }
}

/**
 * 获取进化系统状态
 */
async function getEvolutionSystemStatus() {
  const evolution = _getBridge();
  if (evolution) {
    try {
      const system = evolution.getEvolutionSystem();
      return system.getStatus();
    } catch (e) {
      return { initialized: false, error: e.message };
    }
  }
  // 降级到 EvolutionCoordinator
  try {
    const { getEvolutionCoordinator } = require('./evolution/evolution-coordinator');
    const coordinator = getEvolutionCoordinator();
    return {
      initialized: coordinator._initialized,
      coordinator: {
        queueStatus: coordinator.getQueueStatus(),
        engineCount: coordinator._engines?.size || 0,
      },
    };
  } catch (e) {
    return { initialized: false, status: 'unavailable' };
  }
}

/**
 * 触发进化
 */
async function triggerEvolution() {
  const evolution = _getBridge();
  if (evolution) {
    try {
      const { getEvolutionCoordinator } = require('./evolution/evolution-coordinator');
      const coordinator = getEvolutionCoordinator();
      return await coordinator.evolve();
    } catch (e) {
      return { evolved: false, reason: e.message };
    }
  }
  return { evolved: false, reason: 'evolution_system_unavailable' };
}

/**
 * 收集反馈
 */
/**
 * 收集反馈（P1-5: 原实现调用 coordinator.sendSystemFeedback/sendUserFeedback——
 * 两方法不存在于 EvolutionCoordinator，恒返回 {feedbackId:null,error}。
 * 现路由到已初始化的 FeedbackLoopEngine 真实收集，并留痕演化日志。）
 */
async function collectFeedback(data) {
  try {
    const { getFeedbackLoopEngine } = require('./skill/feedback-loop-engine');
    const engine = getFeedbackLoopEngine();
    engine.recordFeedback({
      skillName: data.skillName || data.skillId || data.metric || 'general',
      success: data.success !== false,
      message: data.message || data.issue || data.content || '',
      source: data.source || 'api',
      kind: data.type === 'system' ? 'system' : 'user',
      ...data,
    });

    // 同时写入演化日志，供 getEvolutionLog 检索
    try {
      const { getEvolutionCoordinator } = require('./evolution/evolution-coordinator');
      getEvolutionCoordinator()._appendEvolutionLog({
        type: 'feedback',
        feedbackType: data.type || 'user',
        skillName: data.skillName || null,
        message: data.message || null,
      });
    } catch (logErr) {
      console.warn('[evolution-system] 演化日志写入失败:', logErr.message);
    }

    return { feedbackId: `fb_${Date.now()}`, recorded: true };
  } catch (e) {
    console.warn('[evolution-system] collectFeedback 失败:', e.message);
    return { feedbackId: null, error: e.message };
  }
}

/**
 * 获取进化日志
 */
async function getEvolutionLog(filter = {}) {
  try {
    const { getEvolutionCoordinator } = require('./evolution/evolution-coordinator');
    const coordinator = getEvolutionCoordinator();
    return coordinator.getEvolutionLog(filter);
  } catch (e) {
    return [];
  }
}

module.exports = {
  initEvolutionSystem,
  getEvolutionSystemStatus,
  triggerEvolution,
  collectFeedback,
  getEvolutionLog,
};
