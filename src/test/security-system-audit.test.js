/**
 * Bug C 回归测试: SecuritySystem.setLevel 调用了不存在的 this._audit 方法
 * → 任何 GUI 保存(含安全配置即时生效)抛 "this._audit is not a function"→500。
 * 修复: 补上 _audit 方法(推入 _auditLog, 与 getStats 的 auditLogSize 配套)。
 */
const { SecuritySystem } = require('../core/security');

test('setLevel 不应抛异常, 且审计日志应记录事件', () => {
  const sec = new SecuritySystem();
  expect(() => sec.setLevel('standard')).not.toThrow();
  expect(Array.isArray(sec._auditLog)).toBe(true);
  expect(sec._auditLog.length).toBeGreaterThan(0);
  const entry = sec._auditLog[sec._auditLog.length - 1];
  expect(entry.event).toBe('security_level_change');
});
