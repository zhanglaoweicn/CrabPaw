/**
 * filegen-events.js — 文件生成任务事件模块（2026-08-17，2026-09-06 状态机 v2）
 *
 * 统一广播 filegen:start/phase/done/error/source/artifact/cancelled（SSE /events 通道），
 * 维护内存任务态（面板重开时经 GET /api/filegen/status 恢复快照），并驱动 scene
 * surface 'file-panel' 的打开与快照更新（与股票面板 upsertSurface 同模式）。
 * 任务语义：单任务覆盖——新 start 顶掉旧任务（spec: 重复生成覆盖式）。
 *
 * 2026-09-06 状态机 v2（文档卡深度检查轮）：
 *   - 新增 paused/cancelled 态 + cancelFileGen API——治"孤儿任务永卡进行态"；
 *   - Write/Edit 插桩改发 filegen:artifact（不再每次 Write 即 done）——done 语义
 *     从"一个文件写完"修正为"任务完成"，真 done 只来自转换完成或回合收敛
 *     settleTurn()（ai.js chat/chatStream 回合结束调用）；
 *   - ensureFileGenTask 新增 fresh 通道（意图开卡）：复用窗口内清 sources/file、
 *     更新 title——治复用残留；
 *   - lastSubstantiveAt 记录实质活动（搜索/写/转换），settleTurn 据此判定
 *     "意图命中但模型零活动"（典型：模糊指令引发澄清追问）→ paused。
 */
const path = require('path');
const { broadcastEvent } = require('./sse-broadcast');

const FILE_PANEL_SURFACE = 'file-panel';
const FILE_PANEL_KIND = 'file-panel';
// 2026-08-17 R2-4: done/error 任务复用窗口——多文件写作（网页 html+css+js）连续
// Write 不顶掉任务；窗口外（新一轮生成）才新建任务清空 files。
const TASK_REUSE_WINDOW_MS = 5 * 60 * 1000;

// 2026-09-06: 终态集合（cancelled 与 done/error 同列——终态任务不再被写作/转换复用，
// 新意图一律开新任务）
const TERMINAL_PHASES = new Set(['done', 'error', 'cancelled']);

// 进程内任务序号（taskId 生成）
let taskSeq = 0;
// 内存任务态（单任务覆盖语义）
let currentTask = null; // { taskId, title, format, phase, label, file, files, error, startedAt, ... }
// 2026-08-17 R2-4: 当前生成会话产物文件列表（去重 by path，多文件网页产物）
let currentFiles = [];
// 2026-08-23: 当前任务收集的资料（研究阶段 WebSearch 插桩）——面板「资料」区展示
// { query, sources: [{title, url, snippet}], ts }
let currentSources = [];
// 2026-09-06: 回合锚点——ai.js chat/chatStream 回合开始调 beginTurn()，回合结束调
// settleTurn()；lastSubstantiveAt ≥ currentTurnStart 判定"本回合有实质活动"
let currentTurnStart = 0;

function newTaskId() {
  taskSeq += 1;
  return `filegen-${Date.now()}-${taskSeq}`;
}

/** 按扩展名推断 format（Write/Edit 用） */
function formatFromPath(p) {
  const ext = (String(p).split('.').pop() || '').toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'txt') return 'txt';
  return 'code';
}

/** local:// 预览地址（口径对齐 electron main local: 协议白名单——
 *  DATA_DIR 内产物（含 .crabpaw/workspace）+ backend data/workspace 产物目录可内嵌预览） */
function previewUrlFor(format, filePath) {
  if (format !== 'md' && format !== 'html') return null;
  try {
    const { getDataDir } = require('./config');
    // 2026-08-18 实机修复: 放行根含 backend data/workspace——Write 指引产物落盘
    // data/workspace（此前只认 getDataDir()=data/.crabpaw 前缀 → 产物 URL 恒 null →
    // done 态 iframe 不渲染；electron 白名单早已放行 workspace，previewUrlFor 口径滞后）
    const backendWorkspace = path.join(__dirname, '..', '..', 'data', 'workspace');
    const roots = [path.normalize(getDataDir()), path.normalize(backendWorkspace)];
    const norm = path.normalize(filePath);
    if (!roots.some(r => norm.toLowerCase().startsWith(r.toLowerCase() + path.sep))) return null;
    return 'local:///' + filePath.replace(/\\/g, '/');
  } catch (e) {
    console.warn('[filegen] previewUrlFor 失败(降级无预览):', e.message);
    return null;
  }
}

