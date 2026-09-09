/**
 * Agent Task
 * 
 * 借鉴 Claude Code 的 LocalAgentTask 实现
 * 支持本地代理任务执行
 */

const {
  generateTaskId,
  createTaskStateBase,
} = require('./utils')
const {
  TASK_STATUS,
  TASK_TYPES,
} = require('./constants')

const MAX_RECENT_ACTIVITIES = 5

function isLocalAgentTask(task) {
  return task && task.type === TASK_TYPES.LOCAL_AGENT
}

function createProgressTracker() {
  return {
    toolUseCount: 0,
    latestInputTokens: 0,
    cumulativeOutputTokens: 0,
    recentActivities: [],
  }
}

function getTokenCountFromTracker(tracker) {
  return tracker.latestInputTokens + tracker.cumulativeOutputTokens
}

function updateProgressFromMessage(tracker, message, resolveActivityDescription) {
  if (message.type !== 'assistant') return

  const usage = message.message.usage
  if (usage) {
    tracker.latestInputTokens = usage.input_tokens + 
      (usage.cache_creation_input_tokens || 0) + 
      (usage.cache_read_input_tokens || 0)
    tracker.cumulativeOutputTokens += usage.output_tokens
  }

  for (const content of message.message.content) {
    if (content.type === 'tool_use') {
      tracker.toolUseCount++

      const input = content.input
      const activityDescription = resolveActivityDescription
        ? resolveActivityDescription(content.name, input)
        : undefined

      tracker.recentActivities.push({
        toolName: content.name,
        input,
        activityDescription,
      })
    }
  }

  while (tracker.recentActivities.length > MAX_RECENT_ACTIVITIES) {
    tracker.recentActivities.shift()
  }
}

function getProgressUpdate(tracker) {
  return {
    toolUseCount: tracker.toolUseCount,
    tokenCount: getTokenCountFromTracker(tracker),
    lastActivity: tracker.recentActivities.length > 0
      ? tracker.recentActivities[tracker.recentActivities.length - 1]
      : undefined,
    recentActivities: [...tracker.recentActivities],
  }
}

function registerAgentTask(taskSystem, opts) {
  const {
    prompt,
    description,
    agentType,
    agentId,
    selectedAgent,
    model,
    toolUseId,
  } = opts

  const id = generateTaskId(TASK_TYPES.LOCAL_AGENT)

  const task = {
    ...createTaskStateBase(id, TASK_TYPES.LOCAL_AGENT, description || prompt),
    type: TASK_TYPES.LOCAL_AGENT,
    status: TASK_STATUS.PENDING,
    agentId: agentId || id,
    prompt,
    selectedAgent,
    agentType: agentType || 'default',
    model,
    toolUseId,
    progress: null,
    retrieved: false,
    messages: [],
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  }

  taskSystem.registerTask(task)
  taskSystem.emit('agent:registered', { id, agentType })

  return id
}

function updateAgentProgress(taskSystem, taskId, progress) {
  taskSystem.updateTaskState(taskId, task => {
    if (!isLocalAgentTask(task)) return task

    return {
      ...task,
      progress,
    }
  })
}

function completeAgentTask(taskSystem, taskId, result) {
  taskSystem.updateTaskState(taskId, task => {
    if (!isLocalAgentTask(task)) return task

    return {
      ...task,
      status: TASK_STATUS.COMPLETED,
      endTime: Date.now(),
      notified: true,
      result,
    }
  })

  taskSystem.emit('agent:completed', { id: taskId, result })
}

function failAgentTask(taskSystem, taskId, error) {
  taskSystem.updateTaskState(taskId, task => {
    if (!isLocalAgentTask(task)) return task

    return {
      ...task,
      status: TASK_STATUS.FAILED,
      endTime: Date.now(),
      notified: true,
      error: error.message || error,
    }
  })

  taskSystem.emit('agent:failed', { id: taskId, error })
}

function queuePendingMessage(taskSystem, taskId, message) {
  taskSystem.updateTaskState(taskId, task => {
    if (!isLocalAgentTask(task)) return task

    return {
      ...task,
      pendingMessages: [...task.pendingMessages, message],
    }
  })
}

function drainPendingMessages(taskSystem, taskId) {
  const task = taskSystem.getTask(taskId)
  if (!isLocalAgentTask(task) || task.pendingMessages.length === 0) {
    return []
  }

  const drained = task.pendingMessages

  taskSystem.updateTaskState(taskId, t => ({
    ...t,
    pendingMessages: [],
  }))

  return drained
}

const AgentTask = {
  name: 'AgentTask',
  type: TASK_TYPES.LOCAL_AGENT,

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

    taskSystem.emit('agent:killed', { id: taskId })
  },
}

module.exports = {
  AgentTask,
  isLocalAgentTask,
  createProgressTracker,
  getTokenCountFromTracker,
  updateProgressFromMessage,
  getProgressUpdate,
  registerAgentTask,
  updateAgentProgress,
  completeAgentTask,
  failAgentTask,
  queuePendingMessage,
  drainPendingMessages,
  MAX_RECENT_ACTIVITIES,
}
