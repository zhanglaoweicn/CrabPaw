const fs = require('fs');
const path = require('path');

const {
  ROUTE_TABLE,
  LOCAL_HANDLERS,
  PUBLIC_ROUTES_BY_METHOD,
  resolveRoute,
} = require('../cli/request-handler');

const ROOT = path.resolve(__dirname, '..', '..');
const GUI_SRC = path.join(ROOT, 'gui', 'src');

const METHOD_BY_FN = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Upload: 'POST',
};

function collectSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectApiCalls(source) {
  const calls = [];
  // 2026-08-01: 支持 TypeScript 泛型（apiGet<Type>(...)）——此前正则不匹配 <，
  // 约 20% 带泛型的调用（含 /api/config-versions 三个）被静默跳过
  const pattern = /\bapi(Get|Post|Put|Patch|Delete|Upload)\s*(?:<[^>]+>)?\s*\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    let depth = 1;
    let i = pattern.lastIndex;
    let quote = null;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      }
      i += 1;
    }
    const args = source.slice(pattern.lastIndex, Math.max(pattern.lastIndex, i - 1));
    calls.push({ fn: match[1], args });
    pattern.lastIndex = i;
  }
  return calls;
}

function methodForCall(call) {
  const override = call.args.match(/['"](PUT|PATCH|DELETE)['"]\s*\)?$/);
  if (override) return override[1];
  return METHOD_BY_FN[call.fn];
}

function normalizeEndpoint(rawArg) {
  const raw = rawArg.trim();
  let endpoint = raw;
  let isConcatenated = false;

  const template = endpoint.match(/^`([\s\S]*)`$/);
  if (template) {
    endpoint = template[1];
  } else {
    const literal = endpoint.match(/^(['"])([\s\S]*?)\1/);
    if (literal) {
      endpoint = literal[2];
      isConcatenated = true;
    }
  }

  if (endpoint.includes('/plugin-manager/')) {
    endpoint = endpoint.replace(/\$\{action\}/g, 'enable');
  } else if (endpoint.includes('/services/')) {
    endpoint = endpoint.replace(/\$\{action\}/g, 'start');
  }

  endpoint = endpoint
    .replace(/\$\{qs\}/g, '')
    .replace(/\$\{[^}]+\}/g, 'id');

  if (isConcatenated && endpoint.endsWith('/')) {
    endpoint += 'id';
  }
  if (endpoint === '/skills/') endpoint = '/skills/id';

  try {
    return new URL(endpoint, 'http://localhost').pathname;
  } catch (e) {
    return endpoint.split('?')[0];
  }
}

function endpointCandidates(rawArg) {
  const trimmed = rawArg.trim();
  const withoutStringLiterals = trimmed.replace(/['"`]([^'"`]*)['"`]/g, '');
  const isTernary = withoutStringLiterals.includes('?') && withoutStringLiterals.includes(':');
  if (isTernary) {
    const literals = [...trimmed.matchAll(/['"`]([^'"`]+)['"`]/g)].map(match => match[1]);
    if (literals.length > 1) {
      return literals.map(normalizeEndpoint);
    }
  }
  return [normalizeEndpoint(trimmed)];
}

describe('frontend/backend API contract', () => {
  test('every registered route resolves to a real handler', () => {
    const missing = ROUTE_TABLE
      .filter(route => typeof LOCAL_HANDLERS[route.handler] !== 'function')
      .map(route => `${route.method} ${route.pattern} -> ${route.handler}`);
    expect(missing).toEqual([]);
  });

  test('every apiGet/apiPost/apiPut/apiPatch/apiDelete/apiUpload call resolves', () => {
    const files = collectSourceFiles(GUI_SRC);
    expect(files.length).toBeGreaterThan(50);

    const unresolved = [];
    for (const file of files) {
      // 2026-08-01: api.ts 是 API 定义文件（函数签名 apiGet<T>(...)，非调用方），跳过
      if (file.endsWith(`${path.sep}lib${path.sep}api.ts`)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const call of collectApiCalls(source)) {
        const firstArg = call.args.split(',')[0];
        const method = methodForCall(call);
        for (const endpoint of endpointCandidates(firstArg)) {
          if (!endpoint) continue;
          if (!resolveRoute(method, endpoint)) {
            unresolved.push(`${path.relative(ROOT, file)}: ${method} ${endpoint}`);
          }
        }
      }
    }

    expect(unresolved).toEqual([]);
  });

  test('specific regressions stay aligned', () => {
    expect(typeof resolveRoute('POST', '/api/backup/create')).toBe('function');
    expect(resolveRoute('GET', '/api/backup/create')).toBeNull();
    expect(typeof resolveRoute('POST', '/api/backup/delete')).toBe('function');
    expect(typeof resolveRoute('DELETE', '/api/files/delete')).toBe('function');
    expect(typeof resolveRoute('POST', '/api/plugin-manager/plugin-a/enable')).toBe('function');
    expect(typeof resolveRoute('POST', '/api/plugin-manager/plugin-a/disable')).toBe('function');
    expect(typeof resolveRoute('POST', '/api/services/gateway/start')).toBe('function');
  });

  test('SmartControl frontend and backend code is removed', () => {
    expect(fs.existsSync(path.join(GUI_SRC, 'pages', 'SmartControl'))).toBe(false);
    const smartControlRoutes = ROUTE_TABLE.filter(route =>
      /smart[-_]?control|smartcontrol/i.test(route.pattern.source)
    );
    expect(smartControlRoutes).toEqual([]);
  });

  test('public routes remain read-only plus webhook ingress', () => {
    expect(Array.from(PUBLIC_ROUTES_BY_METHOD.POST).sort()).toEqual(['/webhook', '/webhook/wecom']);
    for (const route of PUBLIC_ROUTES_BY_METHOD.GET) {
      expect(route.startsWith('/api/')).toBe(false);
    }
  });
});