function _pushSurface() {
  const { getSceneStore } = require('./scene/scene-store');
  getSceneStore().upsertSurface(FILE_PANEL_SURFACE, {
    kind: FILE_PANEL_KIND,
    data: {
      taskId: currentTask ? currentTask.taskId : null,
      title: currentTask ? currentTask.title : '',
      format: currentTask ? currentTask.format : '',
      phase: currentTask ? currentTask.phase : 'idle',
      label: currentTask ? currentTask.label : '',
      file: currentTask ? currentTask.file : null,
      files: currentFiles,
      sources: currentSources,
      error: currentTask ? currentTask.error : null,
      // 2026-09-06: 补 autoDocx（前端步骤表分流 md 是否含"格式转换"步）、
      // startedAt（前端实时计时）、originalMessage（error 态重试用）
      autoDocx: currentTask ? currentTask.autoDocx : undefined,
      startedAt: currentTask ? currentTask.startedAt : null,
      originalMessage: currentTask ? currentTask.originalMessage : null,
      // 2026-09-06: 执笔专家——激活专家时开卡即署名，卡片头显示"由 X 执笔"
      //（内容本就按专家人设撰写，此字段让"专家介入"在卡片上可见）
      expertName: currentTask ? currentTask.expertName : null,
    },
    intent: 'inform',
  });
}

function startFileGen(taskId, { title, format, autoDocx, originalMessage, expertName }) {
  currentTask = {
    taskId, title, format,
    phase: 'collect', label: '准备内容…',
    file: null, files: [], error: null, startedAt: Date.now(),
    // 2026-08-22: 文章类意图标记——Write md 后自动同步生成 Word（见 file-tools.js handleWrite）
    autoDocx: autoDocx || undefined,
    // 2026-08-23: 资料区数据（研究阶段 WebSearch 插桩累积）——与 files 同模式初始化
    sources: [],
    // 2026-09-06: 执笔专家署名（激活专家时开卡传入；卡片头显示）
    expertName: expertName || null,
    // 2026-09-06: 本回合实质活动锚点（0=尚无——settleTurn 判"意图命中但零活动"用）
    lastSubstantiveAt: 0,
    // 2026-09-06: 原始用户消息（≤500 字符）——error 态"重新生成"复用
    originalMessage: String(originalMessage || title || '').slice(0, 500),
    // 2026-09-06: 本任务已注册产物的 path 集合——防 done 与 artifact 双注册
    registeredPaths: new Set(),
  };
  currentFiles = []; // R2-4: 新任务清空产物列表
  currentSources = []; // 2026-08-23: 新任务清空资料列表
  broadcastEvent('filegen:start', { taskId, title, format, ...(expertName ? { expertName } : {}) });
  _pushSurface();
  // 2026-08-17: 打开时刻同步 panel-state open——此前 open 侧从未写入（_pushSurface
  // 直连 scene store，绕过了 /api/scene/upsert 的 open 侧写入），AI 上下文"面板已打开"
  // 感知断链；closed 侧由 FileGenPanel handleClose 经 /api/scene/panel-state 写入。
  // SURFACE_PANEL_MAP 为 surface→panel key 单一事实源（'file-panel'→'filegen'）。
  try {
    const { setPanelState, SURFACE_PANEL_MAP } = require('./panel-state');
    setPanelState(SURFACE_PANEL_MAP[FILE_PANEL_SURFACE] || 'filegen', 'open');
  } catch (e) {
    console.warn('[filegen] panel-state open 写入失败(不阻塞广播):', e.message);
  }
  return currentTask;
}

