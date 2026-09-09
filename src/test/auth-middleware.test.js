const { authMiddleware, verifyApiToken } = require('../core/http-middleware');
const { PUBLIC_ROUTES_BY_METHOD, PUBLIC_ROUTES_SET } = require('../cli/request-handler');

function makeReq(method, pathname, headers = {}) {
  return {
    method,
    url: pathname,
    headers,
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: '',
    writeHead(status) {
      res.statusCode = status;
    },
    end(body) {
      res.body = body || '';
    },
  };
  return res;
}

function callAuth(options, req, res) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    res.end = (body) => {
      res.body = body || '';
      finish(false);
    };
    const middleware = authMiddleware({
      apiKey: 'test-secret',
      publicRoutes: PUBLIC_ROUTES_SET,
      publicRoutesByMethod: PUBLIC_ROUTES_BY_METHOD,
      requireApiKey: true,
      ...options,
    });
    middleware(req, res, { PORT: 38767 }, () => {
      finish(true);
    });
  });
}

describe('auth middleware fail-closed', () => {
  test('no key and requireApiKey true rejects', async () => {
    const req = makeReq('POST', '/api/computer/action');
    const res = makeRes();
    const passed = await callAuth({ apiKey: '', requireApiKey: true }, req, res);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('no key and requireApiKey false still requires a header when key exists', async () => {
    const req = makeReq('POST', '/api/flows');
    const res = makeRes();
    const passed = await callAuth({ requireApiKey: false }, req, res);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('wrong key rejected', async () => {
    const req = makeReq('POST', '/api/flows', { 'X-Api-Key': 'wrong' });
    const res = makeRes();
    const passed = await callAuth({}, req, res);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('X-Api-Key accepted', async () => {
    const req = makeReq('POST', '/api/flows', { 'X-Api-Key': 'test-secret' });
    const res = makeRes();
    const passed = await callAuth({}, req, res);
    expect(passed).toBe(true);
  });

  test('Authorization Bearer accepted', async () => {
    const req = makeReq('GET', '/api/profiles', { Authorization: 'Bearer test-secret' });
    const res = makeRes();
    const passed = await callAuth({}, req, res);
    expect(passed).toBe(true);
  });

  test('token query accepted for clients that cannot set headers', async () => {
    const req = makeReq('GET', '/api/private?token=test-secret');
    const res = makeRes();
    const passed = await callAuth({}, req, res);
    expect(passed).toBe(true);
  });

  test('wrong token query rejected', async () => {
    const req = makeReq('GET', '/api/private?token=wrong');
    const res = makeRes();
    const passed = await callAuth({}, req, res);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('GET public routes bypass auth', async () => {
    for (const pathname of ['/status', '/events', '/files/readme.md']) {
      const req = makeReq('GET', pathname);
      const res = makeRes();
      const passed = await callAuth({}, req, res);
      expect(passed).toBe(true);
    }
  });

  test('external webhook POST stays public', async () => {
    for (const pathname of ['/webhook', '/webhook/wecom']) {
      const req = makeReq('POST', pathname);
      const res = makeRes();
      const passed = await callAuth({}, req, res);
      expect(passed).toBe(true);
    }
  });

  test('write routes are not public', async () => {
    const writeRoutes = [
      '/api/kg/evolve',
      '/api/sandbox/create',
      '/api/directives/add',
      '/api/flows',
      '/api/webhooks/register',
      '/memory/entries',
    ];
    for (const route of writeRoutes) {
      expect(PUBLIC_ROUTES_BY_METHOD.POST.has(route)).toBe(false);
    }
    for (const route of writeRoutes) {
      const req = makeReq('POST', route);
      const res = makeRes();
      const passed = await callAuth({}, req, res);
      expect(passed).toBe(false);
      expect(res.statusCode).toBe(401);
    }
  });

  test('/dev/token is no longer a public GET route', async () => {
    expect(PUBLIC_ROUTES_BY_METHOD.GET.has('/dev/token')).toBe(false);
    const req = makeReq('GET', '/dev/token');
    const res = makeRes();
    const passed = await callAuth({}, req, res);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('verifyApiToken accepts header and query token for WebSocket upgrades', () => {
    const headerReq = makeReq('GET', '/voice/cloud', { 'X-Api-Key': 'test-secret' });
    expect(verifyApiToken(headerReq, 'test-secret')).toBe(true);
    const queryReq = makeReq('GET', '/scene?token=test-secret');
    expect(verifyApiToken(queryReq, 'test-secret')).toBe(true);
    const missingReq = makeReq('GET', '/voice/cloud');
    expect(verifyApiToken(missingReq, 'test-secret')).toBe(false);
    const emptyKeyReq = makeReq('GET', '/voice/cloud?token=test-secret');
    expect(verifyApiToken(emptyKeyReq, '')).toBe(false);
  });

  test('OPTIONS bypasses auth', async () => {
    const req = makeReq('OPTIONS', '/api/flows');
    const res = makeRes();
    const passed = await callAuth({}, req, res);
    expect(passed).toBe(true);
  });
});
