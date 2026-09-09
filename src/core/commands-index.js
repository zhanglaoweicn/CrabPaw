const crypto = require('crypto');
const commands = require('./commands');
const state = require('./state');
const subagent = require('./subagent');
const { getGoalManager } = require('./goal-manager');
const { buildRecap } = require('./session-recap');
const { getToolsetManager } = require('./toolset-manager');
const profileManager = require('./profile-manager');
const { getEnvSummary, listAliases, detectTerminalBackend } = require('./env-aliases');
const { getChannelDirectory } = require('./channel-directory');
const { getSlashAccessControl } = require('./slash-access');
const config = require('./config');

// ─── 会话级状态（支持 /retry, /undo, /yolo 等） ───
let _lastUserMessage = null;
let _lastAssistantMessage = null;
let _yoloMode = false;
let _messageHistory = []; // 用于 /undo 和 /branch
let _sessionTitle = null;
let _disabledTools = new Set();
let _backgroundSessions = new Map();
let _queuedPrompt = null;
let _reasoningLevel = 'medium'; // low | medium | high
let _reasoningVisible = true;
let _quickCommands = {};

commands.registerCommand({
  name: 'help',
  aliases: ['h', '?'],
  description: '显示帮助信息',
  execute: () => {
    return {
      type: 'text',
      value: commands.formatHelp()
    };
  }
});

commands.registerCommand({
  name: 'stats',
  aliases: ['stat', 'status'],
  description: '显示会话统计信息',
  execute: () => {
    const stats = state.getSessionStats();
    const lines = [
      '📊 会话统计',
      '━'.repeat(20),
      `会话 ID: ${stats.sessionId}`,
      `运行时间: ${stats.uptimeFormatted}`,
      `API 调用: ${stats.totalApiCalls} 次`,
      `消息数: ${stats.totalMessages} 条`,
      `总成本: $${stats.totalCostUSD}`,
      '',
      '模型使用:'
    ];
    
    if (Object.keys(stats.modelUsage).length === 0) {
      lines.push('  暂无数据');
    } else {
      for (const [model, usage] of Object.entries(stats.modelUsage)) {
        lines.push(`  ${model}:`);
        lines.push(`    调用: ${usage.calls} 次`);
        lines.push(`    输入: ${usage.inputTokens} tokens`);
        lines.push(`    输出: ${usage.outputTokens} tokens`);
        lines.push(`    成本: $${usage.cost.toFixed(4)}`);
      }
    }
    
    lines.push('');
    lines.push(`错误数: ${stats.errorCount}`);
    lines.push(`活动任务: ${stats.activeTasks}`);
    lines.push(`待确认: ${stats.pendingConfirmations}`);
    
    return {
      type: 'text',
      value: lines.join('\n')
    };
  }
});

commands.registerCommand({
  name: 'errors',
  aliases: ['error', 'err'],
  description: '显示最近的错误日志',
  argumentHint: '[limit]',
  execute: (args) => {
    const limit = parseInt(args, 10) || 10;
    const errors = state.getRecentErrors(limit);
    
    if (errors.length === 0) {
      return {
        type: 'text',
        value: '✅ 没有错误记录'
      };
    }
    
    const lines = [`❌ 最近 ${errors.length} 条错误:`, ''];
    
    for (const err of errors) {
      lines.push(`[${err.timestamp}]`);
      lines.push(`  错误: ${err.error}`);
      if (err.context && Object.keys(err.context).length > 0) {
        lines.push(`  上下文: ${JSON.stringify(err.context)}`);
      }
      lines.push('');
    }
    
    return {
      type: 'text',
      value: lines.join('\n')
    };
  }
});

commands.registerCommand({
  name: 'clear',
  aliases: ['cls', 'reset'],
  description: '清除会话历史',
  execute: () => {
    const newSessionId = state.regenerateSessionId();
    return {
      type: 'text',
      value: `✅ 会话已重置\n新会话 ID: ${newSessionId}`
    };
  }
});

commands.registerCommand({
  name: 'session',
  aliases: ['sid'],
  description: '显示当前会话 ID',
  execute: () => {
    const sessionId = state.getSessionId();
    return {
      type: 'text',
      value: `当前会话 ID: ${sessionId}`
    };
  }
});

commands.registerCommand({
  name: 'uptime',
  aliases: ['time'],
  description: '显示服务运行时间',
  execute: () => {
    const stats = state.getSessionStats();
    return {
      type: 'text',
      value: `运行时间: ${stats.uptimeFormatted}\n启动时间: ${new Date(stats.startTime).toLocaleString('zh-CN')}`
    };
  }
});

commands.registerCommand({
  name: 'cost',
  aliases: ['money', '费用'],
  description: '显示 API 成本',
  execute: () => {
    const stats = state.getSessionStats();
    const lines = [
      '💰 成本统计',
      '━'.repeat(20),
      `总成本: $${stats.totalCostUSD}`,
      `API 调用: ${stats.totalApiCalls} 次`,
      '',
      '模型成本:'
    ];
    
    if (Object.keys(stats.modelUsage).length === 0) {
      lines.push('  暂无数据');
    } else {
      for (const [model, usage] of Object.entries(stats.modelUsage)) {
        lines.push(`  ${model}: $${usage.cost.toFixed(4)}`);
      }
    }
    
    return {
      type: 'text',
      value: lines.join('\n')
    };
  }
});

commands.registerCommand({
  name: 'version',
  aliases: ['v', 'ver'],
  description: '显示版本信息',
  execute: () => {
    return {
      type: 'text',
      value: `🦀 CrabPaw v1.0.0\nNode.js ${process.version}`
    };
  }
});

commands.registerCommand({
  name: 'ping',
  description: '测试服务响应',
  execute: () => {
    const stats = state.getSessionStats();
    return {
      type: 'text',
      value: `🏓 Pong!\n延迟: ${Date.now() - stats.lastInteractionTime}ms`
    };
  }
});

