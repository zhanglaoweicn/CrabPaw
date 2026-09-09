/**
 * HTML 消毒函数 - 防止 XSS 攻击
 * S7 fix: 使用 DOMParser 解析替代 regex，防止绕过
 */
export function sanitizeHtml(html: string): string {
  const ALLOWED_TAGS = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span', 'article', 'section', 'header', 'footer', 'nav',
    'details', 'summary', 'figure', 'figcaption'
  ])

  const ALLOWED_ATTRS: Record<string, string[]> = {
    '*': ['id', 'class', 'title', 'lang', 'dir'],
    'a': ['href', 'target', 'rel'],
    'img': ['src', 'alt', 'width', 'height', 'loading'],
    'td': ['colspan', 'rowspan'],
    'th': ['colspan', 'rowspan', 'scope'],
    'ol': ['start', 'type'],
    'ul': ['type'],
    'li': ['value'],
    'pre': ['data-language'],
    'code': ['data-language'],
    'blockquote': ['cite'],
  }

  const DANGEROUS_PROTOCOLS = ['javascript:', 'vbscript:', 'data:text/html', 'data:text/javascript', 'file:']

  /** 检查 URL 值是否存在危险协议，含 C0 控制字符绕过防护 */
  function hasDangerousProtocol(value: string): boolean {
    // 2026-08-07: 剥离全部 C0 控制字符（含 \t \r \n，防止 java\tscript:、java\nscript: 等绕过）
    const stripped = value.replace(/[\x00-\x20]/g, '')
    const lowerValue = stripped.trim().toLowerCase()
    // 收紧 data: 协议：仅允许 image/png, image/jpeg, image/gif, image/webp
    // (2026-08-07: 移除 image/svg+xml——SVG 内嵌 script 是经典 XSS 向量)
    if (lowerValue.startsWith('data:')) {
      const mimeEnd = lowerValue.indexOf(',')
      const mime = mimeEnd > 5 ? lowerValue.slice(5, mimeEnd) : lowerValue.slice(5)
      const baseMime = mime.split(';')[0].trim().toLowerCase()
      const ALLOWED_DATA_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']
      if (!ALLOWED_DATA_MIMES.includes(baseMime)) return true
      return false
    }
    return DANGEROUS_PROTOCOLS.some(proto => lowerValue.startsWith(proto))
  }

  // 使用 DOMParser 解析 HTML（比 regex 安全，无法被编码绕过）
  // 守卫：部分受限环境（如旧版 SSR/Web Worker）可能没有 DOMParser
  if (typeof DOMParser === 'undefined') {
    // 回退：基础正则清理 script/style 标签 + 剥离事件属性与危险协议 URL 属性
    // 2026-08-07: 此前回退分支不清理属性 → 攻击者可借 onerror="..." / href="javascript:..." 绕过
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      // 剥离事件属性(on\w+=...，含引号与无引号值)
      .replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      // URL 属性(href/src/action 等)做危险协议检查：危险则整条属性剥离
      .replace(/\s+(?:href|src|action|formaction|xlink:href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (m) => {
        const valueMatch = m.match(/=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i)
        const value = valueMatch ? (valueMatch[1] ?? valueMatch[2] ?? valueMatch[3]) : ''
        if (hasDangerousProtocol(value)) return ''
        return m
      })
      // 2026-08-14 审计 M9: reverse tabnabbing——target=_blank 的链接强制
      // rel="noopener noreferrer"(剥除攻击者提供的 rel,含 target 前后两侧)
      .replace(/<a\b([^>]*)\btarget\s*=\s*(?:"_blank"|'_blank')([^>]*)>/gi, (_m, pre, post) => {
        const relFreePre = pre.replace(/\brel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        const relFreePost = post.replace(/\brel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        return `<a${relFreePre} target="_blank"${relFreePost} rel="noopener noreferrer">`
      })
  }
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  function cleanNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || ''
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const tagName = el.tagName.toLowerCase()

      // 不允许的标签：保留子内容但移除标签本身
      if (!ALLOWED_TAGS.has(tagName)) {
        // script/style 标签：完全移除，包括子内容
        if (tagName === 'script' || tagName === 'style') {
          return ''
        }
        let inner = ''
        for (const child of Array.from(el.childNodes)) {
          inner += cleanNode(child)
        }
        return inner
      }

      // 过滤属性
      const allowedForTag = ALLOWED_ATTRS[tagName] || []
      const allAllowed = [...(ALLOWED_ATTRS['*'] || []), ...allowedForTag]
      const safeAttrs: string[] = []

      for (const attr of Array.from(el.attributes)) {
        const attrName = attr.name.toLowerCase()
        const attrValue = attr.value

        // 阻止所有 on 开头的事件属性
        if (attrName.startsWith('on')) continue

        // 检查属性白名单
        if (!allAllowed.includes(attrName)) continue

        // 对 URL 属性进行危险协议检查
        if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(attrName)) {
          if (hasDangerousProtocol(attrValue)) {
            continue
          }
        }

        safeAttrs.push(` ${attrName}="${escapeAttr(attrValue)}"`)
      }

      // 2026-08-14 审计 M9: reverse tabnabbing 防护——target=_blank 的链接强制
      // rel="noopener noreferrer"(覆盖调用方/攻击者提供的 rel,防止 opener 反向劫持)
      if (tagName === 'a') {
        const targetAttr = safeAttrs.find(a => a.startsWith(' target="'))
        if (targetAttr && /^ target="_blank"$/i.test(targetAttr)) {
          const relIdx = safeAttrs.findIndex(a => a.startsWith(' rel="'))
          if (relIdx !== -1) safeAttrs.splice(relIdx, 1)
          safeAttrs.push(' rel="noopener noreferrer"')
        }
      }

      // 自闭合标签
      const voidElements = new Set(['br', 'hr', 'img'])
      if (voidElements.has(tagName)) {
        return `<${tagName}${safeAttrs.join('')}/>`
      }

      let inner = ''
      for (const child of Array.from(el.childNodes)) {
        inner += cleanNode(child)
      }
      return `<${tagName}${safeAttrs.join('')}>${inner}</${tagName}>`
    }

    // 其他节点类型（注释等）忽略
    return ''
  }

  function escapeAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  let result = ''
  for (const child of Array.from(doc.body.childNodes)) {
    result += cleanNode(child)
  }
  return result
}

