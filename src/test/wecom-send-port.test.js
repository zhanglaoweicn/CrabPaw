/**
 * resolveWecomSendPort 纯函数测试（P0 SP3）
 * 统一端口解析：env.WECOM_SEND_PORT > .wecom_send_port 文件值 > 默认 38769
 * 非法值（非数字/非正数/空串）自动下坠到下一优先级。
 */
const { resolveWecomSendPort } = require('../channels/wecom/index');

describe('resolveWecomSendPort', () => {
  test('env WECOM_SEND_PORT 优先于端口文件值', () => {
    const port = resolveWecomSendPort({ WECOM_SEND_PORT: '40001' }, '39999');
    expect(port).toBe(40001);
  });

  test('无 env 时使用端口文件值', () => {
    const port = resolveWecomSendPort({}, '39998');
    expect(port).toBe(39998);
  });

  test('两者皆无时默认 38769', () => {
    const port = resolveWecomSendPort({}, null);
    expect(port).toBe(38769);
  });

  test('env 非法值时下坠到文件值', () => {
    const port = resolveWecomSendPort({ WECOM_SEND_PORT: 'abc' }, '39997');
    expect(port).toBe(39997);
  });

  test('文件值非法/为空时下坠到默认 38769', () => {
    expect(resolveWecomSendPort({}, '  ')).toBe(38769);
    expect(resolveWecomSendPort({}, 'abc')).toBe(38769);
    expect(resolveWecomSendPort({}, undefined)).toBe(38769);
  });
});
