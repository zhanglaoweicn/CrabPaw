/**
 * sheet-state 单元测试（jest testEnvironment=node，无 jsdom → 假 document 注入）
 */
import { activateOverlay, activateSheet, closeActiveSheet, closeSheet, getActiveSheet, registerSheet, setSheetDocument } from './sheet-state'

describe('sheet-state 互斥与 body class 联动', () => {
  // 2026-08-14: 同步新 syncBody 使用的 DOMTokenList 完整接口(length/item/add/remove/startsWith)
  // 而非仅 toggle
  let clsList: string[] = []
  const cls: any = {
    toggle: vi.fn((c: string, on: boolean) => {
      const idx = clsList.indexOf(c)
      if (on && idx === -1) clsList.push(c)
      else if (!on && idx !== -1) clsList.splice(idx, 1)
    }),
    add: vi.fn((c: string) => { if (!clsList.includes(c)) clsList.push(c) }),
    remove: vi.fn((c: string) => {
      const idx = clsList.indexOf(c); if (idx !== -1) clsList.splice(idx, 1)
    }),
    item: vi.fn((i: number) => (i >= 0 && i < clsList.length ? clsList[i] : '')),
    get length() { return clsList.length },
    toJSON() { return clsList },
  }
  const style = { setProperty: vi.fn(), removeProperty: vi.fn() }
  let doc: any

  beforeEach(() => {
    clsList = []
    cls.toggle.mockClear()
    cls.add.mockClear()
    cls.remove.mockClear()
    cls.item.mockClear()
    style.setProperty.mockClear()
    style.removeProperty.mockClear()
    doc = { body: { classList: cls, style } }
    setSheetDocument(doc)
    closeSheet('hotspot')
    closeSheet('weather')
    closeSheet('music')
  })

  afterEach(() => {
    setSheetDocument(null)
  })

  test('打开面板挂 side-sheet-open + side-sheet-<name> 并设置 --sheet-width', () => {
    activateSheet('hotspot', 'min(56vw, 860px)')
    expect(getActiveSheet()).toBe('hotspot')
    expect(cls.toggle).toHaveBeenCalledWith('side-sheet-open', true)
    expect(cls.add).toHaveBeenCalledWith('side-sheet-hotspot')
    expect(clsList).toContain('side-sheet-hotspot')
    expect(style.setProperty).toHaveBeenCalledWith('--sheet-width', 'min(56vw, 860px)')
  })

  test('互斥：打开第二个面板先触发第一个的关闭回调，并切换 side-sheet-<name>', () => {
    const closeHotspot = vi.fn()
    registerSheet('hotspot', closeHotspot)
    activateSheet('hotspot', 'w1')
    activateSheet('weather', 'w2')
    expect(closeHotspot).toHaveBeenCalledTimes(1)
    expect(getActiveSheet()).toBe('weather')
    // side-sheet-hotspot 应当在切 weather 时被清理(remove 过)
    expect(clsList).not.toContain('side-sheet-hotspot')
    expect(clsList).toContain('side-sheet-weather')
    expect(style.setProperty).toHaveBeenLastCalledWith('--sheet-width', 'w2')
  })

  test('关闭面板移除 side-sheet-open 与 side-sheet-<name> 及 --sheet-width', () => {
    activateSheet('hotspot', 'w1')
    closeSheet('hotspot')
    expect(getActiveSheet()).toBeNull()
    expect(cls.toggle).toHaveBeenLastCalledWith('side-sheet-open', false)
    expect(clsList).not.toContain('side-sheet-hotspot')
    expect(style.removeProperty).toHaveBeenCalledWith('--sheet-width')
  })

  test('关闭非激活面板是 no-op（互斥顶掉后旧面板 cleanup 不误关新面板）', () => {
    const closeMusic = vi.fn()
    registerSheet('music', closeMusic)
    activateSheet('music', 'w')
    activateSheet('weather', 'w2')
    closeSheet('music')
    expect(getActiveSheet()).toBe('weather')
  })

  test('无 document 时操作不崩溃', () => {
    setSheetDocument(null)
    expect(() => activateSheet('hotspot', 'w')).not.toThrow()
    expect(getActiveSheet()).toBe('hotspot')
  })

  // 2026-08-19: 裸「关闭」命令的通用关闭入口（VoiceShell handleUserInput 用）
  describe('closeActiveSheet（裸「关闭」命令通用关闭）', () => {
    test('有激活面板时触发其关闭回调并返回 true', () => {
      const closeMeeting = vi.fn()
      registerSheet('meeting', closeMeeting)
      activateSheet('meeting', 'min(75vw, 1920px)')
      expect(closeActiveSheet()).toBe(true)
      expect(closeMeeting).toHaveBeenCalledTimes(1)
      expect(getActiveSheet()).toBeNull()
      expect(cls.toggle).toHaveBeenLastCalledWith('side-sheet-open', false)
    })

    test('回调抛异常也照常清激活态（不静默吞错）', () => {
      registerSheet('hotspot', () => { throw new Error('boom') })
      activateSheet('hotspot', 'w')
      expect(() => closeActiveSheet()).not.toThrow()
      expect(getActiveSheet()).toBeNull()
    })

    test('无激活面板时返回 false（调用方落 LLM，不拦截对话语境）', () => {
      expect(closeActiveSheet()).toBe(false)
    })
  })

  // A2(2026-09-05): overlay 档——管理舱/会话抽屉与 SideSheet 共用互斥位,
  // 但不做 body 布局联动(side-sheet-open/--sheet-width 是侧板让位语义)
  describe('activateOverlay（全屏浮层互斥,无 body 联动）', () => {
    test('打开 overlay 挂互斥位但不写 side-sheet-open/--sheet-width', () => {
      const closeCockpit = vi.fn()
      activateOverlay('cockpit', closeCockpit)
      expect(getActiveSheet()).toBe('cockpit')
      expect(cls.toggle).not.toHaveBeenCalledWith('side-sheet-open', true)
      expect(clsList).not.toContain('side-sheet-open')
      expect(style.setProperty).not.toHaveBeenCalled()
    })

    test('overlay 互斥:打开 overlay 关闭激活中的 SideSheet,反之亦然', () => {
      const closeHotspot = vi.fn()
      registerSheet('hotspot', closeHotspot)
      activateSheet('hotspot', 'w1')

      const closeCockpit = vi.fn()
      activateOverlay('cockpit', closeCockpit)
      expect(closeHotspot).toHaveBeenCalledTimes(1)
      expect(getActiveSheet()).toBe('cockpit')

      const closeWeather = vi.fn()
      registerSheet('weather', closeWeather)
      activateSheet('weather', 'w2')
      expect(closeCockpit).toHaveBeenCalledTimes(1)
      expect(getActiveSheet()).toBe('weather')
    })

    test('两个 overlay 之间互斥', () => {
      const closeCockpit = vi.fn()
      activateOverlay('cockpit', closeCockpit)
      const closeDrawer = vi.fn()
      activateOverlay('history-drawer', closeDrawer)
      expect(closeCockpit).toHaveBeenCalledTimes(1)
      expect(getActiveSheet()).toBe('history-drawer')
    })

    test('closeActiveSheet 能关闭 overlay(裸「关闭」覆盖管理舱/抽屉)', () => {
      const closeCockpit = vi.fn()
      activateOverlay('cockpit', closeCockpit)
      expect(closeActiveSheet()).toBe(true)
      expect(closeCockpit).toHaveBeenCalledTimes(1)
      expect(getActiveSheet()).toBeNull()
    })

    test('closeSheet 可关闭 overlay;被互斥顶掉后旧 overlay cleanup 不误关新面板', () => {
      const closeCockpit = vi.fn()
      const unCockpit = activateOverlay('cockpit', closeCockpit)
      const closeDrawer = vi.fn()
      activateOverlay('history-drawer', closeDrawer)
      closeSheet('cockpit')
      expect(getActiveSheet()).toBe('history-drawer')
      closeSheet('history-drawer')
      expect(getActiveSheet()).toBeNull()
      unCockpit()
    })

    test('overlay 关闭后 SideSheet 恢复 body 联动', () => {
      activateOverlay('cockpit', vi.fn())
      activateSheet('hotspot', 'w1')
      expect(clsList).toContain('side-sheet-open')
      expect(clsList).toContain('side-sheet-hotspot')
      expect(style.setProperty).toHaveBeenLastCalledWith('--sheet-width', 'w1')
    })
  })
})
