/**
 * Process Watchdog - 进程崩溃自动重启守护
 *
 * 作为独立 Node 子进程运行，监控主进程心跳。
 * 主进程定期写入心跳文件（heartbeat.json），Watchdog 检测超时后自动重启主进程。
 *
 * 使用方式：
 * 1. 主进程中调用 startWatchdog() 启动守护
 * 2. Watchdog 自动 fork 自身为独立进程（runner 脚本写入 DATA_DIR/.crabpaw/watchdog/）
 * 3. 主进程通过 heartbeat() 更新心跳（start() 内部已按 heartbeatIntervalMs 定时写入）
 * 4. 主进程崩溃 → Watchdog 检测到心跳超时 → 自动重启主进程（入口脚本经 argv[2] 显式传入）
 *
 * 2026-08-18 重写：修复多字节编码损坏（原模板字面量被写入为 - ? 吞换行，
 * 生成的 runner 解析即崩）；runner 入口脚本不再用 process.argv[1]（那是 runner 自己），
 * 改为父进程把入口脚本作为参数传入；生成后先 node --check 校验语法再启动。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DATA_DIR } = require('./config');

const WATCHDOG_DIR = path.join(DATA_DIR, 'watchdog');
const HEARTBEAT_FILE = path.join(WATCHDOG_DIR, 'heartbeat.json');
const WATCHDOG_STATE_FILE = path.join(WATCHDOG_DIR, 'state.json');
const RUNNER_FILE = path.join(WATCHDOG_DIR, '_watchdog_runner.js');
const RUNNER_PID_FILE = path.join(WATCHDOG_DIR, '_runner.pid');

const DEFAULT_OPTIONS = {
  heartbeatIntervalMs: 5000,    // 主进程心跳间隔
  checkIntervalMs: 10000,       // Watchdog 检查间隔
  missedHeartbeatsThreshold: 3, // 连续丢失 N 次心跳视为崩溃
  maxRestarts: 5,               // 最大重启次数
  restartCooldownMs: 30000,     // 重启冷却时间
  autoRestart: true,            // 是否自动重启
};

class ProcessWatchdog {
  constructor(options = {}) {
    this._options = { ...DEFAULT_OPTIONS, ...options };
    this._heartbeatTimer = null;
    this._watchdogProcess = null;
    this._running = false;
    this._startTime = Date.now();
  }

  /**
   * 启动 Watchdog 守护
   * 在主进程中调用，fork Watchdog 子进程
   */
  start() {
    if (this._running) return;
    this._running = true;

    // 确保心跳目录存在
    if (!fs.existsSync(WATCHDOG_DIR)) {
      fs.mkdirSync(WATCHDOG_DIR, { recursive: true });
    }

    // 写入初始心跳
    this._writeHeartbeat();

    // 启动心跳定时器
    this._heartbeatTimer = setInterval(() => {
      this._writeHeartbeat();
    }, this._options.heartbeatIntervalMs);

    if (this._heartbeatTimer.unref) {
      this._heartbeatTimer.unref();
    }

    // Fork Watchdog 监控进程
    this._forkWatchdog();

    console.log('🐕 Process Watchdog 已启动');
  }

  /**
   * 停止 Watchdog
   */
  stop() {
    this._running = false;

    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // 写入停止标记（runner 读到后自行退出）
    try {
      const state = {
        status: 'stopped',
        stoppedAt: Date.now(),
      };
      fs.writeFileSync(WATCHDOG_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[process-watchdog] 写入停止标记失败:', e.message);
    }

    if (this._watchdogProcess) {
      this._watchdogProcess.kill('SIGTERM');
      this._watchdogProcess = null;
    }

    console.log('🐕 Process Watchdog 已停用');
  }

  /**
   * 手动心跳（用于关键操作前确认存活）
   */
  heartbeat() {
    this._writeHeartbeat();
  }

  _writeHeartbeat() {
    try {
      const data = {
        pid: process.pid,
        timestamp: Date.now(),
        uptime: Date.now() - this._startTime,
        memory: process.memoryUsage ? {
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        } : null,
      };
      fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[process-watchdog] 写入心跳失败:', e.message);
    }
  }

  /**
   * 生成 runner 脚本（行数组 + '\n' 拼接，值一律 JSON.stringify 嵌入，
   * 避免模板字面量/多字节编码损坏导致生成脚本解析失败）
   */
  _buildRunnerScript() {
    const o = this._options;
    const lines = [
      "'use strict';",
      '',
      'const fs = require(\'fs\');',
      'const { spawn } = require(\'child_process\');',
      '',
      'const HEARTBEAT_FILE = ' + JSON.stringify(HEARTBEAT_FILE) + ';',
      'const WATCHDOG_STATE_FILE = ' + JSON.stringify(WATCHDOG_STATE_FILE) + ';',
      'const RUNNER_PID_FILE = ' + JSON.stringify(RUNNER_PID_FILE) + ';',
      'const CHECK_INTERVAL = ' + JSON.stringify(o.checkIntervalMs) + ';',
      'const MISSED_THRESHOLD = ' + JSON.stringify(o.missedHeartbeatsThreshold) + ';',
      'const MAX_RESTARTS = ' + JSON.stringify(o.maxRestarts) + ';',
      'const RESTART_COOLDOWN = ' + JSON.stringify(o.restartCooldownMs) + ';',
      'const AUTO_RESTART = ' + JSON.stringify(o.autoRestart) + ';',
      '',
      '// 入口脚本由父进程通过 argv[2] 显式传入。',
      '// 不能用 process.argv[1]：那指向本 runner 自己，重启会变成重启守护进程。',
      'const ENTRY_SCRIPT = process.argv[2];',
      'const EXTRA_ARGS = process.argv.slice(3);',
      '',
      'let missedCount = 0;',
      'let restartCount = 0;',
      'let lastRestartTime = 0;',
      '',
      '// 记录本 runner 的 pid，供外部清理',
      'try { fs.writeFileSync(RUNNER_PID_FILE, String(process.pid)); } catch (e) { /* 目录不可写则忽略 */ }',
      '',
      'function checkHeartbeat() {',
      '  try {',
      '    // 检查是否收到停止信号',
      '    if (fs.existsSync(WATCHDOG_STATE_FILE)) {',
      '      const state = JSON.parse(fs.readFileSync(WATCHDOG_STATE_FILE, \'utf-8\'));',
      '      if (state.status === \'stopped\') {',
      '        process.exit(0);',
      '      }',
      '    }',
      '',
      '    if (!fs.existsSync(HEARTBEAT_FILE)) {',
      '      missedCount++;',
      '      handleMissed();',
      '      return;',
      '    }',
      '',
      '    const data = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, \'utf-8\'));',
      '    const age = Date.now() - (data.timestamp || 0);',
      '',
      '    if (age > CHECK_INTERVAL * MISSED_THRESHOLD) {',
      '      missedCount++;',
      '      handleMissed();',
      '    } else {',
      '      missedCount = 0;',
      '    }',
      '  } catch (e) {',
      '    missedCount++;',
      '    handleMissed();',
      '  }',
      '}',
      '',
      'function handleMissed() {',
      '  if (missedCount < MISSED_THRESHOLD) return;',
      '',
      '  console.error(\'[Watchdog] 主进程心跳丢失 \' + missedCount + \' 次\');',
      '',
      '  if (!AUTO_RESTART) {',
      '    console.error(\'[Watchdog] 自动重启已禁用，退出\');',
      '    process.exit(1);',
      '  }',
      '',
      '  if (restartCount >= MAX_RESTARTS) {',
      '    console.error(\'[Watchdog] 已达最大重启次数 \' + MAX_RESTARTS + \'，放弃重启\');',
      '    process.exit(1);',
      '  }',
      '',
      '  const now = Date.now();',
      '  if (now - lastRestartTime < RESTART_COOLDOWN) {',
      '    return; // 冷却中，下个周期再试',
      '  }',
      '',
      '  console.log(\'[Watchdog] 正在重启主进程...\');',
      '  restartCount++;',
      '  lastRestartTime = now;',
      '',
      '  // 保存重启记录',
      '  try {',
      '    const state = {',
      '      status: \'restarting\',',
      '      restartCount: restartCount,',
      '      lastRestartAt: now,',
      '    };',
      '    fs.writeFileSync(WATCHDOG_STATE_FILE, JSON.stringify(state, null, 2), \'utf-8\');',
      '  } catch (e) {',
      '    console.warn(\'[Watchdog] 写入重启记录失败: \' + e.message);',
      '  }',
      '',
      '  // 重启主进程：入口脚本必须存在，否则放弃（防止凭空 spawn 死循环）',
      '  if (!ENTRY_SCRIPT || !fs.existsSync(ENTRY_SCRIPT)) {',
      '    console.error(\'[Watchdog] 入口脚本不存在，放弃重启: \' + ENTRY_SCRIPT);',
      '    process.exit(1);',
      '  }',
      '',
      '  const child = spawn(process.execPath, [ENTRY_SCRIPT].concat(EXTRA_ARGS), {',
      '    detached: true,',
      '    stdio: \'ignore\',',
      '    windowsHide: true,',
      '    env: Object.assign({}, process.env, {',
      '      WATCHDOG_RESTART: \'true\',',
      '      WATCHDOG_RESTART_COUNT: String(restartCount),',
      '    }),',
      '  });',
      '  child.unref();',
      '}',
      '',
      'setInterval(checkHeartbeat, CHECK_INTERVAL);',
      'console.log(\'[Watchdog] 监控进程已启动 PID: \' + process.pid);',
    ];
    return lines.join('\n');
  }

  /**
   * 生成后语法校验：node --check，失败则不启动（避免把坏脚本 fork 出去）
   */
  _checkRunnerSyntax(runnerPath) {
    try {
      const r = spawnSync(process.execPath, ['--check', runnerPath], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) {
        console.error('[process-watchdog] runner 语法校验失败:\n' + (r.stderr || ''));
        return false;
      }
      return true;
    } catch (e) {
      console.warn('[process-watchdog] runner 语法校验执行失败:', e.message);
      return false;
    }
  }

  _forkWatchdog() {
    try {
      // 生成 runner 脚本（utf8 显式写出，杜绝编码损坏）
      fs.writeFileSync(RUNNER_FILE, this._buildRunnerScript(), 'utf8');

      // 语法校验，失败即放弃启动
      if (!this._checkRunnerSyntax(RUNNER_FILE)) {
        console.error('[process-watchdog] runner 脚本语法校验未通过，Watchdog 未启动');
        try { fs.unlinkSync(RUNNER_FILE); } catch (e) { /* 忽略清理失败 */ }
        return;
      }

      // 入口脚本：主进程入口（参数显式传入，不用 process.argv[1]——那是 runner 自身）
      const entryScript = path.resolve(process.argv[1] || path.join(__dirname, '..', 'cli', 'index.js'));

      this._watchdogProcess = spawn(process.execPath, [RUNNER_FILE, entryScript].concat(process.argv.slice(2)), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });

      this._watchdogProcess.unref();
    } catch (e) {
      console.warn('⚠️ Watchdog 进程启动失败:', e.message);
    }
  }

  getStatus() {
    return {
      running: this._running,
      pid: process.pid,
      watchdogPid: this._watchdogProcess?.pid || null,
      uptime: Date.now() - this._startTime,
      isRestarted: !!process.env.WATCHDOG_RESTART,
      restartCount: parseInt(process.env.WATCHDOG_RESTART_COUNT || '0', 10),
    };
  }
}

// 单例
let _watchdog = null;

function startWatchdog(options = {}) {
  if (!_watchdog) {
    _watchdog = new ProcessWatchdog(options);
  }
  _watchdog.start();
  return _watchdog;
}

function stopWatchdog() {
  if (_watchdog) {
    _watchdog.stop();
  }
}

function getWatchdog() {
  return _watchdog;
}

module.exports = {
  ProcessWatchdog,
  startWatchdog,
  stopWatchdog,
  getWatchdog,
};
