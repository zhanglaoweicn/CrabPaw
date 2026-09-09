const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
  // 新增：LLM 生命周期钩子
  'PreLLMCall',
  'PostLLMCall',
];

const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled'
];

const SUBAGENT_TYPES = {
  RESEARCH: 'research',
  IMPLEMENT: 'implement',
  VERIFY: 'verify',
  ANALYZE: 'analyze'
};

const MESSAGE_TYPES = {
  USER: 'user',
  ASSISTANT: 'assistant',
  SYSTEM: 'system',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result'
};

const SESSION_STATES = {
  INITIALIZING: 'initializing',
  READY: 'ready',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ERROR: 'error',
  TERMINATED: 'terminated'
};

const TOOL_PERMISSIONS = {
  ALLOW: 'allow',
  DENY: 'deny',
  ASK: 'ask'
};

module.exports = {
  HOOK_EVENTS,
  EXIT_REASONS,
  SUBAGENT_TYPES,
  MESSAGE_TYPES,
  SESSION_STATES,
  TOOL_PERMISSIONS
};