/**
 * 剥离 HTML 中的 <script> 标签(含内容)与事件处理器属性(on*)。
 * 2026-08-14 审计 G4: DocReader 内嵌 iframe srcDoc 预清洗——与 iframe sandbox 双保险。
 * 仅做粗粒度剥离,保留样式/链接/图片等文档阅读功能;
 * 需要严格白名单时请使用 sanitizeHtml。
 */
export function stripScripts(html: string): string {
  if (!html) return html
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

/**
 * Strip leaked XML/DSML tool-call tags from LLM output.
 * Prevents raw tool invocation syntax from appearing in rendered chat messages.
 */
export function sanitizeContent(text: string): string {
  if (!text) return text;
  let cleaned = text;
  // Remove script/style and tool-call tags in a loop to handle nesting (SA1)
  let prevCleaned: string;
  do {
    prevCleaned = cleaned;
    cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '');
    cleaned = cleaned.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/g, '');
    cleaned = cleaned.replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/g, '');
    cleaned = cleaned.replace(/<\/?(?:function_calls|invoke|parameter)[^>]*>/g, '');
  } while (cleaned !== prevCleaned);
  // Remove event handler attributes (SA2: handle both quoted and unquoted values)
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  cleaned = cleaned.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');
  // Strip DSML-style tags
  cleaned = cleaned.replace(/<\/?[\s｜]*DSML[\s｜]*[^>]*>/gi, '');
  cleaned = cleaned.replace(/<\/?[\s｜]*tool_calls[\s｜]*[^>]*>/gi, '');
  cleaned = cleaned.replace(/<\/?[\s｜]*invoke[\s｜]*[^>]*>/gi, '');
  cleaned = cleaned.replace(/<\/?[\s｜]*parameter[\s｜]*[^>]*>/gi, '');
  cleaned = cleaned.replace(/<\/?[^>]*｜｜[^>]*>/g, '');
  cleaned = cleaned.replace(/<(?!br\s*\/|hr\s*\/|img\s)[a-zA-Z_][\w:]*(?:\s+[^>]*)?\/>/g, '');
  // Strip tool-execution status lines: specific known control sequences first, then generic emoji-prefixed lines as fallback
  const TOOL_STATUS_PREFIX_RE = /^[⏳✅❌⚠️💭🔧]\s+(?:正在|执行|搜索|读取|调用|完成|失败|等待|思考|工具|调用中|执行中|已完成|已失败)/;
  cleaned = cleaned.replace(new RegExp(TOOL_STATUS_PREFIX_RE.source + '.*(?:\\n|$)', 'gm'), '');
  // I5 fix: fallback to original emoji regex for any emoji-starting line not caught by specific keywords
  cleaned = cleaned.replace(/^[⏳✅❌⚠️💭🔧]\s.*(?:\n|$)/gm, '');
  // Strip lines that are only status emoji (single or repeated with spaces)
  cleaned = cleaned.replace(/^[⏳✅❌⚠️💭🔧🤖🦾🎯\s]+(?:\n|$)/gm, '');
  // Strip leading status-marker-only prefixes before real content
  cleaned = cleaned.replace(/^(?:[\s]*[⏳✅❌⚠️💭🔧🤖🦾🎯][\s]*)+(?=\S)/gm, '');
  // Clean any remaining orphaned status emoji in text
  cleaned = cleaned.replace(/[⏳✅❌⚠️]\s*$/gm, '');
  cleaned = cleaned.trim();
  return cleaned;
}
