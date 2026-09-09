/**
 * 发布 S-2a — 技能 URL 安装 SSRF 防护测试。
 * - isAllowedSkillSourceUrl: 协议白名单 + 私网/环回阻断（resolver 注入，离线确定性）。
 * - fetchUrl: 重定向目标逐跳复校验 + 重定向上限（本地 http server，无外网依赖）。
 * - installFromUrl: 私网地址在发请求前即拒绝（短路断言）。
 */
const http = require('http');
const { isAllowedSkillSourceUrl, _isBlockedIp, fetchUrl, installFromUrl } = require('../core/skill-market');

const pubResolver = (ip) => async () => [{ address: ip, family: 4 }];

async function withLocalServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe('isAllowedSkillSourceUrl — 协议白名单 + 私网/环回阻断', () => {
  test('公网 https 允许', async () => {
    await expect(isAllowedSkillSourceUrl('https://example.com/skills/demo.tar.gz', { resolver: pubResolver('93.184.216.34') })).resolves.toBe(true);
  });

  test('公网 http 允许', async () => {
    await expect(isAllowedSkillSourceUrl('http://example.com/skills/demo.tar.gz', { resolver: pubResolver('8.8.8.8') })).resolves.toBe(true);
  });

  test('私网 IP 字面量拒绝 (10/8)', async () => {
    await expect(isAllowedSkillSourceUrl('http://10.1.2.3/demo.tar.gz')).resolves.toBe(false);
  });

  test('私网段拒绝 (172.16/12, 192.168/16, 169.254/16)', async () => {
    await expect(isAllowedSkillSourceUrl('http://172.16.0.5/demo.tar.gz')).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl('http://192.168.1.1/demo.tar.gz')).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl('http://169.254.169.254/latest/meta-data')).resolves.toBe(false);
  });

  test('环回 IP 字面量拒绝 (127/8)', async () => {
    await expect(isAllowedSkillSourceUrl('http://127.0.0.1:8080/demo.tar.gz')).resolves.toBe(false);
  });

  test('localhost 域名解析到环回即拒绝', async () => {
    await expect(isAllowedSkillSourceUrl('http://localhost:3000/demo.tar.gz', { resolver: pubResolver('127.0.0.1') })).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl('https://localhost/demo.tar.gz', { resolver: pubResolver('::1') })).resolves.toBe(false);
  });

  test('DNS 重绑定（公网+私网混答）拒绝', async () => {
    const resolver = async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await expect(isAllowedSkillSourceUrl('https://evil.example.com/demo.tar.gz', { resolver })).resolves.toBe(false);
  });

  test('协议白名单：非 http/https 拒绝且不发解析', async () => {
    await expect(isAllowedSkillSourceUrl('ftp://example.com/demo.tar.gz')).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl('file:///C:/Windows/win.ini')).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl('javascript:alert(1)')).resolves.toBe(false);
  });

  test('IPv6 字面量：公网允许 / ULA+环回拒绝', async () => {
    await expect(isAllowedSkillSourceUrl('https://[2606:4700::1111]/demo.tar.gz')).resolves.toBe(true);
    await expect(isAllowedSkillSourceUrl('https://[fc00::1]/demo.tar.gz')).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl('https://[::1]/demo.tar.gz')).resolves.toBe(false);
  });

  test('非法输入一律拒绝', async () => {
    await expect(isAllowedSkillSourceUrl('')).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl(null)).resolves.toBe(false);
    await expect(isAllowedSkillSourceUrl('not a url')).resolves.toBe(false);
  });
});

describe('_isBlockedIp — 段属判定', () => {
  test('v4-mapped 形态回退判段', () => {
    expect(_isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(_isBlockedIp('::ffff:10.0.0.1')).toBe(true);
    expect(_isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });
  test('非合法 IP 按不安全处理', () => {
    expect(_isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('fetchUrl — 重定向逐跳复校验 + 上限', () => {
  test('重定向目标校验不过即拒绝，且每跳都被校验', async () => {
    await withLocalServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final' });
        res.end();
      } else {
        res.writeHead(200);
        res.end('data');
      }
    }, async (port) => {
      const seen = [];
      const validateTarget = (u) => { seen.push(u); return Promise.resolve(u.endsWith('/start')); };
      await expect(fetchUrl(`http://127.0.0.1:${port}/start`, { validateTarget })).rejects.toThrow('目标地址不允许');
      expect(seen).toEqual([
        `http://127.0.0.1:${port}/start`,
        `http://127.0.0.1:${port}/final`,
      ]);
    });
  });

  test('重定向上限 3 跳，超过即拒绝', async () => {
    await withLocalServer((req, res) => {
      res.writeHead(302, { Location: '/next' });
      res.end();
    }, async (port) => {
      await expect(fetchUrl(`http://127.0.0.1:${port}/a`, { validateTarget: () => true })).rejects.toThrow('Too many redirects');
    });
  });
});

describe('installFromUrl — 私网地址发请求前短路拒绝', () => {
  test('私网 IP 初始 URL 直接拒绝（不发任何请求）', async () => {
    const result = await installFromUrl('http://127.0.0.1:1/demo.tar.gz', { skillName: 'demo-skill' });
    expect(result).toEqual({ success: false, error: '目标地址不允许' });
  });

  test('非 http(s) 协议直接拒绝', async () => {
    const result = await installFromUrl('ftp://example.com/demo.tar.gz', { skillName: 'demo-skill' });
    expect(result).toEqual({ success: false, error: '目标地址不允许' });
  });
});
