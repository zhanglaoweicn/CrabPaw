/**
 * Safe Exec - Wraps child_process with security checks.
 *
 * Features:
 * 1. BashCommandFilter   blocks dangerous commands
 * 2. Secret redaction   redacts API keys/tokens from output
 * 3. Output truncation   caps output at 100KB to avoid memory issues
 */

// eslint-disable-next-line no-unused-vars -- require 解构中 execFileSync 未用（不可删 require）
const { exec, execSync, execFile, execFileSync, spawn } = require('child_process');
const { getBashCommandFilter } = require('./security/bash-command-filter');
const { redactText } = require('./secret-redactor');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 100_000;

/**
 * Run command through BashCommandFilter before execution.
 * @param {string} command - The full command string
 * @param {object} [options]
 * @param {boolean} [options.skipFilter=false] - Bypass filter (dangerous, for trusted callers only)
 */
function _checkCommand(command, options = {}) {
  if (options.skipFilter) return;

  const filter = getBashCommandFilter();
  const result = filter.check(command);

  if (result.blocked) {
    const err = new Error('Command blocked by security policy: ' + result.reason);
    err.code = 'COMMAND_BLOCKED';
    err.reason = result.reason;
    throw err;
  }

  if (result.warnings.length > 0) {
    console.warn('[safe-exec] Security warnings:', result.warnings.join('; '));
  }
}

/**
 * Redact secrets from output and truncate if too long.
 */
function _redactOutput(output) {
  if (output == null) return '';
  if (Buffer.isBuffer(output)) {
    output = output.toString('utf-8');
  } else if (typeof output !== 'string') {
    output = String(output);
  }
  if (output.length > MAX_OUTPUT_LENGTH) {
    output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n...[output truncated at ' + MAX_OUTPUT_LENGTH + ' chars]';
  }
  return redactText(output);
}

/**
 * Safe exec - wraps child_process.exec with security filtering.
 */
function safeExec(command, options = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, skipFilter, redact = true, ...execOptions } = options;
  _checkCommand(command, { skipFilter });

  return new Promise((resolve, reject) => {
    // 2026-08-22 实机修复: windowsHide——GUI 模式下 exec/execSync 不带该选项会在
    // 每次命令执行时弹出一个 CMD 窗口（用户实测「CMD 窗口不停打开关闭」）
    exec(command, { timeout, windowsHide: true, ...execOptions }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = redact ? _redactOutput(stdout) : stdout;
        error.stderr = redact ? _redactOutput(stderr) : stderr;
        reject(error);
      } else {
        resolve({
          stdout: redact ? _redactOutput(stdout) : stdout,
          stderr: redact ? _redactOutput(stderr) : stderr,
        });
      }
    });
  });
}

/**
 * Safe execSync - synchronous version with security filtering.
 */
function safeExecSync(command, options = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, skipFilter, redact = true, ...execOptions } = options;
  _checkCommand(command, { skipFilter });

  try {
    // 2026-08-22 实机修复: windowsHide——同上（execSync 无该选项必弹 CMD 窗口）
    const result = execSync(command, { timeout, encoding: 'utf-8', windowsHide: true, ...execOptions });
    return redact ? _redactOutput(result) : result;
  } catch (e) {
    console.error('[safe-exec] safeExecSync failed:', e.message);
    throw e;
  }
}

/**
 * Safe execFile - spawns a file directly without a shell.
 * More secure than exec because no shell interpretation.
 */
function safeExecFile(file, args = [], options = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, skipFilter, redact = true, ...execOptions } = options;

  // For execFile, build the full command for filter checking
  if (!skipFilter) {
    const fullCommand = [file, ...args].join(' ');
    _checkCommand(fullCommand, { skipFilter });
  }

  return new Promise((resolve, reject) => {
    // 2026-08-22 实机修复: windowsHide——与 exec/execSync 同型（GUI 模式防弹窗）
    execFile(file, args, { timeout, windowsHide: true, ...execOptions }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = redact ? _redactOutput(stdout) : stdout;
        error.stderr = redact ? _redactOutput(stderr) : stderr;
        reject(error);
      } else {
        resolve({
          stdout: redact ? _redactOutput(stdout) : stdout,
          stderr: redact ? _redactOutput(stderr) : stderr,
        });
      }
    });
  });
}

/**
 * Safe spawn - wraps child_process.spawn with security filtering.
 * Returns the ChildProcess object directly (streaming).
 */
function safeSpawn(command, args = [], options = {}) {
  const { skipFilter, redact = true, ...spawnOptions } = options;

  if (!skipFilter) {
    const fullCommand = [command, ...args].join(' ');
    _checkCommand(fullCommand, { skipFilter });
  }

  // 2026-08-22 实机修复: windowsHide 默认注入——调用方可覆盖（GUI 模式防 CMD 弹窗）
  const child = spawn(command, args, { windowsHide: true, ...spawnOptions });

  if (redact) {
    if (child.stdout) _wrapOutputStream(child, 'stdout');
    if (child.stderr) _wrapOutputStream(child, 'stderr');
  }

  return child;
}

function _wrapOutputStream(child, streamName) {
  const { PassThrough } = require('stream');
  const original = child[streamName];
  const passthrough = new PassThrough();
  let accumulated = '';
  let lastRedactedLength = 0;

  original.on('data', (chunk) => {
    if (accumulated.length >= MAX_OUTPUT_LENGTH) return;

    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    accumulated += str;

    const redacted = _redactOutput(accumulated);
    const newPart = redacted.slice(lastRedactedLength);
    if (newPart) {
      passthrough.write(newPart);
    }
    lastRedactedLength = redacted.length;
  });

  original.on('end', () => {
    passthrough.end();
  });

  original.on('error', (err) => {
    passthrough.destroy(err);
  });

  child[streamName] = passthrough;
}

module.exports = {
  safeExec,
  safeExecSync,
  safeExecFile,
  safeSpawn,
  _checkCommand,
  _redactOutput,
};