/**
 * hyperframes-tools.js — HyperFrames HTML→视频渲染（HeyGen 开源, Apache 2.0）
 *
 * 与 RemotionRender（React 代码合成）互补：
 * - HyperFrames = 普通 HTML（data-start/data-duration 时序属性）→ 确定性 MP4，
 *   registry 有 155 个现成设计块可参考，写 HTML 比写 React 更稳。
 * - 强项工作流：给现有视频加字幕/覆层、URL→宣传片、参数化批量渲染。
 *
 * 架构（与 remotion-tools 同构，插槽全部复用）：
 *   1. 工作区项目 scaffold（data/.crabpaw/workspace/hyperframes，首次自动创建）
 *   2. 依赖安装（首次 npm install hyperframes，含 Puppeteer 托管 Chrome 下载）
 *   3. lint 预检（hyperframes lint --json，静态拦截坏合成物）
 *   4. 渲染 spawn `npx hyperframes render`（非 TTY 每行 "bar 42% stage"，可解析）
 *   5. 产物写入 generated-videos 白名单目录 + registerArtifact + SceneMedia 卡
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { registry } = require('./registry');
const { DATA_DIR, WORKSPACE_DIR } = require('../core/config');
const { redactText } = require('../core/secret-redactor');
const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');

const GENERATED_VIDEOS_DIR = path.join(DATA_DIR, 'generated-videos');
const PROJECT_DIR = path.join(WORKSPACE_DIR, 'hyperframes');

const RENDER_WAIT_DEFAULT_SECONDS = 90;
const RENDER_RUNNING_TIMEOUT_MS = 900000; // 15 分钟,与契约 maxTimeout 一致

// ── 本地预览 URL（DATA_DIR 相对 → /files/）──
function _localFileUrl(filePath) {
  if (!filePath) return null;
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (process.versions.electron) {
    return `local:///${normalizedPath}`;
  }
  const apiPort = parseInt(process.env.API_PORT || '38767', 10);
  let relativePath = filePath;
  if (DATA_DIR && filePath.startsWith(DATA_DIR)) {
    relativePath = filePath.substring(DATA_DIR.length).replace(/^[\\/]+/, '');
  } else {
    relativePath = path.basename(filePath);
  }
  relativePath = relativePath.replace(/\\/g, '/');
  return `http://localhost:${apiPort}/files/${encodeURIComponent(relativePath).replace(/%2F/g, '/')}`;
}

// ── 场景卡（进度卡 → 完成后同 id 变形为视频卡/错误卡）──
function _getSceneStore() {
  try {
    return require('../core/scene/scene-store').getSceneStore();
  } catch (e) {
    return null;
  }
}

function _upsertProgress(surfaceId, label, percent, text, steps) {
  const store = _getSceneStore();
  if (!store) return;
  try {
    store.upsertSurface(surfaceId, {
      kind: 'progress',
      data: {
        label: label || 'HyperFrames 渲染',
        progress: Math.max(0, Math.min(100, Math.round(percent))),
        text: text || '',
        steps: Array.isArray(steps) ? steps : undefined,
      },
      intent: 'ambient',
    });
  } catch (e) {
    console.warn('[hyperframes-tools] 进度卡更新失败:', e.message);
  }
}

function _upsertMediaDone(surfaceId, item) {
  const store = _getSceneStore();
  if (!store) return;
  try {
    store.upsertSurface(surfaceId, {
      kind: 'media',
      data: { items: [item] },
      intent: 'inform',
    });
  } catch (e) {
    console.warn('[hyperframes-tools] 视频卡写入失败:', e.message);
  }
}

function _upsertFailure(surfaceId, title, body) {
  const store = _getSceneStore();
  if (!store) return;
  try {
    store.upsertSurface(surfaceId, {
      kind: 'text',
      data: { title: title || '视频渲染失败', body: String(body || ''), footnote: '' },
      intent: 'confront',
    });
  } catch (e) {
    console.warn('[hyperframes-tools] 错误卡写入失败:', e.message);
  }
}

// ── 任务表（与 REMOTION_TASKS 同构）──
const HYPERFRAMES_TASKS = new Map();
const TASK_CLEANUP_INTERVAL = 60000;
const MAX_TASK_AGE = 600000;

let _taskCleanupTimer = null;

function startTaskCleanup() {
  if (_taskCleanupTimer) return;
  _taskCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [taskId, task] of HYPERFRAMES_TASKS.entries()) {
      if (task.status === 'completed' || task.status === 'failed') {
        if (now - task.completedAt > MAX_TASK_AGE) HYPERFRAMES_TASKS.delete(taskId);
      }
      if (task.status === 'running' && now - task.startedAt > RENDER_RUNNING_TIMEOUT_MS) {
        task.status = 'failed';
        task.error = 'Task timeout';
        task.completedAt = Date.now();
        if (task.child && !task.child.killed) {
          try { task.child.kill(); } catch (e) { console.warn('[hyperframes-tools] 超时进程终止失败:', e.message); }
        }
      }
    }
  }, TASK_CLEANUP_INTERVAL).unref();
}

function stopTaskCleanup() {
  if (_taskCleanupTimer) {
    clearInterval(_taskCleanupTimer);
    _taskCleanupTimer = null;
  }
}

function createRenderTask(composition, options) {
  let vrnd;
  try { vrnd = crypto.randomBytes(4).toString('hex').slice(0, 8); } catch (e) { vrnd = Math.random().toString(36).slice(2, 10); }
  const taskId = `hf_${Date.now()}_${vrnd}`;
  const task = {
    id: taskId,
    composition,
    status: 'pending',
    phase: 'preparing',
    percent: 0,
    startedAt: Date.now(),
    completedAt: null,
    options,
    child: null,
    output: null,
    result: null,
    error: null,
    settled: false,
    surfaceId: `hyperframes_${taskId}`,
  };
  HYPERFRAMES_TASKS.set(taskId, task);
  startTaskCleanup();
  return task;
}

// ── 脚手架模板 ──────────────────────────────────────────────
const SAMPLE_COMPOSITION = `<!doctype html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <title>Hello Crab</title>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1280px; height: 720px; overflow: hidden;
      background: linear-gradient(150deg, #0a1522 0%, #10243a 100%);
      font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; }
    #stage { width: 1280px; height: 720px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; }
    #logo { width: 120px; height: 120px; border-radius: 32px; margin-bottom: 26px;
      background: linear-gradient(135deg, #ff6b35, #ffa94d); display: flex;
      align-items: center; justify-content: center; font-size: 60px; }
    #title { font-size: 76px; font-weight: 800; color: #f8fafc; letter-spacing: 2px; }
    #title span { color: #ff6b35; }
    #subtitle { font-size: 30px; color: #94a3b8; margin-top: 20px; letter-spacing: 6px; }
  </style>
</head>
<body>
  <div id="stage" data-composition-id="hello-crab" data-width="1280" data-height="720"
       data-start="0" data-duration="5"
       data-composition-variables='[{"id":"title","type":"string","label":"标题","default":"Hello Crab"}]'>
    <div id="logo">🦀</div>
    <div id="title">Hello <span data-var="title">Crab</span></div>
    <div id="subtitle">HYPERFRAMES · HTML TO VIDEO</div>
  </div>
  <script>
    // seekable 时间轴：GSAP timeline 必须 paused 且注册到 window.__timelines[合成物ID]
    // 渲染器按 ID 查找并逐帧 seek。用 fromTo()（随机 seek 下可靠），勿用 from()。
    const tl = gsap.timeline({ paused: true });
    tl.fromTo('#logo', { scale: 0 }, { scale: 1, duration: 0.6, ease: 'back.out(1.6)' }, 0)
      .fromTo('#title', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5 }, 0.3)
      .fromTo('#subtitle', { opacity: 0 }, { opacity: 1, duration: 0.5 }, 0.6)
      .to('#stage', { opacity: 0, duration: 0.4 }, 4.4);
    window.__timelines = window.__timelines || {};
    window.__timelines['hello-crab'] = tl;
  </script>
</body>
</html>
`;

function _buildScaffold() {
  return {
    'package.json': JSON.stringify({
      name: 'crabpaw-hyperframes-workspace',
      version: '1.0.0',
      private: true,
      dependencies: {
        hyperframes: '^0.8.30',
      },
    }, null, 2),
    '.gitignore': 'node_modules/\n.vars-*.json\n',
    'compositions/hello-crab.html': SAMPLE_COMPOSITION,
  };
}

/** compositions/ 下已登记的合成物（.html 文件名，不含扩展名与扩展名两种都返回） */
function _listCompositions(projectDir) {
  try {
    const dir = path.join(projectDir, 'compositions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => /\.html?$/i.test(f))
      .map((f) => f.replace(/\.html?$/i, ''));
  } catch (e) {
    return [];
  }
}

function _resolveCompositionFile(projectDir, composition) {
  const dir = path.join(projectDir, 'compositions');
  for (const candidate of [`${composition}.html`, `${composition}.htm`, composition]) {
    const full = path.join(dir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** 创建工作区项目：缺失补齐，不覆盖已有合成物 */
async function ensureProject(projectDir, onStep) {
  const files = _buildScaffold();
  const report = (p, t) => { if (onStep) onStep(p, t); };

  await fsp.mkdir(path.join(projectDir, 'compositions'), { recursive: true });

  let created = 0;
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(projectDir, rel);
    if (!fs.existsSync(target)) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, 'utf8');
      created++;
    }
  }
  report(created > 0 ? 6 : 4, created > 0 ? '工作区项目已就绪' : '工作区项目已存在');

  if (!fs.existsSync(path.join(projectDir, 'node_modules', 'hyperframes'))) {
    report(8, '首次初始化：安装 HyperFrames（含浏览器下载，约 2-5 分钟）…');
    await _npmInstall(projectDir);
    report(10, '依赖安装完成');
  }
  return projectDir;
}

function _npmInstall(projectDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: projectDir,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errTail = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { console.warn('[hyperframes-tools] npm install 超时终止失败:', e.message); }
      reject(new Error('npm install 超时（10 分钟）'));
    }, 600000);
    child.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-4000);
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm install 退出码 ${code}: ${errTail.slice(-500)}`));
    });
  });
}

// ── 渲染执行 ────────────────────────────────────────────────
function _slug(s) {
  return String(s || 'video').replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]+/g, '_').slice(0, 60) || 'video';
}

const PHASE_ORDER = ['preparing', 'lint', 'rendering', 'done'];
const PHASE_LABELS = {
  preparing: '准备项目',
  lint: '静态校验',
  rendering: '逐帧渲染',
  done: '输出成片',
};

/** 阶段步骤条数据（percent 全局单调：preparing 2-10, lint 10-14, rendering 20-98, done 100） */
function _buildSteps(phase, percent) {
  let cur = PHASE_ORDER.indexOf(phase);
  if (cur < 0) cur = 0;
  if (percent >= 100) cur = PHASE_ORDER.length;
  return PHASE_ORDER.map((p, i) => ({
    label: PHASE_LABELS[p],
    status: i < cur ? 'done' : i === cur ? 'active' : 'pending',
  }));
}

function _reportTaskProgress(task, percent, phase, text) {
  task.percent = Math.max(0, Math.min(100, Math.round(percent)));
  if (phase) task.phase = phase;
  const now = Date.now();
  if (!task._lastSurfaceAt || now - task._lastSurfaceAt > 800 || task.percent >= 100) {
    task._lastSurfaceAt = now;
    _upsertProgress(task.surfaceId, `HyperFrames 渲染：${task.composition}`, task.percent,
      text || `${PHASE_LABELS[task.phase] || task.phase} ${task.percent}%`,
      _buildSteps(task.phase, task.percent));
  }
}

async function _registerArtifact(task, outPath, previewUrl) {
  try {
    const { registerArtifact } = require('../core/doc-artifacts/registry');
    const stats = fs.existsSync(outPath) ? fs.statSync(outPath) : null;
    await registerArtifact({
      path: outPath,
      name: path.basename(outPath),
      size: stats ? stats.size : undefined,
      format: task.options.format || 'mp4',
      url: previewUrl,
      taskId: task.id,
      status: 'completed',
      title: task.composition,
    });
  } catch (e) {
    console.warn('[hyperframes-tools] 产物登记失败(不影响交付):', e.message);
  }
}

async function _finalizeSuccess(task) {
  if (task.settled) return;
  task.settled = true;
  task.status = 'completed';
  task.percent = 100;
  task.completedAt = Date.now();
  const previewUrl = _localFileUrl(task.output);
  _upsertMediaDone(task.surfaceId, {
    id: task.surfaceId,
    type: 'video',
    title: task.options.title || task.composition,
    url: previewUrl,
    thumbnail: '',
    autoplay: false,
    muted: false,
  });
  task.result = {
    output: task.output,
    preview_url: previewUrl,
    duration_ms: task.completedAt - task.startedAt,
  };
  await _registerArtifact(task, task.output, previewUrl);
  if (task._resolve) task._resolve({ ok: true });
}

function _finalizeFailure(task, error) {
  if (task.settled) return;
  task.settled = true;
  task.status = 'failed';
  task.error = error;
  task.completedAt = Date.now();
  _upsertFailure(task.surfaceId, `视频渲染失败：${task.composition}`, error);
  if (task._resolve) task._resolve({ ok: false, error });
}

function _startRender(task, projectDir) {
  return new Promise((resolve) => {
    task._resolve = resolve;
    const opts = task.options;
    const outName = `hyperframes_${Date.now()}_${_slug(opts.output_name || task.composition)}.${opts.format || 'mp4'}`;
    const outPath = path.join(GENERATED_VIDEOS_DIR, outName);
    task.output = outPath;

    (async () => {
      let varsFile = null;
      try {
        await fsp.mkdir(GENERATED_VIDEOS_DIR, { recursive: true });
        if (!canWriteGeneratorOutput(outPath)) {
          throw new Error(`安全限制：不允许写入该输出路径: ${outPath}`);
        }

        const args = [
          'hyperframes',
          'render',
          '-c', `compositions/${task.composition}${path.extname(task.composition) || '.html'}`,
          '-o', outPath,
        ];
        if (opts.props && typeof opts.props === 'object') {
          // 参数化渲染走 --variables-file, 避开 Windows 内联 JSON 引号问题
          varsFile = path.join(projectDir, `.vars-${task.id}.json`);
          await fsp.writeFile(varsFile, JSON.stringify(opts.props), 'utf8');
          args.push('--variables-file', varsFile);
        }
        if (opts.fps) args.push('--fps', String(opts.fps));
        if (opts.format && opts.format !== 'mp4') args.push('--format', opts.format);

        const child = spawn('npx', args, {
          cwd: projectDir,
          shell: process.platform === 'win32',
          windowsHide: true,
          env: process.env,
        });
        task.child = child;
        task.status = 'running';

        let errTail = '';
        let doneSeen = false;

        const handleLine = (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          // 非TTY 进度行: "<bar> 42% <stage>"; Chrome 下载行含 "Downloading Chrome"
          const m = /(\d{1,3})%\s+(.*)$/.exec(trimmed);
          if (!m) return;
          const pct = parseInt(m[1], 10);
          const stage = (m[2] || '').trim();
          if (/downloading chrome/i.test(trimmed)) {
            _reportTaskProgress(task, 12 + pct * 0.08, 'rendering', `下载浏览器内核 ${pct}%（仅首次）`);
          } else {
            doneSeen = doneSeen || pct >= 100;
            _reportTaskProgress(task, 20 + Math.min(100, pct) * 0.78, 'rendering', stage || `渲染 ${pct}%`);
          }
        };

        let stdoutBuf = '';
        child.stdout.on('data', (d) => {
          stdoutBuf += d.toString();
          let idx;
          while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
            handleLine(stdoutBuf.slice(0, idx));
            stdoutBuf = stdoutBuf.slice(idx + 1);
          }
        });
        child.stderr.on('data', (d) => {
          errTail = (errTail + d.toString()).slice(-2000);
        });
        child.on('error', (e) => {
          _finalizeFailure(task, `渲染进程启动失败: ${e.message}`);
          resolve();
        });
        child.on('close', (code) => {
          if (varsFile) fsp.unlink(varsFile).catch(() => {});
          if (code === 0 && fs.existsSync(outPath)) {
            _finalizeSuccess(task);
          } else {
            _finalizeFailure(task, `渲染退出码 ${code}: ${redactText(errTail.slice(-600)) || '无错误输出（可尝试先运行 hyperframes lint 检查合成物）'}`);
          }
          resolve();
        });
      } catch (e) {
        if (varsFile) fsp.unlink(varsFile).catch(() => {});
        _finalizeFailure(task, redactText(e.message) || String(e));
        resolve();
      }
    })();
  });
}

// ── lint 预检（静态校验门）──────────────────────────────────
function _runLint(projectDir, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['hyperframes', 'lint', '--json', projectDir], {
      cwd: projectDir,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let errTail = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* 进程可能已退出 */ }
      resolve({ ok: true, skipped: true, reason: 'lint 超时(跳过,不阻塞渲染)' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: true, skipped: true, reason: `lint 不可用(${e.message}), 放行` });
    });
    child.on('close', () => {
      clearTimeout(timer);
      // lint 有 findings 时退出码非 0; --json 输出 findings 数组
      let findings = null;
      try {
        const start = stdout.indexOf('[');
        const end = stdout.lastIndexOf(']');
        if (start >= 0 && end > start) findings = JSON.parse(stdout.slice(start, end + 1));
      } catch (e) { /* 非 JSON 输出,按文本处理 */ }
      if (findings === null) {
        const hasErrorWord = /error|not found|cannot/i.test(stdout + errTail);
        resolve({ ok: !hasErrorWord, findings: [], raw: (stdout + errTail).slice(-600), skipped: false });
        return;
      }
      const errors = Array.isArray(findings)
        ? findings.filter((f) => f && (f.severity === 'error' || f.severity === 'warn'))
        : [];
      resolve({ ok: errors.length === 0, findings: errors, raw: stdout.slice(-600), skipped: false });
    });
  });
}

// ── 工具 handler ────────────────────────────────────────────
async function handleHyperFramesRender(params, _context) {
  const {
    composition,
    props,
    output_name,
    title,
    format = 'mp4',
    fps,
    wait_seconds = RENDER_WAIT_DEFAULT_SECONDS,
    project_dir,
  } = params;

  if (!composition || typeof composition !== 'string') {
    return { success: false, error: 'composition 必填（compositions/ 下的合成物名，可不含 .html 后缀）' };
  }
  if (props !== undefined && (typeof props !== 'object' || props === null || Array.isArray(props))) {
    return { success: false, error: 'props 必须是对象（合成物 data-composition-variables 的取值）' };
  }
  if (wait_seconds < 5 || wait_seconds > 840) {
    return { success: false, error: 'wait_seconds 必须在 5-840 之间' };
  }

  const projectDir = path.resolve(project_dir || PROJECT_DIR);
  const task = createRenderTask(composition, { props, output_name, title, format, fps });
  const waitMs = Math.max(5, Math.min(840, wait_seconds)) * 1000;

  try {
    _reportTaskProgress(task, 2, 'preparing', '准备工作区项目…');
    await ensureProject(projectDir, (p, text) => _reportTaskProgress(task, p, 'preparing', text));

    // 预检 1：合成物文件存在
    const available = _listCompositions(projectDir);
    const compFile = _resolveCompositionFile(projectDir, composition);
    if (!compFile) {
      HYPERFRAMES_TASKS.delete(task.id);
      _upsertFailure(task.surfaceId, `合成物不存在：${composition}`,
        `项目 ${projectDir}\\compositions\\ 下可用: ${available.join(', ') || '（无）'}。请先创建 <name>.html 合成物。`);
      return {
        success: false,
        error: `合成物 "${composition}" 不存在。项目 ${projectDir} 的 compositions/ 下可用: [${available.join(', ') || '（无）'}]。请先创建合成物 HTML 文件（结构参考技能文档），或改用以上任一已存在名称。`,
        available_compositions: available,
        project_dir: projectDir,
      };
    }

    // 预检 2：lint 静态校验门（超时/不可用放行，不阻塞渲染）
    _reportTaskProgress(task, 10, 'lint', '静态校验合成物…');
    const lint = await _runLint(projectDir);
    if (!lint.ok) {
      HYPERFRAMES_TASKS.delete(task.id);
      const findingsText = Array.isArray(lint.findings) && lint.findings.length > 0
        ? lint.findings.map((f) => `- [${f.severity || 'error'}] ${f.rule || f.check || ''}: ${f.message || f.description || JSON.stringify(f).slice(0, 200)}`).join('\n')
        : (lint.raw || '未知问题');
      _upsertFailure(task.surfaceId, `合成物静态校验未通过：${composition}`, findingsText);
      return {
        success: false,
        error: `合成物静态校验（hyperframes lint）未通过，尚未开始渲染，修复后重试即可：\n${findingsText}`,
        lint_findings: lint.findings,
        project_dir: projectDir,
      };
    }

    const renderPromise = _startRender(task, projectDir);
    const outcome = await Promise.race([
      renderPromise,
      new Promise((res) => setTimeout(() => res({ asyncTimeout: true }), waitMs)),
    ]);

    if (outcome && outcome.asyncTimeout) {
      return {
        success: true,
        async: true,
        task_id: task.id,
        composition,
        message: `渲染仍在后台进行（超时上限 15 分钟）。完成后视频卡会自动出现在对话流，也可用 HyperFramesStatus(task_id="${task.id}") 查询进度。`,
      };
    }

    if (task.status === 'completed') {
      return {
        success: true,
        content: `视频渲染完成：**${task.options.title || composition}**\n\n- 输出: ${task.output}\n- 预览: ${task.result.preview_url}\n- 耗时: ${(task.result.duration_ms / 1000).toFixed(1)}s\n\n视频卡已自动展示；如需发送到飞书/企微，用 SendLarkFile / SendWecomFile（注意 30MB 上限）。`,
        task_id: task.id,
        video_path: task.output,
        preview_url: task.result.preview_url,
        duration_ms: task.result.duration_ms,
        message: '视频渲染完成',
      };
    }
    return { success: false, error: task.error || '渲染失败', task_id: task.id };
  } catch (e) {
    _finalizeFailure(task, redactText(e.message) || String(e));
    return { success: false, error: `渲染错误: ${redactText(e.message) || String(e)}`, task_id: task.id };
  }
}

async function handleHyperFramesStatus(params, _context) {
  const { task_id } = params || {};
  if (task_id) {
    const task = HYPERFRAMES_TASKS.get(task_id);
    if (!task) return { success: false, error: `任务不存在或已过期: ${task_id}` };
    return {
      success: true,
      task: {
        id: task.id,
        composition: task.composition,
        status: task.status,
        phase: task.phase,
        percent: task.percent,
        output: task.output,
        error: task.error,
      },
    };
  }
  const recent = Array.from(HYPERFRAMES_TASKS.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 10)
    .map((t) => ({
      id: t.id,
      composition: t.composition,
      status: t.status,
      phase: t.phase,
      percent: t.percent,
      error: t.error,
    }));
  const projectDir = path.resolve(PROJECT_DIR);
  return {
    success: true,
    recent_tasks: recent,
    project_dir: projectDir,
    available_compositions: _listCompositions(projectDir),
    message: `最近 ${recent.length} 个渲染任务`,
  };
}

// ── 素材入库 + 转写（给已有视频加字幕/覆层工作流）─────────────
async function handleHyperFramesStageAsset(params, _context) {
  const { file_path, name } = params || {};
  if (!file_path || typeof file_path !== 'string') {
    return { success: false, error: 'file_path 必填（要入库的素材文件绝对路径）' };
  }
  if (!fs.existsSync(file_path) || !fs.statSync(file_path).isFile()) {
    return { success: false, error: `文件不存在: ${file_path}` };
  }
  const size = fs.statSync(file_path).size;
  if (size > 500 * 1024 * 1024) {
    return { success: false, error: `文件超过 500MB 上限: ${(size / 1024 / 1024).toFixed(0)}MB` };
  }

  const projectDir = path.resolve(PROJECT_DIR);
  try { await ensureProject(projectDir, null); } catch (e) {
    return { success: false, error: `工作区项目初始化失败: ${e.message}` };
  }
  const assetsDir = path.join(projectDir, 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });

  const base = path.basename(file_path);
  const ext = path.extname(base) || '.mp4';
  const destName = _slug(name || path.basename(base, ext)) + ext;
  const destPath = path.join(assetsDir, destName);
  if (!canWriteGeneratorOutput(destPath)) {
    return { success: false, error: `安全限制：不允许写入 ${destPath}` };
  }
  fs.copyFileSync(file_path, destPath);

  return {
    success: true,
    assets_ref: `assets/${destName}`,
    staged_path: destPath,
    size,
    message: `素材已入库。合成物 HTML 里用 src="${`assets/${destName}`}" 引用；转写可直接把该路径传给 HyperFramesTranscribe。`,
  };
}

async function handleHyperFramesTranscribe(params, _context) {
  const { input_path, model, output_name, wait_seconds = 300 } = params || {};
  if (!input_path || typeof input_path !== 'string') {
    return { success: false, error: 'input_path 必填（视频/音频文件，或要导入的 .srt/.vtt/.json 转写稿）' };
  }
  if (wait_seconds < 5 || wait_seconds > 840) {
    return { success: false, error: 'wait_seconds 必须在 5-840 之间' };
  }
  if (!fs.existsSync(input_path)) {
    return { success: false, error: `文件不存在: ${input_path}` };
  }

  const projectDir = path.resolve(PROJECT_DIR);
  const isImport = /\.(srt|vtt|json)$/i.test(input_path);
  const taskId = `hft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const surfaceId = `hyperframes_${taskId}`;

  try {
    await ensureProject(projectDir, null);

    // 输入不在项目 assets/ 内时先复制进去（转写产物落在 assets/，与合成物同址）
    let workInput = input_path;
    const normInput = path.resolve(input_path);
    const normAssets = path.join(projectDir, 'assets');
    if (!normInput.startsWith(normAssets)) {
      await fsp.mkdir(normAssets, { recursive: true });
      const staged = path.join(normAssets, `${_slug(path.basename(input_path, path.extname(input_path)))}${path.extname(input_path)}`);
      fs.copyFileSync(input_path, staged);
      workInput = staged;
    }

    const slug = _slug(output_name || path.basename(workInput, path.extname(workInput)));
    const outPath = path.join(normAssets, `transcript_${slug}.json`);

    const args = ['hyperframes', 'transcribe', workInput, '--json'];
    if (model) args.push('--model', String(model));

    const _transcribeSteps = (p) => ([
      { label: '提取音频转写', status: p > 0 ? 'done' : 'active' },
      { label: '输出词级文稿', status: p >= 100 ? 'done' : 'pending' },
    ]);
    _upsertProgress(surfaceId, `HyperFrames 转写：${path.basename(workInput)}`, 5, '准备转写…', _transcribeSteps(0));

    let tail = '';
    const exitCode = await new Promise((resolve) => {
      const child = spawn('npx', args, {
        cwd: projectDir,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: process.env,
      });
      const timer = setTimeout(() => {
        try { child.kill(); } catch (e) { /* 进程可能已退出 */ }
        resolve(-1);
      }, Math.max(5, Math.min(840, wait_seconds)) * 1000);
      const onData = (d) => {
        const text = d.toString();
        tail = (tail + text).slice(-4000);
        const m = /(\d{1,3})%/.exec(text);
        if (m) _reportTaskProgress(surfaceId, 5 + parseInt(m[1], 10) * 0.9, 'rendering', `转写 ${m[1]}%`);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { clearTimeout(timer); tail += `\n${e.message}`; resolve(-2); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? 0 : (code || -3)); });
    });

    // 2026-09-07: 导入模式忽略 --output 且固定写 assets/transcript.json；
    // 从 stdout JSON 的 transcriptPath 解析实际落点，统一归一到带名字空间的输出。
    if (exitCode === 0 && !fs.existsSync(outPath)) {
      try {
        const jsonStart = tail.indexOf('{');
        const jsonEnd = tail.lastIndexOf('}');
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          const doc = JSON.parse(tail.slice(jsonStart, jsonEnd + 1));
          if (doc.transcriptPath && fs.existsSync(doc.transcriptPath) && doc.transcriptPath !== outPath) {
            fs.copyFileSync(doc.transcriptPath, outPath);
          }
        }
      } catch (e) { console.warn('[hyperframes-tools] transcriptPath 解析失败:', e.message); }
    }

    if (exitCode !== 0 || !fs.existsSync(outPath)) {
      return {
        success: false,
        error: `转写未完成（退出码 ${exitCode}）。最常见原因：whisper-cpp 未安装（Windows 需 PATH 已装或 cmake 本地编译，见 https://github.com/ggml-org/whisper.cpp#building）。替代方案：若已有 .srt/.vtt 转写稿，直接把该文件传给本工具（自动导入为 transcript.json）。`,
        transcript_path: fs.existsSync(outPath) ? outPath : null,
        hint: '也可用 bossagent 会议记录的转写稿（SRT）走导入模式。',
      };
    }

    let words = [];
    try {
      const doc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      words = Array.isArray(doc) ? doc : (doc.words || []);
    } catch (e) { /* 解析失败按 0 词处理 */ }

    _upsertMediaDone2(surfaceId, `转写完成：${path.basename(workInput)}`, `词数 ${words.length}，输出 ${outPath}`);

    return {
      success: true,
      transcript_path: outPath,
      assets_ref: `assets/${path.basename(outPath)}`,
      words_count: words.length,
      preview: words.slice(0, 12).map((w) => `[${(w.start ?? 0).toFixed ? Number(w.start).toFixed(1) : w.start}s] ${w.text || w.word || ''}`),
      hint: '合成物里用 <video class="clip" src="assets/原视频"> 做底层，字幕/覆层按 transcript 的词级时间排布；渲染交给 HyperFramesRender。',
    };
  } catch (e) {
    return { success: false, error: `转写错误: ${redactText(e.message) || String(e)}` };
  }
}

