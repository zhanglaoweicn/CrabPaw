/**
 * DesktopControl 安全修复轮测试 (2026-09-06)
 *
 * 覆盖外部审查确认的缺口修复：
 * 1. 契约单源化——schema 与 registry 同源, 孤立校验不再被 additionalProperties:false 误拒
 * 2. highRiskActions per-action 审批闸——kill_process 等高风险动作不再借 selfApproval 免审
 * 3. composeSendKeys——press_key 修饰键生成正确的 .NET SendKeys 语法(此前 '{Ctrlc}' 打字面文本)
 * 4. volume_control 死动作修复——volume_action 专用参数
 * 5. ClipboardWrite 风险标记
 *
 * 注意: 本文件绝不调用 press_key/mouse_move 的成功路径——那会真实 SendKeys/移动光标。
 */

const { composeSendKeys } = require('../core/computer-use/windows-backend');
const { validateToolInput, getToolContract } = require('../core/tool-contract');
const { buildRegistryParameters, buildContractSchema } = require('../core/desktop/schema');

// 审批系统 mock 为立即拒绝——避免测试真的等待人工审批超时(此前等满 jest 5s 超时)。
// registry._requestToolApproval 在钩子内部延迟 require 这两个模块, jest.mock 可拦截。
jest.mock('../core/security/index', () => ({
  getApprovalSystem: () => ({
    request: async () => ({ requestId: 'req_test_mock' }),
    waitForApproval: async () => ({ status: 'denied', reason: '测试审批拒绝' }),
  }),
}));
jest.mock('../core/security/approval', () => ({
  getApprovalWaitTimeout: () => 100,
}));

require('../tools'); // 全量工具注册(含 ClipboardWrite/ClipboardRead)
const { registry } = require('../tools/registry');
const { handleDesktopControl } = require('../tools/desktop-tools');

describe('DesktopControl 契约单源化', () => {
  test('契约 schema 与 registry schema 属性集完全一致', () => {
    const contractProps = Object.keys(buildContractSchema().properties).sort();
    const registryProps = Object.keys(buildRegistryParameters().properties).sort();
    expect(contractProps).toEqual(registryProps);
  });

  test('此前被静态契约拒绝的调用, 孤立加载(不经启动期合并)即可通过', () => {
    const cases = [
      { action: 'mouse_click', x: 10, y: 20 },
      { action: 'mouse_move', x: 1, y: 2 },
      { action: 'screenshot', mode: 'som' },
      { action: 'press_key', key: 'c', modifiers: ['Control'] },
      { action: 'open_folder', path: 'C:/Users' },
      { action: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 },
      { action: 'start_process', command: 'notepad', args: 'a.txt', cwd: '.' },
      { action: 'volume_control', volume_action: 'mute' },
      { action: 'screen_capture', region: 'full' },
      { action: 'kill_process', pid: 123 },
    ];
    for (const input of cases) {
      const v = validateToolInput('DesktopControl', input);
      expect(v.valid).toBe(true);
    }
  });

  test('契约仍是强校验: 未知参数被拒', () => {
    expect(validateToolInput('DesktopControl', { action: 'screenshot', evil: 1 }).valid).toBe(false);
    expect(validateToolInput('DesktopControl', { action: 'no_such_action' }).valid).toBe(false);
  });

  test('volume_action 参数进入单源 schema', () => {
    const props = buildRegistryParameters().properties;
    expect(props.volume_action).toBeDefined();
    expect(props.volume_action.enum).toEqual(['mute', 'unmute', 'up', 'down']);
  });
});