/**
 * 2026-08-17: 惰性任务保障——文件生成四步流程可视化
 * （①资料搜集→②大纲→③内容撰写→④文档生成）的事件基础。
 * 活跃任务存在且流程未结束（非终态）→ 复用（阶段推进，taskId/title 不变；
 * 含 collect 同请求双调用不裂任务）；
 * 2026-08-17 R2-4: done/error 任务在 TASK_REUSE_WINDOW_MS 窗口内仅写作/转换插桩
 * （phase writing/converting）复用（多文件连续写作不顶掉任务），复用即重置回
 * collect 态继续流程；新意图（phase collect）对终态任务一律开新任务
 * （files 清空 + filegen:start 广播 → 前端清 mainHtmlPath/tabs），窗口外同样新建。
 * 2026-08-23 实机修复: 非终态任务复用同样受 TASK_REUSE_WINDOW_MS 约束——模型中断
 * （零工具调用回复）后任务永卡 collect，后续生成请求无条件复用旧任务：不广播
 * filegen:start（面板无新任务感知）、旧 sources 残留混入新任务。窗口外一律新建。
 * 副作用评估：正常写作中 Write/转换插桩间隔毫秒级，5 分钟窗口不可能误裂任务。
 * 2026-09-06: 新增 fresh 通道（意图开卡专用）——复用窗口内命中 fresh 时清
 * sources/file、更新 title（治"复用残留"：旧资料混进新任务、标题停留旧文案）；
 * cancelled 并入终态集合。
 * 供 ai.js 生成意图请求开始（资料搜集阶段面板立即滑入）与 Write/转换插桩共用——
 * 此前每次 Write/转换都 newTaskId，搜索阶段（任务未开始）完全不可见。
 */
function ensureFileGenTask({ title, format = 'md', phase = 'collect', label, autoDocx, fresh, originalMessage, expertName }) {
  let taskId;
  // 2026-08-23: 所有复用路径统一受窗口约束（此前非终态无限期复用——模型中断
  // 后任务卡 collect，新请求不广播 start、旧 sources 残留）。窗口内：非终态任务
  // 任意 phase 复用（同一请求 chat/chatStream 双路径幂等），终态仅写作/转换插桩复用。
  const withinWindow = currentTask && Date.now() - currentTask.startedAt < TASK_REUSE_WINDOW_MS;
  const reuse = currentTask && withinWindow && (
    !TERMINAL_PHASES.has(currentTask.phase) ||
    phase !== 'collect'
  );
  if (reuse) {
    taskId = currentTask.taskId;
    // R2-2 final-review P1 修复: 复用任务采纳实际产物格式——意图启动占位 'md'
    // 被首个真实写入覆盖（前端 live 分屏门 task.format==='html' 因此真正可达）；
    // html 永不被 css/js 子文件('code')降级（多文件网页保持 live 分屏）。
    if (format && (currentTask.format !== 'html' || format === 'html')) {
      currentTask.format = format;
    }
    // 2026-08-22: autoDocx 意图标记——复用不清除（intent 级属性, 一次命中全程生效）
    if (autoDocx) currentTask.autoDocx = true;
    // 2026-09-06: fresh 通道——新一轮意图复用旧任务壳时清残留（sources/file/title）
    if (fresh) {
      currentSources = [];
      currentFiles = [];
      currentTask.sources = [];
      currentTask.files = [];
      currentTask.file = null;
      currentTask.registeredPaths = new Set();
      if (title) currentTask.title = title;
      if (originalMessage) currentTask.originalMessage = String(originalMessage).slice(0, 500);
      // 执笔专家署名——fresh(新一轮意图)按当前激活专家重置（无专家则清空旧署名）
      currentTask.expertName = expertName ? String(expertName).slice(0, 20) : null;
    } else if (expertName && !currentTask.expertName) {
      // 写作/转换插桩复用时补写空值（不覆盖已有署名）
      currentTask.expertName = String(expertName).slice(0, 20);
    }
    // R2-4: 终态任务窗口内写作/转换插桩复用（多文件连续写作）→ 回到流程态
    if (TERMINAL_PHASES.has(currentTask.phase)) {
      currentTask.phase = 'collect';
      currentTask.error = null;
    }
  } else {
    taskId = newTaskId();
    startFileGen(taskId, { title, format, autoDocx, originalMessage, expertName });
  }
  if (phase) phaseFileGen(taskId, phase, label || '');
  return taskId;
}

function phaseFileGen(taskId, phase, label) {
  if (!currentTask || currentTask.taskId !== taskId) return;
  currentTask.phase = phase;
  currentTask.label = label;
  broadcastEvent('filegen:phase', { taskId, phase, label });
  _pushSurface();
}

/**
 * 2026-09-06: 产物登记事件（替代"每 Write 即 done"）。
 * Write/Edit 插桩每次成功写入调用——文件进 currentFiles（去重）、广播
 * filegen:artifact（前端产物清单/预览实时更新），任务保持 writing 态。
 * 任务级 done 只来自：转换工具完成（doneFileGen）或回合收敛（settleTurn）。
 * 注册表登记也移至此处（每个产物一条），doneFileGen 凭 registeredPaths 去重。
 */
