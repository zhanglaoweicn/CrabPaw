'use strict';

/**
 * install-software-tool.js — AI 可调用的软件安装工具
 *
 * 设计参考 10.5 install_software:
 * - 后台 job 异步执行，不阻塞对话
 * - 通过 SceneSet 卡片显示进度
 * - 用户随时查询/取消
 * - 强审批：必须用户明确确认 packageId 才执行
 *
 * 工具:
 * InstallSoftware — 启动一个安装任务
 * UninstallSoftware — 启动一个卸载任务
 * SearchSoftware — 搜索可用软件
 * GetInstallJob — 查询 job 状态
 * CancelInstallJob — 取消一个 job
 * ListInstallJobs — 列出用户所有 jobs
 * DetectSoftwareManagers — 探测本机可用的 manager
 */

const { registry } = require('./registry');
const { getSoftwareJobManager, JOB_STATUS } = require('../core/software-jobs');
const winget = require('../core/winget-installer');

// ---------------------------------------------------------------------------
// Scene 卡片工具
// ---------------------------------------------------------------------------

let _getSceneStore = null;
function getSceneStore() {
 if (!_getSceneStore) {
 try {
 _getSceneStore = require('../core/scene/scene-store').getSceneStore;
 } catch (e) {
 console.warn('[install-software-tool] scene-store 不可用:', e.message);
 }
 }
 return _getSceneStore ? _getSceneStore() : null;
}

function upsertSceneCard(job) {
 const store = getSceneStore();
 if (!store) return;
 try {
 const cardId = `install_job_${job.id}`;
 if (!job.sceneCardId) job.sceneCardId = cardId;

 const statusIcon = {
 queued: '⏳',
 running: '⚙️',
 succeeded: '✅',
 failed: '❌',
 cancelled: '🚫',
 }[job.status] || '❓';

 store.setSurface(cardId, {
 kind: 'progress',
 intent: 'ambient',
 data: {
 label: `${statusIcon} ${job.action === 'install' ? '安装' : '卸载'} ${job.packageName}`,
 progress: job.progress,
 text: job.message,
 status: job.status,
 manager: job.manager,
 packageId: job.packageId,
 jobId: job.id,
 },
 });
 } catch (e) {
 console.error('[install-software-tool] 写 scene 失败:', e.message);
 }
}

function removeSceneCard(job) {
 const store = getSceneStore();
 if (!store || !job.sceneCardId) return;
 try {
 store.setSurface(job.sceneCardId, null);
 } catch (e) {
 console.error('[install-software-tool] 移除 scene 失败:', e.message);
 }
}

// ---------------------------------------------------------------------------
// 工具 handler 1: InstallSoftware
// ---------------------------------------------------------------------------

