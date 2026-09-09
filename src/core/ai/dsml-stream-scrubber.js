'use strict';

/**
 * StreamingDSMLScrubber — 流式 DSML/工具调用标签清洗器。
 *
 * 2026-08-06: AI 流式输出中会夹杂 `<tool_calls>`/`<invoke>`/`<DSML>` 标签，
 * 若直接 onChunk 透传给前端，用户会在对话卡片/语音播报中看到原始标签文本。
 * 本 scrubber 流式检测并隐藏这些标签块，其余文本正常透传。
 *
 * 用法（与 StreamingThinkScrubber 一致）：
 *   const s = new StreamingDSMLScrubber()
 *   const clean = s.feed(chunk)   // 逐 chunk 喂入，返回可透传文本
 *   const tail = s.flush()        // 流结束，返回残留清理文本
 */

// 标签起始模式：<tool_calls / <invoke / <DSML / <parameter / <xxx_invoke（支持 |｜| 变体）
const OPEN_RE = /<\s*(?:[a-zA-Z_]*(?:[|｜|])*)?(?:tool_calls|invoke|parameter|DSML)(?:[|｜|])*[^>]*>/i
// 闭合模式
const CLOSE_RE = /<\s*\/\s*(?:tool_calls|invoke|parameter|DSML)[^>]*>/i

class StreamingDSMLScrubber {
  constructor() {
    this.reset()
  }

  reset() {
    this._inBlock = false
    this._buf = ''
  }

  feed(text) {
    if (!text) return ''
    let buf = this._buf + text
    this._buf = ''
    const out = []

    while (buf.length > 0) {
      if (this._inBlock) {
        const closeMatch = buf.match(CLOSE_RE)
        if (!closeMatch || closeMatch.index === undefined) {
          // 闭合标签可能被 chunk 截断——保留最长可能后缀等下一 chunk
          const held = this._maxPartialSuffix(buf)
          buf = held ? buf.slice(-held) : ''
          break
        }
        buf = buf.slice(closeMatch.index + closeMatch[0].length)
        this._inBlock = false
      } else {
        const openMatch = buf.match(OPEN_RE)
        if (openMatch && openMatch.index !== undefined) {
          // 确认 < 前面没有已闭合的内容（避免误判普通文本中的 <）
          const before = buf.slice(0, openMatch.index)
          const lastGt = before.lastIndexOf('>')
          const lastLt = before.lastIndexOf('<')
          // 只有在前文无未闭合 < 时才视为标签起始
          if (lastLt === -1 || (lastGt !== -1 && lastGt > lastLt)) {
            out.push(before)
            buf = buf.slice(openMatch.index + openMatch[0].length)
            this._inBlock = true
          } else {
            // 前文有未闭合 <，可能是截断的开标签——整个作为普通文本输出
            out.push(buf)
            buf = ''
          }
        } else {
          // 无完整开标签——先检查是否有游离的闭合标签(如 </invoke> 无匹配开标签)
          const loneClose = buf.match(CLOSE_RE)
          if (loneClose && loneClose.index !== undefined && loneClose.index === 0) {
            buf = buf.slice(loneClose.index + loneClose[0].length)
            continue
          }
          // 检查是否有被截断的开标签前缀
          const partial = buf.match(/<\s*(?:[a-zA-Z_]*(?:[|｜|])*)?(?:tool_calls|invoke|parameter|DSML)(?:[|｜|])*[^>]*$/i)
          if (partial) {
            const held = partial[0].length
            out.push(buf.slice(0, buf.length - held))
            buf = buf.slice(-held)
          } else {
            out.push(buf)
            buf = ''
          }
        }
      }
    }

    this._buf = buf
    return out.join('')
  }

  flush() {
    const tail = this._buf
    this._buf = ''
    this._inBlock = false
    // 残留的未闭合标签——用 stripDSMLTags 兜底清理
    if (!tail) return ''
    try {
      const { stripDSMLTags } = require('./dsml')
      return stripDSMLTags(tail)
    } catch (e) {
      return ''
    }
  }

  _maxPartialSuffix(text) {
    const m = text.match(/<\s*\/\s*(?:tool_calls|invoke|parameter|DSML)[^>]*$/i)
    return m ? m[0].length : 0
  }
}

module.exports = { StreamingDSMLScrubber }