commands.registerCommand({
  name: 'subagent',
  aliases: ['sub', 'agent'],
  description: 'SubAgent 管理',
  argumentHint: '[list|stats|cancel <id>]',
  execute: (args) => {
    const [action, ...params] = (args || '').split(' ');
    
    switch (action) {
      case 'list':
      case 'ls': {
        const agents = subagent.listSubAgents();
        if (agents.length === 0) {
          return {
            type: 'text',
            value: '没有 SubAgent 记录'
          };
        }

        const lines = ['🤖 SubAgent 列表:', ''];
        for (const agent of agents) {
          lines.push(`  ${agent.id}`);
          lines.push(`    类型: ${agent.type}`);
          lines.push(`    状态: ${agent.status}`);
          lines.push(`    描述: ${agent.description}`);
          lines.push('');
        }
        return {
          type: 'text',
          value: lines.join('\n')
        };
      }
      case 'stats': {
        const stats = subagent.getSubAgentStats();
        return {
          type: 'text',
          value: `🤖 SubAgent 统计
━━━━━━━━━━━━━━━━━━━━
总数: ${stats.total}
待执行: ${stats.pending}
运行中: ${stats.running}
已完成: ${stats.completed}
失败: ${stats.failed}
已取消: ${stats.cancelled}`
        };
      }
      case 'cancel': {
        const cancelId = params[0];
        if (!cancelId) {
          return {
            type: 'text',
            value: '❌ 请提供 SubAgent ID'
          };
        }

        const cancelled = subagent.cancelSubAgent(cancelId);
        return {
          type: 'text',
          value: cancelled
            ? `✅ SubAgent ${cancelId} 已取消`
            : `❌ SubAgent ${cancelId} 不存在`
        };
      }
      case 'cleanup': {
        const cleaned = subagent.cleanupCompletedSubAgents();
        return {
          type: 'text',
          value: `✅ 清理了 ${cleaned} 个已完成的 SubAgent`
        };
      }
        
      default:
        return {
          type: 'text',
          value: `🤖 SubAgent 命令

用法:
  /subagent list     - 列出所有 SubAgent
  /subagent stats    - 显示统计信息
  /subagent cancel <id> - 取消指定 SubAgent
  /subagent cleanup  - 清理已完成的 SubAgent

类型:
  research   - 研究分析
  implement  - 代码实现
  verify     - 验证测试
  analyze    - 代码分析`
        };
    }
  }
});

commands.registerCommand({
  name: 'events',
  aliases: ['event'],
  description: '显示最近的事件日志',
  argumentHint: '[limit] [type]',
  execute: (args) => {
    const [limitStr, type] = (args || '').split(' ');
    const limit = parseInt(limitStr, 10) || 20;
    
    const events = state.getRecentEvents(limit, type ? { type } : {});
    
    if (events.length === 0) {
      return {
        type: 'text',
        value: '没有事件记录'
      };
    }
    
    const lines = [`📋 最近 ${events.length} 条事件:`, ''];
    
    for (const event of events) {
      const time = new Date(event.timestamp).toLocaleTimeString('zh-CN');
      lines.push(`[${time}] ${event.type}`);
      if (event.data && Object.keys(event.data).length > 0) {
        lines.push(`  ${JSON.stringify(event.data)}`);
      }
    }
    
    return {
      type: 'text',
      value: lines.join('\n')
    };
  }
});

// ═══════════════════════════════════════════════════════════════
// 第一梯队：高价值斜杠命令
// ═══════════════════════════════════════════════════════════════

commands.registerCommand({
  name: 'retry',
  aliases: ['again', '重试'],
  description: '重试最后一条消息（重新发送给 Agent）',
  execute: () => {
    if (!_lastUserMessage) {
      return { type: 'text', value: '❌ 没有可重试的消息。请先发送一条消息。' };
    }
    return {
      type: 'retry',
      value: _lastUserMessage,
      _meta: { description: '重新发送最后一条用户消息给 Agent' }
    };
  }
});

commands.registerCommand({
  name: 'undo',
  aliases: ['撤销'],
  description: '移除最后一条用户/助手交互',
  execute: () => {
    if (_messageHistory.length === 0) {
      return { type: 'text', value: '❌ 没有可撤销的交互。' };
    }
    const last = _messageHistory.pop();
    // 恢复上一个状态
    if (_messageHistory.length > 0) {
      const prev = _messageHistory[_messageHistory.length - 1];
      _lastUserMessage = prev.user || _lastUserMessage;
      _lastAssistantMessage = prev.assistant || _lastAssistantMessage;
    } else {
      _lastUserMessage = null;
      _lastAssistantMessage = null;
    }
    return {
      type: 'undo',
      value: `✅ 已撤销最后一条交互${last.user ? `: "${last.user.slice(0, 50)}${last.user.length > 50 ? '...' : ''}"` : ''}`,
      _meta: { removedUser: last.user, removedAssistant: last.assistant }
    };
  }
});

commands.registerCommand({
  name: 'save',
  aliases: ['保存'],
  description: '保存当前对话',
  argumentHint: '[title]',
  execute: (args) => {
    const title = (args || '').trim();
    if (title) {
      _sessionTitle = title;
    }
    return {
      type: 'save',
      value: `✅ 对话已保存${title ? `，标题: ${title}` : ''}`,
      _meta: { title: title || _sessionTitle, sessionId: state.getSessionId() }
    };
  }
});

commands.registerCommand({
  name: 'compress',
  aliases: ['压缩', 'compact'],
  description: '手动压缩对话上下文',
  execute: () => {
    return {
      type: 'compress',
      value: '🗜️ 正在压缩上下文...',
      _meta: { action: 'manual_compress' }
    };
  }
});

