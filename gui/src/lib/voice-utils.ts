/**
 * Shared voice utility functions
 *
 * Extracted from useVoiceManager.ts and useVoiceReply.ts to eliminate
 * duplicate code between the two hooks.
 */

/**
 * VU1: Replace Markdown links/images using balanced parenthesis matching.
 * Handles URLs that contain parentheses (e.g., Wikipedia links).
 * @param text - Input text
 * @param isImage - If true, remove image tags entirely; if false, keep link text
 */
function replaceMarkdownLinks(text: string, isImage: boolean): string {
  const prefix = isImage ? '!' : ''
  const result: string[] = []
  let i = 0
  while (i < text.length) {
    // Look for prefix + [ (link start)
    if (text[i] === prefix.charAt(0) || (!isImage && text[i] === '[')) {
      if (isImage) {
        // Expect '!' then '['
        if (text[i] !== '!') { result.push(text[i]); i++; continue }
        if (i + 1 >= text.length || text[i + 1] !== '[') { result.push(text[i]); i++; continue }
      }
      const bracketStart = isImage ? i + 1 : i
      if (text[bracketStart] !== '[') { result.push(text[i]); i++; continue }

      // Find matching ']'
      let depth = 1
      let j = bracketStart + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '[') depth++
        else if (text[j] === ']') depth--
        j++
      }
      if (depth !== 0) { result.push(text[i]); i++; continue }

      const linkText = text.substring(bracketStart + 1, j - 1)

      // Expect '(' after ']'
      if (j >= text.length || text[j] !== '(') { result.push(text[i]); i++; continue }

      // Find matching ')' with balance tracking
      let parenDepth = 1
      let k = j + 1
      while (k < text.length && parenDepth > 0) {
        if (text[k] === '(') parenDepth++
        else if (text[k] === ')') parenDepth--
        k++
      }
      if (parenDepth !== 0) { result.push(text[i]); i++; continue }

      // Found a complete link/image
      if (isImage) {
        // Remove image entirely
      } else {
        result.push(linkText)
      }
      i = k
    } else {
      result.push(text[i])
      i++
    }
  }
  return result.join('')
}

/**
 * 清理文本用于语音播放
 * 
 * 处理：
 * - 代码块和行内代码
 * - 链接和图片
 * - HTML标签
 * - Markdown格式（标题、粗体、斜体、列表、引用、水平线）
 * - 表格分隔符
 * - 表情符号
 * - 多余空白
 */
export function sanitizeTextForSpeech(text: string): string {
  if (!text || typeof text !== 'string') {
    return ''
  }

  let cleaned = text

  // 移除代码块（包括语言标记）
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '')

  // 移除行内代码
  cleaned = cleaned.replace(/`[^`]+`/g, '')

  // 移除链接，保留文本（VU1: handle URLs containing parentheses via balanced matching）
  cleaned = replaceMarkdownLinks(cleaned, false)

  // 移除图片（VU1: handle URLs containing parentheses）
  cleaned = replaceMarkdownLinks(cleaned, true)

  // 移除HTML标签
  cleaned = cleaned.replace(/<[^>]+>/g, '')

  // 移除Markdown标题标记
  cleaned = cleaned.replace(/^#{1,6}\s+/gm, '')

  // 移除粗体和斜体标记
  cleaned = cleaned.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')

  // 移除列表标记
  cleaned = cleaned.replace(/^[\s]*[-*+]\s+/gm, '')
  cleaned = cleaned.replace(/^[\s]*\d+\.\s+/gm, '')

  // 移除引用标记
  cleaned = cleaned.replace(/^>\s+/gm, '')

  // 移除水平线
  cleaned = cleaned.replace(/^[-*_]{3,}$/gm, '')

  // 移除表格分隔符
  cleaned = cleaned.replace(/\|/g, ' ')

  // 移除残留的格式字符
  cleaned = cleaned.replace(/[*_~#>[\]()|{}`]/g, '')

  // 清理表情符号
  cleaned = stripEmojis(cleaned)

  // 移除多余空白字符
  cleaned = cleaned.replace(/\s+/g, ' ')

  // 移除首尾空白
  cleaned = cleaned.trim()

  return cleaned
}

