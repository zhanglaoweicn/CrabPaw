/**
 * 消息级点赞/点踩落库测试(P0-3, ag-ui MetaEvent 借鉴)
 *
 * 背景(2026-08-13): 对话卡 hover 反馈(👍/👎)经 POST /api/chat/message-feedback
 * 落 audit-log,定位键 = conversationId + messageTs(消息无服务端持久化 id)。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

describe('logMessageFeedback(消息反馈落库)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crabpaw-audit-test-'));
  let auditLog;

  beforeAll(() => {
    process.env.CRABPAW_DATA_DIR = tmpDir;
    jest.resetModules();
    auditLog = require('./audit-log');
  });

  afterAll(() => {
    delete process.env.CRABPAW_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('写入 message_feedback 事件条目', () => {
    const entry = auditLog.logMessageFeedback('voice_shell_user', {
      conversationId: 'conv_abc',
      messageTs: 1723500000000,
      rating: 'up',
      text: '好的,已生成周报',
    });
    expect(entry).toBeTruthy();
    expect(entry.id).toBeTruthy();
    expect(entry.event).toBe('message_feedback');
    expect(entry.userId).toBe('voice_shell_user');
    expect(entry.conversationId).toBe('conv_abc');
    expect(entry.messageTs).toBe(1723500000000);
    expect(entry.rating).toBe('up');
    expect(entry.text).toBe('好的,已生成周报');
  });

  test('AUDIT_EVENTS 注册了 MESSAGE_FEEDBACK', () => {
    expect(auditLog.AUDIT_EVENTS.MESSAGE_FEEDBACK).toBe('message_feedback');
  });

  test('超长文本被截断到 500 字符', () => {
    const longText = 'x'.repeat(800);
    const entry = auditLog.logMessageFeedback('voice_shell_user', {
      conversationId: 'conv_b',
      messageTs: 1723500000001,
      rating: 'down',
      text: longText,
    });
    expect(entry.text.length).toBe(500);
  });

  test('可经 getAuditLogs 按事件过滤查到', () => {
    auditLog.logMessageFeedback('voice_shell_user', {
      conversationId: 'conv_c',
      messageTs: 1723500000002,
      rating: 'down',
    });
    const logs = auditLog.getAuditLogs({ event: 'message_feedback' });
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.every((l) => l.event === 'message_feedback')).toBe(true);
  });
});
