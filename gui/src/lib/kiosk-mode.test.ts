/**
 * kiosk-mode 单测（2026-09-24 会客厅轮 S1+S3）
 * 用 history.replaceState 改 query（jsdom 下 location 只读，但历史 API 可改 search）
 */
import { getKioskOverride, isKioskDevice, resolveKiosk, setKioskOverride } from './kiosk-mode'

describe('isKioskDevice（设备形态）', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  test('带 ?kiosk=1 → 一体机态', () => {
    window.history.replaceState({}, '', '/?kiosk=1')
    expect(isKioskDevice()).toBe(true)
  })

  test('裸 ?kiosk（无值）也算一体机态', () => {
    window.history.replaceState({}, '', '/?kiosk')
    expect(isKioskDevice()).toBe(true)
  })

  test('?kiosk=0 → 显式关闭，按工位态', () => {
    window.history.replaceState({}, '', '/?kiosk=0')
    expect(isKioskDevice()).toBe(false)
  })

  test('无参数 → 工位态', () => {
    window.history.replaceState({}, '', '/')
    expect(isKioskDevice()).toBe(false)
  })

  test('与其它参数共存（skipSplash）仍能识别', () => {
    window.history.replaceState({}, '', '/?skipSplash&kiosk=1')
    expect(isKioskDevice()).toBe(true)
  })
})

describe('预览开关（S3 顶栏一键切换）', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
    setKioskOverride(false)
  })

  test('默认关；开→resolveKiosk 为真；关→恢复', () => {
    expect(getKioskOverride()).toBe(false)
    expect(resolveKiosk()).toBe(false)
    setKioskOverride(true)
    expect(getKioskOverride()).toBe(true)
    expect(resolveKiosk()).toBe(true)
    setKioskOverride(false)
    expect(resolveKiosk()).toBe(false)
  })

  test('设备形态与预览开关取并集（设备态优先）', () => {
    window.history.replaceState({}, '', '/?kiosk=1')
    setKioskOverride(false)
    expect(resolveKiosk()).toBe(true)
  })
})
