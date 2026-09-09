




function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALLOWED_TOKEN_RE = /^(\d+\.?\d*|true|false|null|undefined|NaN|Infinity|==|!=|>=|<=|>|<|===|!==|&&|\|\||!|\?\?|\?\?\.|[+\-*/%()]|"[^"]*"|'[^']*'|\w+(\.\w+)*(\[\d+\])*)$/;

const BLOCKED_GLOBALS = new Set([
  'global', 'globalThis', 'process', 'require', 'module', 'exports',
  '__dirname', '__filename', 'eval', 'Function', 'setTimeout', 'setInterval',
  'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'Buffer', 'URL', 'URLSearchParams', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'Worker', 'SharedArrayBuffer', 'Atomics', 'Proxy', 'Reflect',
  'document', 'window', 'self', 'navigator', 'location',
  'import', 'importScripts', 'console',
  'WebAssembly', 'FinalizationRegistry', 'WeakRef', 'AggregateError',
]);

const BLOCKED_PROPERTY_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

function tokenizeExpression(expr) {
  const tokens = [];
  let i = 0;
  const s = expr.trim();

  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }

    if (s[i] === '"' || s[i] === "'" || s[i] === '`') {
      const quote = s[i];
      let j = i + 1;
      while (j < s.length && s[j] !== quote) {
        if (s[j] === '\\') j++;
        j++;
      }
      tokens.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(s[i])) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }

    const triOp = s.slice(i, i + 3);
    if (['===', '!=='].includes(triOp)) {
      tokens.push(triOp);
      i += 3;
      continue;
    }

    const biOp = s.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||', '??', '?.'].includes(biOp)) {
      tokens.push(biOp);
      i += 2;
      continue;
    }

    if (/[+\-*/%()<>,!]/.test(s[i])) {
      tokens.push(s[i]);
      i++;
      continue;
    }

    if (/\w/.test(s[i])) {
      let j = i;
      while (j < s.length && /[\w.[\]]/.test(s[j])) j++;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }

    tokens.push(s[i]);
    i++;
  }

  return tokens;
}

function validateTokens(tokens) {
  for (const token of tokens) {
    if (ALLOWED_TOKEN_RE.test(token)) continue;

    if (/^\w/.test(token)) {
      const root = token.split('.')[0].split('[')[0];
      if (BLOCKED_GLOBALS.has(root)) {
        return { safe: false, reason: `禁止访问全局对象: ${root}` };
      }
      continue;
    }

    return { safe: false, reason: `不允许的标记: ${token}` };
  }
  return { safe: true };
}

function resolveContextPath(obj, pathStr) {
  const parts = pathStr.replace(/\[(\d+)\]/g, '.$1').split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    if (BLOCKED_PROPERTY_PARTS.has(part)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part) && part in Object.prototype) return undefined;
    current = current[part];
  }
  return current;
}

