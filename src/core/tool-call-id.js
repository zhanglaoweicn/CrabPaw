const crypto = require('crypto');

const STRICT9_LEN = 9;

const PROVIDER_ID_MODES = {
  deepseek: 'strict',
  qwen: 'strict',
  glm: 'strict',
  moonshot: 'strict9',
  yi: 'strict',
  baichuan: 'strict',
  minimax: 'strict',
  spark: 'strict',
  doubao: 'strict',
  mistral: 'strict9',
  kimi: 'kimi',
  openai: 'passthrough',
  anthropic: 'passthrough',
};

function shortHash(input, length) {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.slice(0, length).replace(/[^a-zA-Z0-9]/g, '');
}

function sanitizeToolCallId(id, mode = 'strict') {
  if (!id || typeof id !== 'string') {
    if (mode === 'strict9') {
      return 'defaultid';
    }
    return 'defaulttoolid';
  }

  if (mode === 'passthrough') {
    return id;
  }

  if (mode === 'kimi') {
    const kimiNative = /^functions\.[a-zA-Z0-9_]+:\d+$/.test(id);
    if (kimiNative) return id;
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, '');
    if (alphanumericOnly.length >= STRICT9_LEN) {
      return alphanumericOnly.slice(0, STRICT9_LEN);
    }
    return shortHash(id, STRICT9_LEN);
  }

  if (mode === 'strict9') {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, '');
    if (alphanumericOnly.length >= STRICT9_LEN) {
      return alphanumericOnly.slice(0, STRICT9_LEN);
    }
    if (alphanumericOnly.length > 0) {
      return shortHash(alphanumericOnly, STRICT9_LEN);
    }
    return shortHash('sanitized', STRICT9_LEN);
  }

  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, '');
  return alphanumericOnly.length > 0 ? alphanumericOnly : 'sanitizedtoolid';
}

function getProviderIdMode(provider) {
  return PROVIDER_ID_MODES[provider] || 'strict';
}

function sanitizeToolCallsForProvider(toolCalls, provider) {
  if (!Array.isArray(toolCalls)) return toolCalls;

  const mode = getProviderIdMode(provider);

  return toolCalls.map(tc => {
    if (!tc || typeof tc !== 'object') return tc;
    const sanitized = { ...tc };
    if (sanitized.id) {
      sanitized.id = sanitizeToolCallId(sanitized.id, mode);
    }
    if (sanitized.function && sanitized.function.name) {
      sanitized.function.name = sanitizeFunctionName(sanitized.function.name);
    }
    return sanitized;
  });
}

function sanitizeFunctionName(name) {
  if (!name || typeof name !== 'string') return name;
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sanitizeMessagesForProvider(messages, provider) {
  if (!Array.isArray(messages)) return messages;

  const mode = getProviderIdMode(provider);

  return messages.map(msg => {
    if (!msg || typeof msg !== 'object') return msg;
    const sanitized = { ...msg };

    if (sanitized.tool_calls) {
      sanitized.tool_calls = sanitized.tool_calls.map(tc => {
        if (!tc || typeof tc !== 'object') return tc;
        const s = { ...tc };
        if (s.id) {
          s.id = sanitizeToolCallId(s.id, mode);
        }
        if (s.function && s.function.name) {
          s.function.name = sanitizeFunctionName(s.function.name);
        }
        return s;
      });
    }

    if (sanitized.tool_call_id) {
      sanitized.tool_call_id = sanitizeToolCallId(sanitized.tool_call_id, mode);
    }

    if (sanitized.role === 'tool' && sanitized.name) {
      sanitized.name = sanitizeFunctionName(sanitized.name);
    }

    return sanitized;
  });
}

function validateToolCallIds(messages) {
  const issues = [];
  if (!Array.isArray(messages)) return issues;

  const toolCallIds = new Set();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!tc.id) {
          issues.push({ index: i, type: 'missing_id', message: '工具调用缺少 id' });
        } else if (toolCallIds.has(tc.id)) {
          issues.push({ index: i, type: 'duplicate_id', id: tc.id, message: `重复的工具调用 id: ${tc.id}` });
        } else {
          toolCallIds.add(tc.id);
        }
      }
    }

    if (msg.tool_call_id) {
      if (!toolCallIds.has(msg.tool_call_id)) {
        issues.push({ index: i, type: 'orphan_result', id: msg.tool_call_id, message: `工具结果无对应调用: ${msg.tool_call_id}` });
      }
    }
  }

  return issues;
}

function repairToolCallIds(messages) {
  if (!Array.isArray(messages)) return messages;

  const idMap = new Map();
  let counter = 0;

  const result = messages.map(msg => {
    const fixed = { ...msg };

    if (fixed.tool_calls) {
      fixed.tool_calls = fixed.tool_calls.map(tc => {
        const s = { ...tc };
        if (!s.id || /[^a-zA-Z0-9]/.test(s.id)) {
          const newId = `call_${counter++}`;
          if (s.id) {
            idMap.set(s.id, newId);
          }
          s.id = newId;
        } else {
          idMap.set(s.id, s.id);
        }
        return s;
      });
    }

    if (fixed.tool_call_id) {
      const mapped = idMap.get(fixed.tool_call_id);
      if (mapped) {
        fixed.tool_call_id = mapped;
      } else {
        fixed.tool_call_id = sanitizeToolCallId(fixed.tool_call_id);
      }
    }

    return fixed;
  });

  return result;
}

function repairToolCallArguments(rawArgs, toolName = '?') {
  if (!rawArgs || typeof rawArgs !== 'string') return '{}';
  const raw = rawArgs.trim();
  if (!raw) return '{}';
  if (raw === 'None') return '{}';

  try {
    JSON.parse(raw);
    return raw;
  } catch (e) {

    // 非有效 JSON，继续尝试修复

    console.warn('[tool-call-id.js] 空 catch 补日志:', e && e.message);
  }


  let fixed = raw;
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  const openCurly = fixed.split('{').length - 1;
  const closeCurly = fixed.split('}').length - 1;
  const openBracket = fixed.split('[').length - 1;
  const closeBracket = fixed.split(']').length - 1;
  if (openCurly > closeCurly) fixed += '}'.repeat(openCurly - closeCurly);
  if (openBracket > closeBracket) fixed += ']'.repeat(openBracket - closeBracket);

  for (let i = 0; i < 20; i++) {
    try {
      JSON.parse(fixed);
      break;
    } catch (e) {
      if (fixed.endsWith('}') && (fixed.split('}').length - 1) > (fixed.split('{').length - 1)) {
        fixed = fixed.slice(0, -1);
      } else if (fixed.endsWith(']') && (fixed.split(']').length - 1) > (fixed.split('[').length - 1)) {
        fixed = fixed.slice(0, -1);
      } else {
        break;
      }
    }
  }

  try {
    JSON.parse(fixed);
    if (fixed !== raw) {
      console.warn(`🔧 修复工具调用参数 (${toolName}): ${raw.slice(0, 60)} → ${fixed.slice(0, 60)}`);
    }
    return fixed;
  } catch (e) {
    console.debug(`[tool-call-id] 修复参数失败 (${toolName}):`, e.message);
  }

  console.warn(`⚠️ 无法修复工具调用参数 (${toolName}): ${raw.slice(0, 80)}`);
  return '{}';
}

module.exports = {
  sanitizeToolCallId,
  sanitizeToolCallsForProvider,
  sanitizeMessagesForProvider,
  sanitizeFunctionName,
  getProviderIdMode,
  validateToolCallIds,
  repairToolCallIds,
  repairToolCallArguments,
  shortHash,
  PROVIDER_ID_MODES,
};
