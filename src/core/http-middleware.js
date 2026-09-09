const crypto = require('crypto');

const MIDDLEWARE_PRIORITY = {
  HIGHEST: 100,
  HIGH: 75,
  NORMAL: 50,
  LOW: 25,
  LOWEST: 0
};

const MIDDLEWARE_PHASE = {
  PRE_AUTH: 'pre_auth',
  AUTH: 'auth',
  PRE_HANDLER: 'pre_handler',
  HANDLER: 'handler',
  POST_HANDLER: 'post_handler',
  ERROR: 'error'
};

class MiddlewareRegistry {
  constructor() {
    this._middlewares = new Map();
    this._sorted = null;
  }

  register(name, middleware, options = {}) {
    const config = {
      name,
      middleware,
      priority: options.priority ?? MIDDLEWARE_PRIORITY.NORMAL,
      phase: options.phase ?? MIDDLEWARE_PHASE.HANDLER,
      enabled: options.enabled ?? true,
      before: options.before || [],
      after: options.after || [],
      condition: options.condition || null
    };

    this._middlewares.set(name, config);
    this._sorted = null;

    return this;
  }

  unregister(name) {
    this._middlewares.delete(name);
    this._sorted = null;
    return this;
  }

  enable(name) {
    const config = this._middlewares.get(name);
    if (config) {
      config.enabled = true;
      this._sorted = null;
    }
    return this;
  }

  disable(name) {
    const config = this._middlewares.get(name);
    if (config) {
      config.enabled = false;
      this._sorted = null;
    }
    return this;
  }

  get(name) {
    return this._middlewares.get(name);
  }

  getAll() {
    return Array.from(this._middlewares.values());
  }

  getSorted() {
    if (this._sorted) {
      return this._sorted;
    }

    const enabled = Array.from(this._middlewares.values()).filter(m => m.enabled);
    const sorted = this._topologicalSort(enabled);
    this._sorted = sorted;
    return sorted;
  }

  _topologicalSort(middlewares) {
    const graph = new Map();
    const inDegree = new Map();

    for (const mw of middlewares) {
      graph.set(mw.name, []);
      inDegree.set(mw.name, 0);
    }

    for (const mw of middlewares) {
      for (const before of mw.before) {
        if (graph.has(before)) {
          graph.get(mw.name).push(before);
          inDegree.set(before, (inDegree.get(before) || 0) + 1);
        }
      }

      for (const after of mw.after) {
        if (graph.has(after)) {
          graph.get(after).push(mw.name);
          inDegree.set(mw.name, (inDegree.get(mw.name) || 0) + 1);
        }
      }
    }

    const queue = [];
    for (const [name, degree] of inDegree) {
      if (degree === 0) {
        queue.push(name);
      }
    }

    queue.sort((a, b) => {
      const mwA = this._middlewares.get(a);
      const mwB = this._middlewares.get(b);
      return mwB.priority - mwA.priority;
    });

    const result = [];
    while (queue.length > 0) {
      const name = queue.shift();
      result.push(this._middlewares.get(name));

      const dependents = graph.get(name) || [];
      for (const dep of dependents) {
        const newDegree = (inDegree.get(dep) || 0) - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) {
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            const mw = this._middlewares.get(queue[i]);
            if (this._middlewares.get(dep).priority > mw.priority) {
              queue.splice(i, 0, dep);
              inserted = true;
              break;
            }
          }
          if (!inserted) {
            queue.push(dep);
          }
        }
      }
    }

    return result;
  }

  build(options = {}) {
    const sorted = this.getSorted();
    const middlewares = [];

    for (const config of sorted) {
      if (config.condition && !config.condition(options)) {
        continue;
      }
      middlewares.push(config.middleware);
    }

    return compose(middlewares);
  }
}

function compose(middlewares) {
  return async function composed(req, res, ctx, next) {
    let index = 0;

    async function dispatch() {
      if (index >= middlewares.length) {
        if (next) return next();
        return;
      }

      const mw = middlewares[index++];
      await mw(req, res, ctx, dispatch);
    }

    await dispatch();
  };
}

