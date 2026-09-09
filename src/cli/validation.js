/**
 * CLI 验证工具
 */

const SENSITIVE_KEYS = new Set([
  'apikey', 'appsecret', 'secret', 'password',
  'token', 'credential', 'key', 'authorization'
]);

function isValidJson(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyString(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

function isArrayOfStrings(val) {
  return Array.isArray(val) && val.every(v => typeof v === 'string');
}

function validateConfig(data) {
  const errors = [];
  
  if (data.lark && typeof data.lark !== 'object') {
    errors.push('lark must be an object');
  }
  if (data.models && typeof data.models !== 'object') {
    errors.push('models must be an object');
  }
  if (data.agent && typeof data.agent !== 'object') {
    errors.push('agent must be an object');
  }
  if (data.user && typeof data.user !== 'object') {
    errors.push('user must be an object');
  }
  if (data.pushTargets && !isArrayOfStrings(data.pushTargets)) {
    errors.push('pushTargets must be an array of strings');
  }
  
  return errors;
}

function validateMemoryNote(data) {
  const errors = [];
  
  if (!isNonEmptyString(data.title)) {
    errors.push('title is required');
  }
  if (data.tags && !isArrayOfStrings(data.tags)) {
    errors.push('tags must be an array of strings');
  }
  
  return errors;
}

function sanitizeLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeLog);
  
  const sanitized = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object') {
        sanitized[key] = sanitizeLog(obj[key]);
      } else {
        sanitized[key] = obj[key];
      }
    }
  }
  return sanitized;
}

function safeLog(...args) {
  const sanitized = args.map(arg => {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      return sanitizeLog(arg);
    }
    return arg;
  });
  console.log(...sanitized);
}

function safeError(...args) {
  const sanitized = args.map(arg => {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      return sanitizeLog(arg);
    }
    return arg;
  });
  console.error(...sanitized);
}


/**
 * Sanitize request input to prevent injection attacks
 * @param {object} body - req.body
 * @returns {object} sanitized body
 */
function sanitizeInput(body) {
  if (!body || typeof body !== 'object') return {};
  const sanitized = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      sanitized[key] = value.substring(0, 10000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // eslint-disable-line no-control-regex
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      sanitized[key] = sanitizeInput(value);
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map(v => typeof v === 'string' ? v.substring(0, 10000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') : v); // eslint-disable-line no-control-regex
    }
  }
  return sanitized;
}
module.exports = {
  isValidJson,
  isNonEmptyString,
  isArrayOfStrings,
  validateConfig,
  sanitizeInput,
  validateMemoryNote,
  sanitizeLog,
  safeLog,
  safeError,
  SENSITIVE_KEYS
};
