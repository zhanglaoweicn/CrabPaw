// experts.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const { readJsonBody, sendJson } = require('../http-utils');
const collab = require('../../core/experts/collaboration');

/**
 * 2026-08-27 B1-5: 专家清单校验接运行时——validateExpertManifest(整列表) 的 problems
 * 按「专家 <id> 」前缀归属到单个专家(manifestValid/manifestIssues); 无前缀的全局问题
 * (缺 id 条目/id 重复)不属于任何专家, 归响应顶层 expertManifestIssues。
 * 校验器抛异常时视为全部通过(不阻断列表)。
 * @param {Array} list 专家列表
 * @returns {{experts: Array, expertManifestIssues: string[]}}
 */
function buildExpertsListWithManifestFlags(list) {
  const expertsList = list || [];
  try {
    const { validateExpertManifest } = require('../../core/experts/manifest-validate');
    const mResult = validateExpertManifest(expertsList);
    const problems = Array.isArray(mResult?.problems) ? mResult.problems.map((p) => String(p)) : [];
    const flagged = expertsList.map((e) => {
      const prefix = `专家 ${e?.id} `;
      const mine = problems.filter((p) => p.startsWith(prefix) || p === `专家 ${e?.id}`);
      return { ...e, manifestValid: mine.length === 0, manifestIssues: mine.slice(0, 4) };
    });
    const expertManifestIssues = problems.filter((p) => (
      !expertsList.some((e) => p.startsWith(`专家 ${e?.id} `) || p === `专家 ${e?.id}`)
    ));
    return { experts: flagged, expertManifestIssues };
  } catch (err) {
    console.warn('[experts] 清单校验失败(不阻断):', err?.message || err);
    return { experts: expertsList, expertManifestIssues: [] };
  }
}

