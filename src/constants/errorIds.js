let nextErrorId = 1;

const ERROR_IDS = {
  UNKNOWN: nextErrorId++,
  API_ERROR: nextErrorId++,
  NETWORK_ERROR: nextErrorId++,
  TIMEOUT: nextErrorId++,
  INVALID_INPUT: nextErrorId++,
  FILE_NOT_FOUND: nextErrorId++,
  PERMISSION_DENIED: nextErrorId++,
  COMMAND_NOT_FOUND: nextErrorId++,
  SKILL_EXECUTION_FAILED: nextErrorId++,
  CHANNEL_ERROR: nextErrorId++,
  HISTORY_ERROR: nextErrorId++,
  SCHEDULER_ERROR: nextErrorId++,
  CONFIG_ERROR: nextErrorId++,
  STATE_ERROR: nextErrorId++,
  AI_ERROR: nextErrorId++
};

function getErrorName(id) {
  for (const [name, value] of Object.entries(ERROR_IDS)) {
    if (value === id) return name;
  }
  return 'UNKNOWN';
}

module.exports = {
  ERROR_IDS,
  getErrorName,
  nextErrorId
};