async function handleInstallSoftware(params, context) {
 const { packageId, packageName, manager = 'winget', confirmation } = params;
 const userId = context?.userId || 'system';

 if (!packageId) return { success: false, error: 'packageId 必填' };

 // 强审批：需要 confirmation === 'YES_INSTALL'
 if (confirmation !== 'YES_INSTALL') {
 return {
 success: false,
 error: '需要用户明确确认。再次调用时传 confirmation="YES_INSTALL" 以执行。',
 needsConfirmation: true,
 packageId,
 manager,
 hint: '安装操作需要用户明确授权。请先向用户说明：需要安装什么、来源、大概体积，再请求用户回复"确认安装"。收到确认后，再次调用本工具并传 confirmation="YES_INSTALL"。',
 };
 }

 // 探测 manager
 const mgr = await winget.checkManager(manager);
 if (!mgr.available) {
 return {
 success: false,
 error: `manager "${manager}" 不可用: ${mgr.error || '未知原因'}`,
 hint: manager === 'winget'
 ? '请先安装 App Installer (winget) — 通过 Microsoft Store 搜索 "App Installer" 即可获得。'
 : `请先安装 ${manager}。`,
 };
 }

 const jobManager = getSoftwareJobManager();

 // 监听 job 事件，更新 scene 卡片
 const onJobEvent = (eventType, jobData) => {
 const job = jobManager.get(jobData.id);
 if (job) upsertSceneCard(job);
 if (eventType === 'succeeded' || eventType === 'failed' || eventType === 'cancelled') {
 // 完成后保留 8s 再移除
 setTimeout(() => {
 const j = jobManager.get(jobData.id);
 if (j) removeSceneCard(j);
 }, 8000);
 }
 };
 jobManager.on('progress', (j) => onJobEvent('progress', j));
 jobManager.on('started', (j) => onJobEvent('started', j));
 jobManager.on('succeeded', (j) => onJobEvent('succeeded', j));
 jobManager.on('failed', (j) => onJobEvent('failed', j));
 jobManager.on('cancelled', (j) => onJobEvent('cancelled', j));

 const job = jobManager.create({
 manager,
 action: 'install',
 packageId,
 packageName: packageName || packageId,
 userId,
 sessionId: context?.sessionId,
 });

 return {
 success: true,
 message: `已入队安装任务: ${packageName || packageId}`,
 data: {
 jobId: job.id,
 status: job.status,
 packageId,
 packageName: job.packageName,
 manager,
 managerVersion: mgr.version,
 sceneCardId: job.sceneCardId,
 _hint: '安装任务已入队（后台执行），用户可随时用 GetInstallJob 查询进度，用 CancelInstallJob 取消。',
 },
 };
}

// ---------------------------------------------------------------------------
// 工具 handler 2: UninstallSoftware
// ---------------------------------------------------------------------------

async function handleUninstallSoftware(params, context) {
 const { packageId, packageName, manager = 'winget', confirmation } = params;
 const userId = context?.userId || 'system';

 if (!packageId) return { success: false, error: 'packageId 必填' };

 if (confirmation !== 'YES_UNINSTALL') {
 return {
 success: false,
 error: '需要用户明确确认。再次调用时传 confirmation="YES_UNINSTALL" 以执行。',
 needsConfirmation: true,
 packageId,
 hint: '卸载会移除软件及关联数据。请先向用户说明风险，得到明确"确认卸载"后再调用。',
 };
 }

 const mgr = await winget.checkManager(manager);
 if (!mgr.available) {
 return { success: false, error: `manager "${manager}" 不可用: ${mgr.error}` };
 }

 const jobManager = getSoftwareJobManager();
 const job = jobManager.create({
 manager,
 action: 'uninstall',
 packageId,
 packageName: packageName || packageId,
 userId,
 sessionId: context?.sessionId,
 });

 // 复用监听逻辑
 jobManager.on('progress', (j) => { const x = jobManager.get(j.id); if (x) upsertSceneCard(x); });

 return {
 success: true,
 message: `已入队卸载任务: ${packageName || packageId}`,
 data: {
 jobId: job.id,
 status: job.status,
 packageId,
 packageName: job.packageName,
 manager,
 sceneCardId: job.sceneCardId,
 },
 };
}

// ---------------------------------------------------------------------------
// 工具 handler 3: SearchSoftware
// ---------------------------------------------------------------------------

async function handleSearchSoftware(params, _context) {
 const { query, limit = 10 } = params;
 if (!query) return { success: false, error: 'query 必填' };

 try {
 const mgr = await winget.checkManager('winget');
 if (!mgr.available) {
 return {
 success: false,
 error: 'winget 不可用，无法搜索。可通过 Microsoft Store 安装 "App Installer" 获得 winget。',
 managerStatus: mgr,
 };
 }
 const results = await winget.searchPackages(query, { limit });
 return {
 success: true,
 query,
 count: results.length,
 results,
 _hint: '获得 packageId 后，可用 InstallSoftware 工具安装（需用户确认）。',
 };
 } catch (e) {
 return { success: false, error: `搜索失败: ${e.message}` };
 }
}