commands.registerCommand({
  name: 'model',
  aliases: ['模型'],
  description: '显示或切换当前模型',
  argumentHint: '[provider:model | model-name]',
  execute: (args) => {
    const input = (args || '').trim();
    const appConfig = config.loadConfig();
    const currentProvider = appConfig.models?.currentProvider || 'default';
    const currentModel = appConfig.models?.providers?.[currentProvider]?.model || 'unknown';

    if (!input) {
      // 显示当前模型和可用选项
      const lines = [
        '🤖 当前模型配置',
        '━'.repeat(30),
        `提供者: ${currentProvider}`,
        `模型: ${currentModel}`,
        '',
        '可用提供者:'
      ];
      const providers = appConfig.models?.providers || {};
      for (const [name, prov] of Object.entries(providers)) {
        if (prov.apiKey || prov.baseUrl) {
          lines.push(`  ${name}: ${prov.model || '(未指定)'}${name === currentProvider ? ' ← 当前' : ''}`);
        }
      }
      lines.push('');
      lines.push('切换方式:');
      lines.push('  /model <model-name>          - 切换模型');
      lines.push('  /model <provider>:<model>     - 切换提供者和模型');
      lines.push('  /model custom:<model>         - 使用自定义端点');
      return { type: 'text', value: lines.join('\n') };
    }

    // 切换模型
    let newProvider = null;
    let newModel = null;

    if (input.includes(':')) {
      const [prov, ...modelParts] = input.split(':');
      newProvider = prov;
      newModel = modelParts.join(':');
    } else {
      newModel = input;
      // 尝试在现有提供者中查找包含该模型名的
      const providers = appConfig.models?.providers || {};
      for (const [name, prov] of Object.entries(providers)) {
        if (prov.model === newModel || (prov.model && prov.model.includes(newModel))) {
          newProvider = name;
          break;
        }
      }
    }

    return {
      type: 'model',
      value: `🔄 切换模型: ${newProvider ? newProvider + ':' : ''}${newModel}`,
      _meta: { provider: newProvider, model: newModel, action: 'switch_model' }
    };
  }
});

commands.registerCommand({
  name: 'btw',
  aliases: ['旁问'],
  description: '使用会话上下文进行临时旁问（不使用工具，不持久化）',
  argumentHint: '<question>',
  execute: (args) => {
    const question = (args || '').trim();
    if (!question) {
      return { type: 'text', value: '❌ 请提供问题: /btw <问题>' };
    }
    return {
      type: 'btw',
      value: question,
      _meta: { noTools: true, noPersist: true, description: '临时旁问' }
    };
  }
});

commands.registerCommand({
  name: 'tools',
  aliases: ['工具'],
  description: '管理工具：列出、启用或禁用',
  argumentHint: '[list | disable | enable] [name...]',
  execute: (args) => {
    const [action, ...toolNames] = (args || '').split(/\s+/);

    switch (action) {
      case 'list':
      case 'ls': {
        const lines = ['🔧 工具列表', '━'.repeat(30)];
        // 尝试获取已注册的工具
        try {
          const { getToolOrchestrator } = require('./tool-orchestrator');
          const orchestrator = getToolOrchestrator();
          const tools = orchestrator.listTools ? orchestrator.listTools() : [];
          if (tools.length === 0) {
            lines.push('  (暂无已注册工具)');
          }
          for (const tool of tools) {
            const disabled = _disabledTools.has(tool.name);
            lines.push(`  ${disabled ? '❌' : '✅'} ${tool.name}${tool.description ? ` - ${tool.description}` : ''}`);
          }
        } catch {
          lines.push('  (工具编排器未初始化)');
        }
        if (_disabledTools.size > 0) {
          lines.push('');
          lines.push(`已禁用: ${[..._disabledTools].join(', ')}`);
        }
        return { type: 'text', value: lines.join('\n') };
      }

      case 'disable': {
        if (toolNames.length === 0) {
          return { type: 'text', value: '❌ 请指定工具名: /tools disable <name...>' };
        }
        for (const name of toolNames) {
          _disabledTools.add(name);
        }
        return {
          type: 'tools',
          value: `✅ 已禁用工具: ${toolNames.join(', ')}`,
          _meta: { action: 'disable', tools: toolNames, disabledTools: [..._disabledTools] }
        };
      }

      case 'enable': {
        if (toolNames.length === 0) {
          return { type: 'text', value: '❌ 请指定工具名: /tools enable <name...>' };
        }
        for (const name of toolNames) {
          _disabledTools.delete(name);
        }
        return {
          type: 'tools',
          value: `✅ 已启用工具: ${toolNames.join(', ')}`,
          _meta: { action: 'enable', tools: toolNames, disabledTools: [..._disabledTools] }
        };
      }

      default:
        return {
          type: 'text',
          value: `🔧 工具管理

用法:
  /tools list              - 列出所有工具
  /tools disable <name...> - 禁用指定工具
  /tools enable <name...>  - 启用指定工具

禁用的工具会从 Agent 工具集中移除。`
        };
    }
  }
});

commands.registerCommand({
  name: 'yolo',
  aliases: ['auto'],
  description: '切换 YOLO 模式 — 跳过所有危险命令的确认提示',
  execute: () => {
    _yoloMode = !_yoloMode;
    return {
      type: 'yolo',
      value: _yoloMode
        ? '🔓 YOLO 模式已开启 — 危险命令将自动执行，无需确认'
        : '🔒 YOLO 模式已关闭 — 危险命令需要确认',
      _meta: { yoloMode: _yoloMode, action: 'toggle_yolo' }
    };
  }
});

