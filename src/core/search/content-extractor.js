/**
 * 正文提取器
 *
 * 从 HTML 中提取可读正文，去除导航、广告、侧边栏等干扰内容。
 * 零外部依赖：使用正则 + 字符串操作解析 HTML。
 *
 * 支持：
 * 1. Readability 风格的正文提取（基于启发式算法）
 * 2. 多 URL 批量提取
 * 3. 与 Playwright JS 渲染联动
 * 4. 结构化输出（标题/正文/作者/日期/元数据）
 */

// ─── 噪声标签（直接移除整个标签及其内容）─────────────────────

const NOISE_TAGS = [
  'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe',
  'svg', 'form', 'button', 'input', 'select', 'textarea',
];

// ─── 噪声 class/id 模式 ─────────────────────────────────────

const NOISE_CLASS_PATTERNS = [
  /\b(nav|navbar|navigation|menu|sidebar|side-bar|widget)\b/i,
  /\b(ad|ads|advertisement|ad-banner|ad-container|sponsor|promotion)\b/i,
  /\b(popup|modal|overlay|cookie-banner|cookie-notice)\b/i,
  /\b(comments?|social-share|social-links|share-?)\b/i,
  /\b(related|recommend|suggested|copyright|legal|disclaimer)\b/i,
  /\b(header|footer|banner|toolbar)\b/i,
];

// ─── 正文候选标签/属性 ──────────────────────────────────────

