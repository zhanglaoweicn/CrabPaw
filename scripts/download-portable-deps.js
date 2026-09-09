/**
 * Download portable dependencies for USB build.
 * 1. CloakBrowser binary (~400MB) to data/cloakbrowser/ —— 仅开发机预下载;
 *    2026-09-08 许可合规: BINARY-LICENSE.md 禁止再分发二进制, 发行 zip 不捆绑,
 *    客户机由 browser-control 首次浏览器任务后台从官方渠道下载(依赖声明模式豁免)
 * 2. Python embeddable (~30MB) to portable/python/
 * 3. pip bootstrap (get-pip.py, ~15MB) into portable/python —— 技能 pip 依赖运行时安装的前提
 * 4. Node.js runtime node.exe (~30MB) to gui/resources/ (release 主进程 spawn 后端用,
 *    gui/package.json extraResources 打包,git 已忽略,必须在此下载)
 * 5. npm CLI (~20MB, node 发行版内自带) to gui/resources/npm —— 运行时技能依赖安装
 *    (portable-deps.installNpmDeps)与 Remotion 拉包的前提;此前只留 node.exe 导致
 *    便携版运行时自装依赖必挂(2026-09-08 全内置发行决策)
 * 6. ffmpeg essentials (~85MB, ffmpeg.exe+ffprobe.exe) to portable/ffmpeg —— VideoEdit
 *    工具与 Electron 主进程 TTS 解码的前提
 * (2026-09-08 修订: 移除便携 Chromium 下载——派车链里它排在 CloakBrowser/系统 Chrome/
 *  系统 Edge 之后第 4 位, Windows 上 Edge 恒在, 644MB 近乎死重; 隐身需求由 CloakBrowser 覆盖)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const { proxyWrap } = require('./portable-lib');

// 2026-08-25 USB 版设计 §5: gh-proxy 加速(可选)——build-portable.ps1 以
// -UseGhProxy 时导出 CRABPAW_GH_PROXY=1。设自定义 URL 后 cloakbrowser 包会
// 跳过校验和(包自身行为, download.js:60/313);二进制落入缓存后幂等,不再复下载。
if (process.env.CRABPAW_GH_PROXY === '1' && !process.env.CLOAKBROWSER_DOWNLOAD_URL) {
  process.env.CLOAKBROWSER_DOWNLOAD_URL = proxyWrap('https://github.com/CloakHQ/cloakbrowser/releases/download');
  console.log('[PROXY] CloakBrowser 下载走 gh-proxy 前缀');
}

const ROOT = path.join(__dirname, '..');
const CLOAKBROWSER_DIR = path.join(ROOT, 'data', 'cloakbrowser');
const PYTHON_DIR = path.join(ROOT, 'portable', 'python');
const FFMPEG_DIR = path.join(ROOT, 'portable', 'ffmpeg');
const NODE_EXE_DIR = path.join(ROOT, 'gui', 'resources');
const NODE_EXE_PATH = path.join(NODE_EXE_DIR, 'node.exe');
const NPM_CLI_PATH = path.join(NODE_EXE_DIR, 'npm', 'bin', 'npm-cli.js');

const PYTHON_URL = 'https://www.python.org/ftp/python/3.12.5/python-3.12.5-embed-amd64.zip';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
// 2026-08-19 发行审计 S2: 内置运行时从 v20.19.0 改为 v24.13.0——better-sqlite3
// v12.10.0 无 node-v115(node 20)官方 prebuild, 本机无 VS 无法本地编译, ABI 137 vs 115
// 分叉导致打包版后端启动即崩。node 24 与开发机一致, better-sqlite3 走官方
// node-v127 prebuild, 零编译。换版本时同步更新此处。
const NODE_VERSION = 'v24.13.0';
const NODE_ZIP_FOLDER = `node-${NODE_VERSION}-win-x64`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP_FOLDER}.zip`;
// ffmpeg essentials(gyan.dev, 静态构建): 含 ffmpeg.exe + ffprobe.exe, 免系统安装
const FFMPEG_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

async function downloadFile(url, dest) {
  const file = fs.createWriteStream(dest);
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', err => { file.close(); fs.unlinkSync(dest); reject(err); });
    }).on('error', err => { file.close(); fs.unlinkSync(dest); reject(err); });
  });
}

async function ensureCloakBrowser() {
  process.env.CLOAKBROWSER_CACHE_DIR = CLOAKBROWSER_DIR;
  fs.mkdirSync(CLOAKBROWSER_DIR, { recursive: true });

  const cb = await import('cloakbrowser');
  const info = cb.binaryInfo();

  if (info.installed && fs.existsSync(info.binaryPath)) {
    console.log(`[OK] CloakBrowser already cached: ${info.binaryPath}`);
    return;
  }

  console.log(`[DL] Downloading CloakBrowser to ${CLOAKBROWSER_DIR} (~400MB)...`);
  await cb.ensureBinary();
  console.log('[OK] CloakBrowser download complete');
}

async function ensurePython() {
  const zipPath = path.join(PYTHON_DIR, 'python-embed.zip');
  const pythonExe = path.join(PYTHON_DIR, 'python.exe');

  if (fs.existsSync(pythonExe)) {
    console.log(`[OK] Python already extracted: ${pythonExe}`);
    return;
  }

  fs.mkdirSync(PYTHON_DIR, { recursive: true });

  if (!fs.existsSync(zipPath)) {
    console.log(`[DL] Downloading Python embeddable from ${PYTHON_URL}`);
    await downloadFile(PYTHON_URL, zipPath);
    console.log('[OK] Python download complete');
  }

  console.log('[EX] Extracting Python...');
  // 2026-08-29: extract-zip 全版本 zip-slip 无上游补丁——统一改 safeExtractZip
  const { safeExtractZip } = require('../src/core/safe-zip');
  await safeExtractZip(zipPath, PYTHON_DIR);
  fs.unlinkSync(zipPath);

  const pthFile = path.join(PYTHON_DIR, 'python312._pth');
  if (fs.existsSync(pthFile)) {
    let content = fs.readFileSync(pthFile, 'utf-8');
    content = content.replace(/^#import site/m, 'import site');
    fs.writeFileSync(pthFile, content, 'utf-8');
    console.log('[OK] Enabled import site in python312._pth');
  }

  console.log(`[OK] Python ready: ${pythonExe}`);
}

/**
 * pip 引导(2026-09-08 全内置): embeddable Python 默认无 pip,技能 pip 依赖
 * (portable-deps.installPipDeps 的 `python -m pip install`)在便携机上必挂。
 * --no-compile + PYTHONDONTWRITEBYTECODE 防字节码落地(洁净度门禁违禁项);
 * pip 被 import 时仍会写 __pycache__(解释器副作用), 引导后再统一清扫兜底。
 */
