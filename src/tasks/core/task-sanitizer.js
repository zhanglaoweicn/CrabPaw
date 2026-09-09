const INTERNAL_CONTEXT_MARKERS = [
  'OpenClaw runtime context',
  '[Internal task completion event]',
  'Keep internal details private',
  'INTERNAL_RUNTIME_CONTEXT'
];

const SENSITIVE_PATTERNS = [
  /api[_-]?key[=:]\s*\S+/gi,
  /secret[=:]\s*\S+/gi,
  /token[=:]\s*\S+/gi,
  /password[=:]\s*\S+/gi,
  /Bearer\s+\S+/gi,
  // Only match known secret-looking strings (mix of upper+lower+digits is more likely a secret)
  /(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z0-9_-]{32,}/g,
  // Common API key prefixes
  /sk-[a-zA-Z0-9]{32,}/g,
  /(?:AKIA|ASIA)[A-Z0-9]{16,}/g,
];

const MAX_TEXT_LENGTH = 500;
const MAX_ERROR_LENGTH = 300;

function stripInternalContext(text) {
  if (!text || typeof text !== 'string') return '';
  
  let result = text;
  
  for (const marker of INTERNAL_CONTEXT_MARKERS) {
    const index = result.indexOf(marker);
    if (index !== -1) {
      result = result.substring(0, index);
    }
  }
  
  return result.trim();
}

function stripSensitiveInfo(text) {
  if (!text || typeof text !== 'string') return '';
  
  let result = text;
  
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  
  return result;
}

function truncateText(text, maxLength = MAX_TEXT_LENGTH) {
  if (!text || typeof text !== 'string') return '';
  
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  
  return trimmed.substring(0, maxLength - 3) + '...';
}

function sanitizeText(text, options = {}) {
  if (!text) return '';
  
  const {
    maxLength = MAX_TEXT_LENGTH,
    stripSensitive = true,
    stripInternal = true,
    errorContext = false
  } = options;
  
  let result = String(text);
  
  if (stripInternal) {
    result = stripInternalContext(result);
  }
  
  if (stripSensitive) {
    result = stripSensitiveInfo(result);
  }
  
  result = result.replace(/\s+/g, ' ').trim();
  
  const actualMaxLength = errorContext ? Math.min(maxLength, MAX_ERROR_LENGTH) : maxLength;
  
  return truncateText(result, actualMaxLength);
}

function sanitizeTaskError(error) {
  if (!error) return '';
  
  let errorMessage = '';
  
  if (error instanceof Error) {
    errorMessage = error.message || error.name || 'Unknown error';
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else if (typeof error === 'object') {
    try {
      errorMessage = JSON.stringify(error);
    } catch (e) {
      errorMessage = String(error);
    }
  } else {
    errorMessage = String(error);
  }
  
  return sanitizeText(errorMessage, {
    maxLength: MAX_ERROR_LENGTH,
    stripSensitive: true,
    stripInternal: true,
    errorContext: true
  });
}

function sanitizeTaskProgress(summary) {
  return sanitizeText(summary, {
    maxLength: 200,
    stripSensitive: true,
    stripInternal: true
  });
}

function sanitizeTaskTerminal(summary) {
  return sanitizeText(summary, {
    maxLength: MAX_TEXT_LENGTH,
    stripSensitive: true,
    stripInternal: true,
    errorContext: true
  });
}

function sanitizeTaskContent(content) {
  return sanitizeText(content, {
    maxLength: MAX_TEXT_LENGTH,
    stripSensitive: false,
    stripInternal: true
  });
}

function sanitizeTaskMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return {};
  
  const sanitized = {};
  
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      sanitized[key] = sanitizeText(value, { stripSensitive: true });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (value === null) {
      sanitized[key] = null;
    } else {
      try {
        sanitized[key] = sanitizeText(JSON.stringify(value), { stripSensitive: true });
      } catch (e) {
        sanitized[key] = '[sanitized]';
      }
    }
  }
  
  return sanitized;
}

function sanitizeTaskRecord(task) {
  if (!task || typeof task !== 'object') return null;
  
  return {
    ...task,
    content: sanitizeTaskContent(task.content),
    progressSummary: task.progressSummary ? sanitizeTaskProgress(task.progressSummary) : null,
    error: task.error ? sanitizeTaskError(task.error) : null,
    terminalSummary: task.terminalSummary ? sanitizeTaskTerminal(task.terminalSummary) : null,
    metadata: task.metadata ? sanitizeTaskMetadata(task.metadata) : {}
  };
}

function sanitizeTaskList(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks.map(sanitizeTaskRecord).filter(Boolean);
}

module.exports = {
  sanitizeText,
  sanitizeTaskError,
  sanitizeTaskProgress,
  sanitizeTaskTerminal,
  sanitizeTaskContent,
  sanitizeTaskMetadata,
  sanitizeTaskRecord,
  sanitizeTaskList,
  stripInternalContext,
  stripSensitiveInfo,
  truncateText,
  MAX_TEXT_LENGTH,
  MAX_ERROR_LENGTH
};