function artifactFileGen(taskId, file) {
  if (!currentTask || currentTask.taskId !== taskId) return;
  try {
    if (file && file.path && !currentFiles.some((f) => f.path === file.path)) {
      currentFiles.push(file);
    }
    currentTask.files = currentFiles;
    currentTask.lastSubstantiveAt = Date.now();
    broadcastEvent('filegen:artifact', { taskId, file, files: currentFiles });
    _pushSurface();
    // 注册表登记：产物即时入历史（回合被打断也有记录）；doneFileGen 去重
    if (file && file.path && !currentTask.registeredPaths.has(file.path)) {
      currentTask.registeredPaths.add(file.path);
      const { registerArtifact } = require('./doc-artifacts/registry');
      registerArtifact({
        path: file.path,
        name: file.name,
        size: file.size,
        format: file.format,
        url: file.url,
        taskId,
      }).catch((e) => console.warn('[filegen] 产物注册失败(不阻塞):', e && e.message));
    }
  } catch (e) {
    console.warn('[filegen] artifact 插桩失败(不阻塞):', e.message);
  }
}

async function doneFileGen(taskId, file, opts = {}) {
  if (!currentTask || currentTask.taskId !== taskId) return;
  // R2-4: 产物登记（去重 by path）——多文件写作累积 files
  if (file && file.path && !currentFiles.some((f) => f.path === file.path)) {
    currentFiles.push(file);
  }
  // final-review SHOULD-FIX: done 刷新 startedAt——复用窗口从 done 时刻重新起算，
  // 长会话(>5min) done→下一写不裂成新任务（前端 tabs/后端 files 不被清空）
  currentTask.startedAt = Date.now();
  currentTask.phase = 'done';
  // 2026-09-03 修复(文档卡卡在"正在撰写"): done 只改 phase 不改 label——状态快照
  // 变成 {phase:'done', label:'正在撰写 X…'},前端展示 label 导致卡片永远显示
  // "正在撰写"(实测)。终态 label 与 phase 同步。
  currentTask.label = '已完成 · 可打开查看';
  currentTask.file = file;
  currentTask.files = currentFiles;
  currentTask.lastSubstantiveAt = Date.now();
  broadcastEvent('filegen:done', { taskId, file, files: currentFiles });
  // final-review SHOULD-FIX: done 自动重开面板（前端 R2-3）与 AI 上下文一致——
  // 与 startFileGen 对称写 panel-state open（生成中用户关闭面板后 done 自动重开）
  // 2026-09-06 修订: 不再强制 open——"完成即打断"改为前端 toast 分层通知；
  // 仅保留 AI 上下文侧的 panel-state 记录（inform 语义，不驱动 UI 滑入）。
  _pushSurface();
  // SP-4 SA-1: 文档产物注册表统一注册点=filegen:done——广播之后追加注册,
  // 失败不阻塞（与广播同构）。await 位于函数尾部: 既有同步副作用（files 累积/
  // 广播/panel-state/surface）均先于首个 await 执行, 同步调用方语义不变。
  // 2026-09-06: artifactFileGen 已登记过的 path 不重复注册（防 v 序列噪声）。
  if (file && file.path && !opts.skipRegister && !currentTask.registeredPaths.has(file.path)) {
    currentTask.registeredPaths.add(file.path);
    try {
      const { registerArtifact } = require('./doc-artifacts/registry');
      await registerArtifact({
        path: file.path,
        name: file.name,
        size: file.size,
        format: file.format,
        url: file.url,
        taskId,
      });
    } catch (e) {
      console.warn('[filegen] 产物注册失败(不阻塞):', e && e.message);
    }
  }
}

function failFileGen(taskId, message) {
  if (!currentTask || currentTask.taskId !== taskId) return;
  currentTask.phase = 'error';
  currentTask.label = '生成失败';
  currentTask.error = message;
  currentTask.lastSubstantiveAt = Date.now();
  broadcastEvent('filegen:error', { taskId, message });
  _pushSurface();
}

/**
 * 2026-09-06: 取消任务——进行中（collect/writing/converting/paused）任务可取消，
 * 转终态 cancelled。终态/无任务返回 false。前端"取消"按钮与卡住兜底共用。
 */
function cancelFileGen(taskId) {
  if (!currentTask) return false;
  if (taskId && currentTask.taskId !== taskId) return false;
  if (TERMINAL_PHASES.has(currentTask.phase)) return false;
  currentTask.phase = 'cancelled';
  currentTask.label = '已取消';
  currentTask.error = null;
  broadcastEvent('filegen:cancelled', { taskId: currentTask.taskId });
  _pushSurface();
  return true;
}

