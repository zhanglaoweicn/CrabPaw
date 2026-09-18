/**
 * web-browse 纯函数测试 — 应用内浏览面板渲染层契约
 * 覆盖：URL 协议白名单 / 面板矩形计算 / guestBounds 推导 / 动作白名单 /
 * 主进程状态清洗 / 标题展示退化链 / IPC 通道名契约锚定
 */

import {
  WEBPANEL_IPC,
  WEBPANEL_ACTIONS,
  isWebPanelAction,
  isWebPanelNavigableUrl,
  computePanelRect,
  guestBounds,
  sanitizeWebPanelState,
  displayTitle,
} from './web-browse'

describe('isWebPanelNavigableUrl', () => {
  test('放行 http/https', () => {
    expect(isWebPanelNavigableUrl('https://example.com/a?b=1')).toBe(true)
    expect(isWebPanelNavigableUrl('http://example.com')).toBe(true)
  })

  test('拒绝危险与未注册协议', () => {
    expect(isWebPanelNavigableUrl('file:///etc/passwd')).toBe(false)
    expect(isWebPanelNavigableUrl('javascript:alert(1)')).toBe(false)
    expect(isWebPanelNavigableUrl('data:text/html,<script>1</script>')).toBe(false)
    // local: 走 WebPreviewCard iframe，面板 partition 未注册该协议
    expect(isWebPanelNavigableUrl('local://preview.html')).toBe(false)
  })

  test('拒绝非法输入', () => {
    expect(isWebPanelNavigableUrl('')).toBe(false)
    expect(isWebPanelNavigableUrl('   ')).toBe(false)
    expect(isWebPanelNavigableUrl('not a url')).toBe(false)
    expect(isWebPanelNavigableUrl(undefined)).toBe(false)
    expect(isWebPanelNavigableUrl(123)).toBe(false)
    expect(isWebPanelNavigableUrl(null)).toBe(false)
  })
})

describe('computePanelRect', () => {
  test('标准视口：宽度取上限 560，右侧停靠', () => {
    const r = computePanelRect(1440, 900)
    expect(r).not.toBeNull()
    expect(r!.width).toBe(560)
    expect(r!.x).toBe(1440 - 560 - 12)
    expect(r!.y).toBe(46 + 12)
    expect(r!.height).toBe(900 - 46 - 24)
  })

  test('窄视口：宽度按视口 42% 收缩', () => {
    const r = computePanelRect(800, 600)
    expect(r!.width).toBe(Math.round(800 * 0.42))
    expect(r!.x).toBe(800 - Math.round(800 * 0.42) - 12)
  })

  test('视口过小返回 null（不铺面板）', () => {
    expect(computePanelRect(400, 600)).toBeNull()   // 宽 < 420
    expect(computePanelRect(1440, 200)).toBeNull()  // 高 < 240
    expect(computePanelRect(NaN, 900)).toBeNull()
    expect(computePanelRect(1440, Infinity)).toBeNull()
    expect(computePanelRect(0, 0)).toBeNull()
  })
})

describe('guestBounds', () => {
  test('工具栏以下为访客区：y +46、height -46', () => {
    const panel = { x: 868, y: 58, width: 560, height: 830 }
    const g = guestBounds(panel)
    expect(g.x).toBe(868)
    expect(g.y).toBe(104)
    expect(g.width).toBe(560)
    expect(g.height).toBe(784)
  })

  test('极端矮面板不出现负高度', () => {
    const g = guestBounds({ x: 0, y: 0, width: 100, height: 10 })
    expect(g.height).toBe(0)
  })
})

describe('isWebPanelAction', () => {
  test('白名单五动作', () => {
    expect(WEBPANEL_ACTIONS).toEqual(['back', 'forward', 'reload', 'stop', 'open-external'])
    for (const a of WEBPANEL_ACTIONS) expect(isWebPanelAction(a)).toBe(true)
  })

  test('拒绝未知动作', () => {
    expect(isWebPanelAction('close')).toBe(false)
    expect(isWebPanelAction('')).toBe(false)
    expect(isWebPanelAction(42)).toBe(false)
    expect(isWebPanelAction(undefined)).toBe(false)
  })
})

describe('sanitizeWebPanelState', () => {
  test('透传合法字段', () => {
    const s = sanitizeWebPanelState({
      url: 'https://example.com', title: '例', isLoading: true,
      canGoBack: true, canGoForward: false,
    })
    expect(s).toEqual({
      url: 'https://example.com', title: '例', isLoading: true,
      canGoBack: true, canGoForward: false,
    })
  })

  test('垃圾输入安全退化（防主进程事件被伪造字段污染）', () => {
    expect(sanitizeWebPanelState(null)).toEqual({
      url: '', title: '', isLoading: false, canGoBack: false, canGoForward: false,
    })
    const s = sanitizeWebPanelState({ url: 42, title: { a: 1 }, isLoading: 'yes', extra: 'x' })
    expect(s.url).toBe('')
    expect(s.title).toBe('')
    expect(s.isLoading).toBe(false)
    expect((s as unknown as Record<string, unknown>).extra).toBeUndefined()
  })
})

describe('displayTitle', () => {
  test('卡片标题优先', () => {
    expect(displayTitle('测试文章', 'https://example.com/a')).toBe('测试文章')
    expect(displayTitle('  带空格标题  ', 'https://example.com/a')).toBe('带空格标题')
  })

  test('无标题退化为主机名，再退化为原文', () => {
    expect(displayTitle(undefined, 'https://news.example.com/a/b')).toBe('news.example.com')
    expect(displayTitle('', 'not a url')).toBe('not a url')
  })
})

describe('WEBPANEL_IPC 通道名契约锚定', () => {
  // 与 electron/main/web-browse.ts、preload webPanel 命名空间三方对齐；
  // 改通道名时此测试会拦住未同步的漏改
  test('通道名与主进程模块一致', () => {
    expect(WEBPANEL_IPC.show).toBe('webpanel:show')
    expect(WEBPANEL_IPC.hide).toBe('webpanel:hide')
    expect(WEBPANEL_IPC.setBounds).toBe('webpanel:set-bounds')
    expect(WEBPANEL_IPC.action).toBe('webpanel:action')
    expect(WEBPANEL_IPC.close).toBe('webpanel:close')
    expect(WEBPANEL_IPC.state).toBe('webpanel:state')
  })
})
