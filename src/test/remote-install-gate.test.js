/**
 * 远程技能安装默认关闭门测试（2026-08-28 发布项）
 *
 * 发布口径红线: 技能=完全信任域。registry/GitHub/URL 三源远程安装默认 403，
 * security.remoteInstall.enabled=true 时放行。
 */
const { handleSkillMarketInstall } = require('../handlers/skill-handler');

function mockRes() {
  const res = {
    statusCode: null, body: null, headersWritten: false,
    writeHead(code) { this.statusCode = code; this.headersWritten = true; return this; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
  return res;
}

function mockReq(method, body) {
  // readRequestBody 是事件型（data/end）——同步注册后异步发射
  const chunks = body !== undefined ? [JSON.stringify(body)] : [];
  return {
    method,
    on(ev, cb) {
      if (ev === 'data') setImmediate(() => chunks.forEach(c => cb(c)));
      if (ev === 'end') setImmediate(() => cb());
      return this;
    },
    removeListener() {},
  };
}

describe('远程技能安装默认关闭门（handleSkillMarketInstall）', () => {
  test('默认（无 remoteInstall 配置）→ 403 拒装', async () => {
    const res = mockRes();
    await handleSkillMarketInstall(mockReq('POST', { source: 'url', url: 'https://example.com/x.tar.gz' }), res, {
      appConfig: { security: {} },
    });
    expect(res.statusCode).toBe(403);
    // http-utils.sendError 载荷形如 { success:false, error } —— 断言 error 字段
    expect(res.body.error).toContain('远程技能安装默认关闭');
  });

  test('appConfig 为空 ctx → 403 拒装', async () => {
    const res = mockRes();
    await handleSkillMarketInstall(mockReq('POST', { source: 'github', repo: 'a/b' }), res, {});
    expect(res.statusCode).toBe(403);
  });

  test('enabled:false → 403 拒装', async () => {
    const res = mockRes();
    await handleSkillMarketInstall(mockReq('POST', { source: 'remote', skillSlug: 'demo' }), res, {
      appConfig: { security: { remoteInstall: { enabled: false } } },
    });
    expect(res.statusCode).toBe(403);
  });

  test('enabled:true → 过门（缺参数进入后续 400 校验而非 403）', async () => {
    const res = mockRes();
    await handleSkillMarketInstall(mockReq('POST', {}), res, {
      appConfig: { security: { remoteInstall: { enabled: true } } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('缺少必要参数');
  });

  test('非 POST → 405', async () => {
    const res = mockRes();
    await handleSkillMarketInstall(mockReq('GET'), res, {
      appConfig: { security: { remoteInstall: { enabled: true } } },
    });
    expect(res.statusCode).toBe(405);
  });
});
