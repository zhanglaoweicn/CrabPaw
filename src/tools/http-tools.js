/**
 * HTTP Tools — 原生 REST API 调用工具
 *
 * 让 AI 能直接调用任意 HTTP API，替代 Bash+curl 方式。
 * 支持 GET/POST/PUT/PATCH/DELETE、JSON/form/raw body、自定义 headers。
 */

const { registry } = require('./registry');

async function handleHttpRequest(params, _context) {
  const { url, method = 'GET', headers = {}, body, timeout = 15000, followRedirect = true } = params;

  if (!url) return { success: false, error: '缺少 url 参数' };

  // 安全过滤：禁止内网地址，防止 SSRF
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const blockedPatterns = [
      /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
      /^0\./, /^localhost$/i, /^::$/, /^\[::1\]$/, /^169\.254\./,
    ];
    for (const pattern of blockedPatterns) {
      if (pattern.test(hostname)) {
        return { success: false, error: `SSRF 防护: 不允许访问内网地址 (${hostname})` };
      }
    }
  } catch (e) {
    return { success: false, error: `URL 格式无效: ${e.message}` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {
        'User-Agent': 'CrabPaw/2.0 (HTTP Tool)',
        'Accept': 'application/json, text/plain, */*',
        ...headers,
      },
      signal: controller.signal,
      redirect: followRedirect ? 'follow' : 'manual',
    };

    if (body) {
      if (typeof body === 'object' && !Array.isArray(body)) {
        // JSON body — 如果没有指定 Content-Type，自动设置
        if (!headers['Content-Type'] && !headers['content-type']) {
          fetchOptions.headers['Content-Type'] = 'application/json';
        }
        fetchOptions.body = JSON.stringify(body);
      } else {
        fetchOptions.body = String(body);
      }
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timer);

    // 读取响应体
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else if (contentType.includes('text/')) {
      data = await response.text();
    } else {
      // 二进制 — 只返回大小信息，不返回具体内容
      const buffer = await response.arrayBuffer();
      data = `[二进制响应: ${buffer.byteLength} bytes, Content-Type: ${contentType}]`;
    }

    // 提取关键响应头
    const responseHeaders = {};
    for (const [k, v] of response.headers.entries()) {
      if (['content-type', 'content-length', 'date', 'server', 'x-request-id', 'location'].includes(k)) {
        responseHeaders[k] = v;
      }
    }

    const result = {
      success: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      data,
    };

    // 如果响应的 JSON 有 error 字段，标记为业务级失败
    if (response.ok && data && typeof data === 'object' && !Array.isArray(data) && data.error) {
      result.success = false;
      result.businessError = data.error;
    }

    return result;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { success: false, error: `请求超时 (${timeout}ms)` };
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return { success: false, error: `无法连接到服务器: ${err.code}`, code: err.code };
    }
    return { success: false, error: `请求失败: ${err.message}` };
  }
}

registry.register({
  name: 'HttpRequest',
  toolset: 'network',
  category: 'web',
  description: '发起 HTTP 请求到外部 API。支持 GET/POST/PUT/PATCH/DELETE，JSON/form/raw body，自定义 headers。适合：调用 REST API、查询开放数据接口、Webhook 回调。安全限制：禁止内网地址（SSRF 防护），默认 15 秒超时。',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整的请求 URL（必须）' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET', description: 'HTTP 方法' },
      headers: { type: 'object', default: {}, description: '自定义请求头（选填），如 {"Authorization": "Bearer xxx"}' },
      body: { description: '请求体。JSON 对象自动转为 JSON（自动加 Content-Type），字符串为 raw body' },
      timeout: { type: 'number', default: 15000, description: '超时时间（毫秒），默认 15000' },
      followRedirect: { type: 'boolean', default: true, description: '是否跟随重定向' },
    },
    required: ['url'],
  },
  handler: handleHttpRequest,
  timeout: 60000,
  isReadOnly: true,
  checkFn: (params) => {
    try { new URL(params.url); return true; } catch { return false; }
  },
});
