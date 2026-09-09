/**
 * 专家协作编排 — 多专家并行执行子任务并汇总
 *
 * 流程：用户选 2-4 个专家 + 各自子任务 → 每个任务创建 SubAgent（注入专家 systemPrompt）
 *       → delegateTasks 并行执行（并发上限 3）→ collab:* SSE 事件实时回传 → 汇总
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const COLLABS_DIR = path.join(config.DATA_DIR, 'collabs');
const ACTIVITY_PATH = path.join(config.DATA_DIR, 'experts-activity.json');

const { getExpert, getDepartments, getTeamPresets } = require('./index');
const { delegateTasks } = require('../subagent-enhanced');
const { broadcastEvent } = require('../sse-broadcast');

// ─── 内部状态 ──────────────────────────────────────────

const _collabs = new Map(); // collabId -> state

function _ensureDirs() {
  fs.mkdirSync(COLLABS_DIR, { recursive: true });
}

function _loadCollab(collabId) {
  if (_collabs.has(collabId)) return _collabs.get(collabId);
  try {
    const p = path.join(COLLABS_DIR, `${collabId}.json`);
    if (fs.existsSync(p)) {
      const state = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _collabs.set(collabId, state);
      return state;
    }
  } catch (err) {
    console.error('[Collab] 加载协作状态失败:', collabId, err.message);
  }
  return null;
}

function _saveCollab(state) {
  // 2026-08-15(T7): 同步写盘改异步 fire-and-forget——写入失败不再阻塞请求路径。
  try {
    _ensureDirs();
    const payload = JSON.stringify(state, null, 2);
    fs.promises.writeFile(path.join(COLLABS_DIR, `${state.collabId}.json`), payload)
      .catch((err) => console.error('[Collab] 保存协作状态失败:', err.message));
  } catch (err) {
    console.error('[Collab] 保存协作状态失败:', err.message);
  }
}

// 2026-09-05: 近期协作发起的内存索引——auto-collab 幂等检查专用。
// 此前每轮聊天都 listCollaborations() 全量 readdirSync+readFileSync(实测 collabs/
// 已积 2.4 万个文件), 聊天路径性能随历史线性劣化。10 分钟窗口跨重启失效可接受
// (重启后进程内无进行中协作, 幂等约束自然解除)。
const _recentCollabStarts = new Map(); // sessionId -> startedAt
function _markRecentCollab(sessionId, startedAt) {
  if (!sessionId) return;
  _recentCollabStarts.set(sessionId, startedAt);
}
function hasActiveCollabSession(sessionId, windowMs) {
  if (!sessionId) return false;
  const ts = _recentCollabStarts.get(sessionId);
  return Boolean(ts && Date.now() - ts < windowMs);
}

// 2026-09-05: 历史协作文件 TTL 清理(30 天, 惰性单次)——目录只增不减已积 2.4 万文件
let _cleanupDone = false;
function _cleanupOldCollabFiles() {
  if (_cleanupDone) return;
  _cleanupDone = true;
  const TTL = 30 * 24 * 3600 * 1000;
  try {
    if (!fs.existsSync(COLLABS_DIR)) return;
    const files = fs.readdirSync(COLLABS_DIR).filter(f => /^(collab|meeting)_.+\.json$/.test(f));
    if (files.length === 0) return;
    const now = Date.now();
    let removed = 0;
    for (const f of files) {
      const p = path.join(COLLABS_DIR, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > TTL) { fs.unlinkSync(p); removed++; }
      } catch (e) { /* 单文件失败跳过 */ }
    }
    if (removed > 0) console.log(`[Collab] 历史协作清理: 删除 ${removed} 个超 30 天的 run 文件(原有 ${files.length} 个)`);
  } catch (e) { console.warn('[Collab] 历史协作清理失败:', e.message); }
}

function _persist(state, patch) {
  Object.assign(state, patch);
  _saveCollab(state);
}

// ─── 专家活动持久化 ────────────────────────────────────

// 2026-08-15(T7): 进程内最新列表缓存——写盘改异步 fire-and-forget 后，
// 刚写入的活动在写盘窗口内也可被 getActivities 立即读到。
let _activityCache = null;

