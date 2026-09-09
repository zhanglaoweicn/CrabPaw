/**
 * voiceCommands — 本地语音命令注册表测试。
 * jest 环境为 node（无 jsdom window），用 stub 捕获 window.dispatchEvent 的事件，
 * 验证 P1 缺陷 1 修复：导航命令改派 crabpaw:open-cockpit（不再派 crabpaw:navigate），
 * 以及 P1 缺陷 4 修复：拦截前剥离唤醒词前缀（"小螃蟹打开设置"可命中）。
 */
import { interceptLocalVoiceCommand, listVoiceCommands } from './voiceCommands'

interface CapturedEvent { type: string; detail?: { tab?: string; section?: string } }

describe('interceptLocalVoiceCommand（语音本地命令）', () => {
  let events: CapturedEvent[]

  beforeEach(() => {
    events = []
    ;(global as any).window = {
      dispatchEvent: (e: any) => { events.push({ type: e?.type || 'unknown', detail: e?.detail }) },
    }
    // node 旧版本无全局 CustomEvent——兜底一个最小实现（Electron/浏览器环境不受影响）
    if (typeof (global as any).CustomEvent === 'undefined') {
      ;(global as any).CustomEvent = class {
        type: string
        detail: any
        constructor(type: string, init?: { detail?: any }) {
          this.type = type
          this.detail = init?.detail
        }
      }
    }
  })

  afterEach(() => { delete (global as any).window })

  test('6 条导航命令全部拦截且派发 crabpaw:open-cockpit（不派 crabpaw:navigate）', () => {
    const ids = listVoiceCommands().map(c => c.id)
    expect(ids).toEqual(expect.arrayContaining(['nav-home', 'nav-chat', 'nav-settings', 'nav-skills', 'nav-calendar', 'nav-memory']))

    expect(interceptLocalVoiceCommand('回到首页')).toBe(true)
    expect(interceptLocalVoiceCommand('打开对话')).toBe(true)
    expect(interceptLocalVoiceCommand('打开设置')).toBe(true)
    expect(interceptLocalVoiceCommand('打开技能')).toBe(true)
    expect(interceptLocalVoiceCommand('打开日历')).toBe(true)
    expect(interceptLocalVoiceCommand('打开记忆')).toBe(true)

    expect(events.map(e => e.type)).toEqual([
      'crabpaw:open-cockpit', 'crabpaw:open-cockpit', 'crabpaw:open-cockpit',
      'crabpaw:open-cockpit', 'crabpaw:open-cockpit', 'crabpaw:open-cockpit',
    ])
    expect(events.map(e => e.detail?.tab)).toEqual(['home', 'chat', 'settings', 'skills', 'calendar', 'memory'])
    expect(events.some(e => e.type === 'crabpaw:navigate')).toBe(false)
  })

  test('导航命令变体命中（设置页/查看日历/查看记忆）', () => {
    expect(interceptLocalVoiceCommand('打开设置页')).toBe(true)
    expect(interceptLocalVoiceCommand('查看日历')).toBe(true)
    expect(interceptLocalVoiceCommand('查看记忆')).toBe(true)
    expect(events.map(e => e.detail?.tab)).toEqual(['settings', 'calendar', 'memory'])
  })

  test('唤醒词"小螃蟹"连读前缀剥离后命中导航命令（P1 缺陷 4）', () => {
    expect(interceptLocalVoiceCommand('小螃蟹打开设置')).toBe(true)
    expect(interceptLocalVoiceCommand('小龙女，打开日历')).toBe(true)
    expect(interceptLocalVoiceCommand('crabpaw 打开技能')).toBe(true)
    expect(events.map(e => e.detail?.tab)).toEqual(['settings', 'calendar', 'skills'])
  })

  test('问候语"你好"后直接跟内容不过度剥离（你好吗 不被拦截）', () => {
    expect(interceptLocalVoiceCommand('你好吗')).toBe(false)
    expect(events).toHaveLength(0)
  })

  test('无关文本不拦截', () => {
    expect(interceptLocalVoiceCommand('帮我写一篇文章')).toBe(false)
    expect(interceptLocalVoiceCommand('今天天气怎么样')).toBe(false)
    expect(events).toHaveLength(0)
  })
})
