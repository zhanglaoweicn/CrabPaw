/**
 * config-handler 契约测试(GUI 全量修复 P2)
 *
 * 验证: POST /config 的 voice 段无字段过滤(replyEnabled 原样合并持久化)、
 * 凭据掩码保留不回退(*** 时保留旧值)。
 */
jest.mock('./http-utils', () => ({
  readJsonBody: jest.fn(),
  sendError: jest.fn(),
  sendJson: jest.fn(),
}))

const { handleConfig } = require('./config-handler')
const { readJsonBody, sendError, sendJson } = require('./http-utils')

beforeEach(() => {
  jest.clearAllMocks()
  delete process.env.ADMIN_API_KEY
})

function makeCtx(overrides = {}) {
  const saveConfig = jest.fn()
  const appConfig = {
    voice: { replyEnabled: true, doubaoKey: 'OLD_KEY', ttsProvider: 'doubao' },
    ...(overrides.appConfig || {}),
  }
  const ctx = {
    appConfig,
    config: {
      loadConfig: jest.fn(() => JSON.parse(JSON.stringify(appConfig))),
      saveConfig,
    },
    ...overrides,
  }
  return { ctx, saveConfig }
}

test('POST voice.replyEnabled 原样合并持久化(无字段过滤)', async () => {
  const { ctx, saveConfig } = makeCtx()
  readJsonBody.mockResolvedValue({ voice: { replyEnabled: true, ttsProvider: 'doubao' } })

  await handleConfig({ method: 'POST', headers: {} }, {}, ctx)

  expect(ctx.appConfig.voice.replyEnabled).toBe(true)
  expect(saveConfig).toHaveBeenCalledWith(ctx.appConfig)
  expect(sendError).not.toHaveBeenCalled()
})

test('POST voice 凭据掩码保留: *** 时保留旧值不回退', async () => {
  const { ctx, saveConfig } = makeCtx()
  readJsonBody.mockResolvedValue({ voice: { doubaoKey: '***', ttsProvider: 'openai' } })

  await handleConfig({ method: 'POST', headers: {} }, {}, ctx)

  expect(ctx.appConfig.voice.doubaoKey).toBe('OLD_KEY')
  expect(ctx.appConfig.voice.ttsProvider).toBe('openai')
  expect(saveConfig).toHaveBeenCalled()
})

test('POST replyEnabled=false 显式关闭生效(用户可关, 不被默认覆盖)', async () => {
  const { ctx, saveConfig } = makeCtx()
  readJsonBody.mockResolvedValue({ voice: { replyEnabled: false } })

  await handleConfig({ method: 'POST', headers: {} }, {}, ctx)

  expect(ctx.appConfig.voice.replyEnabled).toBe(false)
  expect(saveConfig).toHaveBeenCalled()
})

test('GET 返回 voice 段(脱敏后), replyEnabled 不被掩码', async () => {
  const { ctx } = makeCtx()
  await handleConfig({ method: 'GET', headers: {} }, {}, ctx)

  const call = sendJson.mock.calls[0]
  expect(call[1]).toBe(200)
  const data = call[2].data
  expect(data.voice.replyEnabled).toBe(true)
  expect(data.voice.doubaoKey).not.toBe('OLD_KEY') // 掩码
  expect(data.voice.doubaoKey).toContain('*')
})

test('未授权 POST → 401', async () => {
  process.env.ADMIN_API_KEY = 'secret-admin'
  const { ctx } = makeCtx()
  await handleConfig({ method: 'POST', headers: {} }, {}, ctx)

  expect(sendError).toHaveBeenCalledWith(expect.anything(), 401, 'Unauthorized')
})