function sweepPycache(rootDir) {
  let swept = 0;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (st.isDirectory()) {
        if (name === '__pycache__') { fs.rmSync(p, { recursive: true, force: true }); swept++; continue; }
        walk(p);
      } else if (name.endsWith('.pyc')) {
        fs.unlinkSync(p);
        swept++;
      }
    }
  };
  walk(rootDir);
  if (swept > 0) console.log(`[OK] swept ${swept} pycache/pyc entries under ${rootDir}`);
}

async function ensurePip() {
  const pythonExe = path.join(PYTHON_DIR, 'python.exe');
  if (!fs.existsSync(pythonExe)) {
    throw new Error('python.exe 未就绪——pip 引导依赖 Python 先解压');
  }
  const pipPkgDir = path.join(PYTHON_DIR, 'Lib', 'site-packages', 'pip');
  if (fs.existsSync(pipPkgDir)) {
    console.log(`[OK] pip already bootstrapped: ${pipPkgDir}`);
    sweepPycache(path.join(PYTHON_DIR, 'Lib', 'site-packages'));
    return;
  }

  const getpipPath = path.join(PYTHON_DIR, 'get-pip.py');
  if (!fs.existsSync(getpipPath)) {
    console.log(`[DL] Downloading get-pip.py from ${GET_PIP_URL}`);
    await downloadFile(GET_PIP_URL, getpipPath);
  }

  console.log('[EX] Bootstrapping pip into portable/python...');
  const noBytecodeEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  execSync(`"${pythonExe}" "${getpipPath}" --no-compile --no-warn-script-location --quiet`, {
    stdio: 'inherit',
    timeout: 300000,
    windowsHide: true,
    env: noBytecodeEnv,
  });
  // 验证可被 `-m pip` 调用(installPipDeps 只用这一种形式)
  execSync(`"${pythonExe}" -m pip --version`, { stdio: 'inherit', timeout: 30000, windowsHide: true, env: noBytecodeEnv });
  fs.unlinkSync(getpipPath);
  sweepPycache(path.join(PYTHON_DIR, 'Lib', 'site-packages'));
  console.log('[OK] pip ready (python -m pip)');
}

