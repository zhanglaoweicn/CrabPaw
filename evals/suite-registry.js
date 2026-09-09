// eval 套件统一注册表——evals/index.js 与 evals/regression-check.js 的单一事实源。
// 2026-08-28: 修复 regression-check 自维护清单引用已删除的 test-cases/autopilot
// 导致 eval:regression 与 CI 回归检查 require 阶段 crash。新增套件只改本文件。
const toolContracts = require('./test-cases/tool-contracts');
const hooks = require('./test-cases/hooks');
const taskMode = require('./test-cases/task-mode');
const loopDetection = require('./test-cases/loop-detection');
const sandbox = require('./test-cases/sandbox');
const personalization = require('./test-cases/personalization');
const harnessMetrics = require('./test-cases/harness-metrics');
const harnessContracts = require('./test-cases/harness-contracts');
const harnessLifecycle = require('./test-cases/harness-lifecycle');
const condition = require('./test-cases/condition');
const loop = require('./test-cases/loop');
const evolutionCoordinator = require('./test-cases/evolution-coordinator');
const templateConditionLoop = require('./test-cases/template-condition-loop');
const multiFormatOutput = require('./test-cases/multi-format-output');
const budgetEnforcer = require('./test-cases/budget-enforcer');
const toolOrchestrator = require('./test-cases/tool-orchestrator');
const eventBus = require('./test-cases/event-bus');
const dryRunInspector = require('./test-cases/dry-run-inspector');
const profileSystem = require('./test-cases/profile-system');
const tagReinforcement = require('./test-cases/tag-reinforcement');
const memorySystem = require('./test-cases/memory-system');
const pluginSystem = require('./test-cases/plugin-system');
const agentSystem = require('./test-cases/agent-system');
const entertainmentTools = require('./test-cases/entertainment-tools');
const voiceEvolution = require('./test-cases/voice-evolution');
const expertCollab = require('./test-cases/expert-collaboration');
const skillExecutors = require('./test-cases/skill-executors');
const nl2sql = require('./test-cases/nl2sql');
const dataImport = require('./test-cases/data-import');
const businessData = require('./test-cases/business-data');
const riskAlert = require('./test-cases/risk-alert');
const taskOrchestration = require('./test-cases/task-orchestration');
const analysisPipeline = require('./test-cases/analysis-pipeline');
const scenarioReminders = require('./test-cases/scenario-reminders');
const trainTools = require('./test-cases/train-tools');
const stockVoice = require('./test-cases/stock-voice');
const typhoon = require('./test-cases/typhoon');
const bossProfile = require('./test-cases/boss-profile');
const embeddingPipeline = require('./test-cases/embedding-pipeline');
const topicIndex = require('./test-cases/topic-index');
const echoHints = require('./test-cases/echo-hints');
const interrupt = require('./test-cases/interrupt');
const voiceSession = require('./test-cases/voice-session');
const checkpointStore = require('./test-cases/checkpoint-store');
const ttsChunk = require('./test-cases/tts-chunk');
const workflowParallel = require('./test-cases/workflow-parallel');
const uiFarfield = require('./test-cases/ui-farfield');
const mcpSecurity = require('./test-cases/mcp-security');
const runStore = require('./test-cases/run-store');
const uiControlTools = require('./test-cases/ui-control-tools');
const wiringInvariants = require('./test-cases/wiring-invariants');
const siteKnowledgePack = require('./test-cases/site-knowledge-pack');
const capabilityMap = require('./test-cases/capability-map');
const planArtifact = require('./test-cases/plan-artifact');
const auditVisibility = require('./test-cases/audit-visibility');
const seamRoles = require('./test-cases/seam-roles');
const expertOrg = require('./test-cases/expert-org');
const agentLoop = require('./test-cases/agent-loop');

module.exports = {
  suites: [
    toolContracts, hooks, taskMode, loopDetection, sandbox, personalization,
    harnessMetrics, harnessContracts, harnessLifecycle, condition, loop,
    evolutionCoordinator, templateConditionLoop, multiFormatOutput, budgetEnforcer,
    toolOrchestrator, eventBus, dryRunInspector, profileSystem, tagReinforcement,
    memorySystem, pluginSystem, agentSystem, entertainmentTools, voiceEvolution,
    expertCollab, skillExecutors, nl2sql, dataImport, businessData, riskAlert,
    taskOrchestration, analysisPipeline, scenarioReminders, trainTools, stockVoice,
    typhoon, bossProfile, embeddingPipeline, topicIndex, echoHints, interrupt,
    voiceSession, checkpointStore, ttsChunk, workflowParallel, uiFarfield,
    mcpSecurity, runStore, uiControlTools, wiringInvariants, siteKnowledgePack,
    capabilityMap, planArtifact, auditVisibility, seamRoles, expertOrg, agentLoop,
  ],
};
