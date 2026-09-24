/**
 * CLI 命令 - 服务器管理
 *
 * 2026-09-23: 此前 handleStopCommand / handleRestartCommand 是空壳——只打印一行然后
 * process.exit(0)，退出的是 CLI 自己，服务照跑。也就是说这个项目没有可用的停服手段。
 * 更麻烦的是 Process Watchdog 是独立进程（autoRestart=true，每 10s 查心跳、连续 3 次
 * 缺失即重启后端）：即使手工杀掉服务，约 30 秒后它也会被守护重新拉起来。
 * （守护侧同时修了两处：server.js 的 shutdown() 与 /shutdown 端点现在都会
 *  stopWatchdog()；ProcessWatchdog.start() 会清理上一轮留下的 stopped 标记。）
 *
 * 真正的停止顺序：
 *   ①探活：GET /health（该端点不需鉴权）判断是否在运行，避免误报
 *   ②先解除守护：写 watchdog/state.json = {status:'stopped'}，让 runner 自行退出。
 *     必须放在停服之前——否则服务刚停就被守护拉回来，等于没停
 *   ③优先优雅停机：POST /shutdown（本机回环 + .api_token）。该端点会排空语音会话、
 *     走 process.exit(0) 让 exit handler 清理单实例锁
 *   ④轮询 /health 直到不再响应；超时则兜底强杀（pid 取自 .instance.lock，缺失时从
 *     netstat 反查监听该端口的进程）
 *   ⑤回报实际走了哪条路径，并确认端口已释放
 *
 * restart = 停止（同上）后**重新拉起一个 watch 监督器**（与 `npm run dev` 同一条路，
 * 后台运行）。刻意不在本进程内前台顶替服务：那样会丢掉 watch 模式——值班员不在，
 * 此后改后端源码不再自动生效（正是"改了不生效"那类问题的成因）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const { DATA_DIR } = require('../../core/config');

const WATCHDOG_DIR = path.join(DATA_DIR, 'watchdog');
const WATCHDOG_STATE_FILE = path.join(WATCHDOG_DIR, 'state.json');
const LOCK_FILE = path.join(DATA_DIR, '.instance.lock');
const PORT_FILE = path.join(DATA_DIR, '.api_port');
const TOKEN_FILE = path.join(DATA_DIR, '.api_token');

const DEFAULT_PORT = 38767;

function readText(file) {
  try { return fs.readFileSync(file, 'utf-8').trim(); } catch { return null; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/** 停服目标端口：.api_port（服务实际监听值）→ 环境变量 → 默认值 */
function resolvePort() {
  const fromFile = readText(PORT_FILE);
  const fromEnv = process.env.API_PORT || process.env.PORT;
  const raw = fromFile || fromEnv || DEFAULT_PORT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

/** 服务是否在跑：GET /health（不需鉴权；连不上/超时即视为已停） */
function isServerUp(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * 解除守护。写停止标记后 runner 会在下一次巡检(≤10s)自行退出。
 * 不写的话服务被关掉也会被守护重新拉起——这正是"停服务"失效的根因。
 */
function disarmWatchdog() {
  try {
    fs.mkdirSync(WATCHDOG_DIR, { recursive: true });
    fs.writeFileSync(
      WATCHDOG_STATE_FILE,
      JSON.stringify({ status: 'stopped', stoppedAt: Date.now() }, null, 2),
      'utf-8',
    );
    return true;
  } catch (e) {
    console.warn('  ⚠️  写入守护停止标记失败:', e.message);
    return false;
  }
}

/** 请求优雅停机：POST /shutdown（服务端要求本机回环 + 合法 token） */
function requestGracefulShutdown(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const token = readText(TOKEN_FILE) || process.env.ADMIN_API_KEY || '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/shutdown',
        method: 'POST',
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'x-api-key': token },
      },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end('{}');
  });
}

async function waitForDown(port, deadlineMs = 9000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!(await isServerUp(port))) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function waitForUp(port, deadlineMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await isServerUp(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * 拉起一个 watch 监督器（scripts/clean-start.js --watch），脱离本进程后台运行。
 * 与 `npm run dev` 走同一条路，所以行为一致：值班员在岗，改源码即自动重启。
 * 日志追加到系统临时目录，避免用户终端被占住。
 * @returns {boolean} 是否成功派生
 */
function spawnWatchSupervisor() {
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'scripts', 'clean-start.js');
  if (!fs.existsSync(script)) {
    console.error(`  ❌ 未找到监督器脚本: ${script}`);
    return false;
  }
  let out = 'ignore';
  const logPath = path.join(os.tmpdir(), 'crabpaw-backend.log');
  try { out = fs.openSync(logPath, 'a'); } catch { /* 无法写日志则丢弃输出 */ }
  try {
    const child = spawn(process.execPath, [script, '--watch'], {
      cwd: repoRoot,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
      env: { ...process.env },
    });
    child.unref();
    console.log(`  ✅ 已拉起 watch 监督器（日志: ${logPath}）`);
    return true;
  } catch (e) {
    console.error('  ❌ 拉起 watch 监督器失败:', e.message);
    return false;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** 反查监听指定端口的进程 pid（Windows netstat）。仅作兜底，失败返回 null */
function findPidOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number.parseInt(parts[parts.length - 1], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch (e) {
    console.warn('  ⚠️  netstat 反查端口占用失败:', e.message);
  }
  return null;
}

/**
 * 停掉 watch 监督器（scripts/clean-start.js）。
 *
 * 为什么必须停它：watch 模式下监督器会轮询源码 mtime，一有变更就重启服务。
 * 只停服务不停它的话，此后随手改一个后端源码文件，服务就被"复活"了——
 * 那 `stop` 就不是真停。停服语义应是"此后不会有服务在跑"。
 *
 * @returns {number} 实际终止的监督器数量
 */
function killWatchSupervisors() {
  let pids = [];
  try {
    const ps = [
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
      "| Where-Object { $_.CommandLine -like '*clean-start.js*' }",
      '| Select-Object -ExpandProperty ProcessId',
    ].join(' ');
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    pids = out.split(/\r?\n/).map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  } catch (e) {
    console.warn('  ⚠️  查找 watch 监督器失败:', e.message);
    return 0;
  }
  let killed = 0;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); killed += 1; } catch { /* 可能已退出 */ }
  }
  return killed;
}

