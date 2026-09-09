/**
 * dev-all.js — 一键重启开发环境（后端 + GUI）
 *
 * 1. 杀掉旧后端 (port 38767)
 * 2. 杀掉旧 Vite (port 5173/5174)
 * 3. 杀掉所有 Electron 窗口
 * 4. 启动后端
 * 5. 启动 GUI (Vite + Electron)
 *
 * 用法: node scripts/dev-all.js
 */
const { execSync, spawn } = require('child_process');
const path = require('path');

const BACKEND_PORT = '38767';
const GUI_DIR = path.join(__dirname, '..', 'gui');

function exec(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000, windowsHide: true, ...opts });
  } catch { return '' }
}

function findPidOnPort(port) {
  const out = exec(`netstat -ano | findstr ":${port}" | findstr LISTEN`);
  if (!out.trim()) return null;
  const pid = out.trim().split(/\s+/).pop();
  return pid ? parseInt(pid, 10) : null;
}

function killPid(pid) {
  exec(`taskkill /pid ${pid} /f`);
}

function waitPortFree(port, maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const pid = findPidOnPort(port);
    if (!pid) return true;
    killPid(pid);
    exec('ping 127.0.0.1 -n 2 > nul');
  }
  return !findPidOnPort(port);
}

console.log('='.repeat(50));
console.log('  CrabPaw Dev Environment — 一键重启');
console.log('='.repeat(50));

// 1. 清理后端
console.log('\n🔧 清理后端...');
const bp = findPidOnPort(BACKEND_PORT);
if (bp) { killPid(bp); console.log(`  → 旧后端 PID ${bp} 已终止`); }

// 2. 清理 GUI
console.log('\n🔧 清理 GUI...');
exec('taskkill /f /im electron.exe 2>nul');
exec(`taskkill /f /fi "WINDOWTITLE eq vite*" 2>nul`);
for (const p of [5173, 5174]) {
  const pid = findPidOnPort(p);
  if (pid) { killPid(pid); console.log(`  → Vite(PID ${pid}) 端口 ${p} 已释放`); }
}
console.log('  → Electron 窗口已关闭');

// 3. 确认端口空闲
console.log('\n⏳ 等待端口释放...');
if (!waitPortFree(BACKEND_PORT)) {
  console.error(`❌ 后端端口 ${BACKEND_PORT} 无法释放`);
  process.exit(1);
}
for (const p of [5173, 5174]) {
  waitPortFree(p, 3000);
}
console.log('  ✅ 所有端口已释放');

// 4. 启动后端
console.log('\n🚀 启动后端...');
const backend = spawn('node', [path.join(__dirname, '..', 'src', 'cli', 'index.js'), 'start'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env, PORT: BACKEND_PORT },
});
backend.stdout.on('data', d => process.stdout.write('[backend] ' + d));
backend.stderr.on('data', d => process.stderr.write('[backend] ' + d));
backend.on('exit', code => console.log(`[backend] 退出 (code=${code})`));

// 等待后端就绪
console.log('  ⏳ 等待后端就绪...');
let backendReady = false;
for (let i = 0; i < 20; i++) {
  try {
    const r = execSync('curl -s http://localhost:' + BACKEND_PORT + '/health 2>nul || echo fail', { timeout: 2000 });
    if (r.includes('"status":"ok"')) { backendReady = true; break; }
  } catch {}
  exec('ping 127.0.0.1 -n 2 > nul');  // ~1s
}
if (backendReady) {
  console.log('  ✅ 后端就绪 (port ' + BACKEND_PORT + ')');
} else {
  console.error('  ❌ 后端启动超时');
  process.exit(1);
}

// 5. 启动 GUI
console.log('\n🚀 启动 GUI...');
// 2026-08-12: 剔除 ELECTRON_RUN_AS_NODE——若用户环境设置了该变量(常见于其他
// 工具链),electron.exe 会以纯 Node 模式运行,require('electron') 返回路径字符串
// → main 进程 electron.app undefined 崩溃("Cannot read properties of undefined")
const guiEnv = { ...process.env, PORT: BACKEND_PORT };
delete guiEnv.ELECTRON_RUN_AS_NODE;
const gui = spawn('npm.cmd', ['run', 'electron:dev'], {
  cwd: GUI_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  shell: true,
  env: guiEnv,
});
gui.stdout.on('data', d => process.stdout.write('[gui] ' + d));
gui.stderr.on('data', d => process.stderr.write('[gui] ' + d));
gui.on('exit', code => console.log(`[gui] 退出 (code=${code})`));

console.log('\n' + '='.repeat(50));
console.log('  ✅ 全部就绪！');
console.log('  🌐 后端: http://localhost:' + BACKEND_PORT);
console.log('  🖥️  GUI:  http://localhost:5173');
console.log('  🪟 Electron 窗口即将弹出');
console.log('='.repeat(50));
console.log('  按 Ctrl+C 停止所有服务\n');

// 优雅退出
process.on('SIGINT', () => {
  console.log('\n🛑 正在停止...');
  backend.kill('SIGINT');
  gui.kill('SIGTERM');
  exec('taskkill /f /im electron.exe 2>nul');
  setTimeout(() => process.exit(0), 1000);
});