commands.registerCommand({
  name: 'title',
  aliases: ['标题'],
  description: '为当前会话设置标题',
  argumentHint: '<title>',
  execute: (args) => {
    const title = (args || '').trim();
    if (!title) {
      return { type: 'text', value: `当前会话标题: ${_sessionTitle || '(未设置)'}\n用法: /title <标题>` };
    }
    _sessionTitle = title;
    return {
      type: 'title',
      value: `✅ 会话标题已设置为: ${title}`,
      _meta: { title, action: 'set_title' }
    };
  }
});

commands.registerCommand({
  name: 'history',
  aliases: ['hist', '历史'],
  description: '显示对话历史',
  argumentHint: '[limit]',
  execute: (args) => {
    const limit = parseInt(args, 10) || 20;
    if (_messageHistory.length === 0) {
      return { type: 'text', value: '📭 没有对话历史。' };
    }
    const entries = _messageHistory.slice(-limit);
    const lines = [`📜 对话历史 (最近 ${entries.length} 条)`, '━'.repeat(30)];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const idx = _messageHistory.length - entries.length + i + 1;
      lines.push(`[${idx}] 用户: ${(entry.user || '').slice(0, 80)}`);
      if (entry.assistant) {
        lines.push(`     助手: ${entry.assistant.slice(0, 80)}`);
      }
      lines.push('');
    }
    return { type: 'text', value: lines.join('\n') };
  }
});

commands.registerCommand({
  name: 'new',
  aliases: ['new-session'],
  description: '开始新会话（保留历史记录）',
  execute: () => {
    const oldTitle = _sessionTitle;
    _lastUserMessage = null;
    _lastAssistantMessage = null;
    _messageHistory = [];
    _sessionTitle = null;
    _disabledTools.clear();
    _queuedPrompt = null;
    const newSessionId = state.regenerateSessionId();
    return {
      type: 'new',
      value: `✅ 新会话已开始\n新会话 ID: ${newSessionId}${oldTitle ? `\n上一会话标题: ${oldTitle}` : ''}`,
      _meta: { action: 'new_session' }
    };
  }
});

// ═══════════════════════════════════════════════════════════════
// 第二梯队：高级斜杠命令
// ═══════════════════════════════════════════════════════════════

commands.registerCommand({
  name: 'branch',
  aliases: ['fork'],
  description: '分支当前会话（探索不同路径）',
  argumentHint: '[name]',
  execute: (args) => {
    const branchName = (args || '').trim() || `branch_${Date.now()}`;
    // 保存当前会话快照
    const snapshot = {
      messages: [..._messageHistory],
      title: _sessionTitle,
      disabledTools: new Set(_disabledTools),
      yoloMode: _yoloMode,
      createdAt: Date.now()
    };
    return {
      type: 'branch',
      value: `🌿 会话已分支: ${branchName}\n当前状态已保存为快照，可继续探索不同路径。`,
      _meta: { action: 'branch', branchName, snapshot }
    };
  }
});

commands.registerCommand({
  name: 'background',
  aliases: ['bg'],
  description: '在独立的后台会话中运行提示',
  argumentHint: '<prompt>',
  execute: (args) => {
    const prompt = (args || '').trim();
    if (!prompt) {
      return { type: 'text', value: '❌ 请提供提示: /background <提示内容>' };
    }
    const bgId = `bg_${Date.now()}_${crypto.randomBytes(4).toString("hex").slice(0, 8)}`;
    _backgroundSessions.set(bgId, {
      prompt,
      status: 'pending',
      createdAt: Date.now()
    });
    return {
      type: 'background',
      value: `🔄 后台任务已创建: ${bgId}\n提示: "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"\n\n当前会话保持空闲，可继续工作。\n任务完成后结果将显示在此。`,
      _meta: { action: 'background', bgId, prompt }
    };
  }
});

commands.registerCommand({
  name: 'queue',
  aliases: ['q'],
  description: '将提示排队等待下一轮（不会中断当前 Agent 响应）',
  argumentHint: '<prompt>',
  execute: (args) => {
    const prompt = (args || '').trim();
    if (!prompt) {
      return { type: 'text', value: '❌ 请提供提示: /queue <提示内容>' };
    }
    _queuedPrompt = prompt;
    return {
      type: 'queue',
      value: `📋 提示已排队: "${prompt.slice(0, 60)}${prompt.length > 60 ? '...' : ''}"\n将在当前 Agent 响应完成后自动发送。`,
      _meta: { action: 'queue', prompt }
    };
  }
});

commands.registerCommand({
  name: 'rollback',
  aliases: ['回滚'],
  description: '列出或恢复文件系统检查点',
  argumentHint: '[number]',
  execute: (args) => {
    const num = parseInt(args, 10);
    if (isNaN(num)) {
      // 列出可用检查点
      return {
        type: 'rollback',
        value: '📂 检查点功能\n\n用法: /rollback <编号>\n\n检查点在破坏性文件操作前自动创建。\n当前无可用检查点。',
        _meta: { action: 'list_checkpoints' }
      };
    }
    return {
      type: 'rollback',
      value: `⏪ 正在恢复到检查点 #${num}...`,
      _meta: { action: 'restore_checkpoint', checkpointNumber: num }
    };
  }
});

