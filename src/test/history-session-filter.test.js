/**
 * history-index sessionId 过滤测试(P2-4, ag-ui 会话快照恢复借鉴)
 *
 * 背景(2026-08-13): getRecentMessages 支持 sessionId 过滤——
 * (session_id IS NULL OR session_id = ?) 刻意包含 NULL:升级前的历史消息
 * 无 session_id,保证恢复会话时上下文不断档。
 */
jest.mock('better-sqlite3', () => {
  const mockDb = () => {
    const rows = [];
    return {
      _rows: rows,
      prepare: () => ({
        run: (...args) => {
          const [userId, role, content, timestamp, sessionId] = args;
          rows.push({ userId, role, content, timestamp, sessionId });
        },
        all: (...args) => {
          // 模拟 SQL: sessionId 过滤(含 NULL 语义)
          const [userId, sessionId, limit] = args.length >= 3 ? args : [args[0], null, args[1]];
          const filtered = rows.filter(r => r.userId === userId
            && (!sessionId || r.sessionId === null || r.sessionId === sessionId));
          return filtered.slice(-(limit || 20)).reverse().map(r => ({
            role: r.role, content: r.content, timestamp: r.timestamp, session_id: r.sessionId,
          }));
        },
      }),
    };
  };
  // 单例实例:history-index 模块级缓存 db 单例,测试与生产路径须共享同一 rows
  const instance = mockDb();
  return jest.fn(() => instance);
});

describe('history-index getRecentMessages sessionId 过滤', () => {
  let history;
  let db;

  beforeAll(() => {
    history = require('../core/history-index');
    const sqlite = require('better-sqlite3');
    db = sqlite();
  });

  beforeEach(() => {
    db._rows.length = 0;
  });

  test('无 sessionId 时返回全部(向后兼容)', async () => {
    await history.addMessage('u1', 'user', 'hello', null);
    await history.addMessage('u1', 'assistant', 'hi', 'sess_A');
    const msgs = await history.getRecentMessages('u1', 20);
    expect(msgs.length).toBe(2);
  });

  test('sessionId 过滤只返回该会话 + 无标旧消息(NULL 包含)', async () => {
    await history.addMessage('u1', 'user', 'msg-sess-A', 'sess_A');
    await history.addMessage('u1', 'user', 'msg-sess-B', 'sess_B');
    await history.addMessage('u1', 'user', 'msg-legacy');
    const msgs = await history.getRecentMessages('u1', 20, 'sess_A');
    const contents = msgs.map(m => m.content);
    expect(contents).toContain('msg-sess-A');
    expect(contents).toContain('msg-legacy'); // NULL 包含
    expect(contents).not.toContain('msg-sess-B');
  });

  test('其他 userId 的消息被隔离', async () => {
    await history.addMessage('u1', 'user', 'mine', 'sess_A');
    await history.addMessage('u2', 'user', 'theirs', 'sess_A');
    const msgs = await history.getRecentMessages('u1', 20, 'sess_A');
    expect(msgs.every(m => m.content === 'mine')).toBe(true);
  });
});
