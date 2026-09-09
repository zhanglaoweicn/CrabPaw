/**
 * Dream Task
 * 
 * 借鉴 Claude Code 的 DreamTask 实现
 * 用于内存整合的后台任务
 */

const {
  generateTaskId,
  createTaskStateBase,
} = require('./utils')
const {
  TASK_STATUS,
  TASK_TYPES,
} = require('./constants')

const MAX_TURNS = 30

const DREAM_PHASE = {
  STARTING: 'starting',
  UPDATING: 'updating',
}

function isDreamTask(task) {
  return task && task.type === TASK_TYPES.DREAM
}

function registerDreamTask(taskSystem, opts) {
  const {
    sessionsReviewing,
    priorMtime,
    abortController,
  } = opts

  const id = generateTaskId(TASK_TYPES.DREAM)
  
  const task = {
    ...createTaskStateBase(id, TASK_TYPES.DREAM, 'dreaming'),
    type: TASK_TYPES.DREAM,
    status: TASK_STATUS.RUNNING,
    phase: DREAM_PHASE.STARTING,
    sessionsReviewing,
    filesTouched: [],
    turns: [],
    abortController,
    priorMtime,
    isBackgrounded: true,
  }

  taskSystem.registerTask(task)
  taskSystem.emit('dream:started', { id, sessionsReviewing })

  return id
}

function addDreamTurn(taskSystem, taskId, turn, touchedPaths) {
  taskSystem.updateTaskState(taskId, task => {
    if (!isDreamTask(task)) return task

    const seen = new Set(task.filesTouched)
    const newTouched = touchedPaths.filter(p => !seen.has(p) && seen.add(p))

    if (turn.text === '' && 
        turn.toolUseCount === 0 && 
        newTouched.length === 0) {
      return task
    }

    return {
      ...task,
      phase: newTouched.length > 0 ? DREAM_PHASE.UPDATING : task.phase,
      filesTouched: newTouched.length > 0
        ? [...task.filesTouched, ...newTouched]
        : task.filesTouched,
      turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),
    }
  })
}

function completeDreamTask(taskSystem, taskId) {
  taskSystem.updateTaskState(taskId, task => {
    if (!isDreamTask(task)) return task

    return {
      ...task,
      status: TASK_STATUS.COMPLETED,
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
    }
  })

  taskSystem.emit('dream:completed', { id: taskId })
}

function failDreamTask(taskSystem, taskId) {
  taskSystem.updateTaskState(taskId, task => {
    if (!isDreamTask(task)) return task

    return {
      ...task,
      status: TASK_STATUS.FAILED,
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
    }
  })

  taskSystem.emit('dream:failed', { id: taskId })
}

const DreamTask = {
  name: 'DreamTask',
  type: TASK_TYPES.DREAM,

  async kill(taskId, taskSystem) {
    const task = taskSystem.getTask(taskId)
    if (!task || task.status !== TASK_STATUS.RUNNING) return

    if (task.abortController) {
      task.abortController.abort()
    }

    taskSystem.updateTaskState(taskId, t => ({
      ...t,
      status: TASK_STATUS.KILLED,
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
    }))

    taskSystem.emit('dream:killed', { id: taskId })
  },
}

module.exports = {
  DreamTask,
  DREAM_PHASE,
  isDreamTask,
  registerDreamTask,
  addDreamTurn,
  completeDreamTask,
  failDreamTask,
  MAX_TURNS,
}
