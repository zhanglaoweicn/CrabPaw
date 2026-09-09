/**
 * Markdown Renderer — 将 Markdown 转为带 CSS 样式的完整 HTML 页面
 *
 * 支持 5 种网页风格模板、代码高亮、响应式布局
 * 与 delivery-pipeline.js 的 md-to-html 转换对接
 */

// ============================================================
// Markdown → HTML 转换引擎
// ============================================================

function _escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _inlineMdToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function mdToHtml(mdContent) {
  const lines = mdContent.split('\n');
  let html = '';
  let inCodeBlock = false;
  let inTable = false;
  let tableHtml = '';
  let inList = false;
  let listTag = '';

  function closeList() {
    if (inList) { html += `</${listTag}>\n`; inList = false; }
  }
  function closeTable() {
    if (inTable) { html += '<table>\n' + tableHtml + '</table>\n'; inTable = false; tableHtml = ''; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code block
    if (trimmed.startsWith('```')) {
      closeList(); closeTable();
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) {
        const lang = trimmed.slice(3).trim();
        html += `<pre><code class="language-${lang || 'plaintext'}">`;
      } else {
        html += '</code></pre>\n';
      }
      continue;
    }
    if (inCodeBlock) { html += _escapeHtml(line) + '\n'; continue; }

    // Table
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeList();
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^:?-{3,}:?$/.test(c.replace(/\s/g, '')))) continue;
      if (!inTable) { inTable = true; tableHtml = ''; }
      const isFirst = tableHtml === '';
      tableHtml += '<tr>' + cells.map(c => isFirst ? `<th>${_inlineMdToHtml(c)}</th>` : `<td>${_inlineMdToHtml(c)}</td>`).join('') + '</tr>\n';
      continue;
    } else if (inTable) { closeTable(); }

    // Headings
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      closeList();
      const level = hMatch[1].length;
      html += `<h${level}>${_inlineMdToHtml(hMatch[2])}</h${level}>\n`;
      continue;
    }

    // HR
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
      closeList(); html += '<hr>\n'; continue;
    }

    // UL
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listTag !== 'ul') { closeList(); inList = true; listTag = 'ul'; html += '<ul>\n'; }
      html += `<li>${_inlineMdToHtml(ulMatch[1])}</li>\n`;
      continue;
    }

    // OL
    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listTag !== 'ol') { closeList(); inList = true; listTag = 'ol'; html += '<ol>\n'; }
      html += `<li>${_inlineMdToHtml(olMatch[1])}</li>\n`;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      closeList();
      html += `<blockquote>${_inlineMdToHtml(trimmed.substring(2))}</blockquote>\n`;
      continue;
    }

    // Bold standalone line
    const boldLine = trimmed.match(/^\*\*(.+)\*\*\s*$/);
    if (boldLine) {
      closeList();
      html += `<p class="bold-line"><strong>${boldLine[1]}</strong></p>\n`;
      continue;
    }

    // Empty line
    if (trimmed === '') { closeList(); continue; }

    // Regular paragraph
    closeList();
    html += `<p>${_inlineMdToHtml(trimmed)}</p>\n`;
  }

  closeList(); closeTable();
  if (inCodeBlock) html += '</code></pre>\n';
  return html;
}

// ============================================================
// 5 种网页风格 CSS 模板
// ============================================================

