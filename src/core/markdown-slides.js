/**
 * markdown-slides.js — markdown → 幻灯片/表格 结构解析单一事实源（2026-09-06）
 *
 * 背景：此前前端 doc-content-parser.ts 与后端 file-tools.js 各自维护一套
 * markdown 结构解析（--- 分页/封面页/要点截断规则互相漂移），PPT/XLSX 轨道
 * 预览与真实产物结构对不上。本模块从 file-tools.js 抽取 _parseMarkdownToSlides
 * 与 _parseMarkdownTables（行为原样保留），作为后端唯一解析实现：
 *   - MarkdownToPPT / MarkdownToExcel 转换工具直接复用；
 *   - Write 插桩经 filegen:doc-structure 广播解析结果，前端优先渲染后端结构，
 *     本地解析降级为 SSE 丢包兜底。
 * 纯函数、无依赖，可单测。
 */

/**
 * 从 Markdown 内容解析幻灯片结构
 * 规则: # → 封面, ## → 内容页标题, - → 项目符号, | → 表格, --- → 分页
 */
function parseMarkdownToSlides(mdContent) {
  const lines = String(mdContent || '').split('\n');
  const slides = [];
  let currentSlide = null;
  let inTable = false;
  let tableHeaders = [];
  let tableRows = [];

  function flushSlide() {
    if (!currentSlide) return;
    if (inTable) {
      if (currentSlide.type === 'content' && tableRows.length > 0) {
        // Convert content slide to table slide if it has a table
        currentSlide = {
          type: 'table',
          title: currentSlide.title,
          headers: tableHeaders,
          rows: tableRows,
        };
      }
      inTable = false;
      tableHeaders = [];
      tableRows = [];
    }
    if (currentSlide.type === 'content' && (!currentSlide.bullets || currentSlide.bullets.length === 0)) {
      // If a content slide ends up with no bullets but has text_content, use that as bullets
      if (currentSlide._textLines && currentSlide._textLines.length > 0) {
        currentSlide.bullets = currentSlide._textLines;
      }
    }
    delete currentSlide._textLines;
    slides.push(currentSlide);
    currentSlide = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line
    if (trimmed === '') {
      if (inTable) {
        flushSlide();
      }
      continue;
    }

    // Horizontal rule → slide break (if current slide has content)
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
      flushSlide();
      continue;
    }

    // H1 → Title slide
    const h1Match = trimmed.match(/^#\s+(.+)$/);
    if (h1Match) {
      flushSlide();
      currentSlide = { type: 'title', title: h1Match[1], subtitle: '' };
      // Check next line for subtitle
      if (i + 1 < lines.length && lines[i+1].trim() && !lines[i+1].trim().startsWith('#') && !lines[i+1].trim().startsWith('|') && !lines[i+1].trim().startsWith('-') && !lines[i+1].trim().startsWith('*')) {
        const nextLine = lines[i+1].trim();
        if (!nextLine.startsWith('```') && !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(nextLine)) {
          currentSlide.subtitle = nextLine.replace(/^\*\*(.+)\*\*$/, '$1');
        }
      }
      continue;
    }

    // H2 → Content slide
    const h2Match = trimmed.match(/^##\s+(.+)$/);
    if (h2Match) {
      flushSlide();
      currentSlide = { type: 'content', title: h2Match[1], bullets: [], _textLines: [] };
      continue;
    }

    // H3 → Content slide (treat as H2)
    const h3Match = trimmed.match(/^###\s+(.+)$/);
    if (h3Match) {
      flushSlide();
      currentSlide = { type: 'content', title: h3Match[1], bullets: [], _textLines: [] };
      continue;
    }

    // Table → table slide
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length < 2) continue;
      if (cells.every(c => /^:?-{3,}:?$/.test(c.replace(/\s/g, '')))) continue;

      if (!inTable) {
        inTable = true;
        tableHeaders = cells;
        tableRows = [];
        if (!currentSlide) {
          // Look back for a heading as table title
          let tableTitle = '数据表';
          for (let j = i - 1; j >= 0; j--) {
            const prev = lines[j].trim();
            const hm = prev.match(/^#{1,3}\s+(.+)$/);
            if (hm) { tableTitle = hm[1]; break; }
            if (prev === '') continue;
            break;
          }
          currentSlide = { type: 'table', title: tableTitle, headers: [], rows: [] };
        }
      } else {
        tableRows.push(cells);
      }
      continue;
    } else if (inTable) {
      flushSlide();
    }

    // Bullet → content slide
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      if (!currentSlide) {
        currentSlide = { type: 'content', title: '要点', bullets: [], _textLines: [] };
      }
      if (currentSlide.type === 'content') {
        currentSlide.bullets = currentSlide.bullets || [];
        currentSlide.bullets.push(bulletMatch[1]);
      }
      continue;
    }

    // Numbered list → content slide
    const numMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numMatch) {
      if (!currentSlide) {
        currentSlide = { type: 'content', title: '要点', bullets: [], _textLines: [] };
      }
      if (currentSlide.type === 'content') {
        currentSlide.bullets = currentSlide.bullets || [];
        currentSlide.bullets.push(numMatch[1]);
      }
      continue;
    }

    // Regular text → if in content slide, collect as text
    if (currentSlide && currentSlide.type === 'content') {
      currentSlide._textLines = currentSlide._textLines || [];
      currentSlide._textLines.push(trimmed);
    }
  }

  // Flush remaining
  flushSlide();

  // If no slides at all, create a basic one from the first meaningful line
  if (slides.length === 0) {
    const firstLine = lines.find(l => l.trim() && !l.trim().startsWith('```'));
    slides.push({
      type: 'title',
      title: firstLine ? firstLine.trim().replace(/^#\s*/, '') : '演示文稿',
      subtitle: '',
    });
  }

  return slides;
}