function _upsertMediaDone2(surfaceId, title, body) {
  const store = _getSceneStore();
  if (!store) return;
  try {
    store.upsertSurface(surfaceId, {
      kind: 'text',
      data: { title, body, footnote: '' },
      intent: 'inform',
    });
  } catch (e) {
    console.warn('[hyperframes-tools] 转写完成卡写入失败:', e.message);
  }
}

// ── 注册 ────────────────────────────────────────────────────
registry.register({
  name: 'HyperFramesRender',
  toolset: 'media',
  category: 'media',
  description: 'Render a HyperFrames composition (plain HTML with data-start/data-duration timing) into an MP4 video. Workspace project (auto-scaffolded on first use) lives at data/.crabpaw/workspace/hyperframes under the agent workspace; compositions are .html files in its compositions/ folder. Best for template/block-style videos, parametrized rendering, and re-rendering existing compositions with different variables. Runs a static lint gate before rendering.',
  schema: {
    type: 'object',
    properties: {
      composition: { type: 'string', description: '合成物名（compositions/ 下的 .html 文件名，可不含后缀）' },
      props: { type: 'object', description: '合成物变量取值（data-composition-variables），经 --variables-file 传入' },
      output_name: { type: 'string', description: '输出文件名（不含扩展名，默认用 composition 名）' },
      title: { type: 'string', description: '视频卡标题' },
      format: { type: 'string', enum: ['mp4', 'webm', 'gif'], description: '输出格式，默认 mp4' },
      fps: { type: 'number', description: '帧率（默认合成物设定）' },
      wait_seconds: { type: 'integer', minimum: 5, maximum: 840, description: '同步等待秒数（默认 90）。超时任务转后台，完成后视频卡自动出现' },
      project_dir: { type: 'string', description: 'HyperFrames 项目目录（默认工作区项目）' },
    },
    required: ['composition'],
    additionalProperties: false,
  },
  handler: handleHyperFramesRender,
  timeout: 900000,
  whenNotToUse: ['AI 创意实拍画面生成时用 VideoGenerate', 'React 代码级精确控制用 RemotionRender', '给已有视频加字幕/覆层需先按技能文档准备素材', '合成物 HTML 不存在时（先创建）'],
  riskLevel: 'medium',
});