describe('highRiskActions per-action 审批闸', () => {
  test('DesktopControl 注册了高风险 action 列表且整体仍 selfApproval', () => {
    const tool = registry.get('DesktopControl');
    expect(tool.selfApproval).toBe(true);
    expect(tool.highRiskActions).toEqual(
      expect.arrayContaining(['kill_process', 'lock_screen', 'sleep_system', 'start_process'])
    );
  });

  test('高风险 action 触发审批路径, 低风险 action 不触发', async () => {
    let killBlocked = false;
    for (const hook of registry._preExecuteHooks) {
      const kill = await hook('DesktopControl', { action: 'kill_process', pid: 123 }, {});
      // 审批系统已 mock 为立即拒绝 → 高风险 action 必须被闸门拦下
      if (kill?.blocked) {
        killBlocked = true;
        expect(kill.reason).toMatch(/拒绝|审批/);
      }
      const shot = await hook('DesktopControl', { action: 'screenshot' }, {});
      // screenshot 绝不应因审批被拦
      if (shot?.blocked) {
        expect(shot.reason).not.toMatch(/审批/);
      }
    }
    expect(killBlocked).toBe(true);
  });
});

describe('composeSendKeys (.NET SendKeys 语法合成)', () => {
  test('修饰键组合生成正确前缀语法', () => {
    expect(composeSendKeys('ctrl+c')).toBe('^c');
    expect(composeSendKeys('ctrl+shift+s')).toBe('^+s');
    expect(composeSendKeys('ctrl+alt+del'.replace('del', 'delete'))).toBe('^%{DEL}');
    expect(composeSendKeys('alt+d')).toBe('%d');
    expect(composeSendKeys('shift+1')).toBe('+1');
  });

  test('命名键与功能键生成花括号语法', () => {
    expect(composeSendKeys('enter')).toBe('{ENTER}');
    expect(composeSendKeys('escape')).toBe('{ESC}');
    expect(composeSendKeys('pageup')).toBe('{PGUP}');
    expect(composeSendKeys('f5')).toBe('{F5}');
  });

  test('单字符字面发送', () => {
    expect(composeSendKeys('c')).toBe('c');
    expect(composeSendKeys('1')).toBe('1');
  });

  test('不支持的情形显式抛错(而非生成坏语法)', () => {
    // win 修饰键 SendKeys 不支持 → 抛错(由 keybd_event 路径处理)
    expect(() => composeSendKeys('win+d')).toThrow(/Win/);
    // 裸修饰键不是可按压的 SendKeys 目标 → 抛错(由 keybd_event 路径处理)
    expect(() => composeSendKeys('ctrl')).toThrow();
    expect(() => composeSendKeys('')).toThrow();
    expect(() => composeSendKeys('nosuchkey')).toThrow(/无法识别的按键/);
  });
});

describe('volume_control 死动作修复', () => {
  test('缺 volume_action 时快速校验失败, 不执行任何命令', async () => {
    const ret = await handleDesktopControl({ action: 'volume_control' });
    expect(ret.success).toBe(false);
    expect(ret.message).toMatch(/volume_action/);
  });

  test('非法 volume_action 被拒', async () => {
    const ret = await handleDesktopControl({ action: 'volume_control', volume_action: 'loud' });
    expect(ret.success).toBe(false);
    expect(ret.message).toMatch(/volume_action/);
  });
});

describe('ClipboardWrite 风险标记', () => {
  test('riskLevel=medium 且有 whenNotToUse 警示', () => {
    const tool = registry.get('ClipboardWrite');
    expect(tool.riskLevel).toBe('medium');
    expect(tool.whenNotToUse.length).toBeGreaterThan(0);
  });

  test('ClipboardRead 保持只读', () => {
    expect(registry.get('ClipboardRead').isReadOnly).toBe(true);
  });
});

describe('press_key 校验路径(不触执行)', () => {
  test('白名单外按键被拒且不执行', async () => {
    const ret = await handleDesktopControl({ action: 'press_key', key: 'F13_SUPER_DANGER' });
    expect(ret.success).toBe(false);
    expect(ret.message).toMatch(/允许列表/);
  });

  test('白名单外修饰键被拒且不执行', async () => {
    const ret = await handleDesktopControl({ action: 'press_key', key: 'c', modifiers: ['SuperDanger'] });
    expect(ret.success).toBe(false);
    expect(ret.message).toMatch(/修饰键/);
  });
});