commands.registerCommand({
  name: 'reasoning',
  aliases: ['推理'],
  description: '管理推理努力程度和显示',
  argumentHint: '[low | medium | high | show | hide]',
  execute: (args) => {
    const action = (args || '').trim().toLowerCase();
    switch (action) {
      case 'low':
      case 'l':
        _reasoningLevel = 'low';
        return { type: 'text', value: '🧠 推理努力: 低 — 快速响应，较少推理' };
      case 'medium':
      case 'm':
        _reasoningLevel = 'medium';
        return { type: 'text', value: '🧠 推理努力: 中 — 平衡推理和速度' };
      case 'high':
      case 'h':
        _reasoningLevel = 'high';
        return { type: 'text', value: '🧠 推理努力: 高 — 深度推理，较慢响应' };
      case 'show':
        _reasoningVisible = true;
        return { type: 'text', value: '👁 推理过程: 显示' };
      case 'hide':
        _reasoningVisible = false;
        return { type: 'text', value: '🙈 推理过程: 隐藏' };
      default:
        return {
          type: 'text',
          value: `🧠 推理设置\n━`.repeat(15) + `\n当前努力程度: ${_reasoningLevel}\n推理显示: ${_reasoningVisible ? '显示' : '隐藏'}\n\n用法:\n  /reasoning low    - 快速响应\n  /reasoning medium - 平衡模式\n  /reasoning high   - 深度推理\n  /reasoning show   - 显示推理过程\n  /reasoning hide   - 隐藏推理过程`
        };
    }
  }
});

commands.registerCommand({
  name: 'stop',
  aliases: ['停止'],
  description: '终止当前正在运行的 Agent 响应',
  execute: () => {
    return {
      type: 'stop',
      value: '⏹ 正在终止当前 Agent 响应...',
      _meta: { action: 'stop_agent' }
    };
  }
});

commands.registerCommand({
  name: 'provider',
  aliases: ['prov', '提供者'],
  description: '显示可用提供者及当前提供者',
  execute: () => {
    const appConfig = config.loadConfig();
    const currentProvider = appConfig.models?.currentProvider || 'default';
    const providers = appConfig.models?.providers || {};
    const lines = ['📡 提供者列表', '━'.repeat(30)];
    for (const [name, prov] of Object.entries(providers)) {
      const hasKey = !!(prov.apiKey || prov.baseUrl);
      const isCurrent = name === currentProvider;
      lines.push(`  ${isCurrent ? '→' : ' '} ${name}: ${prov.model || '(未指定)'} ${hasKey ? '✅' : '❌'}${isCurrent ? ' ← 当前' : ''}`);
    }
    lines.push('');
    lines.push('切换方式: /model <provider>:<model>');
    return { type: 'text', value: lines.join('\n') };
  }
});

commands.registerCommand({
  name: 'verbose',
  aliases: ['详细'],
  description: '循环切换工具进度显示',
  execute: () => {
    const modes = ['off', 'new', 'all', 'detailed'];
    const currentIdx = modes.indexOf(state.getState()?.verboseMode || 'new');
    const nextIdx = (currentIdx + 1) % modes.length;
    const nextMode = modes[nextIdx];
    state.updateState({ verboseMode: nextMode });
    const labels = { off: '关闭', new: '仅新增', all: '全部', detailed: '详细' };
    return { type: 'text', value: `🔧 工具进度显示: ${labels[nextMode]}` };
  }
});

commands.registerCommand({
  name: 'usage',
  aliases: ['用量'],
  description: '显示令牌使用情况和成本明细',
  execute: () => {
    const stats = state.getSessionStats();
    const lines = [
      '📊 使用情况',
      '━'.repeat(30),
      `会话 ID: ${stats.sessionId}`,
      `运行时间: ${stats.uptimeFormatted}`,
      `API 调用: ${stats.totalApiCalls} 次`,
      `消息数: ${stats.totalMessages} 条`,
      `总成本: $${stats.totalCostUSD}`,
      '',
      '模型明细:'
    ];
    if (Object.keys(stats.modelUsage).length === 0) {
      lines.push('  暂无数据');
    } else {
      for (const [model, usage] of Object.entries(stats.modelUsage)) {
        lines.push(`  ${model}:`);
        lines.push(`    输入: ${usage.inputTokens.toLocaleString()} tokens`);
        lines.push(`    输出: ${usage.outputTokens.toLocaleString()} tokens`);
        lines.push(`    调用: ${usage.calls} 次`);
        lines.push(`    成本: $${usage.cost.toFixed(4)}`);
      }
    }
    return { type: 'text', value: lines.join('\n') };
  }
});

commands.registerCommand({
  name: 'plan',
  aliases: ['计划'],
  description: '加载计划模式 — 编写 Markdown 计划而非执行任务',
  argumentHint: '[request]',
  execute: (args) => {
    const request = (args || '').trim();
    return {
      type: 'plan',
      value: request || '进入计划模式',
      _meta: { action: 'plan_mode', request }
    };
  }
});

commands.registerCommand({
  name: 'personality',
  aliases: ['人格'],
  description: '设置预定义人格',
  argumentHint: '[name]',
  execute: (args) => {
    const name = (args || '').trim();
    if (!name) {
      return {
        type: 'text',
        value: `🎭 人格设置\n\n用法: /personality <名称>\n\n可用人格:\n  default  - 默认助手\n  engineer - 严肃工程师\n  teacher  - 耐心老师\n  creative - 创意伙伴\n\n当前: default`
      };
    }
    return {
      type: 'personality',
      value: `🎭 人格已切换为: ${name}`,
      _meta: { action: 'set_personality', personality: name }
    };
  }
});

// ─── Quick Commands 快速命令 ───
// 用户可在 config.json 中配置 quick_commands 映射

function _loadQuickCommands() {
  try {
    const appConfig = config.loadConfig();
    _quickCommands = appConfig.quick_commands || {};
  } catch {
    _quickCommands = {};
  }
}

