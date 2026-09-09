/**
 * remotion-tools.js — Remotion 代码驱动视频渲染（写 React 组件 → 渲染 MP4）
 *
 * 与 VideoGenerate（AI 创意生成，火山 Seedance）互补：
 * - Remotion = 代码合成：数据驱动/模板化/精确到帧，产出可复现，适合
 *   数据视频、片头片尾、字幕视频、产品演示、营销模板。
 *
 * 架构（借鉴官方 Agent Skills 的工作流，落进 crabpaw 任务体系）：
 *   1. 工作区项目 scaffold（首次自动创建，data/.crabpaw/workspace/remotion）
 *   2. 依赖安装（首次 npm install，含 headless 浏览器下载，约 2-5 分钟）
 *   3. 渲染由项目内 render-runner.cjs 子进程执行，stdout 输出 JSON 行协议进度
 *   4. 产物写入 {DATA_DIR}/generated-videos（/files/ 白名单目录），
 *      registerArtifact 登记 + SceneMedia 卡片自动进对话流（进度卡同 id 变形为视频卡）
 *
 * 长任务模式：handler 默认等待 wait_seconds（默认 90s），未完成则返回
 * task_id 由调用方用 RemotionStatus 查询，渲染继续后台执行，完成后卡片自动出现。
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { registry } = require('./registry');
const { DATA_DIR, WORKSPACE_DIR } = require('../core/config');
const { redactText } = require('../core/secret-redactor');
// 2026-08-28 M1: 输出路径过权限门（与 VideoEdit 同源, 见 permissions/path-rules.js）
const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');

const GENERATED_VIDEOS_DIR = path.join(DATA_DIR, 'generated-videos');
const PROJECT_DIR = path.join(WORKSPACE_DIR, 'remotion');

const RENDER_WAIT_DEFAULT_SECONDS = 90;
const RENDER_RUNNING_TIMEOUT_MS = 900000; // 15 分钟,与契约 maxTimeout 一致

// ── 本地预览 URL（与 video-tools.getVideoUrl 同构：DATA_DIR 相对 → /files/）──
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
        label: label || 'Remotion 渲染',
        progress: Math.max(0, Math.min(100, Math.round(percent))),
        text: text || '',
        steps: Array.isArray(steps) ? steps : undefined,
      },
      intent: 'ambient',
    });
  } catch (e) {
    console.warn('[remotion-tools] 进度卡更新失败:', e.message);
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
    console.warn('[remotion-tools] 视频卡写入失败:', e.message);
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
    console.warn('[remotion-tools] 错误卡写入失败:', e.message);
  }
}

// ── 任务表（与 video-tools.VIDEO_GEN_TASKS 同构）──
const REMOTION_TASKS = new Map();
const TASK_CLEANUP_INTERVAL = 60000;
const MAX_TASK_AGE = 600000;

let _taskCleanupTimer = null;

function startTaskCleanup() {
  if (_taskCleanupTimer) return;
  _taskCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [taskId, task] of REMOTION_TASKS.entries()) {
      if (task.status === 'completed' || task.status === 'failed') {
        if (now - task.completedAt > MAX_TASK_AGE) REMOTION_TASKS.delete(taskId);
      }
      if (task.status === 'running' && now - task.startedAt > RENDER_RUNNING_TIMEOUT_MS) {
        task.status = 'failed';
        task.error = 'Task timeout';
        task.completedAt = Date.now();
        if (task.child && !task.child.killed) {
          try { task.child.kill(); } catch (e) { console.warn('[remotion-tools] 超时进程终止失败:', e.message); }
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
  const taskId = `rmo_${Date.now()}_${vrnd}`;
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
    surfaceId: `remotion_${taskId}`,
  };
  REMOTION_TASKS.set(taskId, task);
  startTaskCleanup();
  return task;
}

// ── 脚手架模板 ──────────────────────────────────────────────
// Root.tsx 映射 COMPOSITIONS 数组：新增视频只改 compositions/ 目录两个文件。
function _buildScaffold() {
  return {
    'package.json': JSON.stringify({
      name: 'crabpaw-remotion-workspace',
      version: '1.0.0',
      private: true,
      scripts: { studio: 'remotion studio' },
      dependencies: {
        remotion: '^4.0.0',
        '@remotion/bundler': '^4.0.0',
        '@remotion/cli': '^4.0.0',
        '@remotion/renderer': '^4.0.0',
        react: '^19.0.0',
        'react-dom': '^19.0.0',
      },
    }, null, 2),
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2018',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: false,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
      },
      include: ['src'],
    }, null, 2),
    'remotion.config.ts': `import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
`,
    '.gitignore': 'node_modules/\nout/\n.props-*.json\n',
    'src/index.ts': `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
`,
    'src/Root.tsx': `import React from "react";
import { Composition } from "remotion";
import { COMPOSITIONS } from "./compositions";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {COMPOSITIONS.map((comp) => (
        <Composition key={comp.id} {...comp} />
      ))}
    </>
  );
};
`,
    'src/compositions/index.tsx': `// 合成物注册表：新增视频 = ① 在本目录新建 <Name>.tsx 组件 ② 在 COMPOSITIONS 数组登记一条
import { HelloCrab, helloCrabMeta } from "./HelloCrab";

export const COMPOSITIONS = [
  { id: "HelloCrab", component: HelloCrab, ...helloCrabMeta },
];
`,
    'src/compositions/HelloCrab.tsx': `import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const helloCrabMeta = { durationInFrames: 90, fps: 30, width: 1280, height: 720 };

export const HelloCrab: React.FC<{ title?: string }> = ({ title = "CrabPaw \\u00d7 Remotion" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill
      style={{
        background: "linear-gradient(135deg,#0f172a,#1e293b)",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          transform: \`scale(\${scale})\`,
          opacity,
          fontSize: 72,
          fontWeight: 800,
          color: "#f8fafc",
          fontFamily: "sans-serif",
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};
`,
    // 渲染 runner：bossagent 托管的子进程脚本，stdout 输出 JSON 行协议。
    // 本文件由工具侧维护（每次 ensure 覆写），智能体无需修改。
    'render-runner.cjs': `/* Remotion 渲染 runner — 由 bossagent RemotionRender 工具托管（覆写更新），JSON 行协议 */
