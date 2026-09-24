/**
 * MCP 连接器向导测试（2026-09-24 M1 金蝶专线）
 *
 * 覆盖：连接器识别（URL/关键词+意图）、凭证校验与规范化、安装白名单、
 * buildServerConfig（PYTHONPATH 注入）、configure 成功路径的凭证打码
 * （密码值绝不出现在任何返回字段）、缺失凭证时降级且不触发连接。
 *
 * 全部 mock：不联网装包、不写真实 data/mcp-servers.json、不连真实金蝶。
 */

jest.mock('../core/mcp', () => ({ getMCPManager: () => global.__mockMgr }));

// spawn mock：import 探测一律"成功退出"（跳过真实 python/pip）
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: jest.fn(() => {
      const { EventEmitter } = jest.requireActual('events');
      const p = new EventEmitter();
      setImmediate(() => p.emit('exit', 0));
      p.kill = () => {};
      return p;
    }),
  };
});

global.__mockMgr = {
  addServer: jest.fn().mockResolvedValue(undefined),
  saveServerConfig: jest.fn().mockResolvedValue(undefined),
  deleteServerConfig: jest.fn().mockResolvedValue(undefined),
  removeServer: jest.fn().mockResolvedValue(undefined),
  getServer: jest.fn().mockReturnValue({ status: 'connected', tools: [{ name: 'query_voucher' }, { name: 'query_customer' }] }),
  getServers: jest.fn().mockReturnValue([]),
};

const { handleQuery, handleManage } = require('../tools/mcp-connect-tools');
const connectors = require('../core/mcp/connectors');