function corsMiddleware(options = {}) {
  const { allowedOrigin = '' } = options;

  return function cors(req, res, ctx, next) {
    if (allowedOrigin && allowedOrigin !== '*') {
      const origin = req.headers.origin;
      if (origin === allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } else if (allowedOrigin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      const origin = req.headers.origin;
      if (origin) {
        // Electron 打包模式下 file:// 协议的 origin 为 "null"
        if (origin === 'null') {
          res.setHeader('Access-Control-Allow-Origin', '*');
        } else {
          try {
            const url = new URL(origin);
            // 2026-08-14: URL.hostname 对 IPv6 返回带括号的 "[::1]"——去括号后比较
            const host = url.hostname.replace(/^\[|\]$/g, '');
            if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
              res.setHeader('Access-Control-Allow-Origin', origin);
            }
          } catch (e) {
            /* 忽略错误 */
            console.warn('[http-middleware.js] 空 catch 补日志:', e && e.message);
          }

        }
      }
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Signature, Authorization, X-Request-Id, X-Electron');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    return next();
  };
}

function securityHeadersMiddleware() {
  return function securityHeaders(req, res, ctx, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Desktop app: no X-Frame-Options needed (CSP frame-src is sufficient)
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://localhost:*");
    return next();
  };
}

function rateLimitMiddleware(options = {}) {
  const {
    windowMs = 60000,
    maxRequests = 60,
    cleanupInterval = 60000
  } = options;

  const counts = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of counts) {
      if (now > record.resetAt) counts.delete(ip);
    }
  }, cleanupInterval);

  if (timer.unref) timer.unref();

  const middleware = function rateLimit(req, res, ctx, next) {
    const clientIp = req.socket?.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';
    // 同时基于 IP 和 API Key 限流，避免多用户共享 IP 时互相影响
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
    const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    const rateLimitKey = apiKey ? `${clientIp}:${apiKey.slice(0, 8)}` : clientIp;
    const now = Date.now();
    const record = counts.get(rateLimitKey) || { count: 0, resetAt: now + windowMs };

    if (now > record.resetAt) {
      record.count = 1;
      record.resetAt = now + windowMs;
    } else {
      record.count++;
    }

    counts.set(rateLimitKey, record);

    if (record.count > maxRequests) {
      res.writeHead(429);
      res.end(JSON.stringify({ success: false, message: 'Rate limit exceeded' }));
      return;
    }

    return next();
  };

  middleware.cleanup = function cleanup() {
    clearInterval(timer);
    counts.clear();
  };

  return middleware;
}

/**
 * 脱敏 URL 中的敏感查询参数（token / apiKey 等），防止日志泄露凭据
 * 例: /events?token=abc → /events?token=***
 */