// ---------------------------------------------------------------------------
// 工具 handler 4: GetInstallJob
// ---------------------------------------------------------------------------

async function handleGetInstallJob(params, _context) {
 const { jobId } = params;
 if (!jobId) return { success: false, error: 'jobId 必填' };

 const jobManager = getSoftwareJobManager();
 const job = jobManager.get(jobId);
 if (!job) return { success: false, error: `未找到 job: ${jobId}` };

 return {
 success: true,
 data: job.toJSON(),
 };
}

// ---------------------------------------------------------------------------
// 工具 handler 5: CancelInstallJob
// ---------------------------------------------------------------------------

async function handleCancelInstallJob(params, _context) {
 const { jobId } = params;
 if (!jobId) return { success: false, error: 'jobId 必填' };

 const jobManager = getSoftwareJobManager();
 const job = jobManager.get(jobId);
 if (!job) return { success: false, error: `未找到 job: ${jobId}` };

 if (job.status === JOB_STATUS.QUEUED) {
 const ok = jobManager.cancel(jobId);
 return { success: ok, message: ok ? '已取消排队中的 job' : '取消失败', data: job.toJSON() };
 }

 if (job.status === JOB_STATUS.RUNNING) {
 // 尝试终止子进程
 const wingetCancelled = require('../core/winget-installer').cancelJob(job);
 if (wingetCancelled) {
 job.status = JOB_STATUS.CANCELLED;
 job.message = '用户取消';
 job.finishedAt = Date.now();
 jobManager.emit('cancelled', job.toJSON());
 return { success: true, message: '已发送终止信号', data: job.toJSON() };
 }
 return { success: false, error: '无法终止运行中的子进程', data: job.toJSON() };
 }

 return {
 success: false,
 error: `job 处于终态 (${job.status})，无法取消`,
 data: job.toJSON(),
 };
}

// ---------------------------------------------------------------------------
// 工具 handler 6: ListInstallJobs
// ---------------------------------------------------------------------------

async function handleListInstallJobs(params, context) {
 const userId = params.userId || context?.userId || 'system';
 const jobManager = getSoftwareJobManager();
 const jobs = jobManager.list({
 userId,
 status: params.status,
 manager: params.manager,
 });
 return {
 success: true,
 userId,
 count: jobs.length,
 jobs,
 stats: jobManager.getStats(),
 };
}