function recordActivity({ type, expertId = null, content = '', action, message, expertName = null, expertIcon = null }) {
  let list = _activityCache;
  if (!Array.isArray(list)) {
    try {
      if (fs.existsSync(ACTIVITY_PATH)) {
        list = JSON.parse(fs.readFileSync(ACTIVITY_PATH, 'utf-8'));
      }
    } catch (err) {
      console.error('[Collab] 读取活动失败:', err.message);
    }
    if (!Array.isArray(list)) list = [];
  }
  // 2026-08-13(Task3 遗留B): 存储 GUI ActivityFeed 渲染所需字段(action/message/expertName/
  // expertIcon/timestamp)——GET /api/experts/activity 直接返回本列表,字段不齐则 GUI 渲染空白/Invalid Date。
  const effectiveType = action || type || 'routed';
  const effectiveContent = String(message || content || '');
  const ts = Date.now();
  list.unshift({
    id: crypto.randomUUID(),
    type: effectiveType,
    expertId,
    content: effectiveContent.slice(0, 500),
    ts,
    action: effectiveType,
    message: effectiveContent.slice(0, 500),
    expertName,
    expertIcon,
    timestamp: ts,
  });
  if (list.length > 200) list = list.slice(0, 200);
  _activityCache = list;
  try {
    fs.mkdirSync(path.dirname(ACTIVITY_PATH), { recursive: true });
    // 2026-08-15(T7): 异步 fire-and-forget——写盘失败不阻塞调用方（API 响应与协作流程）。
    fs.promises.writeFile(ACTIVITY_PATH, JSON.stringify(list, null, 2))
      .catch((err) => console.error('[Collab] 保存活动失败:', err.message));
  } catch (err) {
    console.error('[Collab] 保存活动失败:', err.message);
  }
  return list;
}

function getActivities(limit = 50) {
  try {
    let list = _activityCache;
    if (!Array.isArray(list)) {
      if (!fs.existsSync(ACTIVITY_PATH)) return [];
      list = JSON.parse(fs.readFileSync(ACTIVITY_PATH, 'utf-8'));
      _activityCache = list;
    }
    // 2026-08-13(Task3 遗留B): 归一化 GUI 渲染字段——旧记录只有 type/content/ts,
    // ActivityFeed 需要 action/message/timestamp(否则渲染空白/Invalid Date)。
    return list.slice(0, limit).map((a) => ({
      ...a,
      action: a.action || a.type || 'routed',
      message: a.message || a.content || '',
      timestamp: a.timestamp || a.ts || Date.now(),
    }));
  } catch (err) {
    console.error('[Collab] 读取活动失败:', err.message);
    return [];
  }
}

// ─── 协作启动 ──────────────────────────────────────────

/**
 * 启动专家协作
 * @param {{goal: string, tasks: Array<{expertId: string, prompt: string}>}} params
 * @param {{runner?: Function}} opts 可注入执行器（测试用）
 */