/* ─── 专家面板 API ─── */
async function handleExpertsAPI(req, res, _ctx) {
  try {
    const experts = require('../../core/experts');
    const url = new URL(req.url, 'http://localhost');
    const pathParts = url.pathname.replace(/^\/api\/experts\/?/, '').split('/').filter(Boolean);
    const method = req.method;

    // GET /api/experts — 列表
    // GET /api/experts/categories — 分类
    // GET /api/experts/stats — 统计
    // GET /api/experts/:id — 详情
    if (method === 'GET') {
      // GET /api/experts/active — 当前激活专家(2026-08-26 E1 配套: UI 角标展示)
      if (pathParts[0] === 'active') {
        try {
          const { getActiveExpert } = require('../../core/expert-context');
          const userId = url.searchParams.get('userId') || 'voice_shell_user';
          const active = getActiveExpert(userId);
          return sendJson(res, 200, { success: true, data: active || null });
        } catch (e) {
          console.warn('[experts] getActiveExpert 读取失败:', e?.message || e);
          return sendJson(res, 200, { success: true, data: null });
        }
      }
      if (pathParts.length === 0) {
        // 支持 ?category=xxx / ?department=xxx / ?status=active|parked 过滤(P1 组织层)
        const category = url.searchParams.get('category');
        const department = url.searchParams.get('department');
        const status = url.searchParams.get('status');
        let list = experts.getAllExperts();
        if (category) list = list.filter(e => e.category === category);
        if (department) list = list.filter(e => e.department === department);
        if (status) list = list.filter(e => e.status === status);
        // 2026-08-27 B1-5: per-expert manifestValid + 顶层 expertManifestIssues(全局问题)
        const { experts: flagged, expertManifestIssues } = buildExpertsListWithManifestFlags(list);
        return sendJson(res, 200, { success: true, data: flagged, expertManifestIssues });
      }
      if (pathParts[0] === 'categories') {
        return sendJson(res, 200, { success: true, data: experts.getCategories() });
      }
      // 2026-09-04 P1 组织层: 部门列表 / 预设班组
      if (pathParts[0] === 'departments') {
        return sendJson(res, 200, { success: true, data: experts.getDepartments() });
      }
      if (pathParts[0] === 'presets') {
        return sendJson(res, 200, { success: true, data: experts.getTeamPresets() });
      }
      if (pathParts[0] === 'stats') {
        return sendJson(res, 200, { success: true, data: experts.getStats() });
      }
      const id = pathParts[0];
      const detail = experts.getExpert(id);
      if (!detail) return sendJson(res, 404, { success: false, error: '专家不存在' });
      return sendJson(res, 200, { success: true, data: detail });
    }

    // POST /api/experts — 创建
    // POST /api/experts/route — 路由
    // POST /api/experts/chain — 协作链
    // POST /api/experts/session — 记录会话
    // POST /api/experts/:id/reset — 重置 prompt
    if (method === 'POST') {
      if (pathParts.length === 0) {
        const body = await readJsonBody(req);
        if (!body || !body.name) return sendJson(res, 400, { success: false, error: '缺少 name' });
        const result = experts.createExpert(body);
        if (result.error) return sendJson(res, 400, { success: false, error: result.error });
        return sendJson(res, 201, { success: true, data: result.expert });
      }
      if (pathParts[0] === 'route') {
        const body = await readJsonBody(req);
        if (!body || !body.message) return sendJson(res, 400, { success: false, error: '缺少 message' });
        const results = experts.routeMessage(body.message);
        return sendJson(res, 200, { success: true, data: results });
      }
      // POST /api/experts/summon — 显式召唤(P1: 语音/GUI 统一入口)
      // body: { query: 专家id|岗位别名|部门, userId? }
      // 行为: expert → 精确激活; department → 激活主管并返回成员; ambiguous → 消歧候选;
      //       全部 200 语义(activated=false 供调用方走消歧交互), 未知 query 404。
      if (pathParts[0] === 'summon') {
        const body = await readJsonBody(req);
        if (!body || !body.query) return sendJson(res, 400, { success: false, error: '缺少 query' });
        const userId = body.userId || 'voice_shell_user';
        const resolved = experts.resolveSummon(String(body.query));
        if (!resolved) return sendJson(res, 404, { success: false, error: `未找到匹配「${body.query}」的岗位或部门` });
        const { activateExpert } = require('../../core/expert-context');
        if (resolved.type === 'expert') {
          const state = activateExpert(userId, resolved.expert.id, { source: 'summon-api' });
          experts.recordSession(resolved.expert.id);
          return sendJson(res, 200, { success: true, data: { activated: true, type: 'expert', expert: resolved.expert, state } });
        }
        if (resolved.type === 'department') {
          // 部门召唤(P1 语义): 先接通主管(或首位在编), 成员清单随载荷返回——
          // 班组会议式多岗位协作在下一波接线 collab 引擎。
          let leadActivated = null;
          if (resolved.department.lead) {
            leadActivated = activateExpert(userId, resolved.department.lead, { source: 'summon-department' });
            experts.recordSession(resolved.department.lead);
          }
          return sendJson(res, 200, { success: true, data: { activated: Boolean(leadActivated), type: 'department', department: resolved.department, members: resolved.members, state: leadActivated } });
        }
        return sendJson(res, 200, { success: true, data: { activated: false, type: 'ambiguous', candidates: resolved.candidates } });
      }
      if (pathParts[0] === 'chain') {
        const body = await readJsonBody(req);
        if (!body || !body.expertId) return sendJson(res, 400, { success: false, error: '缺少 expertId' });
        const chain = experts.suggestCollaborationChain(body.expertId);
        return sendJson(res, 200, { success: true, data: chain });
      }
      if (pathParts[0] === 'session') {
        const body = await readJsonBody(req);
        if (!body || !body.expertId) return sendJson(res, 400, { success: false, error: '缺少 expertId' });
        experts.recordSession(body.expertId);
        return sendJson(res, 200, { success: true });
      }
      if (pathParts.length >= 2 && pathParts[1] === 'reset') {
        const result = experts.resetExpertPrompt(pathParts[0]);
        if (result.error) return sendJson(res, 400, { success: false, error: result.error });
        return sendJson(res, 200, { success: true, data: { prompt: result.prompt } });
      }
      return sendJson(res, 404, { success: false, error: '未知端点' });
    }

    // PUT /api/experts/:id — 更新
    if (method === 'PUT' && pathParts.length === 1) {
      const body = await readJsonBody(req);
      const result = experts.updateExpert(pathParts[0], body || {});
      if (result.error) return sendJson(res, 400, { success: false, error: result.error });
      return sendJson(res, 200, { success: true, data: result.expert });
    }

    // DELETE /api/experts/:id
    if (method === 'DELETE' && pathParts.length === 1) {
      const result = experts.deleteExpert(pathParts[0]);
      if (result.error) return sendJson(res, 400, { success: false, error: result.error });
      return sendJson(res, 200, { success: true });
    }

    return sendJson(res, 405, { success: false, error: '不支持的请求方法' });
  } catch (e) {
    return sendJson(res, 500, { success: false, error: e.message });
  }
}