// ---------------------------------------------------------------------------
// 工具 handler 7: DetectSoftwareManagers
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars -- 函数参数 context 未使用（不改签名）
async function handleDetectSoftwareManagers(_params, context) {
 const managers = await winget.detectManagers();
 const available = Object.entries(managers)
 .filter(([_, info]) => info.available)
 .map(([name, info]) => ({ name, version: info.version }));
 return {
 success: true,
 managers,
 available,
 _hint: available.length === 0
 ? '本机没有可用的包管理器，无法执行安装。Windows 用户可在 Microsoft Store 安装 "App Installer" 获得 winget。'
 : `可用 manager: ${available.map(m => `${m.name} (${m.version})`).join(', ')}`,
 };
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

registry.register({
 name: 'InstallSoftware',
 toolset: 'system',
 category: 'execution',
 description: `后台静默安装 Windows 软件（基于 winget/choco/scoop）。
【强审批】必须传 confirmation="YES_INSTALL" 才执行，否则返回 needsConfirmation。
【流程】
 1. 先调用 SearchSoftware(query) 找到 packageId
 2. 向用户说明：包名、来源、用途
 3. 等待用户回复"确认安装"
 4. 再次调用本工具，confirmation="YES_INSTALL" 真正执行
【后台执行】安装任务以 job 形式入队，AI 调用立即返回；进度通过 SceneSet 卡片展示给用户。
【支持的 manager】winget (Windows 默认) / choco / scoop。`,
 schema: {
 type: 'object',
 properties: {
 packageId: { type: 'string', description: '软件包 ID（winget Id / choco name / scoop bucket）' },
 packageName: { type: 'string', description: '软件显示名（可选，用于 UI 展示）' },
 manager: { type: 'string', enum: ['winget', 'choco', 'scoop'], default: 'winget', description: '包管理器' },
 confirmation: { type: 'string', enum: ['YES_INSTALL'], description: '必须传 "YES_INSTALL" 确认执行' },
 },
 required: ['packageId', 'confirmation'],
 },
 handler: handleInstallSoftware,
 isDangerous: true,
 timeout: 10000,
});

registry.register({
 name: 'UninstallSoftware',
 toolset: 'system',
 category: 'execution',
 description: `后台卸载已安装的软件。需要传 confirmation="YES_UNINSTALL" 才执行。`,
 schema: {
 type: 'object',
 properties: {
 packageId: { type: 'string' },
 packageName: { type: 'string' },
 manager: { type: 'string', enum: ['winget', 'choco', 'scoop'], default: 'winget' },
 confirmation: { type: 'string', enum: ['YES_UNINSTALL'] },
 },
 required: ['packageId', 'confirmation'],
 },
 handler: handleUninstallSoftware,
 isDangerous: true,
 timeout: 10000,
});

registry.register({
 name: 'SearchSoftware',
 toolset: 'system',
 category: 'execution',
 description: '在 winget 仓库中搜索软件。返回 id/name/version 列表。',
 schema: {
 type: 'object',
 properties: {
 query: { type: 'string', description: '搜索关键词（中文/英文/拼音均可）' },
 limit: { type: 'number', default: 10, description: '最多返回条数' },
 },
 required: ['query'],
 },
 handler: handleSearchSoftware,
 isReadOnly: true,
 timeout: 30000,
});

registry.register({
 name: 'GetInstallJob',
 toolset: 'system',
 category: 'execution',
 description: '查询一个安装/卸载 job 的当前状态、进度和输出。',
 schema: {
 type: 'object',
 properties: {
 jobId: { type: 'string', description: 'job ID（InstallSoftware 返回的 jobId）' },
 },
 required: ['jobId'],
 },
 handler: handleGetInstallJob,
 isReadOnly: true,
 timeout: 5000,
});

registry.register({
 name: 'CancelInstallJob',
 toolset: 'system',
 category: 'execution',
 description: '取消一个安装/卸载 job。排队中的 job 可直接取消；运行中的 job 会尝试终止子进程。',
 schema: {
 type: 'object',
 properties: {
 jobId: { type: 'string' },
 },
 required: ['jobId'],
 },
 handler: handleCancelInstallJob,
 isDangerous: true,
 timeout: 5000,
});

registry.register({
 name: 'ListInstallJobs',
 toolset: 'system',
 category: 'execution',
 description: '列出当前用户的所有安装/卸载 jobs，可按 status/manager 过滤。',
 schema: {
 type: 'object',
 properties: {
 userId: { type: 'string' },
 status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
 manager: { type: 'string', enum: ['winget', 'choco', 'scoop'] },
 },
 },
 handler: handleListInstallJobs,
 isReadOnly: true,
 timeout: 5000,
});

registry.register({
 name: 'DetectSoftwareManagers',
 toolset: 'system',
 category: 'execution',
 description: '探测本机可用的包管理器（winget/choco/scoop）。在尝试安装前调用，确认环境是否就绪。',
 schema: { type: 'object', properties: {} },
 handler: handleDetectSoftwareManagers,
 isReadOnly: true,
 timeout: 15000,
});

console.log('🔧 install-software 工具已注册 (7 个工具)');

module.exports = {
 handleInstallSoftware,
 handleUninstallSoftware,
 handleSearchSoftware,
 handleGetInstallJob,
 handleCancelInstallJob,
 handleListInstallJobs,
 handleDetectSoftwareManagers,
};