async function startCollaboration(params, opts = {}) {
  _cleanupOldCollabFiles();
  const goal = String(params.goal || '').trim();
  const tasks = Array.isArray(params.tasks) ? params.tasks.slice(0, 4) : [];
  if (!goal) throw new Error('缺少协作目标 goal');
  if (tasks.length < 2) throw new Error('协作至少需要 2 个专家任务');

  // 校验专家并组装任务定义
  const taskDefs = [];
  const collabTasks = [];
  for (const t of tasks) {
    const expert = getExpert(String(t.expertId || ''));
    if (!expert) throw new Error(`专家不存在: ${t.expertId}`);
    const taskPrompt = String(t.prompt || '').trim() || `请围绕目标「${goal}」产出你的专业意见`;
    const taskId = `ct_${crypto.randomBytes(4).toString('hex')}`;
    taskDefs.push({
      // 2026-09-05 真传: 专家人设经 _expert 以 system 消息注入 SubAgent(此前拼进
      // goal 文本且截 800 字符)——真传生效后 goal 只含子任务, 无截断无冗余
      goal: `【子任务】${taskPrompt}`,
      type: 'ANALYZE',
      toolProfile: 'minimal',
      maxIterations: 12,
      timeout: 300000,
      _expert: { id: expert.id, name: expert.name, systemPrompt: expert.systemPrompt || '' },
    });
    collabTasks.push({ taskId, expertId: expert.id, expertName: expert.name, status: 'queued', prompt: taskPrompt });
  }

  const collabId = `collab_${crypto.randomBytes(4).toString('hex')}`;
  const state = {
    collabId,
    goal,
    sessionId: opts.sessionId || null, // 2026-08-15(T7): 自动触发幂等去重用（同会话 running 检查）
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    tasks: collabTasks,
    summary: null,
  };
  _collabs.set(collabId, state);
  _saveCollab(state);
  _markRecentCollab(state.sessionId, state.startedAt);
  recordActivity({ type: 'collab:started', content: `启动协作「${goal.slice(0, 60)}」(${collabTasks.length} 个专家)` });
  broadcastEvent('collab:started', { collabId, goal, taskCount: collabTasks.length });
  // --- TaskRun hook (non-blocking) ---
  try {
    const { globalTaskRunStore } = require('../task-orchestration/task-run');
    const run = globalTaskRunStore.createTaskRun({ title: '协作: ' + goal.slice(0, 80), source: 'collab' });
    for (let i = 0; i < collabTasks.length; i++) {
      if (i === 0) {
        globalTaskRunStore.updateLane(run.id, run.lanes[0].id, { agent: collabTasks[i].expertName, stage: collabTasks[i].prompt.slice(0, 40), status: 'waiting', progress: 0 });
      } else {
        globalTaskRunStore.addLane(run.id, { agent: collabTasks[i].expertName, stage: collabTasks[i].prompt.slice(0, 40), status: 'waiting', progress: 0 });
      }
    }
    state._taskRunId = run.id;
  } catch (e) { console.warn('[collab] TaskRun 接线失败:', e.message || e); }
  // --- end TaskRun hook ---

  // 异步执行，不阻塞请求
  setImmediate(() => {
    runCollab(state, taskDefs, opts.runner || delegateTasks, { deadlineMs: opts.deadlineMs || 600000 }).catch((err) => {
      console.error('[Collab] 协作执行异常:', err);
      _persist(state, { status: 'error' });
      broadcastEvent('collab:error', { collabId, message: err.message });
      // TaskRun: fail on top-level exception (guarded, non-blocking)
      if (state._taskRunId) {
        try {
          const { globalTaskRunStore } = require('../task-orchestration/task-run');
          globalTaskRunStore.failTask(state._taskRunId, err.message);
        } catch (e) { console.warn('[collab] TaskRun fail failed:', e.message || e); }
      }
    });
  });

  return { collabId, goal, tasks: collabTasks };
}

// 2026-08-15(T7): 按任务下标(1:1 对应 state.tasks/taskDefs 构建顺序)落定单任务结果。
// 修复重复 expertId 覆盖：旧实现按 expertId find——同专家多任务时结果互相覆盖。
function _settleTask(state, index, { status, result, error }) {
  const t = state.tasks[index];
  if (!t || t._settled) return; // 幂等：onTaskComplete 已处理或看门狗已收尾
  t.status = status;
  t.result = result;
  t.error = error;
  t._settled = true;
  // 2026-09-06: 成员完成广播带结果首行——智囊团成员卡的"一句话立场"数据源
  const excerpt = result ? String(result).replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  broadcastEvent('collab:progress', {
    collabId: state.collabId, taskId: t.taskId, status: t.status, expertName: t.expertName,
    ...(excerpt ? { excerpt } : {}),
  });
}

function _applyTaskResult(state, index, r) {
  const status = r.status === 'cancelled' || r.status === 'failed' ? 'error' : 'done';
  _settleTask(state, index, { status, result: r.result || null, error: r.error || null });
}