commands.registerCommand({
  name: 'qc',
  aliases: ['quick', '快捷'],
  description: '执行快速命令（用户自定义别名）',
  argumentHint: '<alias>',
  execute: (args) => {
    _loadQuickCommands();
    const alias = (args || '').trim();
    if (!alias) {
      const entries = Object.entries(_quickCommands);
      if (entries.length === 0) {
        return {
          type: 'text',
          value: '⚡ 快速命令\n\n暂无自定义命令。\n\n在 config.json 中配置:\n{\n  "quick_commands": {\n    "review": "Review my latest git diff",\n    "deploy": "Run the deployment script"\n  }\n}'
        };
      }
      const lines = ['⚡ 快速命令', '━'.repeat(20)];
      for (const [key, value] of entries) {
        lines.push(`  /qc ${key} → "${value.slice(0, 60)}${value.length > 60 ? '...' : ''}"`);
      }
      return { type: 'text', value: lines.join('\n') };
    }
    const prompt = _quickCommands[alias];
    if (!prompt) {
      return { type: 'text', value: `❌ 未找到快速命令: ${alias}\n使用 /qc 查看所有可用命令。` };
    }
    return {
      type: 'quick_command',
      value: prompt,
      _meta: { alias, originalPrompt: prompt }
    };
  }
});

// ─── 导出扩展接口 ───

/**
 * 记录用户/助手消息到历史（供 handleMessage 调用）
 */
function recordInteraction(userMessage, assistantMessage) {
  _lastUserMessage = userMessage;
  _lastAssistantMessage = assistantMessage;
  _messageHistory.push({ user: userMessage, assistant: assistantMessage, timestamp: Date.now() });
}

/**
 * 获取 YOLO 模式状态
 */
function isYoloMode() {
  return _yoloMode;
}

/**
 * 获取已禁用工具列表
 */
function getDisabledTools() {
  return [..._disabledTools];
}

/**
 * 获取排队中的提示
 */
function getQueuedPrompt() {
  const prompt = _queuedPrompt;
  _queuedPrompt = null;
  return prompt;
}

/**
 * 获取推理设置
 */
function getReasoningSettings() {
  return { level: _reasoningLevel, visible: _reasoningVisible };
}

/**
 * 获取会话标题
 */
function getSessionTitle() {
  return _sessionTitle;
}

/**
 * 获取后台会话
 */
function getBackgroundSessions() {
  return _backgroundSessions;
}

commands.registerCommand({
  name: 'goal',
  aliases: ['g'],
  description: '管理会话目标循环',
  argumentHint: '[set <text> | status | pause | resume | clear | subgoal <text>]',
  execute: (args) => {
    const goalManager = getGoalManager();
    const [action, ...rest] = (args || '').split(' ');
    const text = rest.join(' ').trim();

    switch (action) {
      case 'set':
      case 's': {
        if (!text) {
          return { type: 'text', value: '❌ 请提供目标文本: /goal set <目标描述>' };
        }
        const goal = goalManager.set(text);
        return { type: 'text', value: `🎯 目标已设定: ${goal.goal}\n状态: active | 轮次: 0/${goalManager.maxTurns}\n\n代理将自动持续工作直到目标完成。使用 /goal status 查看进度。` };
      }

      case 'status':
      case 'st':
        return { type: 'text', value: goalManager.getStatus() };

      case 'pause':
      case 'p':
        goalManager.pause();
        return { type: 'text', value: '⏸ 目标已暂停。使用 /goal resume 继续。' };

      case 'resume':
      case 'r':
        goalManager.resume();
        return { type: 'text', value: '▶ 目标已恢复。代理将继续推进。' };

      case 'clear':
      case 'c':
        goalManager.clear();
        return { type: 'text', value: '🗑 目标已清除。' };

      case 'subgoal':
      case 'sg': {
        if (!text) {
          return { type: 'text', value: '❌ 请提供子目标文本: /goal subgoal <子目标描述>' };
        }
        const sg = goalManager.addSubgoal(text);
        if (!sg) {
          return { type: 'text', value: '❌ 没有活跃目标。请先使用 /goal set 设定目标。' };
        }
        return { type: 'text', value: `📋 子目标已添加: ${text}` };
      }

      default:
        return {
          type: 'text',
          value: `🎯 目标管理命令

用法:
  /goal set <text>      - 设定新目标
  /goal status          - 查看当前目标状态
  /goal pause           - 暂停目标循环
  /goal resume          - 恢复目标循环
  /goal clear           - 清除当前目标
  /goal subgoal <text>  - 添加子目标条件

设定目标后，代理会自动持续工作直到:
  ✓ 目标完成
  ✓ 轮次预算耗尽
  ✓ 用户暂停或清除`
        };
    }
  }
});

commands.registerCommand({
  name: 'recap',
  aliases: ['summary', '回顾'],
  description: '回顾当前会话内容',
  execute: () => {
    const messages = state.getMessages ? state.getMessages() : [];
    if (!messages || messages.length === 0) {
      return { type: 'text', value: '📭 空会话，尚无内容。' };
    }
    return { type: 'text', value: buildRecap(messages) };
  }
});

commands.registerCommand({
  name: 'channels',
  aliases: ['ch', '频道'],
  description: '查看或搜索可用频道/联系人',
  argumentHint: '[search <query>] [platform <name>]',
  execute: (args) => {
    const channelDir = getChannelDirectory();
    const [action, ...rest] = (args || '').split(' ');

    switch (action) {
      case 'search':
      case 'find': {
        const query = rest.join(' ').trim();
        if (!query) {
          return { type: 'text', value: '❌ 请提供搜索关键词: /channels search <关键词>' };
        }
        const results = channelDir.search(query);
        if (results.length === 0) {
          return { type: 'text', value: `🔍 未找到匹配 "${query}" 的频道。` };
        }
        const lines = [`🔍 搜索结果 (${results.length}):`, ''];
        for (const ch of results.slice(0, 20)) {
          lines.push(`  [${ch.platform}] ${ch.name} (${ch.type}) - ID: ${ch.id}`);
        }
        return { type: 'text', value: lines.join('\n') };
      }

      case 'list':
      case 'ls':
      default: {
        const platform = rest[0] || null;
        const channels = channelDir.list(platform);
        if (channels.length === 0) {
          return { type: 'text', value: '📭 频道目录为空。请确保已连接平台适配器。' };
        }
        const byPlatform = {};
        for (const ch of channels) {
          if (!byPlatform[ch.platform]) byPlatform[ch.platform] = [];
          byPlatform[ch.platform].push(ch);
        }
        const lines = ['📡 频道目录', ''];
        for (const [plat, chs] of Object.entries(byPlatform)) {
          lines.push(`${plat} (${chs.length}):`);
          for (const ch of chs.slice(0, 10)) {
            lines.push(`  ${ch.name} (${ch.type}) - ID: ${ch.id}`);
          }
          if (chs.length > 10) {
            lines.push(`  ... 还有 ${chs.length - 10} 个`);
          }
          lines.push('');
        }
        return { type: 'text', value: lines.join('\n') };
      }
    }
  }
});

