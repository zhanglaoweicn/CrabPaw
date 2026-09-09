/**
 * audit-log → audit-log-v2 薄适配层转发锁定 (2026-08-15 P2-7 双审计合并)
 *
 * 锁定: 旧 API 形状不变({id,timestamp,event,...details} 顶层平铺),
 * 写入经 v2 JSONL 落盘,读取从 v2 重建旧形状,clearAuditLogs 清空 v2 存储。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('audit-log v2 适配层(转发锁定)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-audit-adapter-'));
  let auditLog;
  let v2;

  beforeAll(() => {
    process.env.CRABPAW_DATA_DIR = tmpDir;
    jest.resetModules();
    auditLog = require('./audit-log');
    v2 = require('./audit-log-v2');
  });

  afterAll(() => {
    delete process.env.CRABPAW_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('logAuditEvent 转发 v2 JSONL 落盘且返回旧形状', () => {
    const entry = auditLog.logAuditEvent('tool_execute', { userId: 'u1', toolName: 'Bash' });
    expect(entry.event).toBe('tool_execute');
    expect(entry.userId).toBe('u1');
    expect(entry.toolName).toBe('Bash');
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();

    const stored = v2.queryAuditLog({ event: 'tool_execute', limit: 10 });
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored[0].actor).toBe('u1');
    expect(stored[0].metadata.toolName).toBe('Bash');
  });

  test('getAuditLogs 从 v2 读取并重建旧形状(含 userId 顶层字段)', () => {
    auditLog.logSecurityBlock('u2', 'Bash', 'test-reason');
    const logs = auditLog.getAuditLogs({ event: 'security_block' });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].userId).toBe('u2');
    expect(logs[0].reason).toBe('test-reason');
    expect(logs[0].toolName).toBe('Bash');
  });

  test('旧事件常量全集保留(v2 独有键补齐)', () => {
    expect(auditLog.AUDIT_EVENTS.MESSAGE_FEEDBACK).toBe('message_feedback');
    expect(auditLog.AUDIT_EVENTS.TOOL_EXECUTE).toBe('tool_execute');
    expect(auditLog.AUDIT_EVENTS.DESKTOP_CONTROL).toBe('desktop_control');
    expect(auditLog.RISK_LEVELS.CRITICAL).toBe('critical');
  });

  test('clearAuditLogs 清空 v2 存储', () => {
    auditLog.logAuditEvent('chat_message', { userId: 'u3' });
    auditLog.clearAuditLogs();
    expect(v2.queryAuditLog({ limit: 10 })).toHaveLength(0);
  });

  test('显式 result:false 映射为 failed 而非 success (2026-08-15 T7 累积D)', () => {
    // 此前 details.result || 'success' 使显式 false 被存成 'success'（失败审计失真）
    auditLog.logAuditEvent('tool_execute', { userId: 'u4', toolName: 'Bash', result: false });
    const stored = v2.queryAuditLog({ event: 'tool_execute', limit: 10 });
    const entry = stored.find((e) => e.actor === 'u4' && e.metadata.result === false);
    expect(entry).toBeTruthy();
    expect(entry.result).toBe('failed');
    // 缺省仍为 success（原回退语义不变）
    auditLog.logAuditEvent('tool_execute', { userId: 'u5', toolName: 'Bash' });
    const stored2 = v2.queryAuditLog({ event: 'tool_execute', limit: 10 });
    const entry2 = stored2.find((e) => e.actor === 'u5');
    expect(entry2.result).toBe('success');
  });
});