async function runCollab(state, taskDefs, runner, opts = {}) {
  // 整体看门狗（默认 10 分钟）：超时中止未完成子任务并标记 timeout，汇总不挂死。
  const deadlineMs = Number(opts.deadlineMs) > 0 ? opts.deadlineMs : 600000;
  const watchdogController = typeof AbortController !== 'undefined' ? new AbortController() : null;

  // 每任务完成即广播 collab:progress（此前 await 全部完成才一次性广播）。
  const onTaskStart = (i) => {
    const t = state.tasks[i];
    if (t && !t._settled && t.status === 'queued') {
      t.status = 'running';
      broadcastEvent('collab:progress', { collabId: state.collabId, taskId: t.taskId, status: 'running', expertName: t.expertName });
    }
  };
  const onTaskComplete = (i, r) => _applyTaskResult(state, i, r);

  const resultsPromise = Promise.resolve(runner(taskDefs.map((def) => ({
    goal: def.goal,
    type: def.type,
    toolProfile: def.toolProfile,
    maxIterations: def.maxIterations,
    timeout: def.timeout,
    _expert: def._expert || null,
  })), {
    parentAgentId: state.collabId,
    concurrency: 3,
    signal: watchdogController ? watchdogController.signal : undefined,
    onTaskStart,
    onTaskComplete,
  }));

  let watchdogTimer = null;
  let results = null;
  try {
    if (watchdogController) {
      results = await Promise.race([
        resultsPromise,
        new Promise((resolve) => {
          watchdogTimer = setTimeout(() => {
            watchdogController.abort();
            resolve(null); // 看门狗触发：下方统一按 timeout 收尾
          }, deadlineMs);
        }),
      ]);
    } else {
      results = await resultsPromise;
    }
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
  }

  // 收尾：runner 返回但个别任务无结果（或看门狗触发）→ 标记 timeout，保证状态不悬挂。
  const effectiveResults = Array.isArray(results) ? results : [];
  state.tasks.forEach((t, i) => {
    if (t._settled) return;
    const r = effectiveResults[i];
    if (r) {
      _applyTaskResult(state, i, r);
    } else {
      _settleTask(state, i, { status: 'timeout', result: null, error: '执行超时(整体看门狗)' });
    }
  });

  // --- TaskRun: update lanes ---
  if (state._taskRunId) {
    try {
      const { globalTaskRunStore } = require('../task-orchestration/task-run');
      const run = globalTaskRunStore.getTaskRun(state._taskRunId);
      if (run) {
        state.tasks.forEach((t, i) => {
          const lane = run.lanes[i];
          if (lane) {
            globalTaskRunStore.updateLane(state._taskRunId, lane.id, { status: t.status === 'done' ? 'done' : 'failed', progress: t.status === 'done' ? 100 : 0 });
          }
        });
      }
    } catch (e) { console.warn('[collab] TaskRun lane update failed:', e.message || e); }
  }
  // --- end TaskRun lane update ---

  const failed = state.tasks.filter(t => t.status === 'error' || t.status === 'timeout');
  const doneTasks = state.tasks.filter(t => t.status === 'done');
  const resultsPayload = state.tasks.map(t => ({ taskId: t.taskId, expertId: t.expertId, expertName: t.expertName, status: t.status, result: t.result, error: t.error }));

  // 汇总（无 LLM 二次调用：拼接各专家产出，附失败说明）
  let summary = null;
  if (doneTasks.length > 0) {
    summary = `### 协作汇总：「${state.goal}」\n\n` + doneTasks.map(t =>
      `**${t.expertName}**：\n${String(t.result || '（无产出）').slice(0, 1500)}`
    ).join('\n\n---\n\n');
    if (failed.length > 0) summary += `\n\n> ⚠️ ${failed.length} 个任务失败：${failed.map(f => `${f.expertName}(${f.error || '未知错误'})`).join('、')}`;
  }

  _persist(state, {
    status: failed.length === state.tasks.length ? 'error' : 'done',
    finishedAt: Date.now(),
    summary,
  });
  // 2026-09-05 修复: quietCompletion(部门例会 Phase1)不写完成动态——例会主流程
  // 在 Phase2 结束后有正式的完成记录, 此前每次例会都多出一条半程「协作完成」脏数据
  if (!opts.quietCompletion) {
    recordActivity({ type: 'collab:completed', content: `协作「${state.goal.slice(0, 60)}」完成(${doneTasks.length}/${state.tasks.length})` });
  }

  // 2026-09-04 部门例会: 两级树复用 runCollab 跑 Phase1(成员并行), 完成广播/TaskRun
  // 收尾由例会主流程统一负责——quietCompletion 时此处只持久化不广播不 completeTask。
  if (opts.quietCompletion) return;

  if (failed.length === state.tasks.length) {
    broadcastEvent('collab:error', { collabId: state.collabId, message: '全部子任务失败' });
    if (state._taskRunId) {
      try {
        const { globalTaskRunStore } = require('../task-orchestration/task-run');
        globalTaskRunStore.failTask(state._taskRunId, '全部子任务失败');
      } catch (e) { console.warn('[collab] TaskRun fail failed:', e.message || e); }
    }
  } else {
    broadcastEvent('collab:completed', { collabId: state.collabId, results: resultsPayload, summary });
    if (state._taskRunId) {
      try {
        const { globalTaskRunStore } = require('../task-orchestration/task-run');
        globalTaskRunStore.completeTask(state._taskRunId, { message: summary ? summary.slice(0, 200) : ('协作完成 (' + doneTasks.length + '/' + state.tasks.length + ')') });
      } catch (e) { console.warn('[collab] TaskRun complete failed:', e.message || e); }
    }
  }
}

