/**
 * BrowserControl 安全收紧轮测试 (2026-09-06)
 *
 * 覆盖外部审查确认的四类缺口：
 * 1. 契约单源化——schema 与 registry 同源，此前被静态契约拒绝的采集/表单/分页调用可通过
 * 2. raw CDP 策略闸——Page.navigate 走 SSRF 校验、Runtime.evaluate 受开关+黑名单约束、Cookie 默认拒绝
 * 3. connectCDP 主机边界——默认仅本机端点，远程地址需显式白名单
 * 4. 审计脱敏——fill.value / type.text / evaluate.expression 不再明文落库
 */

const { BrowserControlManager } = require('../core/browser-control');
const { validateToolInput, getToolContract } = require('../core/tool-contract');
const { buildRegistryParameters, buildContractSchema } = require('../core/browser-control/schema');
const { redactToolParams, logDesktopControl } = require('../core/audit-log');
const v2 = require('../core/audit-log-v2');

const _managers = [];
function _makeManager(config = {}) {
  const mgr = new BrowserControlManager(config);
  _managers.push(mgr);
  return mgr;
}

afterAll(async () => {
  // 构造器会启动泄漏检查 interval，shutdown 清理以便 jest 自然退出
  for (const mgr of _managers) {
    await mgr.shutdown().catch(() => {});
  }
});

describe('BrowserControl 契约单源化', () => {
  test('契约 schema 与 registry schema 属性集完全一致', () => {
    const contractProps = Object.keys(buildContractSchema().properties).sort();
    const registryProps = Object.keys(buildRegistryParameters().properties).sort();
    expect(contractProps).toEqual(registryProps);
  });

  test('registry 缺口已修复: raw_cdp/click_at_cdp 参数对 LLM 可见', () => {
    const props = buildRegistryParameters().properties;
    for (const p of ['method', 'params', 'button', 'clickCount', 'maxTokens']) {
      expect(props[p]).toBeDefined();
    }
  });

  test('此前被静态契约拒绝的调用, 孤立加载(不经启动期合并)即可通过', () => {
    const cases = [
      { action: 'snapshot', maxChars: 20000, mode: 'text' },
      { action: 'fill', ref: '3', value: 'abc' },
      { action: 'scroll', direction: 'down', amount: 3 },
      { action: 'extract_data', containerSelector: '.list', fields: { title: 'h3' }, limit: 10 },
      { action: 'scroll_collect', containerSelector: '.list', maxScrolls: 5, scrollDelay: 500 },
      { action: 'paginate_collect', containerSelector: '.list', maxPages: 3, nextButton: '.next' },
      { action: 'screenshot', fullPage: true, imageType: 'jpeg' },
      { action: 'wait_for_selector', selector: '#app', timeout: 5000, state: 'visible' },
      { action: 'focus_tab', targetId: 't1' },
      { action: 'open_tab', url: 'https://example.com', label: 'demo' },
      { action: 'select', ref: '7', values: ['a'] },
      { action: 'press', key: 'Enter', modifiers: ['Control'] },
      { action: 'raw_cdp', method: 'DOM.getDocument', params: {} },
      { action: 'click_at_cdp', x: 100, y: 200, button: 'left', clickCount: 2 },
      { action: 'vision', prompt: '描述页面', maxTokens: 500 },
      { action: 'connect_cdp', wsEndpoint: 'ws://localhost:9222' },
      { action: 'stealth_toggle', enabled: false },
    ];
    for (const input of cases) {
      const v = validateToolInput('BrowserControl', input);
      expect(v.valid).toBe(true);
    }
  });

  test('契约仍是强校验: 未知参数与未知动作被拒', () => {
    expect(validateToolInput('BrowserControl', { action: 'navigate', url: 'x', evil: 1 }).valid).toBe(false);
    expect(validateToolInput('BrowserControl', { action: 'no_such_action' }).valid).toBe(false);
    expect(validateToolInput('BrowserControl', {}).valid).toBe(false);
  });

  test('契约 action 枚举与单源动作表一致', () => {
    const c = getToolContract('BrowserControl');
    expect(c.schema.properties.action.enum).toEqual(buildRegistryParameters().properties.action.enum);
  });
});

