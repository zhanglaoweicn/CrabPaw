/**
 * Task Constants
 * 
 * 任务系统常量定义
 * 独立文件避免循环依赖
 */

const TASK_ID_PREFIXES = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}

const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  KILLED: 'killed',
}

const TASK_TYPES = {
  LOCAL_BASH: 'local_bash',
  LOCAL_AGENT: 'local_agent',
  REMOTE_AGENT: 'remote_agent',
  IN_PROCESS_TEAMMATE: 'in_process_teammate',
  LOCAL_WORKFLOW: 'local_workflow',
  MONITOR_MCP: 'monitor_mcp',
  DREAM: 'dream',
}

function isTerminalTaskStatus(status) {
  return status === TASK_STATUS.COMPLETED || 
         status === TASK_STATUS.FAILED || 
         status === TASK_STATUS.KILLED
}

module.exports = {
  TASK_ID_PREFIXES,
  TASK_STATUS,
  TASK_TYPES,
  isTerminalTaskStatus,
}
