const { getTaskFlowRegistry, TaskFlowRegistry } = require('./taskflow-registry');
const { getTaskFlowRuntime, TaskFlowRuntime, FlowEngine, BUILTIN_FLOWS } = require('./taskflow-runtime');
const { getTaskFlowStore, TaskFlowStore } = require('./taskflow-store');
const { getIntentAnalyzer, IntentAnalyzer, INTENT_TYPES } = require('./intent-analyzer');
const { getWorkflowTemplateEngine } = require('./workflow-template-engine');
const { ApprovalGate, getApprovalGate } = require('./approval-gate');
const { classifyError, ErrorClassifier } = require('./error-classifier');
const { LlmProviderManager, getLlmProviderManager } = require('./llm-provider-manager');
const { SubAgentOrchestrator } = require('./sub-agent-orchestrator');
const { TaskWorkflowOrchestrator, getTaskWorkflowOrchestrator, WORKFLOW_STATUS, WORKFLOW_NODE_TYPES } = require('../tasks/core/task-workflow-orchestrator');
const { getAdapterRegistry, AdapterRegistry } = require('./adapters');
const {
  TASKFLOW_SYNC_MODE,
  TASKFLOW_STATUS,
  TASKFLOW_NOTIFY_POLICY,
  TASKFLOW_STEP_TYPE,
  TASKFLOW_STEP_STATUS,
  TASKFLOW_ERROR_CATEGORY,
  TASKFLOW_ERROR_SEVERITY,
  TASKFLOW_ERROR_STRATEGY,
  TASKFLOW_APPROVAL_STATUS,
  TASKFLOW_LOOP_MODE,
  TASKFLOW_LLM_PROVIDER_STATUS,
  TASKFLOW_SUB_AGENT_STATUS,
  TASKFLOW_RETRY_BACKOFF
} = require('./taskflow-types');

let initialized = false;

async function initializeTaskFlow() {
  if (initialized) return;

  const registry = getTaskFlowRegistry();
  const runtime = getTaskFlowRuntime();

  await registry.initialize();
  await runtime.initialize();

  initialized = true;
  console.log('✅ TaskFlow 系统初始化完成');
}

async function createFlow(params) {
  await initializeTaskFlow();
  const registry = getTaskFlowRegistry();
  return await registry.createFlow(params);
}

async function executeFlow(flowId, context = {}) {
  await initializeTaskFlow();
  const runtime = getTaskFlowRuntime();
  return await runtime.executeFlow(flowId, context);
}

async function getFlow(flowId) {
  await initializeTaskFlow();
  const registry = getTaskFlowRegistry();
  return await registry.getFlow(flowId);
}

async function listFlows(filter = {}) {
  await initializeTaskFlow();
  const registry = getTaskFlowRegistry();
  return await registry.listFlows(filter);
}

async function cancelFlow(flowId) {
  await initializeTaskFlow();
  const runtime = getTaskFlowRuntime();
  return await runtime.cancelFlow(flowId);
}

async function deleteFlow(flowId) {
  await initializeTaskFlow();
  const registry = getTaskFlowRegistry();
  return await registry.deleteFlow(flowId);
}

async function getFlowStatus(flowId) {
  await initializeTaskFlow();
  const runtime = getTaskFlowRuntime();
  return await runtime.getFlowStatus(flowId);
}

async function getStats() {
  await initializeTaskFlow();
  const registry = getTaskFlowRegistry();
  return await registry.getStats();
}

function getMetrics() {
  const runtime = getTaskFlowRuntime();
  return runtime.getMetrics();
}

function getIntentMetrics() {
  const analyzer = getIntentAnalyzer();
  return analyzer.getUsageStats();
}

function setSkillExecutor(executor) {
  const runtime = getTaskFlowRuntime();
  runtime.setSkillExecutor(executor);
}

function setTaskExecutor(executor) {
  const runtime = getTaskFlowRuntime();
  runtime.setTaskExecutor(executor);
}

