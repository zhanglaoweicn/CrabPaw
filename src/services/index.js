/**
 * Services Index
 *
 * 统一服务入口
 * 梦境系统：EnhancedAutoDreamService（5阶段：Orient/Gather/Consolidate/Prune/Finalize）
 * autoDream.js / dreamIntegration.js / MemoryConsolidationService 已删除（死代码，无消费者）
 */

const { PromptFingerprint, promptFingerprint } = require('./prompt-fingerprint');
const { ToolOptimizer, toolOptimizer } = require('./tool-optimizer');
const { TaskProgressTracker, taskProgressTracker } = require('./task-progress');
const { SmartDreamScheduler, smartDreamScheduler } = require('./smart-dream-scheduler');
const { DreamReplay, dreamReplay } = require('./dream-replay');
const { memoryExtractionService, MemoryExtractionService } = require('./memoryExtraction');

module.exports = {
  PromptFingerprint,
  promptFingerprint,
  ToolOptimizer,
  toolOptimizer,
  TaskProgressTracker,
  taskProgressTracker,
  SmartDreamScheduler,
  smartDreamScheduler,
  DreamReplay,
  dreamReplay,
  memoryExtractionService,
  MemoryExtractionService,
};