async function ensureNodeExe() {
  // 幂等:已存在则跳过(CI 缓存命中时零下载)
  if (fs.existsSync(NODE_EXE_PATH)) {
    console.log(`[OK] node.exe already present: ${NODE_EXE_PATH}`);
    return;
  }

  fs.mkdirSync(NODE_EXE_DIR, { recursive: true });
  const zipPath = await fetchNodeDistZip();

  console.log('[EX] Extracting node.exe...');
  const { safeExtractZip } = require('../src/core/safe-zip');
  // node 发行版 2721 条目, 超默认防炸弹上限(2000); 版本锁定的官方可信源, 放宽即可
  await safeExtractZip(zipPath, NODE_EXE_DIR, { maxEntries: 5000 });
  fs.unlinkSync(zipPath);

  const extractedExe = path.join(NODE_EXE_DIR, NODE_ZIP_FOLDER, 'node.exe');
  if (!fs.existsSync(extractedExe)) {
    throw new Error(`node.exe not found after extraction: ${extractedExe}`);
  }
  fs.renameSync(extractedExe, NODE_EXE_PATH);
  if (!fs.existsSync(extractedExe)) {
    throw new Error(`node.exe not found after extraction: ${extractedExe}`);
  }
  fs.renameSync(extractedExe, NODE_EXE_PATH);

  console.log(`[OK] node.exe ready: ${NODE_EXE_PATH}`);
}

/** 取 node 发行版 zip(带缓存);ensureNpmCli 在 node.exe 已存在但 npm 缺失时也用它 */
async function fetchNodeDistZip() {
  fs.mkdirSync(NODE_EXE_DIR, { recursive: true });
  const zipPath = path.join(NODE_EXE_DIR, `${NODE_ZIP_FOLDER}.zip`);
  if (!fs.existsSync(zipPath)) {
    console.log(`[DL] Downloading Node.js from ${NODE_URL} (~30MB)...`);
    await downloadFile(NODE_URL, zipPath);
    console.log('[OK] Node.js download complete');
  }
  return zipPath;
}

/**
 * npm CLI(2026-09-08 全内置): node 发行版自带 npm(纯 JS)。拷出 npm 包本体 +
 * 写 npm.cmd/npx.cmd 垫片(经捆绑 node.exe 解释),gui/package.json extraResources
 * 打包进 resources/,后端 spawn env 的 PATH 前置后 `npm install` 即可用。
 */
async function ensureNpmCli() {
  if (fs.existsSync(NPM_CLI_PATH)) {
    console.log(`[OK] npm already present: ${NPM_CLI_PATH}`);
    return;
  }

  const zipPath = await fetchNodeDistZip();
  const { safeExtractZip } = require('../src/core/safe-zip');
  if (!fs.existsSync(path.join(NODE_EXE_DIR, NODE_ZIP_FOLDER, 'node.exe'))) {
    console.log('[EX] Extracting node dist (for npm package)...');
    await safeExtractZip(zipPath, NODE_EXE_DIR, { maxEntries: 5000 });
  }
  const distNpm = path.join(NODE_EXE_DIR, NODE_ZIP_FOLDER, 'node_modules', 'npm');
  if (!fs.existsSync(path.join(distNpm, 'bin', 'npm-cli.js'))) {
    throw new Error(`npm package not found in node dist: ${distNpm}`);
  }
  fs.cpSync(distNpm, path.join(NODE_EXE_DIR, 'npm'), { recursive: true });

  // 垫片放在 node.exe 同目录(%~dp0),由 spawn env PATH 前置解析
  const shims = {
    'npm.cmd': '@ECHO OFF\r\n"%~dp0node.exe" "%~dp0npm\\bin\\npm-cli.js" %*\r\n',
    'npx.cmd': '@ECHO OFF\r\n"%~dp0node.exe" "%~dp0npm\\bin\\npx-cli.js" %*\r\n',
  };
  for (const [name, content] of Object.entries(shims)) {
    fs.writeFileSync(path.join(NODE_EXE_DIR, name), content, 'utf-8');
  }

  // 清理解压目录(node.exe 已由 ensureNodeExe 单独落位)
  fs.rmSync(path.join(NODE_EXE_DIR, NODE_ZIP_FOLDER), { recursive: true, force: true });
  console.log(`[OK] npm CLI ready: ${NPM_CLI_PATH}`);
}

