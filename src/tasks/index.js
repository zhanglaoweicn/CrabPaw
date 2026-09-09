/**
 * CrabPaw Task System
 * 
 * 借鉴 Claude Code 的任务系统设计
 * - 统一的任务类型和状态管理
 * - 任务生命周期管理
 * - 后台任务执行
 * - 任务进度跟踪
 */

const EventEmitter = require('events')
const path = require('path')
const fs = require('fs').promises

const {
  TASK_ID_PREFIXES,
  TASK_STATUS,
  TASK_TYPES,
  isTerminalTaskStatus,
} = require('./constants')

const {
  generateTaskId,
  createTaskStateBase,
} = require('./utils')

class TaskSystem extends EventEmitter {
  constructor(options = {}) {
    super()
    this.tasks = new Map()
    this.maxTasks = options.maxTasks || 100
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data', 'tasks')
    this.cleanupInterval = options.cleanupInterval || 60000
    this.cleanupTimer = null
  }

  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true })
    this.startCleanupTimer()
    this.emit('system:initialized')
  }

  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      this.cleanupCompletedTasks()
    }, this.cleanupInterval)
    this.cleanupTimer.unref()
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  registerTask(taskState) {
    if (this.tasks.size >= this.maxTasks) {
      this.evictOldestTask()
    }

    this.tasks.set(taskState.id, taskState)
    this.emit('task:registered', { id: taskState.id, task: taskState })
    
    return taskState.id
  }

  updateTaskState(taskId, updater) {
    const task = this.tasks.get(taskId)
    if (!task) return null

    const updatedTask = updater(task)
    this.tasks.set(taskId, updatedTask)
    this.emit('task:updated', { id: taskId, task: updatedTask })
    
    return updatedTask
  }

  getTask(taskId) {
    return this.tasks.get(taskId)
  }

  getAllTasks() {
    return Array.from(this.tasks.values())
  }

  getTasksByType(type) {
    return this.getAllTasks().filter(task => task.type === type)
  }

  getTasksByStatus(status) {
    return this.getAllTasks().filter(task => task.status === status)
  }

  getBackgroundTasks() {
    return this.getAllTasks().filter(task => 
      (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.PENDING) &&
      task.isBackgrounded !== false
    )
  }

  getActiveTasks() {
    return this.getAllTasks().filter(task => 
      task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.PENDING
    )
  }

  evictOldestTask() {
    const tasks = this.getAllTasks()
      .filter(t => isTerminalTaskStatus(t.status))
      .sort((a, b) => a.endTime - b.endTime)

    if (tasks.length > 0) {
      this.removeTask(tasks[0].id)
    }
  }

  cleanupCompletedTasks() {
    const now = Date.now()
    const maxAge = 3600000

    for (const [id, task] of this.tasks) {
      if (isTerminalTaskStatus(task.status) && 
          task.endTime && 
          now - task.endTime > maxAge) {
        this.removeTask(id)
      }
    }
  }

  removeTask(taskId) {
    const task = this.tasks.get(taskId)
    if (task) {
      this.tasks.delete(taskId)
      this.emit('task:removed', { id: taskId, task })
    }
  }

  getStats() {
    const tasks = this.getAllTasks()
    const byStatus = {}
    const byType = {}

    for (const task of tasks) {
      byStatus[task.status] = (byStatus[task.status] || 0) + 1
      byType[task.type] = (byType[task.type] || 0) + 1
    }

    return {
      total: tasks.length,
      active: this.getActiveTasks().length,
      background: this.getBackgroundTasks().length,
      byStatus,
      byType,
    }
  }

  async shutdown() {
    this.stopCleanupTimer()
    
    for (const task of this.getActiveTasks()) {
      if (task.abortController) {
        task.abortController.abort()
      }
    }

    this.emit('system:shutdown')
  }
}

class TaskExecutor extends EventEmitter {
  constructor(taskSystem) {
    super()
    this.taskSystem = taskSystem
    this.taskImplementations = new Map()
  }

  registerTaskImplementation(taskImpl) {
    this.taskImplementations.set(taskImpl.type, taskImpl)
    this.emit('implementation:registered', { type: taskImpl.type })
  }

  getTaskImplementation(type) {
    return this.taskImplementations.get(type)
  }

  async killTask(taskId) {
    const task = this.taskSystem.getTask(taskId)
    if (!task) {
      throw new Error(`Task ${taskId} not found`)
    }

    if (isTerminalTaskStatus(task.status)) {
      throw new Error(`Task ${taskId} is not running (status: ${task.status})`)
    }

    const taskImpl = this.getTaskImplementation(task.type)
    if (!taskImpl) {
      throw new Error(`Unsupported task type: ${task.type}`)
    }

    await taskImpl.kill(taskId, this.taskSystem)

    this.taskSystem.updateTaskState(taskId, t => ({
      ...t,
      status: TASK_STATUS.KILLED,
      endTime: Date.now(),
      notified: true,
    }))

    this.emit('task:killed', { id: taskId })
  }

  async stopTask(taskId) {
    return this.killTask(taskId)
  }
}

module.exports = {
  TaskSystem,
  TaskExecutor,
  TASK_STATUS,
  TASK_TYPES,
  TASK_ID_PREFIXES,
  generateTaskId,
  createTaskStateBase,
  isTerminalTaskStatus,
}

const taskSystem = new TaskSystem()
const taskExecutor = new TaskExecutor(taskSystem)

const { DreamTask } = require('./dream')
const { ShellTask } = require('./shell')
const { AgentTask } = require('./agent')

taskExecutor.registerTaskImplementation(DreamTask)
taskExecutor.registerTaskImplementation(ShellTask)
taskExecutor.registerTaskImplementation(AgentTask)

module.exports = {
  ...module.exports,
  taskSystem,
  taskExecutor,
  DreamTask,
  ShellTask,
  AgentTask,
}