const HTML_STYLES = {
  '商务报告': {
    name: '商务报告',
    description: '专业深蓝商务风格，适合企业报告、白皮书',
    css: `
      :root { --primary: #1E3A5F; --accent: #2B5797; --bg: #FFFFFF; --text: #1A1A1A; --light-bg: #F7FAFC; --border: #E0E6ED; --code-bg: #F0F4F8; }
      body { font-family: 'Microsoft YaHei','Segoe UI',sans-serif; font-size: 11pt; color: var(--text); background: var(--bg); line-height: 1.7; max-width: 900px; margin: 0 auto; padding: 40px 20px; }
      h1 { font-size: 24pt; color: var(--primary); border-bottom: 3px solid var(--primary); padding-bottom: 10px; margin: 40px 0 20px; }
      h2 { font-size: 16pt; color: var(--primary); margin: 32px 0 12px; padding-left: 12px; border-left: 4px solid var(--accent); }
      h3 { font-size: 13pt; color: var(--accent); margin: 24px 0 8px; }
      h4 { font-size: 11pt; color: var(--accent); font-weight: bold; }
      table { width:100%; border-collapse:collapse; margin:16px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
      th { background:var(--primary); color:#FFF; padding:10px 14px; font-size:10pt; text-align:left; }
      td { padding:8px 14px; border-bottom:1px solid var(--border); font-size:10pt; }
      tr:nth-child(even) td { background:var(--light-bg); }
      code { font-family:'Consolas','Courier New',monospace; font-size:9pt; background:var(--code-bg); padding:2px 6px; border-radius:3px; color:#C7254E; }
      pre { background:#F5F7FA; border:1px solid var(--border); border-left:4px solid var(--primary); padding:16px; overflow-x:auto; font-size:9pt; line-height:1.5; border-radius:0 4px 4px 0; }
      pre code { background:none; padding:0; color:inherit; font-size:inherit; }
      blockquote { border-left:4px solid var(--accent); margin:16px 0; padding:8px 20px; color:#666; font-style:italic; background:var(--light-bg); border-radius:0 4px 4px 0; }
      ul, ol { margin:8px 0; padding-left:28px; }
      li { margin:4px 0; line-height:1.6; }
      hr { border:none; border-top:1px solid var(--border); margin:32px 0; }
      a { color:var(--accent); text-decoration:none; border-bottom:1px dotted var(--accent); }
      a:hover { border-bottom-style:solid; }
      .bold-line { font-size:13pt; color:var(--primary); }
      @media (max-width:768px) { body { padding:20px 16px; } h1 { font-size:20pt; } }
    `,
  },
  '技术文档': {
    name: '技术文档',
    description: 'GitHub 风格文档，适合 API 文档、技术手册',
    css: `
      :root { --primary: #0969DA; --bg: #FFFFFF; --text: #1F2328; --light-bg: #F6F8FA; --border: #D0D7DE; --code-bg: #F6F8FA; }
      body { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif; font-size: 16px; color: var(--text); background: var(--bg); line-height: 1.6; max-width: 1012px; margin: 0 auto; padding: 32px 24px; }
      h1 { font-size: 2em; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin: 24px 0 16px; }
      h2 { font-size: 1.5em; font-weight: 600; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin: 24px 0 16px; }
      h3 { font-size: 1.25em; font-weight: 600; margin: 24px 0 12px; }
      table { width:100%; border-collapse:collapse; margin:16px 0; display:block; overflow-x:auto; }
      th { background:var(--light-bg); padding:8px 13px; border:1px solid var(--border); font-weight:600; text-align:left; }
      td { padding:8px 13px; border:1px solid var(--border); }
      tr:nth-child(even) td { background:var(--light-bg); }
      code { font-family:'SF Mono','Consolas',monospace; font-size:85%; background:var(--code-bg); padding:0.2em 0.4em; border-radius:6px; border:1px solid rgba(175,184,193,0.2); }
      pre { background:var(--light-bg); padding:16px; overflow-x:auto; border-radius:6px; line-height:1.45; }
      pre code { background:none; border:none; padding:0; font-size:85%; }
      blockquote { border-left:4px solid #0969DA; padding:0 1em; color:#57606A; margin:16px 0; }
      ul, ol { padding-left:2em; }
      li { margin:4px 0; }
      hr { border:none; height:0.25em; background:var(--border); margin:24px 0; }
      a { color:var(--primary); }
    `,
  },
  '博客文章': {
    name: '博客文章',
    description: '优雅居中式阅读布局，适合长文、博客',
    css: `
      :root { --primary: #2D3748; --accent: #E53E3E; --bg: #FFFDF7; --text: #4A5568; --light-bg: #FEFCBF; }
      body { font-family: 'Georgia','Noto Serif SC','Source Han Serif SC',serif; font-size: 18px; color: var(--text); background: var(--bg); line-height: 1.9; max-width: 720px; margin: 0 auto; padding: 60px 24px; }
      h1 { font-size: 36px; color: var(--primary); font-weight: 700; margin: 0 0 12px; line-height:1.3; }
      h2 { font-size: 26px; color: var(--primary); margin: 48px 0 16px; }
      h3 { font-size: 21px; color: var(--primary); margin: 32px 0 12px; }
      table { width:100%; border-collapse:collapse; margin:20px 0; font-size:15px; }
      th { background:var(--primary); color:#FFF; padding:10px; text-align:left; }
      td { padding:8px 10px; border-bottom:1px solid #E2E8F0; }
      code { font-family:'Consolas',monospace; font-size:15px; background:var(--light-bg); padding:2px 6px; border-radius:3px; }
      pre { background:#F7FAFC; padding:20px; overflow-x:auto; border-radius:8px; font-size:14px; line-height:1.6; border:1px solid #E2E8F0; }
      blockquote { border-left:3px solid var(--accent); margin:24px 0; padding:4px 24px; font-style:italic; color:#718096; }
      ul, ol { padding-left:24px; }
      li { margin:8px 0; }
      hr { border:none; text-align:center; margin:40px 0; }
      hr::after { content:'◆ ◆ ◆'; color:#CBD5E0; letter-spacing:12px; }
      a { color:var(--accent); }
      @media (max-width:640px) { body { font-size:16px; padding:32px 16px; } h1 { font-size:28px; } }
    `,
  },
  '落地页': {
    name: '落地页',
    description: '渐变 Hero + CTA 按钮，适合产品展示、营销页面',
    css: `
      :root { --primary: #667EEA; --accent: #764BA2; --bg: #FFFFFF; --text: #333; --light-bg: #F8FAFC; }
      * { box-sizing:border-box; margin:0; padding:0; }
      body { font-family: 'Microsoft YaHei','Segoe UI',sans-serif; color: var(--text); background: var(--bg); line-height: 1.7; }
      .hero { background: linear-gradient(135deg, var(--primary) 0%, var(--accent) 100%); color: #FFF; padding: 80px 24px; text-align: center; }
      .hero h1 { font-size: 48px; font-weight: 700; margin-bottom: 16px; color: #FFF; border: none; }
      .hero p { font-size: 20px; opacity: 0.9; max-width: 600px; margin: 0 auto 32px; }
      .cta-button { display: inline-block; background: #FFF; color: var(--accent); padding: 14px 40px; border-radius: 50px; font-size: 18px; font-weight: 600; text-decoration: none; box-shadow: 0 4px 15px rgba(0,0,0,0.15); transition: transform 0.2s; }
      .cta-button:hover { transform: translateY(-2px); }
      .content { max-width: 960px; margin: 0 auto; padding: 48px 24px; }
      .content h2 { color: var(--primary); font-size: 28px; margin: 40px 0 16px; }
      .content h3 { color: var(--accent); font-size: 20px; margin: 28px 0 10px; }
      .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; margin: 32px 0; }
      .feature-card { background: var(--light-bg); padding: 28px; border-radius: 12px; border: 1px solid #E2E8F0; }
      .feature-card h4 { color: var(--primary); font-size: 18px; margin-bottom: 8px; }
      table { width:100%; border-collapse:collapse; margin:20px 0; }
      th { background:var(--primary); color:#FFF; padding:12px; text-align:left; }
      td { padding:10px 12px; border-bottom:1px solid #E2E8F0; }
      code { background:#EDF2F7; padding:2px 6px; border-radius:4px; font-family:'Consolas',monospace; font-size:0.9em; }
      pre { background:#2D3748; color:#E2E8F0; padding:20px; border-radius:8px; overflow-x:auto; line-height:1.5; }
      ul, ol { padding-left:24px; margin:12px 0; }
      blockquote { border-left:4px solid var(--primary); padding:8px 20px; margin:16px 0; background:var(--light-bg); }
      footer { text-align:center; padding:40px 24px; color:#999; font-size:14px; border-top:1px solid #EEE; margin-top:40px; }
      @media (max-width:768px) { .hero h1 { font-size:32px; } .hero p { font-size:16px; } }
    `,
  },
  '简约暗色': {
    name: '简约暗色',
    description: '现代暗色主题，适合技术博客、个人站点',
    css: `
      :root { --primary: #64FFDA; --accent: #80CBC4; --bg: #1A1A2E; --card-bg: #16213E; --text: #E0E0E0; --text-light: #8892B0; --border: #2A2A4A; }
      body { font-family: 'SF Pro Display','Segoe UI','Microsoft YaHei',sans-serif; font-size: 16px; color: var(--text); background: var(--bg); line-height: 1.8; max-width: 860px; margin: 0 auto; padding: 48px 24px; }
      h1 { font-size: 32px; color: var(--primary); font-weight: 600; margin: 0 0 8px; }
      h2 { font-size: 22px; color: var(--primary); margin: 40px 0 14px; font-weight: 500; }
      h3 { font-size: 17px; color: var(--accent); margin: 28px 0 10px; font-weight: 500; }
      h4 { font-size: 15px; color: var(--text-light); font-weight: 500; }
      p { color: var(--text-light); }
      table { width:100%; border-collapse:collapse; margin:16px 0; }
      th { background:var(--card-bg); color:var(--primary); padding:10px 14px; text-align:left; border-bottom:2px solid var(--primary); font-size:14px; }
      td { padding:8px 14px; border-bottom:1px solid var(--border); color:var(--text-light); font-size:14px; }
      code { font-family:'JetBrains Mono','Consolas',monospace; background:rgba(100,255,218,0.1); color:var(--primary); padding:2px 6px; border-radius:4px; font-size:0.88em; }
      pre { background:var(--card-bg); border:1px solid var(--border); padding:20px; border-radius:8px; overflow-x:auto; line-height:1.6; }
      pre code { background:none; padding:0; }
      blockquote { border-left:3px solid var(--primary); padding:4px 20px; margin:20px 0; color:var(--text-light); }
      ul, ol { padding-left:24px; color:var(--text-light); }
      li { margin:6px 0; }
      hr { border:none; border-top:1px solid var(--border); margin:40px 0; }
      a { color:var(--primary); text-decoration:none; border-bottom:1px solid rgba(100,255,218,0.3); }
      a:hover { border-bottom-color:var(--primary); }
      .bold-line { color:var(--primary); font-size:18px; }
    `,
  },
};

