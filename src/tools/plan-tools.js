'use strict';

/**
 * plan-tools.js — AI 可调用的显式计划工具（Plan 实体, Plan/Artifact 深化轮）
 *
 * 工具:
 *   PlanCreate — 任务开始时创建执行计划（标题 + 步骤清单）
 *   PlanUpdate — 推进步骤状态 / 修订计划
 *
 * 模型通过这两个工具把"打算怎么干"对象化：每轮决策后更新状态，
 * 前端 PlanSection（Agent 右板）实时渲染进度投影。
 * 复杂任务（Task Mode/多工具任务）建议主动使用；简单问答无需创建计划。
 */

const { registry } = require('./registry');
const { getPlanStore, STEP_STATUSES } = require('../core/plan-store');
const { registerToolContract } = require('../core/tool-contract');

// ── PlanCreate ──────────────────────────────────────
registry.register({
  name: 'PlanCreate',
  toolset: 'planning',
  category: 'planning',
  description: '为多步任务创建显式执行计划（3-8 个步骤）。凡任务含 3 个及以上步骤——例如"查询A → 查询B → 对比生成报告"——应当首先调用本工具创建计划再开始执行；前端会实时展示进度清单给用户，每个关键节点用 PlanUpdate 同步状态。简单问答/单步任务无需调用。',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '计划标题（任务的一句话概括）' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 20,
        description: '步骤清单，按执行顺序，每步一句话',
      },
    },
    required: ['title', 'steps'],
  },
  riskLevel: 'low',
  whenNotToUse: ['简单问答/单步任务', '用户没有要求规划且任务一眼可完成'],
  handler: async (params, context = {}) => {
    const runId = context.runId || null;
    if (!runId) {
      return { success: false, error: '当前无活跃回合（runId 缺失），无法创建计划' };
    }
    const store = getPlanStore();
    // 2026-09-07 P1: 同回合重复创建去重——宣传片实测同一秒连发两次 PlanCreate
    // (第二次静默覆盖第一次, 白耗一轮工具调用)。同 runId 已有计划时不再重建,
    // 引导模型用 PlanUpdate 修订步骤/推进状态。
    const existing = store.getPlan(runId);
    if (existing && existing.planId) {
      return {
        success: true,
        data: {
          planId: existing.planId,
          deduplicated: true,
          planText: store.renderPlanText(existing),
          hint: '本回合已存在执行计划，本次调用未重复创建。需要调整步骤请用 PlanUpdate 传 steps 全量修订，推进状态也用 PlanUpdate。',
        },
      };
    }
    const result = store.setPlan(runId, { title: params.title, steps: params.steps });
    if (!result.ok) return { success: false, error: result.error };
    return {
      success: true,
      data: {
        planId: result.plan.planId,
        revised: result.revised,
        planText: getPlanStore().renderPlanText(result.plan),
        hint: '计划已创建并展示给用户。每完成/推进一个关键步骤，请调用 PlanUpdate 同步状态。',
      },
    };
  },
});

// ── PlanUpdate ──────────────────────────────────────
registry.register({
  name: 'PlanUpdate',
  toolset: 'planning',
  category: 'planning',
  description: '更新执行计划：推进某步骤状态（running/done/failed），或用 steps 全量修订剩余计划。修订时同文本步骤状态保留。',
  schema: {
    type: 'object',
    properties: {
      stepIndex: { type: 'integer', description: '要更新的步骤序号（从 1 开始）。与 steps 二选一。' },
      status: { type: 'string', enum: ['running', 'done', 'failed', 'pending'], description: '新状态' },
      note: { type: 'string', description: '可选：一句话备注（失败原因/进展说明）' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: '全量修订剩余计划（与 stepIndex 二选一，修订后 revision +1）',
      },
      title: { type: 'string', description: '修订时的可选新标题' },
    },
  },
  riskLevel: 'low',
  handler: async (params, context = {}) => {
    const runId = context.runId || null;
    if (!runId) {
      return { success: false, error: '当前无活跃回合（runId 缺失）' };
    }
    const store = getPlanStore();
    if (Array.isArray(params.steps) && params.steps.length > 0) {
      const current = store.getPlan(runId);
      if (!current) return { success: false, error: '计划不存在（先 PlanCreate）' };
      const result = store.setPlan(runId, { title: params.title || current.title, steps: params.steps });
      if (!result.ok) return { success: false, error: result.error };
      return { success: true, data: { revised: true, planText: store.renderPlanText(result.plan) } };
    }
    if (params.stepIndex != null) {
      const status = params.status || 'done';
      if (!STEP_STATUSES.has(status)) return { success: false, error: `非法状态: ${status}` };
      const result = store.updateStep(runId, params.stepIndex, status, params.note || '');
      if (!result.ok) return { success: false, error: result.error };
      // 步骤完成时自动把下一步置为 running（进度投影更顺滑）
      const plan = result.plan;
      const next = plan.steps.find((s) => s.status === 'pending');
      if (status === 'done' && next) next.status = 'running';
      return { success: true, data: { planText: store.renderPlanText(plan) } };
    }
    return { success: false, error: 'stepIndex 与 steps 至少提供一项' };
  },
});

// 契约注册（与 mcp-manager 同款动态注册模式）
registerToolContract('PlanCreate', {
  description: '为当前任务创建显式执行计划（标题+步骤清单），前端渲染进度投影',
  whenNotToUse: ['简单问答', '单步任务', '用户未要求规划且任务一眼可完成'],
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '计划标题' },
      steps: { type: 'array', items: { type: 'string' }, minItems: 2, description: '按执行顺序的步骤清单' },
    },
    required: ['title', 'steps'],
  },
  maxTimeout: 5000,
  riskLevel: 'low',
});
registerToolContract('PlanUpdate', {
  description: '更新执行计划步骤状态或全量修订剩余计划',
  schema: {
    type: 'object',
    properties: {
      stepIndex: { type: 'integer', description: '步骤序号(1起)' },
      status: { type: 'string', enum: ['running', 'done', 'failed', 'pending'] },
      note: { type: 'string' },
      steps: { type: 'array', items: { type: 'string' } },
      title: { type: 'string' },
    },
  },
  maxTimeout: 5000,
  riskLevel: 'low',
});

console.log('✅ 计划工具已注册: PlanCreate, PlanUpdate');