function redactSensitiveQuery(url) {
  if (!url || typeof url !== 'string') return url || '';
  return url.replace(/([?&])(token|apiKey|api_key|key|signature|sig|code)=[^&#]*/gi, '$1$2=***');
}

function verifyApiToken(req, apiKey) {
  if (!apiKey || !req || !req.url) return false;

  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token') || '';
  const header = (
    req.headers['x-api-key'] ||
    req.headers['X-Api-Key'] ||
    req.headers['authorization'] ||
    req.headers['Authorization'] ||
    ''
  ).toString();
  const candidate = header || queryToken;
  if (!candidate) return false;

  const value = candidate.startsWith('Bearer ') ? candidate.slice(7) : candidate;
  const expected = Buffer.from(apiKey, 'utf8');
  const provided = Buffer.from(value, 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

function authMiddleware(options = {}) {
  const {
    apiKey = process.env.ADMIN_API_KEY || '',
    protectedRoutes = new Set(),
    publicRoutes = new Set(),
    publicRoutesByMethod = null,
    requireApiKey = false
  } = options;

  return function auth(req, res, ctx, next) {
    if (!apiKey) {
      if (requireApiKey) {
        res.writeHead(401);
        res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
        return;
      }
      return next();
    }

    const url = new URL(req.url, `http://localhost:${ctx.PORT || 3000}`);
    const pathname = url.pathname;

    function isPublicPath() {
      const method = (req.method || 'GET').toUpperCase();
      if (publicRoutesByMethod) {
        const methodRoutes = publicRoutesByMethod[method];
        if (methodRoutes) {
          for (const route of methodRoutes) {
            if (route === pathname || (route.length > 1 && route.endsWith('/') && pathname.startsWith(route))) {
              return true;
            }
          }
        }
        return false;
      }

      if (publicRoutes.size > 0 && (publicRoutes.has(pathname) || Array.from(publicRoutes).some(route => route.length > 1 && route.endsWith('/') && pathname.startsWith(route)))) {
        return true;
      }
      return false;
    }

    const queryToken = url.searchParams.get('token') || '';
    if (isPublicPath()) {
      return next();
    }

    // 公开路由直接放行
    if (req.method === 'OPTIONS') {
      return next();
    }

    // 默认拒绝模式：如果定义了 protectedRoutes，不在其中的也需要认证
    // 只有显式在 publicRoutes 中的路由才放行
    if (protectedRoutes.size > 0 && !protectedRoutes.has(pathname)) {
      // 不在 protectedRoutes 中，但仍需认证（除非在 publicRoutes 中，上面已放行）
    }

    const header = (req.headers['x-api-key'] || req.headers['X-Api-Key'] || req.headers['authorization'] || req.headers['Authorization'] || '').toString();
    const candidate = header || queryToken;
    if (!candidate) {
      res.writeHead(401);
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    const value = candidate.startsWith('Bearer ') ? candidate.slice(7) : candidate;
    // 使用时序安全比较防止时序攻击
    const expected = Buffer.from(apiKey, 'utf8');
    const provided = Buffer.from(value, 'utf8');
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
      res.writeHead(401);
      res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
      return;
    }

    return next();
  };
}

function requestLoggerMiddleware() {
  return function requestLogger(req, res, ctx, next) {
    const startTime = Date.now();
    const requestId = crypto.randomBytes(5).toString("hex").slice(0, 10);

    ctx._requestId = requestId;
    ctx._startTime = startTime;

    const originalEnd = res.end.bind(res);
    res.end = function (...args) {
      const duration = Date.now() - startTime;
      const url = new URL(req.url, `http://localhost:${parseInt(ctx.PORT) || 3000}`);
      console.log(`[${requestId}] ${req.method} ${url.pathname} ${res.statusCode} ${duration}ms`);
      return originalEnd(...args);
    };

    return next();
  };
}

function errorHandlerMiddleware() {
  return function errorHandler(req, res, ctx, next) {
    return next().catch(err => {
      const isDev = process.env.NODE_ENV !== 'production';
      const errorDetail = isDev ? err.message : 'Internal Server Error';
      console.error(`❌ 请求处理错误: ${err.message}`);
      if (err.stack && isDev) {
        console.error(`   堆栈: ${err.stack.split('\n').slice(1, 4).join('\n    ')}`);
      }
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({
          success: false,
          error: errorDetail,
          ...(isDev ? { stack: err.stack?.split('\n').slice(0, 3).join('\n') } : {})
        }));
      }
    });
  };
}

function timeoutMiddleware(options = {}) {
  const { timeout = 30000 } = options;

  return function timeoutHandler(req, res, ctx, next) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!res.headersSent) {
        res.writeHead(504);
        res.end(JSON.stringify({ success: false, error: 'Request timeout' }));
      }
    }, timeout);

    const originalEnd = res.end.bind(res);
    res.end = function (...args) {
      clearTimeout(timer);
      return originalEnd(...args);
    };

    // 标记超时状态，handler 可检查此标志提前退出
    ctx._timedOut = () => timedOut;

    return next();
  };
}

function requestSizeLimitMiddleware(options = {}) {
  const { maxSize = 10 * 1024 * 1024 } = options;

  return function sizeLimit(req, res, ctx, next) {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxSize) {
      res.writeHead(413);
      res.end(JSON.stringify({ success: false, error: 'Request entity too large' }));
      return;
    }
    return next();
  };
}

function securityMiddleware() {
  return async function security(req, res, ctx, next) {
    if (!ctx.security) {
      return next();
    }

    // eslint-disable-next-line no-unused-vars
    const url = new URL(req.url, `http://localhost:${parseInt(ctx.PORT) || 3000}`);
    ctx._securityChecked = true;

    return next();
  };
}

const globalRegistry = new MiddlewareRegistry();

globalRegistry
  .register('errorHandler', errorHandlerMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.HIGHEST,
    phase: MIDDLEWARE_PHASE.ERROR
  })
  .register('requestLogger', requestLoggerMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.HIGH,
    phase: MIDDLEWARE_PHASE.PRE_HANDLER
  })
  .register('cors', corsMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.HIGH,
    phase: MIDDLEWARE_PHASE.PRE_AUTH
  })
  .register('securityHeaders', securityHeadersMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.HIGH,
    phase: MIDDLEWARE_PHASE.PRE_AUTH
  })
  .register('rateLimit', rateLimitMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.NORMAL,
    phase: MIDDLEWARE_PHASE.PRE_AUTH
  })
  .register('auth', authMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.NORMAL,
    phase: MIDDLEWARE_PHASE.AUTH
  })
  .register('timeout', timeoutMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.LOW,
    phase: MIDDLEWARE_PHASE.PRE_HANDLER
  })
  .register('requestSizeLimit', requestSizeLimitMiddleware(), {
    priority: MIDDLEWARE_PRIORITY.LOW,
    phase: MIDDLEWARE_PHASE.PRE_HANDLER
  });