// ============================================================
// MarkdownRenderer 类（对接 delivery-pipeline.js）
// ============================================================

class MarkdownRenderer {
  /**
   * 将 Markdown 渲染为完整 HTML 页面
   * @param {string} text - Markdown 内容
   * @param {Object} options - { style, title, lang }
   * @returns {string} 完整 HTML 文档
   */
  render(text, options = {}) {
    const styleName = options.style || '商务报告';
    const styleCfg = HTML_STYLES[styleName] || HTML_STYLES['商务报告'];
    const title = options.title || this._extractTitle(text) || 'Document';
    const lang = options.lang || 'zh-CN';
    const bodyHtml = mdToHtml(text);

    // 落地页特殊处理：检测 h1 并包裹 hero section
    let bodyContent = bodyHtml;
    let heroBlock = '';
    if (styleName === '落地页') {
      const h1Match = bodyHtml.match(/<h1>(.+?)<\/h1>/);
      const firstPara = bodyHtml.match(/<h1>.+?<\/h1>\s*<p>(.+?)<\/p>/);
      if (h1Match) {
        heroBlock = `
  <section class="hero">
    <h1>${h1Match[1]}</h1>
    ${firstPara ? `<p>${firstPara[1]}</p>` : ''}
    <a href="#content" class="cta-button">了解更多</a>
  </section>`;
        bodyContent = bodyHtml.replace(/<h1>.+?<\/h1>\s*/, '').replace(/<p>.+?<\/p>\s*/, '');
      }
      bodyContent = `<div class="content" id="content">\n${bodyContent}\n  </div>`;
    }

    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${styleCfg.css}</style>
</head>
<body>
  ${heroBlock}
  ${bodyContent}
  ${styleName === '落地页' ? '<footer>Generated by CrabPaw</footer>' : ''}
</body>
</html>`;
  }

  /** 简化版：仅 body HTML 片段 */
  renderToHTML(text) {
    return mdToHtml(text);
  }

  /** 获取可用样式列表 */
  static listStyles() {
    return Object.entries(HTML_STYLES).map(([id, cfg]) => ({ id, name: cfg.name, description: cfg.description }));
  }

  /** 获取指定样式 CSS */
  static getStyleCSS(styleName) {
    const cfg = HTML_STYLES[styleName];
    return cfg ? cfg.css : null;
  }

  /** 从 Markdown 提取第一个 h1 作为标题 */
  _extractTitle(text) {
    const m = text.match(/^#\s+(.+?)(?:\n|$)/m);
    return m ? m[1].replace(/\*\*/g, '') : null;
  }
}

module.exports = { MarkdownRenderer, HTML_STYLES, mdToHtml };