// ─── 部门例会（2026-09-04 部门化 P2 两级树） ──────────────────

/**
 * 部门例会——主管汇总制两级编排：
 *   Phase1 在编成员岗位并行执行（复用 runCollab：并发 3 / 看门狗 / TaskRun / SSE）
 *   Phase2 主管岗汇总成员产出形成结论（单任务，goal 携带成员结果）
 * 与 startCollaboration 的差异：成员由部门/班组模板自动确定、任务间有依赖
 * （主管必须等成员完成），因此串两轮而非扁平一轮。
 *
 * @param {{department?: string, presetId?: string, goal: string}} params
 * @param {{runner?: Function, deadlineMs?: number, sessionId?: string}} opts
 * @returns {{collabId, kind, departmentLabel, lead, tasks}} 例会句柄（异步执行，轮询 getCollabStatus）
 */
async function startDepartmentMeeting(params, opts = {}) {
  const goal = String(params.goal || '').trim();
  if (!goal) throw new Error('缺少例会目标 goal');

  let deptLabel = null;
  let lead = null;
  let memberExperts = [];
  if (params.presetId) {
    const preset = getTeamPresets().find(p => p.id === params.presetId);
    if (!preset) throw new Error(`班组不存在: ${params.presetId}`);
    deptLabel = preset.label;
    const roster = preset.expertIds.map(id => getExpert(id)).filter(Boolean);
    lead = roster[0] || null;                 // 班组模板顺序即职级：首位任主持
    memberExperts = roster.slice(1, 4);       // 成员任务至多 3 个
  } else {
    const dept = getDepartments().find(d => d.id === params.department);
    if (!dept) throw new Error(`部门不存在: ${params.department}`);
    deptLabel = dept.label;
    const { getAllExperts } = require('./index');
    const roster = getAllExperts().filter(e => e.department === dept.id && e.status !== 'parked')
      .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
    lead = roster.find(e => e.id === dept.lead) || roster[0] || null;
    memberExperts = roster.filter(e => !lead || e.id !== lead.id).slice(0, 3);
  }
  if (!lead && memberExperts.length === 0) throw new Error(`${deptLabel} 无在编岗位，无法召开例会`);
  if (memberExperts.length === 0 && lead) memberExperts = [lead]; // 单人编制：主管先出方案再自汇总

  const meetingId = `meeting_${crypto.randomBytes(4).toString('hex')}`;
  const taskDefs = [];
  const collabTasks = [];
  for (const expert of memberExperts) {
    const prompt = `作为${deptLabel}的「${expert.name}」（${expert.title || '岗位'}），围绕例会目标「${goal}」从你的职责出发给出：①专业判断 ②可执行建议 ③需要的配合。简洁给结论。`;
    taskDefs.push({
      goal: `${expert.systemPrompt ? `【专家：${expert.name}】${String(expert.systemPrompt).slice(0, 800)}\n\n` : ''}【子任务】${prompt}`,
      type: 'ANALYZE',
      toolProfile: 'minimal',
      maxIterations: 12,
      timeout: 300000,
      _expert: { id: expert.id, name: expert.name, systemPrompt: expert.systemPrompt || '' },
    });
    collabTasks.push({ taskId: `mt_${crypto.randomBytes(4).toString('hex')}`, expertId: expert.id, expertName: expert.name, status: 'queued', prompt });
  }

  const state = {
    collabId: meetingId,
    goal,
    kind: 'department-meeting',
    departmentLabel: deptLabel,
    leadId: lead ? lead.id : null,
    leadName: lead ? lead.name : null,
    sessionId: opts.sessionId || null,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    tasks: collabTasks,
    summary: null,
    synthesis: null,
  };
  _collabs.set(meetingId, state);
  _saveCollab(state);
  _markRecentCollab(state.sessionId, state.startedAt);
  recordActivity({ type: 'collab:started', content: `召开${deptLabel}例会「${goal.slice(0, 60)}」(${collabTasks.length} 个成员岗位 + 主管汇总)` });
  broadcastEvent('collab:started', { collabId: meetingId, goal, taskCount: collabTasks.length, kind: 'department-meeting', department: deptLabel });
  // 2026-09-07: 例会不再创建 TaskRun——进度展示已由 CollabOrbit 成员卡+进度行
  // 唯一承载（语音球下方）；此前 TaskOrbit 左下角再渲染一份例会泳道，与左栏
  // 日志卡重叠（用户实测"卡片重叠看不清"），且窄容器文字逐字竖排不可读。
  // 完成/失败路径均有 _taskRunId 存在性守卫，此处置空即整条 TaskRun 链静默。

  const runner = opts.runner || delegateTasks;
  const deadlineMs = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 600000;

  setImmediate(async () => {
    try {
      // Phase1: 成员并行（quietCompletion——完成广播由例会主流程统一发）
      await runCollab(state, taskDefs, runner, { deadlineMs, quietCompletion: true });
      const memberFailed = state.tasks.filter(t => t.status === 'error' || t.status === 'timeout');
      const memberDone = state.tasks.filter(t => t.status === 'done');

      // Phase2: 主管汇总（state.tasks 补 synthesis 条目, 与 TaskRun synthesis lane 对齐）
      const synthesisTask = { taskId: 'synthesis', expertId: lead ? lead.id : null, expertName: lead ? lead.name : '主持', status: 'running', prompt: '主管汇总' };
      state.tasks.push(synthesisTask);
      _persist(state, { status: 'synthesizing' });
      broadcastEvent('collab:progress', { collabId: meetingId, taskId: 'synthesis', status: 'running', expertName: synthesisTask.expertName });

      if (memberDone.length === 0) {
        synthesisTask.status = 'skipped';
        const summary = `### ${deptLabel}例会：「${goal}」\n\n> ⚠️ 全部成员任务未完成，无汇总产出。`;
        _persist(state, { status: 'error', finishedAt: Date.now(), summary });
        broadcastEvent('collab:error', { collabId: meetingId, message: '全部成员任务失败' });
        if (state._taskRunId) {
          try { require('../task-orchestration/task-run').globalTaskRunStore.failTask(state._taskRunId, '全部成员任务失败'); } catch (e) { console.warn('[collab] TaskRun fail:', e.message || e); }
        }
        return;
      }

      const resultsText = memberDone.map(t => `【${t.expertName}】\n${String(t.result || '').slice(0, 1200)}`).join('\n\n');
      const leadExpert = lead ? getExpert(lead.id) : null;
      const synthesisGoal = `${leadExpert?.systemPrompt ? `【专家：${leadExpert.name}】${String(leadExpert.systemPrompt).slice(0, 800)}\n\n` : ''}【主持汇总】你是${deptLabel}主管。例会目标：「${goal}」。以下是各岗位的专业意见：\n\n${resultsText}\n\n请形成例会结论：①共识与分歧 ②可执行方案（谁做什么/优先级）③风险与下一步。控制在 600 字内。`;
      const synthResults = await Promise.resolve(runner([{
        goal: synthesisGoal,
        type: 'ANALYZE',
        toolProfile: 'minimal',
        maxIterations: 10,
        timeout: 300000,
        _expert: { id: lead ? lead.id : null, name: lead ? lead.name : '主持', systemPrompt: leadExpert?.systemPrompt || '' },
      }], { parentAgentId: meetingId, concurrency: 1 }));
      const synthResult = Array.isArray(synthResults) ? synthResults[0] : null;
      synthesisTask.status = synthResult && synthResult.status !== 'cancelled' && synthResult.status !== 'failed' ? 'done' : 'error';
      synthesisTask.result = synthResult ? (synthResult.result || null) : null;
      synthesisTask.error = synthResult ? (synthResult.error || null) : '主管汇总无结果';

      // 汇总：主管结论优先，成员意见附后；主管失败回退扁平拼接
      let summary = null;
      if (synthesisTask.status === 'done' && synthesisTask.result) {
        summary = `### ${deptLabel}例会结论（主持：${synthesisTask.expertName}）：「${goal}」\n\n${String(synthesisTask.result).slice(0, 4000)}\n\n---\n\n### 附：成员意见\n\n`
          + memberDone.map(t => `**${t.expertName}**：\n${String(t.result || '（无产出）').slice(0, 1000)}`).join('\n\n---\n\n');
      } else {
        summary = `### ${deptLabel}例会：「${goal}」\n\n> ⚠️ 主管汇总未完成(${synthesisTask.error || '未知错误'})，附成员意见：\n\n`
          + memberDone.map(t => `**${t.expertName}**：\n${String(t.result || '（无产出）').slice(0, 1200)}`).join('\n\n---\n\n');
      }
      if (memberFailed.length > 0) summary += `\n\n> ⚠️ ${memberFailed.length} 个成员任务失败：${memberFailed.map(f => `${f.expertName}(${f.error || '未知错误'})`).join('、')}`;

      _persist(state, { status: 'done', finishedAt: Date.now(), summary, synthesis: { leadId: synthesisTask.expertId, leadName: synthesisTask.expertName, text: synthesisTask.result } });
      recordActivity({ type: 'collab:completed', content: `${deptLabel}例会「${goal.slice(0, 60)}」完成(${memberDone.length}/${collabTasks.length} 成员 + 主管汇总)` });
      broadcastEvent('collab:completed', { collabId: meetingId, kind: 'department-meeting', department: deptLabel, summary });
      if (state._taskRunId) {
        try {
          const { globalTaskRunStore } = require('../task-orchestration/task-run');
          globalTaskRunStore.completeTask(state._taskRunId, { message: `${deptLabel}例会完成 (${memberDone.length}/${collabTasks.length})` });
        } catch (e) { console.warn('[collab] TaskRun complete:', e.message || e); }
      }
    } catch (err) {
      console.error('[collab] 例会执行异常:', err);
      _persist(state, { status: 'error', finishedAt: Date.now() });
      broadcastEvent('collab:error', { collabId: meetingId, message: err.message });
      if (state._taskRunId) {
        try { require('../task-orchestration/task-run').globalTaskRunStore.failTask(state._taskRunId, err.message); } catch (e) { console.warn('[collab] TaskRun fail:', e.message || e); }
      }
    }
  });

  return {
    collabId: meetingId,
    kind: 'department-meeting',
    departmentLabel: deptLabel,
    lead: lead ? { id: lead.id, name: lead.name, title: lead.title || '', voiceStyle: lead.voiceStyle || '' } : null,
    tasks: collabTasks,
  };
}