const CONTENT_TAG_PATTERNS = [
  /<article[\s>]/i,
  /<main[\s>]/i,
  /<div[^>]*(?:class|id)\s*=\s*["'][^"']*\b(article|post|content|entry|rich-text|rich_media_content|Post-RichText|RichText)\b[^"']*["']/i,
  /<div[^>]*(?:id)\s*=\s*["'][^"']*\b(article|post|content|main|js_content)\b[^"']*["']/i,
  /<section[^>]*role\s*=\s*["']article["']/i,
  /<div[^>]*role\s*=\s*["']main["']/i,
];

// ─── HTML 工具函数 ───────────────────────────────────────────

/**
 * 去除 HTML 标签，返回纯文本
 */
function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/gi, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/\t/g, ' ')
    .replace(/ {3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 移除匹配的标签及其内容（迭代处理嵌套）
 */
function removeTag(html, tagName) {
  let result = html;
  let changed = true;
  let iterations = 0;

  // 从内到外迭代移除
  while (changed && iterations < 30) {
    changed = false;
    iterations++;

    // 先移除不含嵌套同名标签的
    const re = new RegExp(`<${tagName}[^>]*>(?:(?!<${tagName}[\\s>])[\\s\\S])*?<\\/${tagName}>`, 'gi');
    const newResult = result.replace(re, '');
    if (newResult !== result) {
      result = newResult;
      changed = true;
    }

    // 移除自闭合标签
    const selfCloseRe = new RegExp(`<${tagName}[^>]*/?>`, 'gi');
    const afterSelfClose = result.replace(selfCloseRe, '');
    if (afterSelfClose !== result) {
      result = afterSelfClose;
      changed = true;
    }
  }

  return result;
}

/**
 * 移除噪声 class/id 的 div（迭代处理嵌套）
 */
function removeNoiseDivs(html) {
  let result = html;
  let iterations = 0;
  const maxIterations = 10;

  // 从内到外迭代移除噪声 div
  while (iterations < maxIterations) {
    iterations++;
    const before = result.length;

    // 匹配不含嵌套 div 的噪声 div
    result = result.replace(/<div([^>]*)>([\s\S]*?)<\/div>/gi, (match, attrs, content) => {
      // 如果内容中还有 div，跳过（先处理内层）
      if (/<div/i.test(content)) return match;

      for (const pattern of NOISE_CLASS_PATTERNS) {
        if (pattern.test(attrs)) return '';
      }
      return match;
    });

    // 如果长度没变，说明没有更多可移除的内层噪声 div
    if (result.length === before) break;
  }

  // 第二阶段：移除包含嵌套 div 的外层噪声 div
  iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const before = result.length;

    result = result.replace(/<div([^>]*)>([\s\S]*?)<\/div>/gi, (match, attrs, _content) => {
      for (const pattern of NOISE_CLASS_PATTERNS) {
        if (pattern.test(attrs)) return '';
      }
      return match;
    });

    if (result.length === before) break;
  }

  return result;
}

/**
 * 提取 meta 标签的 content 属性
 */
function extractMetaContent(html, namePattern, propertyPattern) {
  let match;

  if (propertyPattern) {
    match = html.match(new RegExp(`<meta[^>]*property\\s*=\\s*["']${propertyPattern}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i'));
    if (!match) {
      match = html.match(new RegExp(`<meta[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*property\\s*=\\s*["']${propertyPattern}["']`, 'i'));
    }
    if (match) return match[1].trim();
  }

  if (namePattern) {
    match = html.match(new RegExp(`<meta[^>]*name\\s*=\\s*["']${namePattern}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i'));
    if (!match) {
      match = html.match(new RegExp(`<meta[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*name\\s*=\\s*["']${namePattern}["']`, 'i'));
    }
    if (match) return match[1].trim();
  }

  return '';
}

/**
 * 提取标签内容
 */
function extractTagContent(html, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(re);
  return match ? stripTags(match[1]).trim() : '';
}

/**
 * 提取标签属性
 */
function extractTagAttr(html, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = html.match(re);
  return match ? match[1].trim() : '';
}

// ─── 正文提取器 ──────────────────────────────────────────────

class ContentExtractor {
  constructor(config = {}) {
    this._maxContentLength = config.maxContentLength || 50000;
    this._minContentLength = config.minContentLength || 100;
  }

  /**
   * 从 HTML 提取正文
   * @param {string} html 原始 HTML
   * @param {string} url 来源 URL
   * @returns {Object} 提取结果
   */
  extract(html, url = '') {
    if (!html || typeof html !== 'string') {
      return { title: '', content: '', method: 'none', error: '无效 HTML', url };
    }

    // 1. 提取元数据（在清理前）
    const title = this._extractTitle(html);
    const author = this._extractAuthor(html);
    const date = this._extractDate(html);
    const meta = this._extractMeta(html);

    // 2. 清理 HTML
    let cleaned = html;

    // 移除噪声标签
    for (const tag of NOISE_TAGS) {
      cleaned = removeTag(cleaned, tag);
    }

    // 移除噪声 div
    cleaned = removeNoiseDivs(cleaned);

    // 移除隐藏元素
    cleaned = cleaned.replace(/<[^>]*(?:display\s*:\s*none|hidden)[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
    cleaned = cleaned.replace(/<[^>]*(?:display\s*:\s*none|hidden)[^>]*\/?>/gi, '');

    // 3. 尝试精确选择器匹配正文容器
    let content = '';
    let method = 'density';

    for (const pattern of CONTENT_TAG_PATTERNS) {
      const match = cleaned.match(pattern);
      if (match) {
        // 找到匹配的开始标签，提取其内容
        const startIdx = match.index;
        const tagMatch = cleaned.slice(startIdx).match(/^<(\w+)([^>]*)>/);
        if (tagMatch) {
          const tagName = tagMatch[1];
          const contentBlock = this._extractBlock(cleaned, startIdx, tagName);
          if (contentBlock) {
            const text = stripTags(contentBlock);
            if (text.length > this._minContentLength) {
              content = text;
              method = 'selector';
              break;
            }
          }
        }
      }
    }

    // 4. 段落密度算法
    if (content.length < this._minContentLength) {
      content = this._extractByDensity(cleaned);
      method = 'density';
    }

    // 5. 兜底：取 body 文本
    if (content.length < this._minContentLength) {
      const bodyContent = extractTagContent(html, 'body');
      if (bodyContent.length > content.length) {
        content = bodyContent;
        method = 'body';
      }
    }

    // 截断
    if (content.length > this._maxContentLength) {
      content = content.slice(0, this._maxContentLength) + '\n[内容已截断]';
    }

    return {
      title,
      author,
      date,
      content,
      meta,
      method,
      contentLength: content.length,
      url,
    };
  }

  /**
   * 提取标题
   */
  _extractTitle(html) {
    // og:title
    const ogTitle = extractMetaContent(html, null, 'og:title');
    if (ogTitle) return ogTitle;

    // <title>
    const title = extractTagContent(html, 'title');
    if (title) {
      return title.replace(/\s*[-_|–—]\s*(首页|Home|官网|官方网站).*$/i, '').trim();
    }

    // h1
    const h1 = extractTagContent(html, 'h1');
    if (h1) return h1;

    return '';
  }

  /**
   * 提取作者
   */
  _extractAuthor(html) {
    const author = extractMetaContent(html, 'author', 'article:author');
    if (author) return author;
    return '';
  }

  /**
   * 提取日期
   */
  _extractDate(html) {
    const date = extractMetaContent(html, null, 'article:published_time');
    if (date) return date;

    // <time datetime="...">
    const timeAttr = extractTagAttr(html, 'time', 'datetime');
    if (timeAttr) return timeAttr;

    return '';
  }

  /**
   * 提取元数据
   */
  _extractMeta(html) {
    const description = extractMetaContent(html, 'description', 'og:description') || '';
    const keywords = extractMetaContent(html, 'keywords', null) || '';
    const image = extractMetaContent(html, null, 'og:image') || '';

    return { description, keywords, image };
  }

  /**
   * 提取匹配标签的完整块内容（处理嵌套）
   */
  _extractBlock(html, startIdx, tagName) {
    // 找到开始标签的结束位置
    const openTagRe = new RegExp(`<${tagName}[^>]*>`, 'i');
    const openMatch = html.slice(startIdx).match(openTagRe);
    if (!openMatch) return null;

    const contentStart = startIdx + openMatch.index + openMatch[0].length;
    let depth = 1;
    let pos = contentStart;

    const openRe = new RegExp(`<${tagName}[\\s>]`, 'gi');
    const closeRe = new RegExp(`</${tagName}>`, 'gi');

    while (depth > 0 && pos < html.length) {
      // 从当前位置查找下一个开/闭标签
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;

      const nextOpen = openRe.exec(html);
      const nextClose = closeRe.exec(html);

      const openPos = nextOpen ? nextOpen.index : Infinity;
      const closePos = nextClose ? nextClose.index : Infinity;

      if (closePos === Infinity) break; // 没有闭合标签

      if (openPos < closePos) {
        depth++;
        pos = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        if (depth === 0) {
          return html.slice(contentStart, closePos);
        }
        pos = nextClose.index + nextClose[0].length;
      }
    }

    return null;
  }

  /**
   * 段落密度算法提取正文
   * 基于文本密度：选择文本/HTML 比率最高的容器
   */
  _extractByDensity(html) {
    const candidates = [];

    // 提取所有 <div> 和 <section> 块
    const blockRe = /<(div|section)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;

    while ((match = blockRe.exec(html)) !== null) {
      const blockHtml = match[2];
      const text = stripTags(blockHtml);

      if (text.length < this._minContentLength) continue;

      // 文本密度
      const density = text.length / Math.max(blockHtml.length, 1);

      // 段落数量
      const paragraphs = (blockHtml.match(/<p[\s>]/gi) || []).length;

      // 链接密度
      const linkMatches = blockHtml.match(/<a[\s>]/gi) || [];
      const linkTextEstimate = linkMatches.length * 20;
      const linkDensity = linkTextEstimate / Math.max(text.length, 1);

      const score = density * 100 + paragraphs * 10 - linkDensity * 50;

      candidates.push({ text, score, textLength: text.length });
    }

    if (candidates.length === 0) return '';

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].text;
  }

  /**
   * 批量提取多个 URL
   * @param {string[]} urls URL 列表
   * @param {Function} fetchFn 获取函数 (url) => html
   * @returns {Promise<Array>}
   */
  async extractMultiple(urls, fetchFn) {
    const results = [];
    for (const url of urls) {
      try {
        const html = await fetchFn(url);
        if (typeof html === 'string') {
          results.push(this.extract(html, url));
        } else {
          results.push({ url, content: '', error: '获取失败' });
        }
      } catch (err) {
        results.push({ url, content: '', error: err.message });
      }
    }
    return results;
  }
}

module.exports = { ContentExtractor, NOISE_TAGS, NOISE_CLASS_PATTERNS, CONTENT_TAG_PATTERNS };
