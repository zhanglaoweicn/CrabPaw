/**
 * persistent-shell-tool.js — 暴露 PersistentShell 给 LLM
 *
 * 提供 3 个工具:
 *   - ShellExec  : 在持久化 shell 中执行命令（保留 cwd / 历史）
 *   - ShellState : 查询当前 shell 状态
 *   - ShellReset : 重置 shell 状态
 */

const { registry } = require('./registry');
const { getPersistentShell, closeAllShells } = require('../core/persistent-shell');
const { resolveProfile, listProfiles } = require('../core/command-profiles');

// ─── ShellExec ───
registry.register({
  name: 'ShellExec',
  toolset: 'system',
  category: 'execution',
  description: `在持久化 shell 中执行命令。
特点:
  - 跨调用保留 cwd（cd 后下条命令在新的目录）
  - 跨调用保留历史，可查询
  - 配合 profile 限制允许的命令

适用场景:
  - 多步骤命令链（cd + ls + cat）
  - 长期会话内的环境切换
  - 跨命令维护的临时状态

注意: 与 Bash 工具不同，ShellExec 共享状态。如需独立执行请用 Bash。`,
  schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的命令',
      },
      profile: {
        type: 'string',
        description: '命令 profile（default/readonly/fs-readonly/no-network/dev）',
        enum: ['default', 'readonly', 'fs-readonly', 'no-network', 'dev'],
        default: 'default',
      },
      sessionId: {
        type: 'string',
        description: '会话 ID（不同 session 隔离 shell）',
        default: 'default',
      },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isDangerous: true,
  selfApproval: true,
  timeout: 60000,
  handler: async (params, _context) => {
    const { command, profile = 'default', sessionId = 'default' } = params;
    const prof = resolveProfile(profile);
    const shell = getPersistentShell({ profile: prof, sessionId });
    const result = await shell.exec(command);
    return {
      success: result.exitCode === 0,
      data: {
        command,
        stdout: (result.stdout || '').slice(0, 8000),
        stderr: (result.stderr || '').slice(0, 4000),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        blocked: !!result.blocked,
      },
    };
  },
});

// ─── ShellState ───
registry.register({
  name: 'ShellState',
  toolset: 'system',
  category: 'execution',
  description: '查询持久化 shell 的当前状态（cwd、历史条数、最后退出码）',
  schema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '会话 ID',
        default: 'default',
      },
      historyLimit: {
        type: 'number',
        description: '返回历史条数',
        default: 10,
      },
    },
  },
  isReadOnly: true,
  isDangerous: false,
  timeout: 5000,
  handler: async (params) => {
    const { sessionId = 'default', historyLimit = 10 } = params;
    const prof = resolveProfile('default');
    const shell = getPersistentShell({ profile: prof, sessionId });
    return {
      success: true,
      data: {
        state: shell.getState(),
        history: shell.getHistory(historyLimit),
        availableProfiles: listProfiles(),
      },
    };
  },
});

// ─── ShellReset ───
registry.register({
  name: 'ShellReset',
  toolset: 'system',
  category: 'execution',
  description: '重置持久化 shell 的状态（cwd 回到启动目录，清空历史）',
  schema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: '会话 ID',
        default: 'default',
      },
    },
  },
  isReadOnly: false,
  isDangerous: false,
  timeout: 5000,
  handler: async (params) => {
    const { sessionId = 'default' } = params;
    const prof = resolveProfile('default');
    const shell = getPersistentShell({ profile: prof, sessionId });
    shell.reset();
    return { success: true, message: 'shell reset', state: shell.getState() };
  },
});

module.exports = { closeAllShells };