/**
 * 性能监控中间件
 * - 记录请求耗时、慢请求告警
 * - 周期性输出内存/CPU指标
 * - 暴露 /api/perf 端点供前端查询
 */
function performanceMonitorMiddleware(options = {}) {
  const {
    slowThresholdMs = 5000,    // 超过5秒视为慢请求
    sampleIntervalMs = 60000,  // 每分钟采样一次资源指标
    maxSamples = 60            // 保留最近60个采样点（1小时）
  } = options;

  // 请求耗时统计
  let _totalRequests = 0;
  let _slowRequests = 0;
  const _recentSlowRequests = []; // 最近10个慢请求
  const MAX_SLOW_REQUESTS = 10;

  // 资源采样
  const _resourceSamples = [];

  const _sampleTimer = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const cpu = process.cpuUsage();
      _resourceSamples.push({
        time: Date.now(),
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        cpuUserMs: cpu.user,
        cpuSystemMs: cpu.system,
      });
      // 保留最近 maxSamples 个采样
      if (_resourceSamples.length > maxSamples) {
        _resourceSamples.splice(0, _resourceSamples.length - maxSamples);
      }
    } catch (e) {
      /* 忽略错误 */
      console.warn('[http-middleware.js] 空 catch 补日志:', e && e.message);
    }

  }, sampleIntervalMs);

  if (_sampleTimer.unref) _sampleTimer.unref();

  const middleware = function performanceMonitor(req, res, ctx, next) {
    const start = Date.now();

    // 挂载查询接口到 ctx
    ctx._perfMonitor = {
      getStats: () => ({
        totalRequests: _totalRequests,
        slowRequests: _slowRequests,
        recentSlowRequests: _recentSlowRequests.slice(-MAX_SLOW_REQUESTS),
        resourceSamples: _resourceSamples.slice(),
        currentMemory: process.memoryUsage(),
      })
    };

    const originalEnd = res.end.bind(res);
    res.end = function (...args) {
      const duration = Date.now() - start;
      _totalRequests++;

      if (duration > slowThresholdMs) {
        _slowRequests++;
        // 2026-08-07 (安全): 慢请求记录/打印的 URL 必须脱敏——query 中可能携带 token
        const sanitizedUrl = redactSensitiveQuery(req.url || '/');
        _recentSlowRequests.push({
          url: sanitizedUrl.length > 200 ? sanitizedUrl.slice(0, 200) : sanitizedUrl,
          method: req.method,
          duration,
          time: Date.now(),
        });
        if (_recentSlowRequests.length > MAX_SLOW_REQUESTS) {
          _recentSlowRequests.shift();
        }
        // 仅慢请求打印日志
        if (duration > slowThresholdMs * 2) {
          console.warn(`⚠️ 慢请求 [${req.method}] ${sanitizedUrl} - ${duration}ms`);
        }
      }
      return originalEnd(...args);
    };

    return next();
  };

  middleware.cleanup = function cleanup() {
    clearInterval(_sampleTimer);
  };

  middleware.getStats = function getStats() {
    return {
      totalRequests: _totalRequests,
      slowRequests: _slowRequests,
      recentSlowRequests: _recentSlowRequests.slice(),
      resourceSamples: _resourceSamples.slice(),
      currentMemory: process.memoryUsage(),
    };
  };

  return middleware;
}

module.exports = {
  compose,
  MiddlewareRegistry,
  MIDDLEWARE_PRIORITY,
  MIDDLEWARE_PHASE,
  corsMiddleware,
  securityHeadersMiddleware,
  securityMiddleware,
  rateLimitMiddleware,
  authMiddleware,
  requestLoggerMiddleware,
  errorHandlerMiddleware,
  timeoutMiddleware,
  requestSizeLimitMiddleware,
  performanceMonitorMiddleware,
  verifyApiToken,
  redactSensitiveQuery,
  globalRegistry
};
