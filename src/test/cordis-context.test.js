'use strict';
const { getHarnessContext, setHarnessContext } = require('../core/cordis/context');

describe('getHarnessContext', () => {
  test('安装后返回相同 ctx 对象（服务即单例引用, 无双真理源）', () => {
    const fakeTree = { ctx: { tools: { registry: true }, serviceRegistry: { r: true } }, inventory: {} };
    setHarnessContext(fakeTree);
    expect(getHarnessContext()).toBe(fakeTree);
    expect(getHarnessContext().ctx.tools).toBe(fakeTree.ctx.tools);
  });
  test('未安装时返回 null（调用方必须 null-safe）', () => {
    setHarnessContext(null);
    expect(getHarnessContext()).toBeNull();
  });
});
