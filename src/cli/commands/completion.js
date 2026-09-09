/**
 * CLI 命令 - Shell 补全脚本生成 (completion)
 *
 * Shell 自动补全配置命令。
 * 输出 bash/zsh/PowerShell 补全脚本
 */

function generateBashCompletion() {
  return `# CrabPaw bash completion
_crabpaw_completion() {
  local cur prev commands
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="start stop config schedule history subagent channel flow wizard mcp status routing taskflow doctor dump completion"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
  fi

  # 子命令补全
  case "$prev" in
    config)
      COMPREPLY=( $(compgen -W "list get set reset" -- "$cur") )
      ;;
    schedule)
      COMPREPLY=( $(compgen -W "list add remove run status" -- "$cur") )
      ;;
    mcp)
      COMPREPLY=( $(compgen -W "list add remove start stop status" -- "$cur") )
      ;;
  esac
}
complete -F _crabpaw_completion crabpaw`;
}

function generateZshCompletion() {
  return `#compdef crabpaw
_crabpaw() {
  local -a commands
  commands=(
    'start:启动服务器'
    'stop:停止服务器'
    'config:配置管理'
    'schedule:定时任务管理'
    'history:历史记录管理'
    'subagent:SubAgent 管理'
    'channel:通道管理'
    'flow:工作流管理'
    'wizard:设置向导'
    'mcp:MCP 服务器管理'
    'status:查看服务状态'
    'routing:路由管理'
    'taskflow:TaskFlow 管理'
    'doctor:诊断修复'
    'dump:配置摘要导出'
    'completion:Shell 补全脚本'
  )

  _describe 'command' commands
}
_crabpaw "$@"`;
}

function generatePowershellCompletion() {
  return `# CrabPaw PowerShell completion
Register-ArgumentCompleter -CommandName crabpaw -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(
    'start', 'stop', 'config', 'schedule', 'history',
    'subagent', 'channel', 'flow', 'wizard', 'mcp',
    'status', 'routing', 'taskflow', 'doctor', 'dump', 'completion'
  )
  $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}`;
}

async function handleCompletionCommand(args) {
  const shell = args[0] || 'bash';

  let script;
  switch (shell) {
    case 'bash':
      script = generateBashCompletion();
      break;
    case 'zsh':
      script = generateZshCompletion();
      break;
    case 'powershell':
    case 'pwsh':
      script = generatePowershellCompletion();
      break;
    default:
      console.log(`不支持的 shell: ${shell}`);
      console.log('支持: bash, zsh, powershell');
      return;
  }

  console.log(script);
  console.error(`\n# 安装方式:`);
  switch (shell) {
    case 'bash':
      console.error('# crabpaw completion bash >> ~/.bashrc');
      break;
    case 'zsh':
      console.error('# crabpaw completion zsh > ~/.zfunc/_crabpaw');
      break;
    case 'powershell':
    case 'pwsh':
      console.error('# crabpaw completion powershell >> $PROFILE');
      break;
  }
}

module.exports = { handleCompletionCommand };
