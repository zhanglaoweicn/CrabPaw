import { sanitizeConfigSetPayload, CONFIG_SET_TOP_LEVEL_WHITELIST } from './config-set-guard'

// 2026-08-15 审查返工回归测试: SetupWizard 把 config:get 整包(含 _isLarkConfigured /
// _isWecomConfigured 注入字段)回传 config:set 修改唤醒词, 必须不被 unknownFields 误拒。

// 模拟真实 config:get 整包: src/core/config.js defaultConfig(:254-400) 17 个顶层键
// + config-handler.js 追加落盘键(providers/modelAssignments)
// + GUI 写入键(wakeWord/defaultModel/security/schedule/visionGeneration/search)
// + config:get 注入的 _ 内部字段。
const buildRealRoundTripPayload = (): any => ({
  chatChannel: ['none'], // 2026-09-06: 'wechat' 通道已退役，夹具对齐 defaultConfig 实际默认值
  lark: { appId: 'cli_xxx', appSecret: '****' },
  wecom: { botId: '', secret: '****', corpId: '', contactsSecret: '', approvalSecret: '', botUserId: '', botName: '', groupPolicy: 'mention_only', watchedTemplates: [] },
  models: { currentProvider: 'deepseek', defaultModel: 'deepseek-chat', providers: { deepseek: { baseUrl: '', apiKey: '****', model: 'deepseek-chat' } } },
  imageGeneration: { provider: 'doubao', model: 'x', providers: { doubao: { baseUrl: '', apiKey: '****', model: 'x' } } },
  videoGeneration: { provider: 'doubao', model: 'x', providers: { doubao: { baseUrl: '', apiKey: '****', model: 'x' } } },
  visionGeneration: { provider: 'qwen', model: 'qwen-vl-plus' },
  agent: { name: 'CrabPaw' },
  user: { name: '', timezone: 'Asia/Shanghai' },
  adminUsers: [],
  enableWhitelist: false,
  allowedUsers: [],
  pushTargets: [],
  update: { autoCheck: true },
  voice: { replyEnabled: true },
  tts: { provider: 'doubao', providers: { volcengine: { appId: '', accessToken: '' } } },
  stt: { provider: 'volcengine', providers: { volcengine: { appId: '', accessToken: '' } } },
  providers: { custom: { apiKey: '****' } },
  modelAssignments: { chat: 'deepseek' },
  search: {},
  security: {},
  schedule: {},
  wakeWord: '小螃蟹',
  defaultModel: 'deepseek-chat',
  setupCompleted: true,
  _isLarkConfigured: true,
  _isWecomConfigured: false,
})

describe('sanitizeConfigSetPayload (config:set 顶层守卫)', () => {
  it('真实 get 整包回传(含 _ 注入字段 + 后端全部顶层键)通过校验, 且 _ 字段被剥离', () => {
    const payload = buildRealRoundTripPayload()
    const result = sanitizeConfigSetPayload(payload)
    expect(result.ok).toBe(true)
    expect(payload._isLarkConfigured).toBeUndefined()
    expect(payload._isWecomConfigured).toBeUndefined()
    // 后端字段全部保留可落盘
    expect(payload.wakeWord).toBe('小螃蟹')
    expect(payload.tts.provider).toBe('doubao')
    expect(payload.stt.provider).toBe('volcengine')
    expect(payload.pushTargets).toEqual([])
    expect(payload.providers).toEqual({ custom: { apiKey: '****' } })
    expect(payload.modelAssignments).toEqual({ chat: 'deepseek' })
  })

  it('真正未知的顶层字段仍被拒绝(白名单防越权保留)', () => {
    const result = sanitizeConfigSetPayload({ wakeWord: 'x', evilField: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('evilField')
  })

  it('非对象输入被拒绝', () => {
    expect(sanitizeConfigSetPayload(null).ok).toBe(false)
    expect(sanitizeConfigSetPayload(undefined).ok).toBe(false)
    expect(sanitizeConfigSetPayload([1, 2]).ok).toBe(false)
    expect(sanitizeConfigSetPayload('str').ok).toBe(false)
  })

  it('无 _ 字段的合法载荷不受影响', () => {
    const payload: any = { wakeWord: '小螃蟹', agent: { name: 'CrabPaw' } }
    const result = sanitizeConfigSetPayload(payload)
    expect(result.ok).toBe(true)
    expect(Object.keys(payload)).toEqual(['wakeWord', 'agent'])
  })

  it('白名单覆盖后端真实落盘顶层字段全集(defaultConfig + config-handler 写入)', () => {
    // 2026-08-15 复核: 以 src/core/config.js defaultConfig(:254-400) 17 个顶层键
    // + src/handlers/config-handler.js HTTP 保存路径(providers / modelAssignments / pushTargets) 为准, 全部必须可写
    const backendFields = [
      // defaultConfig 17 键
      'chatChannel', 'lark', 'wecom', 'models', 'imageGeneration', 'videoGeneration', 'agent', 'user',
      'adminUsers', 'enableWhitelist', 'allowedUsers', 'pushTargets', 'update', 'voice', 'tts', 'stt',
      'setupCompleted',
      // config-handler.js 追加落盘键
      'providers', 'modelAssignments',
      // 2026-08-28 审计 L2: ai.js 启动读 config.json permissions.mode(用户手动写入的
      // GUI 外权限入口)——整包回传不得被误拒
      'permissions',
    ]
    for (const f of backendFields) expect(CONFIG_SET_TOP_LEVEL_WHITELIST.has(f)).toBe(true)
  })
})