registry.register({
  name: 'HyperFramesStatus',
  toolset: 'media',
  category: 'media',
  description: 'Check HyperFrames render task status — pass task_id for one task, or no args for the 10 most recent tasks PLUS the workspace project absolute path (project_dir) and available composition names. Call this first when unsure where the project lives or which compositions exist.',
  schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'HyperFramesRender 返回的任务 id（缺省则列出最近任务）' },
    },
    additionalProperties: false,
  },
  handler: handleHyperFramesStatus,
  timeout: 10000,
  whenNotToUse: ['渲染已同步完成（HyperFramesRender 直接返回结果）时'],
  riskLevel: 'low',
});

registry.register({
  name: 'HyperFramesStageAsset',
  toolset: 'media',
  category: 'media',
  description: 'Stage an uploaded media file (video/audio/image) into the HyperFrames workspace project assets/ folder so compositions can reference it as assets/<name>. Required step before a composition can use the user uploaded footage — the agent cannot copy binary files itself.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: '素材文件绝对路径（如对话上传的视频）' },
      name: { type: 'string', description: '目标文件名（不含扩展名，默认沿用原名）' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  handler: handleHyperFramesStageAsset,
  timeout: 60000,
  whenNotToUse: ['文件已在项目 assets/ 内时', '纯文本素材用 Read/Write 即可'],
  riskLevel: 'low',
});

registry.register({
  name: 'HyperFramesTranscribe',
  toolset: 'media',
  category: 'media',
  description: 'Transcribe a video/audio file into a word-level transcript.json (local whisper.cpp — requires whisper-cpp installed, auto-downloads the ggml model on first use). Also imports existing .srt/.vtt/.json transcripts without whisper. Output lands in the project assets/ folder for caption/overlay compositions.',
  schema: {
    type: 'object',
    properties: {
      input_path: { type: 'string', description: '视频/音频文件绝对路径；或要导入的 .srt/.vtt/.json 转写稿（导入模式无需 whisper）' },
      model: { type: 'string', description: 'whisper 模型（默认 small；中文勿用 *.en 英文专用模型）' },
      output_name: { type: 'string', description: '输出名（默认 transcript_<输入名>.json）' },
      wait_seconds: { type: 'integer', minimum: 5, maximum: 840, description: '同步等待秒数（默认 300，长视频 CPU 转写较慢）' },
    },
    required: ['input_path'],
    additionalProperties: false,
  },
  handler: handleHyperFramesTranscribe,
  timeout: 900000,
  whenNotToUse: ['whisper-cpp 未安装且无现成转写稿时（报错会给安装指引）', '不需要时间轴的纯文本总结用 DocRead/其他工具'],
  riskLevel: 'medium',
});

console.log('✅ HyperFrames 视频工具已注册（Render / Status / StageAsset / Transcribe）');

module.exports = {
  handleHyperFramesRender,
  handleHyperFramesStatus,
  handleHyperFramesStageAsset,
  handleHyperFramesTranscribe,
  HYPERFRAMES_TASKS,
  PROJECT_DIR,
  ensureProject,
  _buildScaffold,
  _listCompositions,
  _validateCompositionExists: _resolveCompositionFile,
  _buildSteps,
  _localFileUrl,
  stopTaskCleanup,
};