describe('BrowserControl raw CDP 策略闸', () => {
  test('Page.navigate 与 navigate() 同一 SSRF 校验, 且在会话启动前拦截', async () => {
    const mgr = _makeManager({});
    await expect(mgr.rawCDP('Page.navigate', { url: 'http://127.0.0.1/x' })).rejects.toThrow(/SSRF防护/);
    await expect(mgr.rawCDP('Page.navigate', { url: 'http://169.254.169.254/latest/meta-data' })).rejects.toThrow(/SSRF防护/);
    await expect(mgr.rawCDP('Page.navigate', { url: 'file:///etc/passwd' })).rejects.toThrow(/协议不允许/);
    await expect(mgr.rawCDP('Page.navigate', {})).rejects.toThrow(/URL不能为空/);
  });

  test('Runtime.evaluate 受 evaluateEnabled 开关约束', async () => {
    const mgr = _makeManager({ evaluateEnabled: false });
    await expect(mgr.rawCDP('Runtime.evaluate', { expression: '1+1' }))
      .rejects.toThrow(/JS执行已被安全策略禁用/);
  });

  test('Runtime.evaluate 受表达式黑名单约束, 缺参直接拒绝', async () => {
    const mgr = _makeManager({});
    await expect(mgr.rawCDP('Runtime.evaluate', { expression: 'require("fs")' })).rejects.toThrow();
    await expect(mgr.rawCDP('Runtime.evaluate', {})).rejects.toThrow(/缺少 expression 参数/);
    await expect(mgr.rawCDP('Runtime.callFunctionOn', { functionDeclaration: 'process.exit()' })).rejects.toThrow();
  });

  test('Cookie 读写默认拒绝', async () => {
    const mgr = _makeManager({});
    await expect(mgr.rawCDP('Network.getCookies', {})).rejects.toThrow(/Cookie访问被安全策略阻止/);
    await expect(mgr.rawCDP('Network.getAllCookies', {})).rejects.toThrow(/Cookie访问被安全策略阻止/);
    await expect(mgr.rawCDP('Network.setCookie', { name: 'a', value: 'b' })).rejects.toThrow(/Cookie访问被安全策略阻止/);
    await expect(mgr.rawCDP('Storage.getCookies', {})).rejects.toThrow(/Cookie访问被安全策略阻止/);
  });

  test('放行开关 rawCDPAllowCookies 生效(策略层不再拦截)', () => {
    const mgr = _makeManager({ rawCDPAllowCookies: true });
    expect(() => mgr._rawCDPPolicyCheck('Network.getCookies', {})).not.toThrow();
  });

  test('白名单域普通命令不拦截(不触发会话启动)', () => {
    const mgr = _makeManager({});
    expect(() => mgr._rawCDPPolicyCheck('DOM.getDocument', {})).not.toThrow();
    expect(() => mgr._rawCDPPolicyCheck('Page.captureScreenshot', {})).not.toThrow();
  });

  test('危险方法黑名单仍在(Browser.close 等)', async () => {
    const mgr = _makeManager({});
    await expect(mgr.rawCDP('Browser.close', {})).rejects.toThrow(/CDP方法被安全策略阻止/);
  });
});

describe('BrowserControl connectCDP 主机边界', () => {
  test('默认仅允许本机端点', () => {
    const mgr = _makeManager({});
    expect(mgr._cdpHostAllowed('ws://localhost:9222')).toBe('localhost');
    expect(mgr._cdpHostAllowed('ws://127.0.0.1:9222')).toBe('127.0.0.1');
    expect(mgr._cdpHostAllowed('ws://127.0.0.2:9222')).toBe('127.0.0.2');
    expect(mgr._cdpHostAllowed('ws://[::1]:9222')).toBe('[::1]');
  });

  test('远程地址默认拒绝, 白名单内放行', async () => {
    const mgr = _makeManager({});
    expect(() => mgr._cdpHostAllowed('ws://evil.example.com:9222')).toThrow(/CDP连接被安全策略阻止/);
    await expect(mgr.connectCDP('ws://203.0.113.5:9222')).rejects.toThrow(/CDP连接被安全策略阻止/);

    const mgr2 = _makeManager({ cdpAllowedHosts: ['relay.example.com'] });
    expect(mgr2._cdpHostAllowed('ws://relay.example.com:9222')).toBe('relay.example.com');
    expect(() => mgr2._cdpHostAllowed('ws://other.example.com:9222')).toThrow(/CDP连接被安全策略阻止/);
  });

  test('非法端点格式拒绝', () => {
    const mgr = _makeManager({});
    expect(() => mgr._cdpHostAllowed('not a url at all')).toThrow(/CDP端点格式无效/);
  });
});

describe('审计 params 结构化脱敏', () => {
  test('redactToolParams 遮蔽 value/text/expression/密码族, 不改原对象', () => {
    const src = {
      action: 'fill', ref: '3', value: 'hunter2',
      text: 'plain text', expression: 'require("fs")',
      nested: { password: 'p', token: 't', keep: 1 },
      arr: [{ secret: 's' }, 'normal'],
      selector: '.form input', // 非敏感键保持
    };
    const out = redactToolParams(src);
    expect(out.value).toBe('[REDACTED]');
    expect(out.text).toBe('[REDACTED]');
    expect(out.expression).toBe('[REDACTED]');
    expect(out.nested.password).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.nested.keep).toBe(1);
    expect(out.arr[0].secret).toBe('[REDACTED]');
    expect(out.arr[1]).toBe('normal');
    expect(out.selector).toBe('.form input');
    // 原对象未被修改
    expect(src.value).toBe('hunter2');
    expect(src.nested.password).toBe('p');
  });

  test('text 子串不误伤(context 等键)', () => {
    const out = redactToolParams({ context: 'keep me', containerSelector: '.a', maxTokens: 100 });
    expect(out.context).toBe('keep me');
    expect(out.containerSelector).toBe('.a');
    expect(out.maxTokens).toBe(100);
  });

  test('logDesktopControl 落库与 v2 存储均不含明文敏感值', () => {
    const ret = logDesktopControl('system', 'browser_fill', {
      action: 'fill', ref: '3', value: 'hunter2-secret', selector: '#pwd',
    }, { success: true });
    // 顶层平铺(旧返回形状)中的 params 字符串已是脱敏后内容
    expect(ret.params).toContain('[REDACTED]');
    expect(ret.params).not.toContain('hunter2-secret');

    // v2 存储侧同样干净
    const entries = v2.queryAuditLog({ limit: 50 });
    const hit = entries.find(e => e.id === ret.id);
    expect(hit).toBeDefined();
    const storedParams = hit.metadata ? String(hit.metadata.params) : String(hit.params);
    expect(storedParams).toContain('[REDACTED]');
    expect(storedParams).not.toContain('hunter2-secret');
  });
});