function safeEvalResolved(tokens) {
  const MAX_RECURSION_DEPTH = 50;

  let i = 0;
  let depth = 0;

  function parsePrimary() {
    depth++;
    try {
      if (depth > MAX_RECURSION_DEPTH) {
        throw new Error(`Expression recursion depth exceeded: ${MAX_RECURSION_DEPTH}`);
      }
      if (i >= tokens.length) return undefined;
      const t = tokens[i];
      if (t === 'true') { i++; return true; }
      if (t === 'false') { i++; return false; }
      if (t === 'null') { i++; return null; }
      if (t === 'undefined') { i++; return undefined; }
      if (/^-?\d+\.?\d*$/.test(t)) { i++; return Number(t); }
      if (/^["']/.test(t)) { i++; try { return JSON.parse(t); } catch { return t.slice(1, -1); } }
      if (t === '!') { i++; return !parsePrimary(); }
      if (t === '(') {
        i++;
        const val = parseOr();
        if (i < tokens.length && tokens[i] === ')') i++;
        return val;
      }
      i++;
      return undefined;
    } finally {
      depth--;
    }
  }

  function parseComparison() {
    depth++;
    try {
      if (depth > MAX_RECURSION_DEPTH) {
        throw new Error(`Expression recursion depth exceeded: ${MAX_RECURSION_DEPTH}`);
      }
      let left = parsePrimary();
      while (i < tokens.length) {
        const op = tokens[i];
        if (!['==', '!=', '>=', '<=', '>', '===', '!=='].includes(op)) break;
        i++;
        const right = parsePrimary();
        switch (op) {
          case '==': left = left == right; break;
          case '!=': left = left != right; break;
          case '>=': left = left >= right; break;
          case '<=': left = left <= right; break;
          case '>': left = left > right; break;
          case '<': left = left < right; break;
          case '===': left = left === right; break;
          case '!==': left = left !== right; break;
        }
      }
      return left;
    } finally {
      depth--;
    }
  }

  function parseAnd() {
    depth++;
    try {
      if (depth > MAX_RECURSION_DEPTH) {
        throw new Error(`Expression recursion depth exceeded: ${MAX_RECURSION_DEPTH}`);
      }
      let left = parseComparison();
      while (i < tokens.length && tokens[i] === '&&') {
        i++;
        const right = parseComparison();
        left = left && right;
      }
      return left;
    } finally {
      depth--;
    }
  }

  function parseOr() {
    depth++;
    try {
      if (depth > MAX_RECURSION_DEPTH) {
        throw new Error(`Expression recursion depth exceeded: ${MAX_RECURSION_DEPTH}`);
      }
      let left = parseAnd();
      while (i < tokens.length && tokens[i] === '||') {
        i++;
        const right = parseAnd();
        left = left || right;
      }
      return left;
    } finally {
      depth--;
    }
  }

  function parseNullish() {
    depth++;
    try {
      if (depth > MAX_RECURSION_DEPTH) {
        throw new Error(`Expression recursion depth exceeded: ${MAX_RECURSION_DEPTH}`);
      }
      let left = parseOr();
      while (i < tokens.length && tokens[i] === '??') {
        i++;
        const right = parseOr();
        left = left ?? right;
      }
      return left;
    } finally {
      depth--;
    }
  }

  const result = parseNullish();
  return result;
}

function safeEvaluate(expression, context = {}) {
  if (!expression || typeof expression !== 'string') return { value: true, safe: true };

  const trimmed = expression.trim();
  if (!trimmed) return { value: true, safe: true };

  const tokens = tokenizeExpression(trimmed);
  const validation = validateTokens(tokens);
  if (!validation.safe) {
    console.warn(`🔒 安全表达式评估拒 ${validation.reason}`);
    return { value: false, safe: false, reason: validation.reason };
  }

  const resolved = tokens.map(token => {
    if (/^-?\d+\.?\d*$/.test(token)) return token;
    if (/^(true|false|null|undefined|NaN|Infinity)$/.test(token)) return token;
    if (/^["']/.test(token)) return token;
    if (/^[+\-*/%()<>!,]|==|!=|>=|<=|===|!==|&&|\|\||\?\?|\?\?\.$/.test(token)) return token;

    const root = token.split('.')[0].split('[')[0];
    if (/^\d/.test(root)) return token;
    if (BLOCKED_GLOBALS.has(root)) return 'undefined';

    const value = resolveContextPath(context, token);
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    return 'undefined';
  });

  try {
    const result = safeEvalResolved(resolved);
    return { value: !!result, safe: true };
  } catch (e) {
    console.warn(`⚠️ 安全表达式评估失 ${trimmed} ${e.message}`);
    return { value: false, safe: true, error: e.message };
  }
}

function safeEvaluateWithContext(expression, contextVarName, context) {
  if (!expression || typeof expression !== 'string') return { value: true, safe: true };

  const trimmed = expression.trim();
  if (!trimmed) return { value: true, safe: true };

  const contextAccessRe = new RegExp(`\\b${escapeRegExp(contextVarName)}(\\.[\\w.]+|\\[\\d+\\])*`, 'g');
  const preprocessed = trimmed.replace(contextAccessRe, (match) => {
    const pathStr = match.slice(contextVarName.length);
    const value = resolveContextPath(context, pathStr.replace(/^\./, ''));
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return JSON.stringify(value);
    return 'undefined';
  });

  return safeEvaluate(preprocessed);
}

/**
 * _safeEval — 全库唯一安全求值入口（2026-08-15 P2-4 收敛）
 *
 * CLAUDE.md 契约名: workflow-engine.js / tool-orchestrator.js 的旧实现已收敛
 * 到此函数（各自保留 @deprecated 转发）。返回布尔值(与旧调用点语义一致:
 * 旧实现的结果用于条件真值判断)。
 * @param {string} expression - 布尔表达式
 * @param {object} [context] - 变量上下文
 * @returns {boolean}
 */
function _safeEval(expression, context = {}) {
  return safeEvaluate(expression, context).value;
}

module.exports = {
  safeEvaluate,
  safeEvaluateWithContext,
  _safeEval,
  tokenizeExpression,
  validateTokens,
  BLOCKED_GLOBALS,
};
