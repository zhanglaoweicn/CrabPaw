const TASKFLOW_SYNC_MODE = {
  MANAGED: 'managed',
  TASK_MIRRORED: 'task_mirrored'
};

const TASKFLOW_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING: 'waiting',
  BLOCKED: 'blocked',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  LOST: 'lost'
};

const TASKFLOW_NOTIFY_POLICY = {
  ALWAYS: 'always',
  ON_SUCCESS: 'on_success',
  ON_FAILURE: 'on_failure',
  NEVER: 'never'
};

const TASKFLOW_STEP_TYPE = {
  SKILL: 'skill',
  TASK: 'task',
  CONDITION: 'condition',
  GATE: 'gate',
  PARALLEL: 'parallel',
  SEQUENCE: 'sequence',
  DELAY: 'delay',
  WEBHOOK: 'webhook',
  APPROVAL: 'approval',
  LOOP: 'loop',
  LLM: 'llm',
  SUB_AGENT: 'sub_agent'
};

const TASKFLOW_STEP_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  WAITING_APPROVAL: 'waiting_approval'
};

const TASKFLOW_TRIGGER_TYPE = {
  MANUAL: 'manual',
  SCHEDULE: 'schedule',
  EVENT: 'event',
  WEBHOOK: 'webhook',
  FILE: 'file'
};

const TASKFLOW_ERROR_CATEGORY = {
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  PERMISSION: 'permission',
  DATA_FORMAT: 'data_format',
  PROVIDER: 'provider',
  RATE_LIMIT: 'rate_limit',
  CONTEXT_LIMIT: 'context_limit',
  VALIDATION: 'validation',
  UNKNOWN: 'unknown'
};

const TASKFLOW_ERROR_SEVERITY = {
  TRANSIENT: 'transient',
  RECOVERABLE: 'recoverable',
  FATAL: 'fatal'
};

const TASKFLOW_APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired'
};

const TASKFLOW_LOOP_MODE = {
  FIXED: 'fixed',
  CONDITION: 'condition',
  COLLECTION: 'collection'
};

const TASKFLOW_LLM_PROVIDER_STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  FAILED: 'failed',
  RATE_LIMITED: 'rate_limited'
};

const TASKFLOW_SUB_AGENT_STATUS = {
  SPAWNED: 'spawned',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  KILLED: 'killed'
};

const TASKFLOW_WORKFLOW_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  ...Object.fromEntries(
    Object.entries(TASKFLOW_STATUS).filter(([k]) => ['RUNNING', 'FAILED', 'CANCELLED'].includes(k))
  ),
  PAUSED: 'paused',
  COMPLETED: TASKFLOW_STATUS.SUCCEEDED
};

const TASKFLOW_NODE_TYPE = TASKFLOW_STEP_TYPE;

const TASKFLOW_ERROR_STRATEGY = {
  RETRY: 'retry',
  FALLBACK: 'fallback',
  IGNORE: 'ignore',
  STOP: 'stop',
  DEGRADE: 'degrade'
};

const TASKFLOW_RETRY_BACKOFF = {
  LINEAR: 'linear',
  EXPONENTIAL: 'exponential',
  FIXED: 'fixed'
};

module.exports = {
  TASKFLOW_SYNC_MODE,
  TASKFLOW_STATUS,
  TASKFLOW_NOTIFY_POLICY,
  TASKFLOW_STEP_TYPE,
  TASKFLOW_STEP_STATUS,
  TASKFLOW_TRIGGER_TYPE,
  TASKFLOW_ERROR_CATEGORY,
  TASKFLOW_ERROR_SEVERITY,
  TASKFLOW_APPROVAL_STATUS,
  TASKFLOW_LOOP_MODE,
  TASKFLOW_LLM_PROVIDER_STATUS,
  TASKFLOW_SUB_AGENT_STATUS,
  TASKFLOW_WORKFLOW_STATUS,
  TASKFLOW_NODE_TYPE,
  TASKFLOW_ERROR_STRATEGY,
  TASKFLOW_RETRY_BACKOFF
};