/**
 * ffmpeg(2026-09-08 全内置): VideoEdit 工具(src/tools/video-tools.js)与 Electron
 * 主进程 TTS 解码(MP3→WAV)均裸调 ffmpeg——目标机无系统 ffmpeg 时语音播报/视频
 * 编辑静默失效。essentials 构建静态链接,只取 bin 下两个 exe。
 */
async function ensureFfmpeg() {
  const ffmpegExe = path.join(FFMPEG_DIR, 'bin', 'ffmpeg.exe');
  if (fs.existsSync(ffmpegExe)) {
    console.log(`[OK] ffmpeg already present: ${ffmpegExe}`);
    return;
  }

  fs.mkdirSync(FFMPEG_DIR, { recursive: true });
  const zipPath = path.join(FFMPEG_DIR, 'ffmpeg-essentials.zip');
  console.log(`[DL] Downloading ffmpeg essentials from ${FFMPEG_URL} (~85MB)...`);
  await downloadFile(FFMPEG_URL, zipPath);

  const tmpDir = path.join(FFMPEG_DIR, 'tmp');
  const { safeExtractZip } = require('../src/core/safe-zip');
  await safeExtractZip(zipPath, tmpDir);
  fs.unlinkSync(zipPath);

  // zip 内是 ffmpeg-<ver>-essentials_build/bin/ffmpeg.exe,版本号动态匹配
  const buildDir = fs.readdirSync(tmpDir).find(d =>
    fs.existsSync(path.join(tmpDir, d, 'bin', 'ffmpeg.exe')));
  if (!buildDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('ffmpeg.exe not found in essentials zip');
  }
  fs.mkdirSync(path.join(FFMPEG_DIR, 'bin'), { recursive: true });
  for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
    fs.copyFileSync(path.join(tmpDir, buildDir, 'bin', exe), path.join(FFMPEG_DIR, 'bin', exe));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[OK] ffmpeg ready: ${ffmpegExe}`);
}

/**
 * Playwright Chromium 已于 2026-09-08 剔除(用户决策): 派车链第 4 位 + Windows Edge 恒在
 * → 发行包 644MB 死重; 隐身/风控需求由 CloakBrowser 覆盖。如需恢复, 见 git 历史。
 */

async function main() {
  console.log('=== CrabPaw Portable Dependencies Downloader ===\n');

  // 2026-08-19 发行审计 W9: 此前三项 try/catch 吞错且 exit 0, 下载失败被推迟到
  // electron-builder 阶段以难懂形式爆发。改为 fail-fast: 任一失败非零退出。
  const failures = [];
  const steps = [
    ['CloakBrowser', ensureCloakBrowser],
    ['Python', ensurePython],
    ['pip', ensurePip],
    ['node.exe', ensureNodeExe],
    ['npm CLI', ensureNpmCli],
    ['ffmpeg', ensureFfmpeg],
  ];
  for (const [name, fn] of steps) {
    try { await fn(); }
    catch (e) { console.error(`[FAIL] ${name}:`, e.message); failures.push(name); }
  }

  if (failures.length > 0) {
    console.error(`\n[ERROR] ${failures.length} 项依赖下载失败: ${failures.join(', ')}。` +
      '请修复网络/环境后重试——打包流程需要全部依赖就绪。');
    process.exit(1);
  }

  console.log('\n=== Done ===');
  console.log(`CloakBrowser:      ${CLOAKBROWSER_DIR} (仅开发机; 发行 zip 不捆绑, 客户机首次浏览器任务经官方渠道下载)`);
  console.log(`Python + pip:      ${PYTHON_DIR}`);
  console.log(`node.exe + npm:    ${NODE_EXE_DIR}`);
  console.log(`ffmpeg/ffprobe:    ${path.join(FFMPEG_DIR, 'bin')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
