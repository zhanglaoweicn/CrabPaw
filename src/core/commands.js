const { getSlashAccessControl } = require('./slash-access');

const commands = new Map();
const aliases = new Map();

function registerCommand(cmd) {
  if (!cmd.name) {
    throw new Error('Command must have a name');
  }
  
  commands.set(cmd.name, cmd);
  
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      aliases.set(alias, cmd.name);
    }
  }
  
  console.log(`✅ 已注册命令: /${cmd.name}`);
  return cmd;
}

function getCommand(name) {
  const normalizedName = name.startsWith('/') ? name.slice(1) : name;
  const resolvedName = aliases.get(normalizedName) || normalizedName;
  return commands.get(resolvedName);
}

function hasCommand(name) {
  const normalizedName = name.startsWith('/') ? name.slice(1) : name;
  const resolvedName = aliases.get(normalizedName) || normalizedName;
  return commands.has(resolvedName);
}

function listCommands() {
  return Array.from(commands.values()).filter(cmd => !cmd.hidden);
}

function getCommandNames() {
  return Array.from(commands.keys()).filter(name => {
    const cmd = commands.get(name);
    return !cmd.hidden;
  });
}

async function executeCommand(name, args, context) {
  const cmd = getCommand(name);
  
  if (!cmd) {
    return {
      success: false,
      error: `未知命令: /${name}`,
      suggestion: `输入 /help 查看可用命令`
    };
  }
  
  if (cmd.isEnabled && !cmd.isEnabled()) {
    return {
      success: false,
      error: `命令 /${name} 当前不可用`,
      reason: cmd.disabledReason || '条件不满足'
    };
  }

  if (context && context.userId && context.platform) {
    const access = getSlashAccessControl();
    if (!access.canRunCommand(context.userId, cmd.name, context.platform, context.chatType)) {
      return {
        success: false,
        error: `无权执行命令: /${cmd.name}`,
        reason: '权限不足'
      };
    }
  }
  
  try {
    const result = await cmd.execute(args, context);
    return {
      success: true,
      command: cmd.name,
      result
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      command: cmd.name
    };
  }
}

function formatHelp() {
  const cmds = listCommands();
  const lines = ['可用命令:', ''];
  
  for (const cmd of cmds) {
    const aliasStr = cmd.aliases ? ` (${cmd.aliases.map(a => `/${a}`).join(', ')})` : '';
    const argHint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
    lines.push(`  /${cmd.name}${argHint}${aliasStr}`);
    lines.push(`    ${cmd.description}`);
    if (cmd.whenToUse) {
      lines.push(`    使用场景: ${cmd.whenToUse}`);
    }
    lines.push('');
  }
  
  lines.push('提示: 命令不区分大小写，可以使用别名');
  
  return lines.join('\n');
}

module.exports = {
  registerCommand,
  getCommand,
  hasCommand,
  listCommands,
  getCommandNames,
  executeCommand,
  formatHelp
};
