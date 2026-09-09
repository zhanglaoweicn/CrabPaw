import { stripScripts, sanitizeHtml } from './sanitize'

describe('stripScripts (2026-08-14 审计 G4: DocReader srcDoc 预清洗)', () => {
  test('剥离 <script> 标签及其内容', () => {
    expect(stripScripts('<p>hi</p><script>alert(1)</script><div>x</div>')).toBe('<p>hi</p><div>x</div>')
  })

  test('剥离带属性的 <script src=...> 标签', () => {
    expect(stripScripts('<script src="https://evil.example/x.js"></script><b>ok</b>'))
      .toBe('<b>ok</b>')
  })

  test('剥离事件处理器属性(on*=, 含引号/无引号)', () => {
    expect(stripScripts('<img src="a.png" onerror="alert(1)">'))
      .toBe('<img src="a.png">')
    expect(stripScripts('<div onclick=alert(1)>x</div>'))
      .toBe('<div>x</div>')
    expect(stripScripts("<button onmouseover='steal()'>x</button>"))
      .toBe('<button>x</button>')
  })

  test('保留样式/链接/图片(文档阅读功能不受损)', () => {
    const html = '<link rel="stylesheet" href="https://cdn.example/x.css"><a href="https://example.com" target="_blank">l</a><img src="https://example.com/p.png" alt="p">'
    expect(stripScripts(html)).toBe(html)
  })

  test('大小写混合的 script 标签同样剥离', () => {
    expect(stripScripts('<ScRiPt>alert(2)</sCrIpT>after')).toBe('after')
  })

  test('空输入原样返回', () => {
    expect(stripScripts('')).toBe('')
    expect(stripScripts('   ')).toBe('   ')
  })

  test('嵌套/含 < 字符的脚本内容也能剥离(与 sanitizeHtml 回退分支同款正则)', () => {
    expect(stripScripts('<script>if (a < b) { alert(3) }</script>tail')).toBe('tail')
  })
})

describe('sanitizeHtml (2026-08-14 审计 M9: reverse tabnabbing 防护)', () => {
  // jest testEnvironment 为 node(无 DOMParser)→ 走回退正则分支,与浏览器分支行为对齐
  test('target=_blank 链接强制 rel="noopener noreferrer"', () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_blank">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('攻击者提供的 rel(如 opener)被剥除并替换', () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_blank" rel="opener">x</a>')
    expect(out).not.toMatch(/rel="opener"/i)
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('单引号 _blank 同样生效', () => {
    const out = sanitizeHtml("<a href='https://example.com' target='_blank'>x</a>")
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('非 _blank target 不受影响', () => {
    const out = sanitizeHtml('<a href="https://example.com" target="_self">x</a>')
    expect(out).not.toContain('noopener')
  })

  test('危险协议链接整条剥离(既有防护不回归)', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)" target="_blank">x</a>')
    expect(out).not.toContain('javascript:')
  })
})
