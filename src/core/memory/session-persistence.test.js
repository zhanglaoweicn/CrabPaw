/**
 * SessionPersistence 回归测试
 *
 * 2026-08-14 数据链审计 C2/I4:
 * - loadSession 旧实现优先命中 _sessionCache(创建时写入的空快照,运行期无人刷新)
 *   → GET /api/sessions/:id 恒返 messages: []。
 * - session-manager 与 memory-manager 各自 new SessionPersistence → 内存索引/缓存分裂。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// saveSession 会调用 getFtsSearch().indexSessionMessage——真实模块异步 initDatabase
// 泄漏到测试结束后(Cannot log after tests are done)且会写仓库 data/ 目录,测试内打桩。
jest.mock('./fts-search', () => ({
  indexSessionMessage: jest.fn(),
  searchSessions: jest.fn(async () => []),
}))

const { SessionPersistence, getSharedSessionPersistence } = require('./session-persistence')

let tmpDir
let persistence

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-persist-'))
  persistence = new SessionPersistence({
    sessionsDir: tmpDir,
    indexPath: path.join(tmpDir, 'user-sessions-index.json'),
  })
  await persistence.initialize()
})

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('loadSession 磁盘文件更新后返回最新消息(不返回陈旧缓存快照)', async () => {
  const sid = 'sess_c2_test'
  await persistence.saveSession(sid, { messages: [], createdAt: Date.now() }, 'u1')

  // 首次 load 命中空快照(与 handleSessionCreate 场景一致)
  const first = await persistence.loadSession(sid)
  expect(first.messages).toHaveLength(0)

  // 模拟运行期落盘/外部写入直接更新磁盘文件(内存缓存未同步)
  fs.writeFileSync(
    path.join(tmpDir, `${sid}.json`),
    JSON.stringify({ messages: [{ role: 'user', content: '你好', timestamp: Date.now() }] }),
  )

  // C2 修复: 磁盘优先,返回最新消息而非缓存空快照
  const second = await persistence.loadSession(sid)
  expect(second.messages).toHaveLength(1)
  expect(second.messages[0].content).toBe('你好')
})

test('saveSession 同步更新缓存与索引 messageCount(列表计数不再恒 0)', async () => {
  const sid = 'sess_count_test'
  await persistence.registerSession(sid, 'u1')
  await persistence.saveSession(
    sid,
    {
      messages: [
        { role: 'user', content: '问题', timestamp: 1 },
        { role: 'assistant', content: '回答', timestamp: 2 },
      ],
      createdAt: Date.now(),
    },
    'u1',
  )

  const [meta] = await persistence.getUserSessions('u1')
  expect(meta.messageCount).toBe(2)
  expect(meta.summary.firstMessage).toBe('问题')

  const loaded = await persistence.loadSession(sid)
  expect(loaded.messages).toHaveLength(2)
})

test('getSharedSessionPersistence 恒返回同一实例(双实例分裂修复)', () => {
  expect(getSharedSessionPersistence()).toBe(getSharedSessionPersistence())
  expect(getSharedSessionPersistence()).toBeInstanceOf(SessionPersistence)
})
