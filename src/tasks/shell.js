/**
 * Shell Task
 * 
 * 借鉴 Claude Code 的 LocalShellTask 实现
 * 支持后台命令执行和监控
 */

const { spawn } = require('child_process')
const {
  generateTaskId,
  createTaskStateBase,
} = require('./utils')
const {
  TASK_STATUS,
  TASK_TYPES,
} = require('./constants')

const BASH_TASK_KIND = {
  BASH: 'bash',
  MONITOR: 'monitor',
}

const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
]

const STALL_THRESHOLD_MS = 45000
const STALL_CHECK_INTERVAL_MS = 5000

function isLocalShellTask(task) {
  return task && task.type === TASK_TYPES.LOCAL_BASH
}

function looksLikePrompt(tail) {
  const lastLine = tail.trimEnd().split('\n').pop() || ''
  return PROMPT_PATTERNS.some(p => p.test(lastLine))
}

function registerShellTask(taskSystem, opts) {
  const {
    command,
    description,
    toolUseId,
    agentId,
    kind = BASH_TASK_KIND.BASH,
  } = opts

  const id = generateTaskId(TASK_TYPES.LOCAL_BASH)

  const task = {
    ...createTaskStateBase(id, TASK_TYPES.LOCAL_BASH, description || command),
    type: TASK_TYPES.LOCAL_BASH,
    status: TASK_STATUS.PENDING,
    command,
    kind,
    toolUseId,
    agentId,
    result: null,
    completionStatusSentInAttachment: false,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
  }

  taskSystem.registerTask(task)
  taskSystem.emit('shell:registered', { id, command })

  return id
}

async function spawnShellTask(taskSystem, taskId, opts) {
  const {
    command,
    timeout = 30000,
    cwd = process.cwd(),
  } = opts

  const task = taskSystem.getTask(taskId)
  if (!task || !isLocalShellTask(task)) {
    throw new Error(`Task ${taskId} not found or not a shell task`)
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], {
      shell: true,
      cwd,
      timeout,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let lastOutputTime = Date.now()

    taskSystem.updateTaskState(taskId, t => ({
      ...t,
      status: TASK_STATUS.RUNNING,
      process: proc,
    }))

    const stallCheckTimer = setInterval(() => {
      const now = Date.now()
      if (now - lastOutputTime > STALL_THRESHOLD_MS) {
        const tail = stdout.slice(-1024)
        if (looksLikePrompt(tail)) {
          taskSystem.emit('shell:stalled', {
            id: taskId,
            tail,
          })
        }
      }
    }, STALL_CHECK_INTERVAL_MS)
    stallCheckTimer.unref()

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
      lastOutputTime = Date.now()
      taskSystem.emit('shell:stdout', {
        id: taskId,
        data: data.toString(),
      })
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
      lastOutputTime = Date.now()
      taskSystem.emit('shell:stderr', {
        id: taskId,
        data: data.toString(),
      })
    })

    proc.on('close', (code) => {
      clearInterval(stallCheckTimer)

      const result = {
        code,
        interrupted: false,
        stdout,
        stderr,
      }

      taskSystem.updateTaskState(taskId, t => ({
        ...t,
        status: code === 0 ? TASK_STATUS.COMPLETED : TASK_STATUS.FAILED,
        endTime: Date.now(),
        result,
        process: null,
      }))

      taskSystem.emit('shell:completed', {
        id: taskId,
        exitCode: code,
        stdout,
        stderr,
      })

      resolve(result)
    })

    proc.on('error', (error) => {
      clearInterval(stallCheckTimer)

      taskSystem.updateTaskState(taskId, t => ({
        ...t,
        status: TASK_STATUS.FAILED,
        endTime: Date.now(),
        error: error.message,
        process: null,
      }))

      taskSystem.emit('shell:error', {
        id: taskId,
        error: error.message,
      })

      reject(error)
    })
  })
}

const ShellTask = {
  name: 'ShellTask',
  type: TASK_TYPES.LOCAL_BASH,

  async kill(taskId, taskSystem) {
    const task = taskSystem.getTask(taskId)
    if (!task || task.status !== TASK_STATUS.RUNNING) return

    if (task.process) {
      task.process.kill('SIGTERM')
    }

    taskSystem.updateTaskState(taskId, t => ({
      ...t,
      status: TASK_STATUS.KILLED,
      endTime: Date.now(),
      notified: true,
      process: null,
    }))

    taskSystem.emit('shell:killed', { id: taskId })
  },
}

module.exports = {
  ShellTask,
  BASH_TASK_KIND,
  isLocalShellTask,
  looksLikePrompt,
  registerShellTask,
  spawnShellTask,
  PROMPT_PATTERNS,
  STALL_THRESHOLD_MS,
  STALL_CHECK_INTERVAL_MS,
}