const path = require("path");
const fs = require("fs");

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + "\\n"); } catch (e) { /* stdout 可能已关闭 */ }
}

const args = {};
for (const raw of process.argv.slice(2)) {
  const m = /^--([a-zA-Z-]+)=(.*)$/s.exec(raw);
  if (m) args[m[1]] = m[2];
}

(async () => {
  try {
    const { bundle } = require("@remotion/bundler");
    const { renderMedia, selectComposition } = require("@remotion/renderer");

    const entryPoint = path.resolve(args.entry || path.join(process.cwd(), "src", "index.ts"));
    const output = args.output;
    const compositionId = args.composition;
    if (!output || !compositionId) throw new Error("--output 与 --composition 必填");
    const inputProps = args.props ? JSON.parse(fs.readFileSync(args.props, "utf8")) : {};
    const codec = args.codec || "h264";
    const concurrency = args.concurrency ? Number(args.concurrency) : undefined;
    const scale = args.scale !== undefined && args.scale !== "" ? Number(args.scale) : undefined;

    send({ type: "phase", phase: "bundling", percent: 2 });
    const serveUrl = await bundle({
      entryPoint,
      onProgress: (p) => {
        const pct = p <= 1 ? p * 100 : p;
        send({ type: "progress", phase: "bundling", percent: 2 + Math.min(100, pct) * 0.13 });
      },
    });

    send({ type: "phase", phase: "composition", percent: 16 });
    const composition = await selectComposition({ serveUrl, id: compositionId, inputProps });
    send({ type: "composition", durationInFrames: composition.durationInFrames, fps: composition.fps, width: composition.width, height: composition.height });

    await renderMedia({
      composition,
      serveUrl,
      codec,
      outputLocation: output,
      inputProps,
      concurrency,
      scale,
      onProgress: ({ progress }) => {
        send({ type: "progress", phase: "rendering", percent: 20 + Math.max(0, Math.min(1, progress)) * 78 });
      },
    });

    send({ type: "progress", phase: "done", percent: 100 });
    const sizeBytes = fs.existsSync(output) ? fs.statSync(output).size : null;
    send({ type: "done", output, sizeBytes });
    process.exit(0);
  } catch (e) {
    send({ type: "error", error: (e && e.message) || String(e) });
    process.exit(1);
  }
})();
`,
  };
}

/** 创建工作区项目：缺失的文件补齐（不覆盖智能体已编辑的文件），runner 每次覆写保持同步 */
async function ensureProject(projectDir, onStep) {
  const files = _buildScaffold();
  const report = (p, t) => { if (onStep) onStep(p, t); };

  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.mkdir(path.join(projectDir, 'src', 'compositions'), { recursive: true });

  let created = 0;
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(projectDir, rel);
    if (rel === 'render-runner.cjs' || !fs.existsSync(target)) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, 'utf8');
      created++;
    }
  }
  report(created > 0 ? 15 : 12, created > 0 ? `工作区项目已就绪（新建 ${created} 个文件）` : '工作区项目已存在');

  // 依赖检查：node_modules/remotion 存在即视为已安装
  if (!fs.existsSync(path.join(projectDir, 'node_modules', 'remotion'))) {
    report(20, '首次初始化：安装 Remotion 依赖（含浏览器内核下载，约 2-5 分钟）…');
    await _npmInstall(projectDir);
    report(55, '依赖安装完成');
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
      try { child.kill(); } catch (e) { console.warn('[remotion-tools] npm install 超时终止失败:', e.message); }
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

/** 从 src/compositions/index.tsx 解析已登记的合成物 id（供预检与自愈提示） */
function _listCompositions(projectDir) {
  try {
    const src = fs.readFileSync(path.join(projectDir, 'src', 'compositions', 'index.tsx'), 'utf8');
    const ids = [];
    const re = /id:\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) ids.push(m[1]);
    return ids;
  } catch (e) {
    return [];
  }
}

/**
 * 校验 index.tsx 的 import 名与组件文件实际导出是否一致。
 * 实测失败类：组件导出 crabPawMeta，登记写成 crabPromoMeta → 展开 undefined →
 * Composition 缺 durationInFrames，渲染秒挂且报错难懂（模型拿到
 * "The durationInFrames prop is missing" 无法定位到命名笔误，直接放弃）。
 * 在打包前静态拦截，给出可执行的修复指引。
 */
function _validateWiring(projectDir) {
  const issues = [];
  try {
    const idxPath = path.join(projectDir, 'src', 'compositions', 'index.tsx');
    if (!fs.existsSync(idxPath)) return issues;
    const src = fs.readFileSync(idxPath, 'utf8');
    const importRe = /import\s*\{([^}]+)\}\s*from\s*["']\.\/([^"']+)["']/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const fileBase = m[2].replace(/\.(tsx|ts|jsx|js)$/i, '');
      let compPath = path.join(projectDir, 'src', 'compositions', `${fileBase}.tsx`);
      if (!fs.existsSync(compPath)) compPath = path.join(projectDir, 'src', 'compositions', `${fileBase}.ts`);
      if (!fs.existsSync(compPath)) {
        issues.push(`index.tsx 引用了 "./${fileBase}"，但 compositions/ 下不存在该文件`);
        continue;
      }
      const compSrc = fs.readFileSync(compPath, 'utf8');
      const hasDefault = /export\s+default/.test(compSrc);
      const exports = [];
      const exportRe = /export\s+(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
      let em;
      while ((em = exportRe.exec(compSrc)) !== null) exports.push(em[1]);
      for (const name of names) {
        const bare = name.split(/\s+as\s+/)[0].trim();
        if (!bare) continue;
        const satisfied = exports.includes(bare)
          || new RegExp(`export\\s*\\{[^}]*\\b${bare}\\b`).test(compSrc)
          || (hasDefault && names.indexOf(bare) === 0);
        if (!satisfied) {
          issues.push(`index.tsx 从 "./${fileBase}" 引用了 ${bare}，但该文件实际导出: [${exports.join(', ') || '（无具名导出）'}]。请统一命名（组件文件与登记处的 import/展开名一致）后重试。`);
        }
      }
    }
  } catch (e) {
    console.warn('[remotion-tools] 接线校验异常(放行):', e.message);
  }
  return issues;
}

const PHASE_ORDER = ['preparing', 'bundling', 'composition', 'rendering', 'done'];
const PHASE_LABELS = {
  preparing: '准备项目',
  bundling: '打包组件',
  composition: '解析合成物',
  rendering: '逐帧渲染',
  done: '输出成片',
};

/**
 * 阶段步骤条数据（GUI ProgressCard 流程化渲染）。
 * percent 单调映射：preparing 2-55（脚手架/装依赖）→ runner 内部 0-100 线性映射到
 * 55-98 → done 100，保证百分比不回跳。
 */
function _buildSteps(phase, percent) {
  let cur = PHASE_ORDER.indexOf(phase);
  if (cur < 0) cur = 0;
  if (percent >= 100) cur = PHASE_ORDER.length; // 全部 done
  return PHASE_ORDER.map((p, i) => ({
    label: PHASE_LABELS[p],
    status: i < cur ? 'done' : i === cur ? 'active' : 'pending',
  }));
}

function _reportTaskProgress(task, percent, phase, text) {
  task.percent = Math.max(0, Math.min(100, Math.round(percent)));
  if (phase) task.phase = phase;
  // 节流：800ms 内不重复写卡
  const now = Date.now();
  if (!task._lastSurfaceAt || now - task._lastSurfaceAt > 800 || task.percent >= 100) {
    task._lastSurfaceAt = now;
    _upsertProgress(task.surfaceId, `Remotion 渲染：${task.composition}`, task.percent,
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
      format: 'mp4',
      url: previewUrl,
      taskId: task.id,
      status: 'completed',
      title: task.composition,
    });
  } catch (e) {
    console.warn('[remotion-tools] 产物登记失败(不影响交付):', e.message);
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
    const propsFile = path.join(projectDir, `.props-${task.id}.json`);
    const outName = `remotion_${Date.now()}_${_slug(opts.output_name || task.composition)}.mp4`;
    const outPath = path.join(GENERATED_VIDEOS_DIR, outName);
    task.output = outPath;

    (async () => {
      try {
        await fsp.mkdir(GENERATED_VIDEOS_DIR, { recursive: true });
        await fsp.writeFile(propsFile, JSON.stringify(opts.props || {}), 'utf8');
        if (!canWriteGeneratorOutput(outPath)) {
          throw new Error(`安全限制：不允许写入该输出路径: ${outPath}`);
        }

        const runner = path.join(projectDir, 'render-runner.cjs');
        const args = [
          runner,
          `--composition=${task.composition}`,
          `--output=${outPath}`,
          `--entry=${path.join(projectDir, 'src', 'index.ts')}`,
          `--props=${propsFile}`,
          `--codec=${opts.codec || 'h264'}`,
        ];
        if (opts.concurrency) args.push(`--concurrency=${opts.concurrency}`);
        if (opts.scale !== undefined && opts.scale !== null) args.push(`--scale=${opts.scale}`);

        const child = spawn(process.execPath, args, {
          cwd: projectDir,
          windowsHide: true,
          env: process.env,
        });
        task.child = child;
        task.status = 'running';

        let stdoutBuf = '';
        let errTail = '';
        let doneEvent = null;

        child.stdout.on('data', (d) => {
          stdoutBuf += d.toString();
          let idx;
          while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
            const line = stdoutBuf.slice(0, idx).trim();
            stdoutBuf = stdoutBuf.slice(idx + 1);
            if (!line) continue;
            let evt;
            try { evt = JSON.parse(line); } catch (e) { continue; }
            if (evt.type === 'progress' || evt.type === 'phase') {
              // 2026-09-07: runner 内部 0-100 线性映射到全局 55-98——
              // preparing 段(脚手架/装依赖)占 2-55, 百分比全程单调不回跳
              _reportTaskProgress(task, 55 + (evt.percent || 0) * 0.43, evt.phase, evt.text);
            } else if (evt.type === 'composition') {
              task.compositionMeta = evt;
            } else if (evt.type === 'done') {
              doneEvent = evt;
            } else if (evt.type === 'error') {
              errTail = (errTail + `\n[runner] ${evt.error}`).slice(-2000);
            }
          }
        });
        child.stderr.on('data', (d) => {
          errTail = (errTail + d.toString()).slice(-2000);
        });
        child.on('error', (e) => {
          _finalizeFailure(task, `渲染进程启动失败: ${e.message}`);
          fsp.unlink(propsFile).catch(() => {});
          resolve();
        });
        child.on('close', (code) => {
          fsp.unlink(propsFile).catch(() => {});
          if (code === 0 && doneEvent) {
            _finalizeSuccess(task);
          } else {
            _finalizeFailure(task, `渲染退出码 ${code}: ${redactText(errTail.slice(-600)) || '无错误输出'}`);
          }
          resolve();
        });
      } catch (e) {
        _finalizeFailure(task, redactText(e.message) || String(e));
        resolve();
      }
    })();
  });
}

// ── 工具 handler ────────────────────────────────────────────
async function handleRemotionRender(params, _context) {
  const {
    composition,
    props,
    output_name,
    title,
    codec = 'h264',
    wait_seconds = RENDER_WAIT_DEFAULT_SECONDS,
    project_dir,
    concurrency,
    scale,
  } = params;

  if (!composition || typeof composition !== 'string') {
    return { success: false, error: 'composition 必填（在 src/compositions/index.tsx 登记的 id）' };
  }
  if (props !== undefined && (typeof props !== 'object' || props === null || Array.isArray(props))) {
    return { success: false, error: 'props 必须是对象' };
  }
  if (wait_seconds < 5 || wait_seconds > 840) {
    return { success: false, error: 'wait_seconds 必须在 5-840 之间' };
  }

  const projectDir = path.resolve(project_dir || PROJECT_DIR);
  const task = createRenderTask(composition, { props, output_name, title, codec, concurrency, scale });
  const waitMs = Math.max(5, Math.min(840, wait_seconds)) * 1000;

  try {
    _reportTaskProgress(task, 2, 'preparing', '准备工作区项目…');
    await ensureProject(projectDir, (p, text) => _reportTaskProgress(task, p, 'preparing', text));

    // 2026-09-07 P0: 合成物预检——未登记直接失败并带回项目路径+可用清单,
    // 智能体一跳自愈(实测: 模型不知道工作区路径, 盲搜到超时)。
    const availableCompositions = _listCompositions(projectDir);
    if (availableCompositions.length > 0 && !availableCompositions.includes(composition)) {
      REMOTION_TASKS.delete(task.id);
      _upsertFailure(task.surfaceId, `合成物未登记：${composition}`,
        `项目 ${projectDir} 中已登记: ${availableCompositions.join(', ')}。请先在 src/compositions/index.tsx 登记后再渲染。`);
      return {
        success: false,
        error: `合成物 "${composition}" 未在项目登记。已登记: [${availableCompositions.join(', ')}]。请先新建组件并在 ${path.join(projectDir, 'src', 'compositions', 'index.tsx')} 的 COMPOSITIONS 数组登记（{ id: "${composition}", component, ...meta }），或改用以上任一已登记 id 渲染。`,
        available_compositions: availableCompositions,
        project_dir: projectDir,
      };
    }

    // 2026-09-07: 登记接线校验——import 名与组件文件实际导出不一致时,
    // 渲染会以难懂的 "durationInFrames is missing" 秒挂(宣传片实测),
    // 这里在打包前静态拦截并给出精确修复指引。
    const wiringIssues = _validateWiring(projectDir);
    if (wiringIssues.length > 0) {
      REMOTION_TASKS.delete(task.id);
      _upsertFailure(task.surfaceId, `合成物登记校验未通过：${composition}`, wiringIssues.join('\n'));
      return {
        success: false,
        error: `合成物登记校验未通过（尚未开始渲染，修复后重试即可）：\n${wiringIssues.map((w) => `- ${w}`).join('\n')}`,
        wiring_issues: wiringIssues,
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
        message: `渲染仍在后台进行（已在任务表，超时上限 15 分钟）。完成后视频卡会自动出现在对话流，也可用 RemotionStatus(task_id="${task.id}") 查询进度。`,
      };
    }

    if (task.status === 'completed') {
      const meta = task.compositionMeta || {};
      return {
        success: true,
        content: `视频渲染完成：**${task.options.title || composition}**\n\n- 输出: ${task.output}\n- 预览: ${task.result.preview_url}\n- 耗时: ${(task.result.duration_ms / 1000).toFixed(1)}s${meta.durationInFrames ? `\n- 规格: ${meta.width}x${meta.height} @${meta.fps}fps, ${meta.durationInFrames} 帧` : ''}\n\n视频卡已自动展示；如需发送到飞书/企微，用 SendLarkFile / SendWecomFile（注意 30MB 上限）。`,
        task_id: task.id,
        video_path: task.output,
        preview_url: task.result.preview_url,
        duration_ms: task.result.duration_ms,
        composition_meta: meta,
        message: '视频渲染完成',
      };
    }
    return { success: false, error: task.error || '渲染失败', task_id: task.id };
  } catch (e) {
    _finalizeFailure(task, redactText(e.message) || String(e));
    return { success: false, error: `渲染错误: ${redactText(e.message) || String(e)}`, task_id: task.id };
  }
}

async function handleRemotionStatus(params, _context) {
  const { task_id } = params || {};
  if (task_id) {
    const task = REMOTION_TASKS.get(task_id);
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
  const recent = Array.from(REMOTION_TASKS.values())
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
  // 2026-09-07 P0: 无任务时带回项目路径+已登记合成物——迷路的智能体一跳自愈
  const projectDir = path.resolve(PROJECT_DIR);
  return {
    success: true,
    recent_tasks: recent,
    project_dir: projectDir,
    available_compositions: _listCompositions(projectDir),
    message: `最近 ${recent.length} 个渲染任务`,
  };
}

// ── 注册 ────────────────────────────────────────────────────
registry.register({
  name: 'RemotionRender',
  toolset: 'media',
  category: 'media',
  description: 'Render a Remotion composition (React code) into an MP4 video — code-driven video generation for data videos, intros, subtitle videos, product demos and templated motion graphics. Workspace project (auto-scaffolded on first use) lives at data/.crabpaw/workspace/remotion under the agent workspace; add a composition component + register it in src/compositions/index.tsx, then render by its id. Unknown or unregistered composition ids fail fast with the list of registered ids.',
  schema: {
    type: 'object',
    properties: {
      composition: { type: 'string', description: '合成物 id（在 src/compositions/index.tsx 登记的 id）' },
      props: { type: 'object', description: '传入合成物的输入属性（inputProps）' },
      output_name: { type: 'string', description: '输出文件名（不含扩展名，默认用 composition id）' },
      title: { type: 'string', description: '视频卡标题' },
      codec: { type: 'string', enum: ['h264', 'h265', 'vp8', 'vp9', 'gif'], description: '编码格式，默认 h264' },
      wait_seconds: { type: 'integer', minimum: 5, maximum: 840, description: '同步等待秒数（默认 90）。超时后任务转后台，完成后视频卡自动出现' },
      project_dir: { type: 'string', description: 'Remotion 项目目录（默认工作区 remotion 项目）' },
      concurrency: { type: 'integer', minimum: 1, description: '渲染并发数（默认自动）' },
      scale: { type: 'number', description: '分辨率缩放系数（如 0.5 减半）' },
    },
    required: ['composition'],
    additionalProperties: false,
  },
  handler: handleRemotionRender,
  timeout: 900000,
  whenNotToUse: ['AI 创意实拍画面生成时用 VideoGenerate', '只是播放已有视频时用 SceneMedia', 'Remotion 项目里没有对应合成物时（先写组件并登记）'],
  riskLevel: 'medium',
});

registry.register({
  name: 'RemotionStatus',
  toolset: 'media',
  category: 'media',
  description: 'Check Remotion render task status — pass task_id for one task, or no args for the 10 most recent tasks PLUS the workspace project absolute path (project_dir) and registered composition ids (available_compositions). Call this first when unsure where the project lives.',
  schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'RemotionRender 返回的任务 id（缺省则列出最近任务）' },
    },
    additionalProperties: false,
  },
  handler: handleRemotionStatus,
  timeout: 10000,
  whenNotToUse: ['渲染已同步完成（RemotionRender 直接返回结果）时'],
  riskLevel: 'low',
});

console.log('✅ Remotion 视频渲染工具已注册（RemotionRender / RemotionStatus）');

module.exports = {
  handleRemotionRender,
  handleRemotionStatus,
  REMOTION_TASKS,
  PROJECT_DIR,
  ensureProject,
  _buildScaffold,
  _buildScaffoldFiles: _buildScaffold,
  _listCompositions,
  _validateWiring,
  _buildSteps,
  _localFileUrl,
  stopTaskCleanup,
};