/** 从 Markdown 中提取适合语音播放的自然语言段落 */
export function extractVoiceText(md: string): string[] {
  const segments: string[] = []
  const lines = md.split('\n')
  let inCodeBlock = false, inToolSection = false, currentParagraph: string[] = []
  const flush = () => { const t = currentParagraph.join(' ').trim(); if (t) segments.push(t); currentParagraph = [] }

  for (const line of lines) {
    if (line.trim().startsWith('```')) { flush(); inCodeBlock = !inCodeBlock; continue }
    if (inCodeBlock) continue
    if (/^[⏳✅❌⚠️]\s/.test(line.trim()) || /正在(执行|搜索|读取)/.test(line.trim())) { flush(); inToolSection = true; continue }
    if (inToolSection && line.trim() === '') { inToolSection = false; continue }
    if (inToolSection) continue
    if (line.trim() === '') { flush(); continue }
    let lineClean = replaceMarkdownLinks(line, true) // remove images first
    lineClean = replaceMarkdownLinks(lineClean, false) // then extract link text
    lineClean = lineClean.replace(/`[^`]+`/g, '').replace(/[*_~|]/g, '').trim()
    if (lineClean) currentParagraph.push(lineClean)
  }
  flush()

  const merged: string[] = []; let buffer = ''
  for (const seg of segments) {
    if (buffer.length + seg.length < 50) buffer += (buffer ? '，' : '') + seg
    else { if (buffer) merged.push(buffer); buffer = seg }
  }
  if (buffer) merged.push(buffer)
  return merged
}

/**
 * 剥离 Markdown 符号，产出 TTS 引擎能正常朗读的纯文本
 *
 * 清除语音文本中的 Markdown 格式。
 * TTS 引擎会把 `*` `#` `\`` `[]()` 等符号念出来（"星号""井号""反引号"），
 * 所有进入合成的文本都要先过这里。
 */
export function stripMarkdownForSpeech(text: string): string {
  let result = String(text || '').trim()
    // 有序/无序列表标记
    .replace(/^[ \t]*([-*+]|\d+[.、])\s+/gm, '')
    // 斜粗体 → 内容
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    // 粗体 → 内容
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // 斜体 → 内容
    .replace(/\*(.+?)\*/g, '$1')
    // 行内代码 → 内容
    .replace(/`{1,3}(.+?)`{1,3}/g, '$1')
    // 标题标记
    .replace(/#{1,6}\s+/g, '')
  // 图片 → 移除 (VU1: balanced parenthesis matching)
  result = replaceMarkdownLinks(result, true)
  // 链接 → 仅保留显示文字 (VU1: balanced parenthesis matching)
  result = replaceMarkdownLinks(result, false)
  return result
    // 残留的加粗/斜体记号（被流式切句切成半截时）
    .replace(/\*{1,2}/g, '')
    // 反引号残迹
    .replace(/`/g, '')
    // 换行 → 空格（TTS 可以自然停顿）
    .replace(/\n+/g, ' ')
    .trim()
}

/** 清理表情符号 (VU2: use Unicode Emoji property for broader coverage) */
export function stripEmojis(text: string): string {
  // \p{Emoji} matches all Unicode emoji characters; \uFE0F is variation selector; \u200D is ZWJ
  // Exclude ASCII digits 0-9 and basic punctuation that \p{Emoji} also matches
  return text
    .replace(/[\p{Emoji}\uFE0F\u200D]/gu, (ch) => {
      // Preserve ASCII digits and common ASCII symbols that \p{Emoji} incorrectly matches
      if (/[0-9#*©®™]/.test(ch)) return ch
      return ''
    })
    .replace(/\s+/g, ' ').trim()
}
