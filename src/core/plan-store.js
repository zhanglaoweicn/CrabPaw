/**
 * PlanStore — 显式执行计划（Plan 实体, Plan/Artifact 深化轮）
 *
 * 文章基准："Plan 是 Agent 认为应该完成哪些步骤，Run State 是系统当前实际运行
 * 到哪里——两者分开管理，前端看到的 Plan UI 是状态的一种投影。"
 *
 * 此前计划只存在于模型上下文的文字里：用户看不见进度，模型自己也会跑偏
 * （忘目标/重复执行/顺序混乱）。现在计划成为有身份的对象：
 *   planId + runId + steps[{index,text,status}] + revision（调整次数）
 *
 * 存储：DATA_DIR/checkpoints/plan_<runId>.json（CheckpointStore 原子写，
 * 与 runrec 同目录同生命周期——run 崩溃恢复扫描时计划随之可查）。
 * 广播：plan.updated 事件（/events SSE），前端 PlanSection 渲染投影。
 */

const { CheckpointStore } = require('./checkpoint-store');
const { DATA_DIR } = require('./config');
const path = require('path');
const { broadcastEvent } = require('./sse-broadcast');

const STEP_STATUSES = new Set(['pending', 'running', 'done', 'failed']);
const MAX_STEPS = 20;
const MAX_PLANS = 50;

const STEP_ICON = { pending: '○', running: '●', done: '✓', failed: '✗' };

class PlanStore {
  constructor(options = {}) {
    this._store = options.store || new CheckpointStore({
      dir: options.dir || path.join(DATA_DIR, 'checkpoints'),
    });
    this._plans = new Map(); // runId -> plan
  }

  _key(runId) {
    return `plan_${runId}`;
  }

  /**
   * 创建或整体修订计划（PlanCreate / 模型改主意时 PlanUpdate 全量替换）
   * @param {string} runId
   * @param {{title?: string, steps: string[]}} spec
   * @returns {{plan: object, revised: boolean}}
   */
  setPlan(runId, spec = {}) {
    if (!runId) return { ok: false, error: 'runId 必填' };
    const rawSteps = Array.isArray(spec.steps) ? spec.steps : [];
    const texts = rawSteps
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .slice(0, MAX_STEPS);
    if (texts.length === 0) return { ok: false, error: 'steps 不能为空' };

    const existing = this._plans.get(runId) || this._load(runId);
    let plan;
    let revised = false;
    if (existing) {
      revised = true;
      plan = {
        ...existing,
        title: spec.title || existing.title,
        revision: (existing.revision || 1) + 1,
        previousSteps: existing.steps,
        steps: texts.map((text, i) => ({
          index: i + 1,
          text,
          // 修订时保留同文本步骤的状态，新增步骤重置为 pending
          status: (existing.steps.find((s) => s.text === text) || {}).status || 'pending',
        })),
        updatedAt: Date.now(),
      };
    } else {
      plan = {
        planId: `plan_${runId}`,
        runId,
        title: spec.title || '执行计划',
        revision: 1,
        steps: texts.map((text, i) => ({ index: i + 1, text, status: 'pending' })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    this._plans.set(runId, plan);
    this._persist(plan);
    broadcastEvent('plan:updated', this._publicPlan(plan));
    return { ok: true, plan, revised };
  }

  /**
   * 更新单个步骤状态（PlanUpdate 指定 stepIndex 时）
   * @returns {{ok: boolean, plan?: object, error?: string}}
   */
  updateStep(runId, stepIndex, status, note = '') {
    if (!runId) return { ok: false, error: 'runId 必填' };
    if (!STEP_STATUSES.has(status)) return { ok: false, error: `非法状态: ${status}` };
    const plan = this._plans.get(runId) || this._load(runId);
    if (!plan) return { ok: false, error: '计划不存在（先 PlanCreate）' };
    const step = plan.steps.find((s) => s.index === Number(stepIndex));
    if (!step) return { ok: false, error: `步骤 ${stepIndex} 不存在（1-${plan.steps.length}）` };
    step.status = status;
    if (note) step.note = String(note).slice(0, 200);
    plan.updatedAt = Date.now();
    this._plans.set(runId, plan);
    this._persist(plan);
    broadcastEvent('plan:updated', this._publicPlan(plan));
    return { ok: true, plan };
  }

  getPlan(runId) {
    if (!runId) return null;
    return this._plans.get(runId) || this._load(runId);
  }

  /** 渲染给模型看的紧凑文本（上下文注入/工具结果回执共用） */
  renderPlanText(plan) {
    if (!plan) return '';
    const rows = plan.steps.map((s) => `${STEP_ICON[s.status] || '○'} ${s.index}. ${s.text}${s.note ? `（${s.note}）` : ''}`);
    const done = plan.steps.filter((s) => s.status === 'done').length;
    return [
      `[计划] ${plan.title}（v${plan.revision}，${done}/${plan.steps.length} 完成）`,
      ...rows,
    ].join('\n');
  }

  _publicPlan(plan) {
    return {
      planId: plan.planId,
      runId: plan.runId,
      title: plan.title,
      revision: plan.revision,
      steps: plan.steps.map((s) => ({ index: s.index, text: s.text, status: s.status, note: s.note || '' })),
      progress: {
        done: plan.steps.filter((s) => s.status === 'done').length,
        total: plan.steps.length,
      },
      ts: plan.updatedAt,
    };
  }

  _persist(plan) {
    try {
      this._store.saveCheckpoint(this._key(plan.runId), plan);
      this._prune();
    } catch (e) {
      console.warn('[plan-store] 计划落盘失败(不阻塞):', e?.message || e);
    }
  }

  _load(runId) {
    try {
      const plan = this._store.loadCheckpoint(this._key(runId));
      if (!plan) return null;
      this._plans.set(runId, plan);
      return plan;
    } catch (e) {
      return null;
    }
  }

  /** 清理历史计划，防 checkpoints 目录增长（与 runrec 同款策略） */
  _prune() {
    try {
      const keys = this._store.listCheckpoints('plan_');
      if (keys.length <= MAX_PLANS) return;
      const items = [];
      for (const key of keys) {
        const plan = this._store.loadCheckpoint(key);
        if (plan && plan.updatedAt) items.push({ key, updatedAt: plan.updatedAt });
      }
      items.sort((a, b) => a.updatedAt - b.updatedAt);
      for (const item of items.slice(0, items.length - MAX_PLANS)) {
        this._store.deleteCheckpoint(item.key);
      }
    } catch (e) {
      console.warn('[plan-store] 历史计划清理失败(忽略):', e?.message || e);
    }
  }
}

let _instance = null;

function getPlanStore(options) {
  if (!_instance) _instance = new PlanStore(options);
  return _instance;
}

module.exports = { PlanStore, getPlanStore, STEP_STATUSES, STEP_ICON, MAX_STEPS };
