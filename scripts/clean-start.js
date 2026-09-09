/**
 * clean-start.js — 启动后端前清理旧端口进程
 *
 * 解决 Windows 下 `node --watch` / 旧进程残留导致代码变更不生效的问题。
 * 每次启动前自动杀掉占用 38767 端口的旧进程，确保新代码被加载。
 */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || '38767';
const SERVER_SCRIPT = path.join(__dirname, '..', 'src', 'cli', 'index.js');

// --watch 标志：用 node --watch-path 模式启动（只监视 src/ 与 skills/ 源码目录）
// 注意：不能裸用 `node --watch`——它监视整个模块图，服务运行期写入被 require 的
// 数据文件（config.json 等）会触发无限重启循环，每次重启都会断开全部 WS 连接
// （语音 ASR 会话因此反复断连）。--watch-path 限定范围后数据写入不再触发重启。
const useWatch = process.argv.includes('--watch');
const WATCH_PATHS = [
  path.join(__dirname, '..', 'src'),
  path.join(__dirname, '..', 'skills'),
];

function findPidOnPort(port) {
  try {
    const output = execSync(`netstat -ano | findstr ":${port}" | findstr LISTEN`, {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (!output) return null;
    // 逐行解析，只取 LISTENING 行的行尾 PID（防御：多行输出/行尾空格/GBK 解码错位）
    const lines = String(output).split(/\r?\n/).filter((l) => l.includes('LISTENING'));
    for (const line of lines) {
      const m = line.match(/(\d+)\s*$/);
      if (m) {
        const pid = parseInt(m[1], 10);
        // 防御系统进程（Windows 用户进程 PID 通常 > 1000）——绝不误杀 System 等
        if (pid > 100) return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    const output = execSync(`tasklist /FI "PID eq ${pid}"`, { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    return output.includes(String(pid));
  } catch (e) {
    return false;
  }
}

// 优雅终止：先发温和信号（不带 /F），等待 3 秒，未退出再强杀
// 注意：不打印 err.message——Windows 中文系统的 taskkill 错误是 GBK 编码，
// 按 UTF-8 显示会成乱码；用固定文案 + 状态码替代。
function killPid(pid) {
  try {
    execSync(`taskkill /pid ${pid}`, { timeout: 3000, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    console.log(`  📨 已发送优雅终止信号 (PID ${pid})`);
  } catch (e) {
    console.warn(`  ⚠️  优雅终止信号发送失败（进程可能已退出）: taskkill 退出码 ${e.status ?? '未知'}`);
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      console.log(`  ✅ 旧进程已优雅退出 (PID ${pid})`);
      return true;
    }
    require('child_process').execSync('ping 127.0.0.1 -n 2 > nul', { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  }
  if (!isPidAlive(pid)) {
    console.log(`  ✅ 旧进程已优雅退出 (PID ${pid})`);
    return true;
  }
  try {
    execSync(`taskkill /pid ${pid} /f`, { timeout: 3000, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    console.log(`  ✅ 已强制终止旧进程 (PID ${pid})`);
    return true;
  } catch (e) {
    console.warn(`  ⚠️  强杀 PID ${pid} 失败: taskkill 退出码 ${e.status ?? '未知'}`);
    return false;
  }
}

// 清理单实例锁文件（与 server.js 的 .instance.lock 对应）
function cleanupLockFile() {
  const lockPath = path.join(
    process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', 'data', '.crabpaw'),
    '.instance.lock'
  );
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
      console.log(`  🗑️  已清理单实例锁文件: ${lockPath}`);
    }
  } catch (e) {
    console.warn(`  ⚠️  清理锁文件失败: ${e.message}`);
  }
}

function waitForPortFree(port, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const pid = findPidOnPort(port);
    if (!pid) return true;
    killPid(pid);
    // 给 OS 一点时间释放端口
    require('child_process').execSync('ping 127.0.0.1 -n 2 > nul', { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  }
  // 最后一次检查
  return !findPidOnPort(port);
}

// ── 主流程 ──
console.log(`\n🔧 清理端口 ${PORT}...`);
const oldPid = findPidOnPort(PORT);
if (oldPid) {
  console.log(`  ⚠️  发现旧进程 PID ${oldPid}，正在终止...`);
  killPid(oldPid);
  if (waitForPortFree(PORT)) {
    console.log(`  ✅ 端口 ${PORT} 已释放`);
  } else {
    console.warn(`  ⚠️  端口 ${PORT} 仍在占用，5s 后重试...`);
    if (!waitForPortFree(PORT, 5000)) {
      console.error(`  ❌ 无法释放端口 ${PORT}，请手动检查`);
      process.exit(1);
    }
  }
} else {
  console.log(`  ✅ 端口 ${PORT} 未被占用`);
}

// 无论端口是否被占用，都清理可能残留的单实例锁文件
cleanupLockFile();

// ── 服务器启动与自定义 watcher ─────────────────────────────
// 不用 node --watch/--watch-path：两者都监视数据文件写入（AI 交互会把
// pattern-learner.json 等 JSON 写在 src/ 内），触发无限重启循环、反复断开
// WS 连接。自定义 fs.watch 只对源码扩展名变更重启，数据写入完全忽略。
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx']);
let child = null;
let restartTimer = null;
let stopping = false;

function spawnServer() {
  // 陈旧锁自动清理：watch 重启不经过主流程的 cleanupLockFile，而其他实例
  // （并行会话）退出后常留陈旧 .instance.lock → 服务器启动被挡（实测多次
  // "已有 CrabPaw 实例在运行" 且锁 PID 已死）。仅在锁 PID 确认已退出时删除。
  try {
    const lockPath = path.join(
      process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', 'data', '.crabpaw'),
      '.instance.lock'
    );
    if (fs.existsSync(lockPath)) {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (lock.pid && !isPidAlive(lock.pid)) {
        fs.unlinkSync(lockPath);
        console.log(`  🗑️  陈旧锁已清理 (PID ${lock.pid} 已退出)`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠️ 锁检查失败: ${err.message}`);
  }
  child = spawn('node', [SERVER_SCRIPT, 'start'], {
    stdio: 'inherit',
    env: { ...process.env, PORT },
    windowsHide: true,
  });
  child.on('error', (err) => {
    console.error('❌ 启动失败:', err.message);
    if (!stopping) process.exit(1);
  });
  child.on('exit', (code) => {
    if (stopping) return; // 主动停止时不再跟随退出
    console.log(`\n📴 服务器退出 (code=${code})，等待源码变更后重启...`);
    child = null;
  });
  return child;
}

function scheduleRestart() {
  if (restartTimer || stopping) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (stopping) return;
    console.log('\n🔁 检测到源码变更，重启服务器...');
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* 进程可能已退出 */ }
    }
    setTimeout(() => {
      if (stopping) return;
      spawnServer();
    }, 300);
  }, 500); // 防抖：连续文件事件合并为一次重启
}

// 源码变更检测——轮询 mtime 快照（不用 fs.watch：Windows 上递归 watch 对
// 文件打开/读取产生大量伪事件，服务器启动 require 文件时触发无限重启循环。
// 轮询纯 mtime 对比，绝无伪事件；src 约 600 文件每 2s stat 一次，开销 <10ms）。
const POLL_INTERVAL_MS = 2000;
let sourceSnapshot = new Map(); // filePath -> mtimeMs

function collectSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过 node_modules / 构建产物
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-electron') continue;
      collectSourceFiles(full, out);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function buildSnapshot() {
  const snap = new Map();
  for (const dir of WATCH_PATHS) {
    for (const file of collectSourceFiles(dir)) {
      try {
        snap.set(file, fs.statSync(file).mtimeMs);
      } catch { /* 文件被删/占用，跳过 */ }
    }
  }
  return snap;
}

function startSourceWatcher() {
  sourceSnapshot = buildSnapshot();
  console.log(`  👀 已监视源码: ${WATCH_PATHS.join(', ')} (轮询 ${POLL_INTERVAL_MS}ms, 仅 .js/.ts 变更重启)`);
  const timer = setInterval(() => {
    if (stopping) return;
    const fresh = buildSnapshot();
    const changed = [];
    // 新增/修改
    for (const [file, mtime] of fresh) {
      const prev = sourceSnapshot.get(file);
      if (prev === undefined || prev !== mtime) changed.push(file);
    }
    // 删除
    for (const file of sourceSnapshot.keys()) {
      if (!fresh.has(file)) changed.push(file);
    }
    sourceSnapshot = fresh;
    if (changed.length > 0) {
      console.log(`  👀 源码变更: ${changed.slice(0, 5).map((f) => path.relative(process.cwd(), f)).join(', ')}${changed.length > 5 ? ` 等 ${changed.length} 个` : ''}`);
      scheduleRestart();
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}

// 启动服务器
console.log(`\n🚀 启动 CrabPaw 服务器 (PORT=${PORT})${useWatch ? ' [watch 模式]' : ''}...\n`);
let sourceWatcherTimer = null;
if (useWatch) {
  sourceWatcherTimer = startSourceWatcher();
}
child = spawnServer();

// 处理 SIGINT/SIGTERM 优雅退出
function shutdown() {
  stopping = true;
  if (sourceWatcherTimer) { clearInterval(sourceWatcherTimer); sourceWatcherTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) child.kill('SIGINT');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
