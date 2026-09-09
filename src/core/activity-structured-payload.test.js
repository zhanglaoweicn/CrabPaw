/**
 * Activity 结构化 payload 测试(P1-8, ag-ui ActivityDelta 借鉴)
 *
 * 背景(2026-08-13): 工具结果附加结构化负载(cardState/resultPayload)供前端
 * 三态卡片展示;2KB 截断先于脱敏,对象字段经 redactSensitive、字符串内容
 * 经正则遮蔽密钥。
 */
const { buildResultPayload } = require('./activity-stream');

describe('buildResultPayload(结构化结果构建)', () => {
  test('对象结果序列化 + 字段脱敏', () => {
    const payload = buildResultPayload({ rows: 3, apiKey: 'sk-secret123456', data: 'ok' });
    expect(payload.success).toBe(true);
    expect(payload.error).toBeNull();
    expect(payload.content).toContain('"apiKey":"[REDACTED]"');
    expect(payload.content).toContain('"rows":3');
    expect(payload.content).not.toContain('sk-secret123456');
  });

  test('字符串内容中的密钥被遮蔽', () => {
    const payload = buildResultPayload('auth with Bearer abcdef1234567890 done');
    expect(payload.content).not.toContain('abcdef1234567890');
    expect(payload.content).toContain('Bearer ****');
  });

  test('2KB 截断', () => {
    const payload = buildResultPayload({ big: 'x'.repeat(5000) });
    expect(payload.content.length).toBeLessThanOrEqual(2048 + '…[截断]'.length);
    expect(payload.content).toContain('[截断]');
  });

  test('error 字段提取', () => {
    const payload = buildResultPayload({ error: 'timeout' });
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('timeout');
  });

  test('null/undefined 安全', () => {
    expect(buildResultPayload(null).success).toBe(true);
    expect(buildResultPayload(undefined).content).toBe('');
  });

  test('字符串型结果原样保留(脱敏后)', () => {
    const payload = buildResultPayload('plain text result');
    expect(payload.content).toBe('plain text result');
  });
});
