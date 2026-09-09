/**
 * 专家协作自动触发（2026-08-15 T7 分部一）
 *
 * 聊天意图路径：intent-analyzer 命中「多专家协作」（技能提示 agent-team-orchestration
 * 或消息含多专家/协作语义）且当前无同会话进行中的协作任务时，自动发起协作。
 * GUI 手动向导（POST /api/experts/collab/start）路径保持不变——双入口，
 * 幂等去重（同 sessionId 存在 running 协作则跳过）防止与手动路径重复执行。
 */

const COLLAB_ACTIVE_WINDOW_MS = 10 * 60 * 1000; // 同会话 running 协作的有效窗口

// 「多专家协作」技能提示（intent-analyzer SKILL_KEYWORDS 命中产物）
const COLLAB_SKILL_HINTS = new Set(['agent-team-orchestration']);

// 「多专家协作」消息语义模式
const COLLAB_PATTERNS = [
  /(?:多(?:个)?专家|多个.*智能体|专家.*(?:一起|协作|协同|团队))/,
  /(?:团队协作|协同分析|多方.*(?:分析|评审|方案))/,
  /(?:multi[\s-]?agent|team\s+collaboration)/i,
];

function isCollabIntent(message, suggestion) {
  if (suggestion && suggestion.skillHint && COLLAB_SKILL_HINTS.has(String(suggestion.skillHint).toLowerCase())) {
    return true;
  }
  const msg = String(message || '');
  return COLLAB_PATTERNS.some((p) => p.test(msg));
}

/**
 * 默认专家集：用专家路由关键词匹配（intent-analyzer 推荐思路）取前 3 位；
 * 不足 2 位时退回内置组合。
 */
function pickDefaultExperts(message) {
  const { routeMessage } = require('./index');
  let routed = [];
  try {
    routed = (routeMessage(message) || []).slice(0, 3);
  } catch (e) {
    console.warn('[auto-collab] 专家路由失败:', e?.message || e);
  }
  const picked = routed.filter((r) => r && r.expertId);
  if (picked.length >= 2) return picked.map((r) => r.expertId);
  return ['boss_cockpit', 'finance_advisor'];
}

/**
 * @param {string} userId 会话标识（幂等去重维度）
 * @param {string} message 用户消息
 * @param {object|null} suggestion intent-analyzer.suggest 结果（可为 null，仍按消息模式判断）
 * @param {{runner?: Function, deadlineMs?: number}} opts 测试注入（runner 透传 startCollaboration）
 * @returns {Promise<{collabId: string, goal: string}|null>} 发起成功返回协作信息；跳过/失败返回 null
 */
async function maybeAutoStartCollab(userId, message, suggestion, opts = {}) {
  if (!isCollabIntent(message, suggestion)) return null;
  const { startCollaboration, hasActiveCollabSession } = require('./collaboration');

  // 幂等：同会话进行中协作任务存在则跳过（防与手动向导重复执行）
  // 2026-09-05 修复: 改走内存索引——此前每轮聊天 listCollaborations(20) 全量扫盘
  // (collabs/ 目录 2.4 万文件, 每次聊天 readdirSync+逐文件 readFileSync 线性劣化)
  if (userId && hasActiveCollabSession(userId, COLLAB_ACTIVE_WINDOW_MS)) {
    console.log('[auto-collab] 同会话已有进行中协作,跳过自动发起');
    return null;
  }

  const expertIds = pickDefaultExperts(message);
  const goal = String(message || '').trim().slice(0, 80) || '多专家协作任务';
  try {
    const r = await startCollaboration({
      goal,
      tasks: expertIds.map((expertId) => ({ expertId, prompt: '' })),
    }, { sessionId: userId || null, runner: opts.runner, deadlineMs: opts.deadlineMs });
    console.log('🤝 [auto-collab] 自动发起专家协作:', r.collabId, '专家:', expertIds.join(','));
    return r;
  } catch (e) {
    console.warn('[auto-collab] 自动发起专家协作失败(不影响聊天):', e?.message || e);
    return null;
  }
}

module.exports = { maybeAutoStartCollab, isCollabIntent, pickDefaultExperts };