describe('MCP 连接器向导', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('connectors.matchConnector 识别', () => {
    test('贴金蝶 MCP 文档链接 → kingdee', () => {
      expect(connectors.matchConnector('帮我接这个 https://wahailong.github.io/KingdeeMCP/')).toBe('kingdee');
      expect(connectors.matchConnector('https://github.com/wahailong/KingdeeMCP')).toBe('kingdee');
    });

    test('"连接金蝶"意图 → kingdee；单纯聊金蝶不触发', () => {
      expect(connectors.matchConnector('帮我连接金蝶系统')).toBe('kingdee');
      expect(connectors.matchConnector('接入云星空的数据')).toBe('kingdee');
      expect(connectors.matchConnector('金蝶的应收怎么导出')).toBeNull();
    });

    test('无关链接 → null', () => {
      expect(connectors.matchConnector('https://example.com/some-mcp')).toBeNull();
      expect(connectors.matchConnector('')).toBeNull();
    });
  });

  describe('validateCredentials 校验与规范化', () => {
    const preset = connectors.getConnector('kingdee');

    test('全缺 → 4 项缺失，逐项带引导语', () => {
      const r = connectors.validateCredentials(preset, {});
      expect(r.ok).toBe(false);
      expect(r.missing).toHaveLength(4);
      expect(r.errors.KINGDEE_SERVER_URL).toContain('/k3cloud/');
    });

    test('地址缺 /k3cloud/ 后缀 → 报错；规范地址自动补尾斜杠', () => {
      const bad = connectors.validateCredentials(preset, {
        KINGDEE_SERVER_URL: 'http://192.168.1.10',
        KINGDEE_ACCT_ID: 'acct1',
        KINGDEE_USERNAME: 'u',
        KINGDEE_PASSWORD: 'p',
      });
      expect(bad.ok).toBe(false);
      expect(bad.errors.KINGDEE_SERVER_URL).toContain('/k3cloud/');

      const good = connectors.validateCredentials(preset, {
        KINGDEE_SERVER_URL: 'http://192.168.1.10/k3cloud',
        KINGDEE_ACCT_ID: 'acct1',
        KINGDEE_USERNAME: 'u',
        KINGDEE_PASSWORD: 'p',
      });
      expect(good.ok).toBe(true);
      expect(good.normalized.KINGDEE_SERVER_URL).toBe('http://192.168.1.10/k3cloud/');
    });

    test('兼容中文标签键与大小写变体', () => {
      const r = connectors.validateCredentials(preset, {
        '金蝶服务器地址': 'https://x.com/k3cloud/',
        kingdee_acct_id: 'a',
        '金蝶账号': 'u',
        '金蝶账号密码': 'p',
      });
      expect(r.ok).toBe(true);
      expect(r.normalized.KINGDEE_ACCT_ID).toBe('a');
    });
  });

  describe('安装白名单 assertInstallAllowed', () => {
    const preset = connectors.getConnector('kingdee');

    test('preset 声明的包名放行', () => {
      expect(() => connectors.assertInstallAllowed(preset, 'kingdee-mcp')).not.toThrow();
    });

    test('其他包名/非法包名拒绝', () => {
      expect(() => connectors.assertInstallAllowed(preset, 'evil-package')).toThrow('只允许');
      expect(() => connectors.assertInstallAllowed(preset, 'kingdee-mcp; rm -rf /')).toThrow('包名非法');
      expect(() => connectors.assertInstallAllowed(preset, '')).toThrow();
    });
  });

  describe('buildServerConfig', () => {
    test('python-module 形态 + PYTHONPATH 指向 data/mcp-libs/<id>', () => {
      const preset = connectors.getConnector('kingdee');
      const cfg = connectors.buildServerConfig(
        preset,
        { KINGDEE_SERVER_URL: 'https://x/k3cloud/', KINGDEE_ACCT_ID: 'a', KINGDEE_USERNAME: 'u', KINGDEE_PASSWORD: 'p' },
        { pythonPath: 'C:\\py\\python.exe', libDir: 'D:\\data\\mcp-libs\\kingdee' }
      );
      expect(cfg.command).toBe('C:\\py\\python.exe');
      expect(cfg.args).toEqual(['-m', 'kingdee_mcp.server']);
      expect(cfg.env.PYTHONPATH).toBe('D:\\data\\mcp-libs\\kingdee');
      expect(cfg.env.KINGDEE_PASSWORD).toBe('p');
    });
  });

  describe('maskEnv 打码', () => {
    test('secret → ••••，服务器地址保留', () => {
      const preset = connectors.getConnector('kingdee');
      const masked = connectors.maskEnv(preset, {
        KINGDEE_SERVER_URL: 'https://x/k3cloud/',
        KINGDEE_ACCT_ID: 'acct',
        KINGDEE_USERNAME: 'boss',
        KINGDEE_PASSWORD: 'super-secret-pw',
      });
      expect(masked.KINGDEE_PASSWORD).toBe('••••••');
      expect(masked.KINGDEE_SERVER_URL).toBe('https://x/k3cloud/');
      expect(JSON.stringify(masked)).not.toContain('super-secret-pw');
    });
  });

  describe('inspect（查询侧）', () => {
    test('未知链接 → 诚实说未收录，不自由解析', async () => {
      const r = await handleQuery({ action: 'inspect', url: 'https://example.com/unknown-mcp' });
      expect(r.content).toContain('未匹配到已收录的连接器');
    });

    test('金蝶链接 → 给出接入计划与 4 项信息引导（中文标签，不暴露环境变量名）', async () => {
      const r = await handleQuery({ action: 'inspect', url: 'https://wahailong.github.io/KingdeeMCP/' });
      expect(r.content).toContain('金蝶云星空');
      expect(r.content).toContain('金蝶服务器地址');
      expect(r.content).toContain('账套 ID');
      expect(r.content).toContain('账号密码');
      expect(r.connectorId).toBe('kingdee');
    });
  });

  describe('configure（变更侧）', () => {
    test('凭证缺失 → 结构化降级，不触发 addServer', async () => {
      const r = await handleManage({ action: 'configure', connector: 'kingdee', credentials: { KINGDEE_SERVER_URL: 'https://x/k3cloud/' } });
      expect(r.success).toBe(false);
      expect(r.missingFields).toEqual(expect.arrayContaining(['KINGDEE_ACCT_ID', 'KINGDEE_USERNAME', 'KINGDEE_PASSWORD']));
      expect(global.__mockMgr.addServer).not.toHaveBeenCalled();
      expect(global.__mockMgr.saveServerConfig).not.toHaveBeenCalled();
    });

    test('连接失败 → 不落盘（saveServerConfig 不调用）', async () => {
      global.__mockMgr.addServer.mockRejectedValueOnce(new Error('spawn failed'));
      const r = await handleManage({
        action: 'configure',
        connector: 'kingdee',
        credentials: { KINGDEE_SERVER_URL: 'https://x/k3cloud/', KINGDEE_ACCT_ID: 'a', KINGDEE_USERNAME: 'u', KINGDEE_PASSWORD: 'p' },
      });
      expect(r.success).toBe(false);
      expect(r.content).toContain('连接金蝶失败');
      expect(global.__mockMgr.saveServerConfig).not.toHaveBeenCalled();
    });

    test('成功路径：热连接+落盘+工具清单，且密码不出现在任何返回字段', async () => {
      const r = await handleManage({
        action: 'configure',
        connector: 'kingdee',
        credentials: {
          KINGDEE_SERVER_URL: 'https://my.kingdee.local/k3cloud/',
          KINGDEE_ACCT_ID: 'ACCT-001',
          KINGDEE_USERNAME: 'boss',
          KINGDEE_PASSWORD: 'super-secret-pw',
        },
      });
      expect(r.success).toBe(true);
      expect(r.toolCount).toBe(2);
      expect(r.content).toContain('query_voucher');
      expect(global.__mockMgr.saveServerConfig).toHaveBeenCalledTimes(1);

      // 写盘的配置含 PYTHONPATH 与真实凭证（供子进程用）
      const saved = global.__mockMgr.addServer.mock.calls[0][1];
      expect(saved.env.PYTHONPATH).toContain(connectors.getMcpLibDir('kingdee').slice(-18));
      expect(saved.env.KINGDEE_PASSWORD).toBe('super-secret-pw');

      // 但返回给对话的内容里密码必须已打码
      const dumped = JSON.stringify(r);
      expect(dumped).not.toContain('super-secret-pw');
      expect(r.configMasked.env.KINGDEE_PASSWORD).toBe('••••••');
      expect(r.configMasked.env.KINGDEE_SERVER_URL).toBe('https://my.kingdee.local/k3cloud/');
    });
  });
});
