/**
 * execute_code - ?程序化工具调用? *
 * 允许 Agent 编写 JavaScript 脚本调用 CrabPaw 工具，将多步骤工作流
 * 压缩为单- ?LLM 调用。脚本在子进程中运行，通过 TCP IPC 与主进程通信- ? *
 * 核心优势- ? * - 中间工具结果不进入上下文窗口，只- ?print() 输出返回- ?LLM
 * - 3+ 次工具调用从多轮 LLM 对话压缩- ?1 - ? * - token 消耗降- ?50~80%
 *
 * 参- ?Hermes - ?execute_code 设计，但使用 JavaScript + TCP 替代 Python + UDS- ? * 实现跨平台兼容（Windows/Linux/macOS）- ? *
 * 资源限制- ? * - 超时: 5 分钟- ?00 秒）
 * - 标准输出: 50 KB
 * - 标准错误: 10 KB
 * - 工具调用次数: 每次执行最- ?50 - ? */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { EventEmitter } = require('events');
const { IPCBridge } = require('./ipc-bridge');
const { generateToolStub, createToolDispatcher, SANDBOX_TOOLS } = require('./tool-bridge');

// ─── 默认配置 ──────────────────────────────────────────────

const DEFAULTS = {
  timeout: 300,           // 5 分钟
  maxStdout: 50 * 1024,   // 50 KB
  maxStderr: 10 * 1024,   // 10 KB
  maxToolCalls: 50,       // 每次执行最- ?50 次工具调用?  killGraceMs: 5000,      // SIGTERM 后等- ?SIGKILL 的宽限期
};

// 需要从子进程环境中剥离的敏感环境变量关键词
const SENSITIVE_ENV_KEYWORDS = [
  'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PASSWD', 'AUTH',
  'API_KEY', 'PRIVATE', 'ACCESS_KEY', 'SESSION_KEY',
];

// 安全的系统变量（允许传递）
const SAFE_ENV_VARS = new Set([
  'PATH', 'HOME', 'LANG', 'SHELL', 'USER', 'TMPDIR', 'TEMP', 'TMP',
  'NODE_PATH', 'VIRTUAL_ENV', 'PYTHONPATH', 'PROGRAMFILES',
  'SYSTEMROOT', 'COMSPEC', 'OS', 'PROCESSOR_ARCHITECTURE',
  'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'COMPUTERNAME', 'USERNAME', 'USERPROFILE', 'PUBLIC',
]);

/**
 * 剥离子进程环境中的敏感变- ? */
function _sanitizeEnv(originalEnv, passthroughVars = []) {
  const env = {};

  for (const [key, value] of Object.entries(originalEnv)) {
    // 安全变量直接通过
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      env[key] = value;
      continue;
    }

    // 白名单变量通过
    if (passthroughVars.includes(key)) {
      env[key] = value;
      continue;
    }

    // 检查是否包含敏感关键词
    const upperKey = key.toUpperCase();
    const isSensitive = SENSITIVE_ENV_KEYWORDS.some(kw => upperKey.includes(kw));
    if (!isSensitive) {
      env[key] = value;
    }
  }

  return env;
}

/**
 * execute_code 工具定义
 */
const executeCodeTool = {
  name: 'execute_code',
  description: `编写 JavaScript 脚本调用 CrabPaw 工具，将多步骤工作流压缩为单次调用- ?
脚本中可通过 require('crabpaw_tools') 使用以下工具- ?- search(query, limit) - ?搜索代码- ?- read_file(file_path, limit, offset) - ?读取文件
- write_file(file_path, content) - ?写入文件
- search_files(pattern, path, file_glob, limit) - ?搜索文件
- terminal(command, timeout, cwd) - ?执行命令（仅前台模式- ?- web_search(query, limit) - ?搜索网络
- web_extract(urls) - ?提取网页内容

只有 console.log/print 输出会返回给 LLM，中间工具结果不进入上下文窗口- ?适用场景- ?+ 次工具调用、批量数据处理、条件分支、循环处理。`,

  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: '要执行的 JavaScript 代码。使用 const { search, read_file, ... } = require("crabpaw_tools") 导入工具',
      },
      timeout: {
        type: 'number',
        description: `超时秒数，默- ?${DEFAULTS.timeout}`,
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: '允许使用的工具列表，默认全部可用工具',
      },
    },
    required: ['code'],
  },

  async execute(args, context = {}) {
    const { code } = args;
    const timeout = (args.timeout || DEFAULTS.timeout) * 1000;
    const tools = args.tools || Object.keys(SANDBOX_TOOLS);
    const toolRegistry = context.toolRegistry || null;
    const passthroughVars = context.passthroughVars || [];

    if (!code || code.trim().length === 0) {
      return { status: 'error', output: '', error: '代码不能为空', tool_calls_made: 0, duration_seconds: 0 };
    }

    const executor = new CodeExecutor({
      toolRegistry,
      tools,
      timeout,
      maxStdout: DEFAULTS.maxStdout,
      maxStderr: DEFAULTS.maxStderr,
      maxToolCalls: DEFAULTS.maxToolCalls,
      killGraceMs: DEFAULTS.killGraceMs,
      passthroughVars,
    });

    try {
      const result = await executor.execute(code);
      return result;
    } catch (err) {
      return {
        status: 'error',
        output: '',
        error: err.message,
        tool_calls_made: 0,
        duration_seconds: 0,
      };
    }
  },
};