function setBroadcastFn(fn) {
  const runtime = getTaskFlowRuntime();
  runtime.setBroadcastFn(fn);
}

function setSkillRouter(router) {
  const analyzer = getIntentAnalyzer();
  analyzer.setSkillRouter(router);
}

function setTaskAdapter(adapter) {
  const analyzer = getIntentAnalyzer();
  analyzer.setTaskAdapter(adapter);
}

async function recoverLostFlows() {
  await initializeTaskFlow();
  const runtime = getTaskFlowRuntime();
  return await runtime.recoverLostFlows();
}

async function resumeFlow(resumeToken, approvalResult) {
  await initializeTaskFlow();
  const runtime = getTaskFlowRuntime();
  return await runtime.resumeFlow(resumeToken, approvalResult);
}

function registerLlmProvider(id, providerFn, config) {
  const manager = getLlmProviderManager();
  manager.registerProvider(id, providerFn, config);
}

function getLlmProviderStatuses() {
  const manager = getLlmProviderManager();
  return manager.getAllProviderStatuses();
}

function classifyWorkflowError(error) {
  return classifyError(error);
}

function getTaskFlowAPI() {
  return {
    createFlow,
    executeFlow,
    getFlow,
    listFlows,
    cancelFlow,
    deleteFlow,
    getFlowStatus,
    getStats,
    getMetrics,
    getIntentMetrics,
    setSkillExecutor,
    setTaskExecutor,
    setBroadcastFn,
    setSkillRouter,
    setTaskAdapter,
    recoverLostFlows,
    resumeFlow,
    registerLlmProvider,
    getLlmProviderStatuses,
    classifyWorkflowError
  };
}

module.exports = {
  // Workflow engine (deprecated wrapper exports)
  flowEngine: { FlowEngine, BUILTIN_FLOWS },
  initializeTaskFlow,
  createFlow,
  executeFlow,
  getFlow,
  listFlows,
  cancelFlow,
  deleteFlow,
  getFlowStatus,
  getStats,
  getMetrics,
  getIntentMetrics,
  setSkillExecutor,
  setTaskExecutor,
  setBroadcastFn,
  setSkillRouter,
  setTaskAdapter,
  recoverLostFlows,
  resumeFlow,
  registerLlmProvider,
  getLlmProviderStatuses,
  classifyWorkflowError,
  getTaskFlowAPI,

  TaskFlowRegistry,
  TaskFlowRuntime,
  taskWorkflowOrchestrator: { TaskWorkflowOrchestrator, getTaskWorkflowOrchestrator, WORKFLOW_STATUS, WORKFLOW_NODE_TYPES },
  TaskFlowStore,
  IntentAnalyzer,
  ApprovalGate,
  ErrorClassifier,
  LlmProviderManager,
  SubAgentOrchestrator,
  AdapterRegistry,

  // Task workflow orchestrator (auxiliary engine)
  TaskWorkflowOrchestrator,
  getTaskFlowRegistry,
  getTaskFlowRuntime,
  getTaskFlowStore,
  getIntentAnalyzer,
  getWorkflowTemplateEngine,
  getApprovalGate,
  getLlmProviderManager,
  getAdapterRegistry,

  TASKFLOW_SYNC_MODE,
  TASKFLOW_STATUS,
  TASKFLOW_NOTIFY_POLICY,
  TASKFLOW_STEP_TYPE,
  TASKFLOW_STEP_STATUS,
  TASKFLOW_ERROR_CATEGORY,
  TASKFLOW_ERROR_SEVERITY,
  TASKFLOW_ERROR_STRATEGY,
  TASKFLOW_APPROVAL_STATUS,
  TASKFLOW_LOOP_MODE,
  TASKFLOW_LLM_PROVIDER_STATUS,
  TASKFLOW_SUB_AGENT_STATUS,
  TASKFLOW_RETRY_BACKOFF,
  INTENT_TYPES
};
