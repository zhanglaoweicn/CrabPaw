/**
 * console-bridge.js 单元测试
 */

const { install, uninstall, isInstalled } = require('../core/console-bridge');

describe('console-bridge', () => {
  afterEach(() => {
    // 确保每次测试后卸载
    if (isInstalled()) {
      uninstall();
    }
  });

  test('初始状态应为未安装', () => {
    expect(isInstalled()).toBe(false);
  });

  test('安装后应为已安装状态', () => {
    install({ keepOriginal: false });
    expect(isInstalled()).toBe(true);
  });

  test('卸载后应为未安装状态', () => {
    install({ keepOriginal: false });
    expect(isInstalled()).toBe(true);
    uninstall();
    expect(isInstalled()).toBe(false);
  });

  test('重复安装不应报错', () => {
    install({ keepOriginal: false });
    install({ keepOriginal: false });
    expect(isInstalled()).toBe(true);
  });

  test('卸载后 console 方法应恢复原始行为', () => {
    const originalLog = console.log;
    install({ keepOriginal: false });
    uninstall();
    expect(console.log).toBe(originalLog);
  });
});