/* ─── 专家协作 API ─── */
async function handleCollabStart(req, res, _ctx) {
  try {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { console.warn('[collab] body 解析失败:', e?.message || e); }
    const result = await collab.startCollaboration(body);
    return sendJson(res, 200, { success: true, data: result });
  } catch (err) {
    return sendJson(res, 400, { success: false, error: err.message });
  }
}

// POST /api/experts/collab/department — 部门例会（2026-09-04 P2 两级树）
// body: { department?: string, presetId?: string, goal: string, userId?: string }
// 行为: 成员并行 → 主管汇总; 顺手激活主管（语音播报/角标），失败不阻塞。
async function handleCollabDepartment(req, res, _ctx) {
  try {
    let body = {};
    try { body = await readJsonBody(req); } catch (e) { console.warn('[collab] 例会 body 解析失败:', e?.message || e); }
    const result = await collab.startDepartmentMeeting(body);
    try {
      if (result?.lead?.id) {
        const { activateExpert } = require('../../core/expert-context');
        activateExpert(body.userId || 'voice_shell_user', result.lead.id, { source: 'department-meeting' });
      }
    } catch (e) { console.warn('[collab] 例会主管激活失败(不阻塞):', e?.message || e); }
    return sendJson(res, 200, { success: true, data: result });
  } catch (err) {
    return sendJson(res, 400, { success: false, error: err.message });
  }
}

async function handleCollabStatus(req, res, ctx) {
  const id = ctx.query?.id || '';
  const st = collab.getCollabStatus(id);
  if (!st) return sendJson(res, 404, { success: false, error: '协作不存在' });
  return sendJson(res, 200, { success: true, data: st });
}

async function handleCollabList(req, res) {
  return sendJson(res, 200, { success: true, collaborations: collab.listCollaborations(20) });
}

async function handleExpertActivityGet(req, res) {
  const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 50);
  return sendJson(res, 200, { success: true, data: collab.getActivities(limit) });
}

async function handleExpertActivityPost(req, res) {
  let body = {};
  try { body = await readJsonBody(req); } catch (e) { console.warn('[activity] body 解析失败:', e?.message || e); }
  // 2026-08-13(Task3 遗留B): GUI postActivity 发 { expertId, expertName, expertIcon, action, message },
  // 旧实现只读 type/expertId/content → 字段被丢弃。此处映射入参并透传 expertName/expertIcon。
  collab.recordActivity({
    type: body.action || body.type || 'custom',
    expertId: body.expertId || null,
    content: body.message || body.content || '',
    expertName: body.expertName || null,
    expertIcon: body.expertIcon || null,
  });
  return sendJson(res, 200, { success: true });
}

module.exports = {
  handleExpertsAPI,
  buildExpertsListWithManifestFlags,
  handleCollabStart,
  handleCollabDepartment,
  handleCollabStatus,
  handleCollabList,
  handleExpertActivityGet,
  handleExpertActivityPost,
};
