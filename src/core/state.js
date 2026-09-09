const crypto = require('crypto');
let state = null;

function _genSessionId() {
  return `session_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function getInitialState() {
  return {
    sessionId: _genSessionId(),
    startTime: Date.now(),
    lastInteractionTime: Date.now(),
    
    cwd: process.cwd(),
    projectRoot: null,
    
    totalCostUSD: 0,
    totalApiCalls: 0,
    totalMessages: 0,
    modelUsage: {},
    
    isInteractive: true,
    clientType: 'web',
    
    inMemoryErrorLog: [],
    maxErrorLogSize: 100,
    
    config: null,
    schedules: null,
    skills: null,
    
    activeTasks: new Map(),
    pendingConfirmations: new Map(),
    
    events: [],
    maxEventLogSize: 500
  };
}

function initState(config) {
  if (state) return state;
  
  state = getInitialState();
  state.config = config;
  state.projectRoot = config.projectRoot || process.cwd();
  
  console.log(`🆔 会话 ID: ${state.sessionId}`);
  return state;
}

function getState() {
  if (!state) {
    throw new Error('State not initialized. Call initState() first.');
  }
  return state;
}

function getSessionId() {
  return getState().sessionId;
}

function regenerateSessionId() {
  const s = getState();
  s.sessionId = _genSessionId();
  s.startTime = Date.now();
  s.totalCostUSD = 0;
  s.totalApiCalls = 0;
  s.totalMessages = 0;
  s.modelUsage = {};
  s.inMemoryErrorLog = [];
  s.activeTasks.clear();
  s.pendingConfirmations.clear();
  return s.sessionId;
}

function updateState(updates) {
  const s = getState();
  Object.assign(s, updates);
  s.lastInteractionTime = Date.now();
  return s;
}

function recordApiCall(model, inputTokens, outputTokens, cost) {
  const s = getState();
  s.totalApiCalls++;
  s.totalCostUSD += cost || 0;
  
  if (!s.modelUsage[model]) {
    s.modelUsage[model] = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0
    };
  }
  
  s.modelUsage[model].calls++;
  s.modelUsage[model].inputTokens += inputTokens || 0;
  s.modelUsage[model].outputTokens += outputTokens || 0;
  s.modelUsage[model].cost += cost || 0;
  
  return s;
}

function recordMessage() {
  const s = getState();
  s.totalMessages++;
  return s.totalMessages;
}

function logError(error, context = {}) {
  const s = getState();
  const entry = {
    error: error.message || String(error),
    stack: error.stack,
    context,
    timestamp: new Date().toISOString()
  };
  
  s.inMemoryErrorLog.push(entry);
  
  if (s.inMemoryErrorLog.length > s.maxErrorLogSize) {
    s.inMemoryErrorLog.shift();
  }
  
  console.error(`❌ [${entry.timestamp}] ${entry.error}`);
  return entry;
}

function getRecentErrors(limit = 10) {
  return getState().inMemoryErrorLog.slice(-limit);
}

function getSessionStats() {
  const s = getState();
  const uptime = Date.now() - s.startTime;
  
  return {
    sessionId: s.sessionId,
    uptime,
    uptimeFormatted: formatDuration(uptime),
    totalApiCalls: s.totalApiCalls,
    totalMessages: s.totalMessages,
    totalCostUSD: s.totalCostUSD.toFixed(4),
    modelUsage: s.modelUsage,
    errorCount: s.inMemoryErrorLog.length,
    activeTasks: s.activeTasks.size,
    pendingConfirmations: s.pendingConfirmations.size
  };
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function registerTask(taskId, task) {
  const s = getState();
  s.activeTasks.set(taskId, {
    ...task,
    startedAt: Date.now()
  });
  return taskId;
}

function completeTask(taskId) {
  const s = getState();
  const task = s.activeTasks.get(taskId);
  if (task) {
    s.activeTasks.delete(taskId);
    return {
      ...task,
      completedAt: Date.now(),
      duration: Date.now() - task.startedAt
    };
  }
  return null;
}


function recordEvent(eventType, data = {}) {
  const s = getState();
  const entry = {
    type: eventType,
    data,
    timestamp: Date.now()
  };
  
  s.events.push(entry);
  
  if (s.events.length > s.maxEventLogSize) {
    s.events.shift();
  }
  
  return entry;
}

function getRecentEvents(limit = 50, filter = {}) {
  let events = getState().events.slice(-limit * 2);
  
  if (filter.type) {
    events = events.filter(e => e.type === filter.type);
  }
  
  return events.slice(-limit);
}


module.exports = {
  initState,
  getState,
  getSessionId,
  regenerateSessionId,
  updateState,
  recordApiCall,
  recordMessage,
  logError,
  getRecentErrors,
  getSessionStats,
  registerTask,
  completeTask,
  recordEvent,
  getRecentEvents
};
