/**
 * 共享常量定义
 * 统一管理项目中多处使用的常量，避免重复定义导致不一致
 */

const TASK_STATES = Object.freeze({
  TRIAGE: 'triage',
  TODO: 'todo',
  CLAIMED: 'claimed',
  RUNNING: 'running',
  DONE: 'done',
  BLOCKED: 'blocked',
  FAILED: 'failed',
});

module.exports = {
  TASK_STATES,
};