/**
 * 代码执行- ? */
class CodeExecutor extends EventEmitter {
  constructor(config = {}) {
    super();
    this._toolRegistry = config.toolRegistry;
    this._tools = config.tools || Object.keys(SANDBOX_TOOLS);
    this._timeout = config.timeout || DEFAULTS.timeout * 1000;
    this._maxStdout = config.maxStdout || DEFAULTS.maxStdout;
    this._maxStderr = config.maxStderr || DEFAULTS.maxStderr;
    this._maxToolCalls = config.maxToolCalls || DEFAULTS.maxToolCalls;
    this._killGraceMs = config.killGraceMs || DEFAULTS.killGraceMs;
    this._passthroughVars = config.passthroughVars || [];

    this._ipcBridge = null;
    this._toolStub = null;
    this._childProcess = null;
  }

  async execute(code) {
    const startTime = Date.now();

    // 1. 启动 IPC 桥接
    this._ipcBridge = new IPCBridge({
      maxToolCalls: this._maxToolCalls,
      toolDispatcher: this._toolRegistry ? createToolDispatcher(this._toolRegistry) : null,
    });

    const { port, host } = await this._ipcBridge.start();

    // 2. 生成工具存根
    this._toolStub = generateToolStub({
      port,
      host,
      tools: this._tools,
      timeout: Math.min(this._timeout, 30000),
    });

    // 3. 写入脚本文件（包裹在 async IIFE 中以支持顶层 await）
    const scriptPath = path.join(this._toolStub.tmpDir, 'script.js');
    const wrappedCode = [
      '(async () => {',
      code,
      '})()',
      '  .then(() => { process.exit(0); })',
      '  .catch(err => { process.stderr.write(err.stack + "\\n"); process.exit(1); });',
    ].join('\n');
    fs.writeFileSync(scriptPath, wrappedCode, 'utf8');

    // 4. 启动子进程
    const result = await this._runScript(scriptPath, startTime);

    // 5. 清理
    await this._cleanup();

    return result;
  }

  _runScript(scriptPath, startTime) {
    return new Promise((resolve) => {
      const env = _sanitizeEnv(process.env, this._passthroughVars);
      env.NODE_PATH = [this._toolStub.tmpDir, env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);

      const child = spawn(process.execPath, [
        '--no-warnings',
        '--experimental-vm-modules',
        scriptPath,
      ], {
        cwd: this._toolStub.tmpDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this._childProcess = child;

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let killed = false;

      const timeoutTimer = setTimeout(() => {
        killed = true;
        this._killProcess(child);
      }, this._timeout);

      child.stdout.on('data', (data) => {
        if (stdout.length < this._maxStdout) {
          stdout += data.toString();
          if (stdout.length > this._maxStdout) {
            stdout = stdout.slice(0, this._maxStdout);
            truncated = true;
          }
        }
      });

      child.stderr.on('data', (data) => {
        if (stderr.length < this._maxStderr) {
          stderr += data.toString();
          if (stderr.length > this._maxStderr) {
            stderr = stderr.slice(0, this._maxStderr);
          }
        }
      });

      child.on('close', (exitCode) => {
        clearTimeout(timeoutTimer);
        this._childProcess = null;

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const toolCallsMade = this._ipcBridge ? this._ipcBridge.toolCallCount : 0;

        let status = 'success';
        if (killed) status = 'timeout';
        else if (exitCode !== 0) status = 'error';

        if (truncated) {
          stdout += '\n[output truncated at 50KB]';
        }

        const result = {
          status,
          output: stdout,
          tool_calls_made: toolCallsMade,
          duration_seconds: parseFloat(duration),
        };

        if (exitCode !== 0 && stderr) {
          result.error = stderr;
        }

        if (killed) {
          result.error = `Script timed out after ${this._timeout / 1000}s and was killed.`;
        }

        resolve(result);
      });

      child.on('error', (err) => {
        clearTimeout(timeoutTimer);
        this._childProcess = null;

        resolve({
          status: 'error',
          output: '',
          error: err.message,
          tool_calls_made: 0,
          duration_seconds: ((Date.now() - startTime) / 1000).toFixed(1),
        });
      });
    });
  }

  _killProcess(child) {
    try {
      if (process.platform === 'win32') {
        // Windows: 使用 taskkill 强制终止进程- ?        spawn('taskkill', ['/pid', child.pid.toString(), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { console.warn('[execute-code] silent catch, error swallowed'); }
        }, this._killGraceMs);
      }
    } catch { console.warn('[execute-code] silent catch, error swallowed'); }
  }

  async _cleanup() {
    try {
      if (this._ipcBridge) {
        await this._ipcBridge.stop();
      }
    } catch { console.warn('[execute-code] silent catch, error swallowed'); }

    try {
      if (this._toolStub) {
        this._toolStub.cleanup();
      }
    } catch { console.warn('[execute-code] silent catch, error swallowed'); }

    this._ipcBridge = null;
    this._toolStub = null;
  }

  /**
   * 中断当前执行
   */
  interrupt() {
    if (this._childProcess) {
      this._killProcess(this._childProcess);
    }
  }
}

module.exports = {
  executeCodeTool,
  CodeExecutor,
  _sanitizeEnv,
  DEFAULTS,
  SANDBOX_TOOLS,
};
