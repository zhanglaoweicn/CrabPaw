/**
 * HoloPanel 全息面板组件测试（TDD：先写测试，再实现）
 *
 * 使用 renderToStaticMarkup 结构断言（项目先例：SplashScreen/orbit-particles.test.tsx）。
 * 测试环境为 node（无 jsdom），不依赖 @testing-library/react。
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { HoloPanel } from './HoloPanel'
import { HoloNumber } from './HoloNumber'
import { HoloOrbitText } from './HoloOrbitText'

// ═══════════════════════════════════════════════════════
// HoloPanel 测试
// ═══════════════════════════════════════════════════════
describe('HoloPanel', () => {
  test('渲染 children 内容', () => {
    const html = renderToStaticMarkup(
      createElement(HoloPanel, null, createElement('span', null, 'test content'))
    )
    expect(html).toContain('test content')
  })

  test('包含 holo-panel CSS class', () => {
    const html = renderToStaticMarkup(
      createElement(HoloPanel, null, createElement('span', null, 'x'))
    )
    expect(html).toContain('class="holo-panel')
  })

  test('className 透传合并', () => {
    const html = renderToStaticMarkup(
      createElement(HoloPanel, { className: 'my-extra' }, createElement('span', null, 'x'))
    )
    expect(html).toContain('class="holo-panel')
    expect(html).toContain('my-extra')
  })

  test('注入 tint CSS 变量 --holo-r/--holo-g/--holo-b', () => {
    const html = renderToStaticMarkup(
      createElement(HoloPanel, { tint: [100, 200, 50] }, createElement('span', null, 'x'))
    )
    expect(html).toContain('--holo-r:100')
    expect(html).toContain('--holo-g:200')
    expect(html).toContain('--holo-b:50')
  })
})

// ═══════════════════════════════════════════════════════
// HoloNumber 测试
// ═══════════════════════════════════════════════════════
describe('HoloNumber', () => {
  test('渲染 value 文本', () => {
    const html = renderToStaticMarkup(
      createElement(HoloNumber, { value: 28 })
    )
    expect(html).toContain('28')
  })

  test('渲染 unit 文本（提供时）', () => {
    const html = renderToStaticMarkup(
      createElement(HoloNumber, { value: 28, unit: '°' })
    )
    expect(html).toContain('28')
    expect(html).toContain('°')
  })

  test('无 unit 时不渲染单位元素', () => {
    const html = renderToStaticMarkup(
      createElement(HoloNumber, { value: 99 })
    )
    expect(html).toContain('>99<')
    // 不含 holo-number-unit class 属性（CSS 定义在 style 标签内，不算）
    expect(html).not.toContain('class="holo-number-unit"')
  })

  test('包含 holo-number CSS class', () => {
    const html = renderToStaticMarkup(
      createElement(HoloNumber, { value: 42 })
    )
    expect(html).toContain('class="holo-number')
  })

  test('注入 size CSS 变量', () => {
    const html = renderToStaticMarkup(
      createElement(HoloNumber, { value: 7, size: 200 })
    )
    expect(html).toContain('--holo-size:200px')
  })

  test('注入 tint CSS 变量', () => {
    const html = renderToStaticMarkup(
      createElement(HoloNumber, { value: 1, tint: [10, 20, 30] })
    )
    expect(html).toContain('--holo-r:10')
    expect(html).toContain('--holo-g:20')
    expect(html).toContain('--holo-b:30')
  })
})

// ═══════════════════════════════════════════════════════
// HoloOrbitText 测试
// ═══════════════════════════════════════════════════════
describe('HoloOrbitText', () => {
  test('渲染 items 文本', () => {
    const html = renderToStaticMarkup(
      createElement(HoloOrbitText, { items: ['湿度 65%', '风速 3级'] })
    )
    expect(html).toContain('湿度 65%')
    expect(html).toContain('风速 3级')
  })

  test('包含 holo-orbit CSS class', () => {
    const html = renderToStaticMarkup(
      createElement(HoloOrbitText, { items: ['A'] })
    )
    expect(html).toContain('class="holo-orbit')
  })

  test('每 item 有 transform 环形定位样式', () => {
    const html = renderToStaticMarkup(
      createElement(HoloOrbitText, { items: ['A', 'B', 'C'] })
    )
    // 每个 item 都应该有 transform 样式（环形定位）
    const transformMatches = html.match(/transform:/g)
    expect(transformMatches).not.toBeNull()
    expect(transformMatches!.length).toBeGreaterThanOrEqual(3)
  })

  test('注入 radius/speed/tint CSS 变量', () => {
    const html = renderToStaticMarkup(
      createElement(HoloOrbitText, {
        items: ['X'],
        radius: 120,
        speed: 30,
        tint: [255, 128, 0],
      })
    )
    expect(html).toContain('--holo-orbit-radius:120px')
    expect(html).toContain('--holo-orbit-speed:30s')
    expect(html).toContain('--holo-r:255')
    expect(html).toContain('--holo-g:128')
    expect(html).toContain('--holo-b:0')
  })

  test('空 items 不渲染 item span', () => {
    const html = renderToStaticMarkup(
      createElement(HoloOrbitText, { items: [] })
    )
    // 容器仍在，但不应有 holo-orbit-item class 属性（CSS 定义除外）
    expect(html).toContain('class="holo-orbit')
    expect(html).not.toContain('class="holo-orbit-item"')
  })
})