/**
 * 2026-09-06: 回合收敛——ai.js chat()/chatStream() 回合结束（含中断/异常）调用。
 *   - 无任务/已终态 → no-op；
 *   - converting → no-op（异步转换自行收尾）；
 *   - 本回合零实质活动（意图开卡后模型只追问/闲聊）→ paused（"等待补充需求信息"），
 *     治"孤儿任务永卡正在搜集资料"；
 *   - 有实质活动且有产物 → 收敛为 done（主产物=html 优先，否则最后产物）——
 *     治 done-per-Write 震荡后"写完无终态"；
 *   - 有实质活动无产物（搜完没写）→ paused（"可继续生成"）。
 */
function settleTurn() {
  try {
    if (!currentTask) return;
    const t = currentTask;
    if (TERMINAL_PHASES.has(t.phase) || t.phase === 'converting') return;
    const hadActivity = t.lastSubstantiveAt >= currentTurnStart && currentTurnStart > 0;
    if (!hadActivity) {
      t.phase = 'paused';
      t.label = '已暂停 · 等待补充需求信息';
      // 2026-09-06 追问回答链路: 记录暂停时刻——ai.js 据此限定"补充需求回答"hint
      // 注入窗口（防长期挂起的任务给后续无关聊天注入提示噪声）
      t.pausedAt = Date.now();
      broadcastEvent('filegen:phase', { taskId: t.taskId, phase: 'paused', label: t.label });
      _pushSurface();
      return;
    }
    if (currentFiles.length > 0) {
      const mainFile = currentFiles.find((f) => /\.html?$/i.test(f.path || ''))
        || currentFiles[currentFiles.length - 1];
      doneFileGen(t.taskId, mainFile, { skipRegister: true });
    } else {
      t.phase = 'paused';
      t.label = '已暂停 · 可继续生成';
      t.pausedAt = Date.now();
      broadcastEvent('filegen:phase', { taskId: t.taskId, phase: 'paused', label: t.label });
      _pushSurface();
    }
  } catch (e) {
    console.warn('[filegen] 回合收敛失败(不阻塞):', e.message);
  }
}

/** 2026-09-06: 回合开始锚点（ai.js chat/chatStream 入口调用；silent 内部任务不调） */
function beginTurn() {
  currentTurnStart = Date.now();
}

/**
 * 2026-09-06 恢复链路: 是否存在可恢复（非终态）任务——继续类消息命中时复活用。
 */
function hasResumableTask() {
  return !!(currentTask && !TERMINAL_PHASES.has(currentTask.phase));
}

/**
 * 2026-09-06 恢复链路: 复活未终态任务（ai.js 继续类消息命中时调用）。
 *   - paused/collect → phase 回 collect、label "正在继续…"、刷新 startedAt——
 *     跨数小时恢复时复用窗口（5min）必然已过期，不刷新 startedAt 的话后续
 *     Write/搜索插桩会裂成新任务、旧资料/产物全丢；
 *   - writing/converting → 流程状态不动，仅重播 surface 让卡片回归；
 *   - _pushSurface 重挂 'file-panel' surface（用户此前关掉面板也能重新滑入）。
 * 返回任务上下文快照供继续引导文案；无可恢复任务返回 null。
 */
function resumeFileGenTask() {
  if (!currentTask || TERMINAL_PHASES.has(currentTask.phase)) return null;
  const t = currentTask;
  if (t.phase === 'paused' || t.phase === 'collect') {
    t.phase = 'collect';
    t.label = '正在继续…';
    t.startedAt = Date.now();
    broadcastEvent('filegen:phase', { taskId: t.taskId, phase: t.phase, label: t.label });
  }
  _pushSurface();
  return { taskId: t.taskId, title: t.title, format: t.format, phase: t.phase, label: t.label };
}

/**
 * 2026-09-06 追问回答链路: 当前 paused 任务快照（无则 null）。
 * ai.js 判"用户这条消息是否可能是对暂停任务追问的回答"用——追问后用户的回答
 * 往往不含文件词（"做关于智能家居的"），isFileGenIntent/isFileGenResumeMessage
 * 均不命中，需要独立的 paused 通道注入条件引导。 */
