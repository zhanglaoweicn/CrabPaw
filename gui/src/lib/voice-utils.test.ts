import { sanitizeTextForSpeech, extractVoiceText, stripMarkdownForSpeech, stripEmojis } from './voice-utils'

describe('VU1 replaceMarkdownLinks（平衡括号匹配）', () => {
  it('链接 URL 含括号（维基风格）仍保留链接文字', () => {
    expect(stripMarkdownForSpeech('[Python](https://en.wikipedia.org/wiki/Python_(programming_language)) 是门语言'))
      .toBe('Python 是门语言')
  })
  it('图片标签含括号 URL 整体移除', () => {
    // 图片移除后两侧空格不折叠（空格折叠在 sanitizeTextForSpeech 的 stripEmojis 阶段）
    expect(stripMarkdownForSpeech('请看 ![图](https://x.com/a_(1).png) 说明'))
      .toBe('请看  说明')
  })
  it('嵌套方括号的链接文字保留', () => {
    expect(stripMarkdownForSpeech('[a[b]c](url)')).toBe('a[b]c')
  })
  it('未闭合的链接原样保留（不误删）', () => {
    expect(stripMarkdownForSpeech('文本 [未闭合(')).toContain('[未闭合(')
  })
  it('普通括号文本不受影响', () => {
    expect(stripMarkdownForSpeech('单价(元) 100')).toBe('单价(元) 100')
  })
  it('多链接连续替换', () => {
    expect(stripMarkdownForSpeech('[甲](https://a.com/x_(1)) 和 [乙](https://b.com/y)'))
      .toBe('甲 和 乙')
  })
})

describe('VU2 stripEmojis（Unicode Emoji 属性）', () => {
  it('移除常见 emoji', () => {
    expect(stripEmojis('进度 🚀 完成 🎉')).toBe('进度 完成')
  })
  it('保留 ASCII 数字（Emoji 属性误匹配的数字）', () => {
    expect(stripEmojis('版本 1.2.3')).toBe('版本 1.2.3')
  })
  it('保留常见符号 ©®™', () => {
    expect(stripEmojis('© 2026 CrabPaw®')).toBe('© 2026 CrabPaw®')
  })
  it('多空格折叠', () => {
    expect(stripEmojis('a   b')).toBe('a b')
  })
  it('中文文本不受影响', () => {
    expect(stripEmojis('你好，世界')).toBe('你好，世界')
  })
})

describe('extractVoiceText（语音段落提取）', () => {
  it('链接保留文字、图片移除', () => {
    const segs = extractVoiceText('看 [文档](https://a.com/x_(1)) 吧\n\n![img](https://a.com/y_(2).png)')
    expect(segs.length).toBeGreaterThan(0)
    expect(segs[0]).toContain('文档')
    expect(segs[0]).not.toContain('!')
  })
  it('代码块整体跳过', () => {
    const segs = extractVoiceText('```js\nconst a = 1\n```\n正文内容')
    expect(segs.join(' ')).toContain('正文内容')
    expect(segs.join(' ')).not.toContain('const')
  })
})

describe('sanitizeTextForSpeech 回归', () => {
  it('普通 markdown 混合清理', () => {
    const out = sanitizeTextForSpeech('# 标题\n\n**粗体** 和 [链接](https://a.com) 内容')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).toContain('粗体')
    expect(out).toContain('链接')
    expect(out).toContain('内容')
  })
})