function getCollabStatus(collabId) {
  const state = _loadCollab(String(collabId || ''));
  if (!state) return null;
  return {
    collabId: state.collabId,
    goal: state.goal,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    tasks: state.tasks,
    summary: state.summary,
  };
}

function listCollaborations(limit = 20) {
  // 2026-08-15(T7): 磁盘文件与内存态合并——写盘改异步后，新启动的协作在写盘窗口内
  // 也必须可见（自动触发幂等检查依赖此列表）。
  const merged = new Map();
  try {
    _ensureDirs();
    const files = fs.readdirSync(COLLABS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
    for (const f of files) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(COLLABS_DIR, f), 'utf-8'));
        if (s && s.collabId) merged.set(s.collabId, s);
      } catch (err) { console.error('[Collab] 解析协作文件失败:', err.message); }
    }
  } catch (err) {
    console.error('[Collab] 列出协作失败:', err.message);
  }
  for (const [id, s] of _collabs) {
    if (!merged.has(id)) merged.set(id, s);
  }
  return [...merged.values()]
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, limit)
    .map(s => ({
      collabId: s.collabId, goal: s.goal, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, taskCount: s.tasks?.length || 0,
      sessionId: s.sessionId || null,
    }));
}

module.exports = { startCollaboration, startDepartmentMeeting, getCollabStatus, listCollaborations, recordActivity, getActivities, runCollab, hasActiveCollabSession };