commands.registerCommand({
  name: 'access',
  aliases: ['acl', '权限'],
  description: '查看斜杠命令权限控制',
  argumentHint: '[list | check <command>]',
  execute: (args) => {
    const access = getSlashAccessControl();
    const [action, ...rest] = (args || '').split(' ');

    switch (action) {
      case 'list':
      case 'ls': {
        const policies = access.listPolicies();
        if (policies.length === 0) {
          return { type: 'text', value: '🔓 未配置命令权限控制。所有用户可执行所有命令。' };
        }
        const lines = ['🔒 命令权限策略:', ''];
        for (const p of policies) {
          lines.push(`[${p.platform}:${p.scope}]`);
          lines.push(`  管理员: ${p.adminUserIds.join(', ') || '(无)'}`);
          lines.push(`  用户可用命令: ${p.userAllowedCommands.join(', ') || '(无)'}`);
          lines.push('');
        }
        return { type: 'text', value: lines.join('\n') };
      }

      case 'check': {
        const cmdName = rest[0];
        if (!cmdName) {
          return { type: 'text', value: '❌ 请提供命令名: /access check <command>' };
        }
        const context = state.getCurrentContext ? state.getCurrentContext() : {};
        const canRun = access.canRunCommand(context.userId, cmdName, context.platform, context.chatType);
        return { type: 'text', value: canRun ? `✅ 可以执行 /${cmdName}` : `❌ 无权执行 /${cmdName}` };
      }

      default:
        return {
          type: 'text',
          value: `🔒 命令权限控制

用法:
  /access list          - 列出所有权限策略
  /access check <cmd>   - 检查当前用户是否可执行某命令

配置方式:
  在 config.json 中添加 slash_access 配置:
  {
    "slash_access": {
      "platforms": {
        "lark": {
          "dm": {
            "allow_admin_from": ["user_id_1"],
            "user_allowed_commands": ["help", "status", "recap"]
          }
        }
      }
    }
  }`
        };
    }
  }
});