function getPausedTask() {
  if (!currentTask || currentTask.phase !== 'paused') return null;
  const t = currentTask;
  return { taskId: t.taskId, title: t.title, format: t.format, label: t.label, pausedAt: t.pausedAt || 0 };
}

/** 2026-09-06: 结构化解析广播——Write 插桩按任务 format 广播 doc-structure
 *  （slides/tables），前端载体视图优先渲染后端结构（预览/产物单一事实源）。
 *  md/docx 文档流前端自解析，不广播。失败不阻塞。 */
function broadcastDocStructure(taskId, format, markdown) {
  try {
    if (!currentTask || currentTask.taskId !== taskId) return;
    if (format === 'pptx') {
      const { parseMarkdownToSlides } = require('./markdown-slides');
      const pages = parseMarkdownToSlides(markdown);
      broadcastEvent('filegen:doc-structure', { taskId, kind: 'slides', pages });
    } else if (format === 'xlsx') {
      const { parseMarkdownTables } = require('./markdown-slides');
      const tables = parseMarkdownTables(markdown);
      if (tables.length) {
        broadcastEvent('filegen:doc-structure', { taskId, kind: 'tables', tables });
      }
    }
  } catch (e) {
    console.warn('[filegen] doc-structure 广播失败(不阻塞):', e.message);
  }
}

function getFileGenStatus() {
  // R2-4: 返回活引用并同步 files（面板快照含产物列表；测试模拟窗口过期需改 startedAt）
  if (currentTask) currentTask.files = currentFiles;
  return currentTask;
}

/**
 * 2026-08-23: 研究阶段资料来源插桩——生成任务活跃期间 WebSearch/WebFetch
 * 命中时调用，广播 filegen:source（面板「资料」区：🔍 关键词 → 来源标题+链接）。
 * 无活跃任务（普通聊天搜索）不广播——面板不弹、不污染资料区。
 * 失败不阻塞——搜索插桩失败仅 console.warn，工具结果照常回给模型。
 */
function sourceFileGen(query, sources) {
  try {
    if (!currentTask || TERMINAL_PHASES.has(currentTask.phase)) return;
    const list = (Array.isArray(sources) ? sources : []).slice(0, 8).map((s) => ({
      title: String(s?.title || s?.name || '未命名来源').slice(0, 120),
      url: String(s?.url || s?.link || '').slice(0, 300),
      snippet: String(s?.snippet || s?.abstract || s?.description || '').slice(0, 200),
    })).filter((s) => s.title && s.title !== '未命名来源');
    if (!list.length) return;
    const entry = { query: String(query || '').slice(0, 100), sources: list, ts: Date.now() };
    currentSources.push(entry);
    currentTask.sources = currentSources;
    currentTask.lastSubstantiveAt = Date.now();
    broadcastEvent('filegen:source', { taskId: currentTask.taskId, query: entry.query, sources: list });
    _pushSurface();
    // 2026-08-23: 资料收集完成 → 阶段推进「正在组织内容…」——此前 PPT/文章场景
    // 卡片 15 秒停「正在搜集资料…」（资料区已 2 条来源仍显示搜集, 用户判定"卡住",
    // 日志实锤 03:20:21 搜索完成 → 03:20:31 PptxGenerate 前零事件）。
    // 2026-09-06: paused 任务收到搜索（用户补充需求后继续）同样恢复流程。
    // 仅 collect/paused 时推进一次（写作中二次搜索不干扰 writing 后的 label）。
    if (currentTask.phase === 'collect' || currentTask.phase === 'paused') {
      try {
        phaseFileGen(currentTask.taskId, 'writing', '正在组织内容…');
      } catch (e) {
        console.warn('[filegen] 阶段推进失败(不阻塞):', e.message);
      }
    }
  } catch (e) {
    console.warn('[filegen] 资料插桩失败(不阻塞):', e.message);
  }
}

module.exports = {
  FILE_PANEL_SURFACE,
  TASK_REUSE_WINDOW_MS,
  TERMINAL_PHASES,
  newTaskId,
  formatFromPath,
  previewUrlFor,
  startFileGen,
  ensureFileGenTask,
  phaseFileGen,
  artifactFileGen,
  doneFileGen,
  failFileGen,
  cancelFileGen,
  settleTurn,
  beginTurn,
  hasResumableTask,
  resumeFileGenTask,
  getPausedTask,
  broadcastDocStructure,
  sourceFileGen,
  getFileGenStatus,
};