// eslint-disable-next-line no-unused-vars -- ctx 参数未使用，保留签名以兼容 CLI 调用
async function handleStartCommand(args, ctx) {
  const { startServer } = require('../server');
  await startServer(ctx);
}

/**
 * 停服核心逻辑（可被 stop / restart 复用）。
 * @returns {Promise<boolean>} true = 已停（或本就没在运行）；false = 停不下来
 */
async function stopServer() {
  const port = resolvePort();
  console.log(`🛑 停止服务器 (端口 ${port})...`);

  const wasUp = await isServerUp(port);

  if (!wasUp) {
    // 服务没在跑，但监督器/守护可能还在——它们会让服务复活。一并收掉。
    const n = killWatchSupervisors();
    disarmWatchdog();
    console.log(n > 0
      ? `  ✅ 已停止 watch 监督器 ×${n}（服务本就未在运行）`
      : 'ℹ️  服务未在运行（已顺带解除可能残留的守护）');
    return true;
  }

  // 先解除守护：否则服务刚停就被 watchdog 拉回来（心跳丢失即重启）。
  const disarmed = disarmWatchdog();
  console.log(disarmed ? '  ✅ 守护已解除' : '  ⚠️  守护解除失败（服务仍会停，但可能被拉起）');

  const graceful = await requestGracefulShutdown(port);
  console.log(graceful ? '  ✅ 已请求优雅停机' : '  ⚠️  优雅停机请求未成功，尝试直接终止');

  let down = await waitForDown(port);

  if (!down) {
    // 兜底：强杀。pid 优先取单实例锁，缺失/失效时从端口反查
    const lock = readJson(LOCK_FILE);
    let pid = lock && Number.isFinite(lock.pid) ? lock.pid : null;
    if (!pid || !pidAlive(pid)) pid = findPidOnPort(port);

    if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
        console.log(`  ⚠️  优雅停机超时，已强制终止 PID ${pid}`);
      } catch (e) {
        console.error(`  ❌ 终止 PID ${pid} 失败:`, e.message);
      }
      down = await waitForDown(port, 4000);
      if (down) {
        // 强杀不触发进程内 exit handler，单实例锁可能残留——清掉避免挡下次启动
        try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch { /* 下次启动也会清 */ }
      }
    }
  }

  // 最后再收 watch 监督器。
  // 顺序很重要：必须是"服务已停之后"。实测监督器被杀时其子进程(服务)会一起消失
  // （Windows 作业对象/控制台组语义），先杀它就会跳过上面的优雅停机、变成硬杀。
  const supervisors = killWatchSupervisors();
  if (supervisors > 0) console.log(`  ✅ 已停止 watch 监督器 ×${supervisors}`);

  if (down) {
    console.log(graceful ? '✅ 服务器已停止' : '✅ 服务器已停止（强制或随监督器一并退出）');
    return true;
  }
  console.error('❌ 无法停止服务器：端口仍被占用且未能定位可终止的进程');
  return false;
}

// eslint-disable-next-line no-unused-vars -- ctx 参数未使用，保留签名以兼容 CLI 调用
async function handleStopCommand(_args, _ctx) {
  const ok = await stopServer();
  // CLI 是一次性命令，必须显式退出：index.js 的初始化会留下未释放的句柄
  // （进化引擎/调度器等），不退出的话进程会一直挂着——实测"stop 干完活但进程不结束"。
  process.exit(ok ? 0 : 1);
}

// eslint-disable-next-line no-unused-vars -- 参数未使用, 保留签名以兼容 CLI 调用
async function handleRestartCommand(args, ctx) {
  console.log('🔄 重启服务器...');
  const ok = await stopServer();
  if (!ok) {
    console.error('❌ 停止未成功，已放弃重启');
    process.exit(1);
  }

  // 保持 watch 模式：重新拉一个监督器后台跑，而不是在本进程内前台顶替服务。
  // 后者会把"值班员"弄丢——之后改后端源码不再自动生效（今天排查过的同款问题）。
  if (!spawnWatchSupervisor()) process.exit(1);

  const up = await waitForUp(resolvePort());
  if (up) {
    console.log('✅ 服务器已重启（watch 模式，后台运行）');
    process.exit(0);
  }
  console.error('⚠️  监督器已拉起，但端口在 40s 内未就绪；稍后可查看日志或直接跑 npm run dev');
  process.exit(1);
}

module.exports = {
  handleStartCommand,
  handleStopCommand,
  handleRestartCommand,
};
