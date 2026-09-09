/**
 * Sandbox Tool — registers sandbox execution as a tool the agent can call.
 * Wraps DockerSandbox.run() with parameter validation and result formatting.
 */

// eslint-disable-next-line no-unused-vars
const { DockerSandbox, sandboxPool } = require('./docker-sandbox');

let _activeSandbox = null;

async function getOrCreateSandbox() {
  if (_activeSandbox) {
    try {
      const ok = await _activeSandbox.healthCheck();
      if (ok) return _activeSandbox;
    } catch (_) {
      console.warn('[SandboxTool] healthCheck failed on cached sandbox, will acquire new one');
    }
    _activeSandbox = null;
  }
  _activeSandbox = await sandboxPool.acquire();
  return _activeSandbox;
}

async function sandboxExecuteHandler(params) {
  const { command, language, timeout_ms = 30000 } = params;
  try {
    const sb = await getOrCreateSandbox();
    let cmd = command;
    if (language === 'python') {
      cmd = `python3 -c ${JSON.stringify(command)}`;
    } else if (language === 'node') {
      cmd = `node -e ${JSON.stringify(command)}`;
    }
    const result = await sb.run(cmd, { timeout: timeout_ms });
    return {
      success: result.success,
      stdout: result.stdout ? result.stdout.slice(0, 50000) : '',
      stderr: result.stderr ? result.stderr.slice(0, 10000) : '',
      exitCode: result.exitCode,
    };
  } catch (e) {
    return { success: false, stdout: '', stderr: e.message, exitCode: 1 };
  }
}

const SANDBOX_TOOL_SCHEMA = {
  name: 'SandboxExec',
  toolset: 'execution',
  category: 'sandbox',
  description: 'Execute code in a Docker sandbox with resource limits and network isolation',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command or code to execute' },
      language: { type: 'string', enum: ['bash', 'python', 'node'], description: 'Language interpreter' },
      timeout_ms: { type: 'integer', description: 'Max execution time in milliseconds', default: 30000 },
    },
    required: ['command'],
  },
  isDangerous: false,
  isReadOnly: true,
  handler: sandboxExecuteHandler,
};

async function cleanupSandbox() {
  if (_activeSandbox) {
    await _activeSandbox.stop();
    _activeSandbox = null;
  }
  await sandboxPool.drain();
}

module.exports = { SANDBOX_TOOL_SCHEMA, sandboxExecuteHandler, getOrCreateSandbox, cleanupSandbox };
