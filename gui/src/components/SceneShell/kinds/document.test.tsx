/**
 * DocumentCard 关闭按钮测试（2026-08-12 修复：卡片此前忽略 onClose，无关闭按钮）
 *
 * 使用 renderToStaticMarkup 结构断言（项目先例：HoloPanel/holo.test.tsx）。
 * 测试环境为 node（无 jsdom），不依赖 @testing-library/react。
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { DocumentCard } from './document'

describe('DocumentCard', () => {
  test('传入 onClose 时渲染关闭按钮 (title="关闭")', () => {
    const html = renderToStaticMarkup(
      createElement(DocumentCard, {
        data: { title: '测试文章', pages: [{ text: '正文内容' }] },
        onClose: () => {},
      })
    )
    expect(html).toContain('title="关闭"')
    expect(html).toContain('测试文章')
    expect(html).toContain('正文内容')
  })

  test('未传入 onClose 时不渲染关闭按钮（避免死按钮）', () => {
    const html = renderToStaticMarkup(
      createElement(DocumentCard, {
        data: { title: '测试文章', pages: [{ text: '正文内容' }] },
      })
    )
    expect(html).not.toContain('title="关闭"')
  })
})