/**
 * 从 Markdown 内容解析表格结构（MarkdownToExcel 输入解析）
 * 规则: | a | b | 行 + |---| 分隔行；表格标题回溯最近标题/加粗行
 */
function parseMarkdownTables(mdContent) {
  const lines = String(mdContent || '').split('\n');
  const tables = [];
  let inTable = false;
  let currentTable = { headers: [], rows: [], title: null };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 检测表格行
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length < 2) continue;

      // 检测分隔行 (|---|:---:|---|)
      if (cells.every(c => /^:?-{3,}:?$/.test(c.replace(/\s/g, '')))) {
        continue;
      }

      if (!inTable) {
        // Look back for a potential title (preceding heading or bold line)
        for (let j = i - 1; j >= 0; j--) {
          const prev = lines[j].trim();
          const hMatch = prev.match(/^#{1,3}\s+(.+)$/);
          if (hMatch) { currentTable.title = hMatch[1]; break; }
          const bMatch = prev.match(/^\*\*(.+)\*\*\s*$/);
          if (bMatch) { currentTable.title = bMatch[1]; break; }
          if (prev === '') continue;
          break;
        }

        inTable = true;
        currentTable.headers = cells;
      } else {
        currentTable.rows.push(cells);
      }
    } else if (inTable) {
      // Table ended
      if (currentTable.headers.length > 0) {
        tables.push({
          title: currentTable.title,
          headers: currentTable.headers,
          rows: currentTable.rows,
        });
      }
      inTable = false;
      currentTable = { headers: [], rows: [], title: null };
    } else {
      // Check for bold line as candidate title before next table
      currentTable.title = null;
    }
  }

  // Close last table
  if (inTable && currentTable.headers.length > 0) {
    tables.push({
      title: currentTable.title,
      headers: currentTable.headers,
      rows: currentTable.rows,
    });
  }

  return tables;
}

module.exports = { parseMarkdownToSlides, parseMarkdownTables };
