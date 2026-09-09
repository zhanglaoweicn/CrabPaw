const { taskStore, taskFlowStore, initialize, close } = require('./task-store');
const { taskExecutor, taskFlowRegistry, TASK_STATUS, FLOW_STATUS } = require('./task-executor');
const { ownerAccess, PermissionError, SCOPE_KINDS } = require('./task-owner-access');
const { taskMaintenance } = require('./task-maintenance');
const { taskExecutionHistory } = require('./task-execution-history');
const { 
  sanitizeText, 
  sanitizeTaskError, 
  sanitizeTaskRecord, 
  sanitizeTaskList 
} = require('./task-sanitizer');
const { TodoManager, globalTodoManager } = require('./todo-tool');

async function initializeTaskSystem() {
  await initialize();
  // 初始化执行历史持久化
  const { DATA_DIR } = require('../../core/config');
  taskExecutionHistory.initialize(DATA_DIR);
  taskMaintenance.start();
  console.log('✅ 任务系统已初始化');
}

async function shutdownTaskSystem() {
  taskMaintenance.stop();
  taskExecutionHistory.close();
  close();
  console.log('✅ 任务系统已关闭');
}

module.exports = {
  initializeTaskSystem,
  shutdownTaskSystem,
  
  taskStore,
  taskFlowStore,
  taskExecutor,
  taskFlowRegistry,
  ownerAccess,
  taskMaintenance,
  
  TodoManager,
  globalTodoManager,
  
  TASK_STATUS,
  FLOW_STATUS,
  SCOPE_KINDS,
  PermissionError,
  
  sanitizeText,
  sanitizeTaskError,
  sanitizeTaskRecord,
  sanitizeTaskList
};