// ─── /toolset 命令：工具集管理 ───
commands.registerCommand({
  name: 'toolset',
  aliases: ['ts'],
  description: '管理工具集（查看/激活/停用）',
  execute: (args) => {
    const tsm = getToolsetManager();
    const parts = (args || '').trim().split(/\s+/);
    const subCmd = parts[0] || 'list';

    switch (subCmd) {
      case 'list':
      case 'ls': {
        return { type: 'text', value: tsm.getSummary() };
      }
      case 'activate':
      case 'on':
      case 'use': {
        const name = parts[1];
        if (!name) {
          return { type: 'text', value: '❌ 用法: /toolset activate <name>' };
        }
        try {
          tsm.activateToolset(name);
          const toolCount = tsm.resolveToolNames(name).length;
          return { type: 'text', value: `✅ 已激活工具集: ${name} (${toolCount} 工具)` };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      case 'deactivate':
      case 'off': {
        const name = parts[1];
        if (!name) {
          return { type: 'text', value: '❌ 用法: /toolset deactivate <name>' };
        }
        tsm.deactivateToolset(name);
        return { type: 'text', value: `✅ 已停用工具集: ${name}` };
      }
      case 'reset': {
        tsm.setActiveToolsets([]);
        return { type: 'text', value: '✅ 已重置工具集为全部可用' };
      }
      case 'info': {
        const name = parts[1];
        if (!name) {
          return { type: 'text', value: '❌ 用法: /toolset info <name>' };
        }
        const ts = tsm.getToolset(name);
        if (!ts) {
          return { type: 'text', value: `❌ 工具集不存在: ${name}` };
        }
        const toolNames = tsm.resolveToolNames(name);
        return {
          type: 'text',
          value: `📦 ${name} (${ts.label})\n描述: ${ts.description}\n包含工具集: ${(ts.toolsets || []).join(', ') || '(直接工具)'}\n工具列表: ${toolNames.join(', ')}`
        };
      }
      case 'platform': {
        const platform = parts[1];
        if (!platform) {
          return { type: 'text', value: `当前平台: ${tsm.getPlatform()}\n可用: ${Object.keys(tsm.getAllToolsets().platform).join(', ')}` };
        }
        try {
          tsm.setPlatform(platform);
          return { type: 'text', value: `✅ 已切换平台: ${platform}` };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      case 'stats': {
        const stats = tsm.getStats();
        return {
          type: 'text',
          value: `📊 工具集统计\n总工具: ${stats.totalTools}\n核心: ${stats.coreToolsets} | 复合: ${stats.compositeToolsets} | 自定义: ${stats.customToolsets} | MCP: ${stats.mcpToolsets}\n活跃工具集: ${stats.activeToolsets} | 活跃工具: ${stats.activeTools}\n平台: ${stats.platform}`
        };
      }
      default:
        return {
          type: 'text',
          value: `用法: /toolset <list|activate|deactivate|reset|info|platform|stats> [name]\n示例:\n  /toolset list          查看所有工具集\n  /toolset activate coding  激活编码模式\n  /toolset info debugging   查看调试工具集详情\n  /toolset platform lark    切换到飞书平台`
        };
    }
  }
});

// ─── /profile 命令：多配置文件管理 ───
commands.registerCommand({
  name: 'profile',
  aliases: ['pf'],
  description: '管理配置文件（查看/切换/创建/删除/导出/导入）',
  execute: (args) => {
    const parts = (args || '').trim().split(/\s+/);
    const subCmd = parts[0] || 'list';

    switch (subCmd) {
      case 'list':
      case 'ls': {
        const profiles = profileManager.listProfiles();
        const lines = ['📋 配置文件列表\n'];
        for (const p of profiles) {
          const active = p.isActive ? ' ← 当前' : '';
          const label = p.label !== p.name ? ` (${p.label})` : '';
          const cloned = p.clonedFrom ? ` [克隆自: ${p.clonedFrom}]` : '';
          lines.push(`  ${p.isActive ? '✅' : '⬜'} ${p.name}${label}${cloned}${active}`);
        }
        return { type: 'text', value: lines.join('\n') };
      }
      case 'use':
      case 'switch': {
        const name = parts[1];
        if (!name) return { type: 'text', value: '❌ 用法: /profile use <name>' };
        try {
          const result = profileManager.useProfile(name);
          return { type: 'text', value: `✅ 已切换到 Profile: ${result.profile}\n⚠️ 部分配置需要重启服务生效` };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      case 'create': {
        const name = parts[1];
        if (!name) return { type: 'text', value: '❌ 用法: /profile create <name> [--clone <source>]' };
        const cloneIdx = parts.indexOf('--clone');
        const cloneFrom = cloneIdx > -1 ? parts[cloneIdx + 1] : null;
        try {
          // eslint-disable-next-line no-unused-vars -- createProfile 调用有副作用不可删，result 值未使用
          const result = profileManager.createProfile(name, { clone: cloneFrom });
          const cloned = cloneFrom ? ` (克隆自 ${cloneFrom})` : '';
          return { type: 'text', value: `✅ 已创建 Profile: ${name}${cloned}` };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      case 'delete':
      case 'rm':
      case 'remove': {
        const name = parts[1];
        if (!name) return { type: 'text', value: '❌ 用法: /profile delete <name>' };
        try {
          profileManager.deleteProfile(name);
          return { type: 'text', value: `✅ 已删除 Profile: ${name}` };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      case 'show':
      case 'info': {
        const name = parts[1] || profileManager.getActiveProfile();
        try {
          const info = profileManager.showProfile(name);
          const lines = [
            `📋 Profile: ${info.name}`,
            `标签: ${info.label}`,
            `描述: ${info.description || '(无)'}`,
            `默认: ${info.isDefault ? '是' : '否'}`,
            `当前: ${info.isActive ? '是' : '否'}`,
          ];
          if (info.clonedFrom) lines.push(`克隆自: ${info.clonedFrom}`);
          if (info.createdAt) lines.push(`创建时间: ${info.createdAt}`);
          return { type: 'text', value: lines.join('\n') };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      case 'export': {
        const name = parts[1] || profileManager.getActiveProfile();
        try {
          const json = profileManager.exportProfile(name);
          return { type: 'text', value: `📤 Profile "${name}" 导出:\n\`\`\`json\n${json}\n\`\`\`` };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      case 'import': {
        const name = parts[1];
        if (!name) return { type: 'text', value: '❌ 用法: /profile import <name> <json>' };
        const jsonStr = parts.slice(2).join(' ');
        if (!jsonStr) return { type: 'text', value: '❌ 请提供 JSON 配置数据' };
        try {
          profileManager.importProfile(name, jsonStr);
          return { type: 'text', value: `✅ 已导入 Profile: ${name}` };
        } catch (e) {
          return { type: 'text', value: `❌ ${e.message}` };
        }
      }
      default:
        return {
          type: 'text',
          value: `用法: /profile <list|use|create|delete|show|export|import> [args]\n示例:\n  /profile list              列出所有 Profile\n  /profile use work          切换到 work Profile\n  /profile create dev        创建 dev Profile\n  /profile create dev2 --clone dev  克隆 dev 创建 dev2\n  /profile delete dev        删除 dev Profile\n  /profile show              显示当前 Profile 详情\n  /profile export work       导出 work Profile`
        };
    }
  }
});

// ─── /env 命令：环境变量查看 ───
commands.registerCommand({
  name: 'env',
  aliases: ['environment'],
  description: '查看环境变量别名和终端后端配置',
  execute: (args) => {
    const subCmd = (args || '').trim() || 'summary';
    switch (subCmd) {
      case 'summary':
        return { type: 'text', value: getEnvSummary() };
      case 'backend':
        return { type: 'text', value: `终端后端: ${detectTerminalBackend()}` };
      case 'list': {
        const aliases = listAliases();
        const lines = ['🔑 环境变量别名映射\n'];
        for (const a of aliases) {
          const status = a.isSet ? '✅' : '⬜';
          const from = a.resolvedFrom ? ` ← ${a.resolvedFrom}` : '';
          lines.push(`  ${status} ${a.canonical}${from} (别名: ${a.aliases.join(', ')})`);
        }
        return { type: 'text', value: lines.join('\n') };
      }
      default:
        return { type: 'text', value: '用法: /env [summary|list|backend]' };
    }
  }
});

module.exports = commands;
module.exports.recordInteraction = recordInteraction;
module.exports.isYoloMode = isYoloMode;
module.exports.getDisabledTools = getDisabledTools;
module.exports.getQueuedPrompt = getQueuedPrompt;
module.exports.getReasoningSettings = getReasoningSettings;
module.exports.getSessionTitle = getSessionTitle;
module.exports.getBackgroundSessions = getBackgroundSessions;
