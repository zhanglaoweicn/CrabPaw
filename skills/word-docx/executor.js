const crypto = require('crypto');
/**
 * Word DOCX 技能执行器
 *
 * 提供以下操作（通过 input.action 或 input.op 指定）：
 *   - read            提取纯文本（含段落、表格、列表）
 *   - structure       提取结构化大纲（标题/段落/表格）
 *   - metadata        提取文档元数据
 *   - styles          提取样式定义摘要
 *   - tables          提取所有表格为二维数组
 *   - comments        提取批注
 *   - revisions       提取修订追踪
 *   - sections        提取分节/页眉页脚
 *   - inspect         综合检查报告
 *
 * 调用约定：execute(input, options, params)
 *   input 必填字段：filePath
 *   input 可选字段：action（默认 'read'）
 *   options：技能配置（config.json）
 *   params：原始参数
 *
 * 依赖：safe-zip（CrabPaw 全局依赖，src/core/safe-zip）、内置 xml 解析
 */

const fs = require('fs');
const path = require('path');

// 2026-08-29 安全收口: extract-zip 全版本 zip-slip (CWE-22, CVSS 8.1) 无上游补丁——
// 改用 CrabPaw 统一安全解压 safeExtractZip(条目名越界/绝对路径/符号链接整体拒绝,
// 全有或全无)。技能目录可能被安装到仓库外, 相对路径失败时按 cwd 回退(进程
// cwd=仓库根)。二级回退也失败则 fail-loud。
let safeExtractZip = null;
try {
  ({ safeExtractZip } = require('../../src/core/safe-zip'));
} catch (_) {
  console.warn('[WordDocx] 按相对路径加载 safe-zip 失败, 尝试按 cwd 回退');
  try {
    ({ safeExtractZip } = require(path.join(process.cwd(), 'src', 'core', 'safe-zip')));
  } catch (e2) {
    console.error('[WordDocx] 无法加载 safe-zip 安全解压模块:', e2.message);
  }
}

const ACTION_HANDLERS = {
  read: handleRead,
  structure: handleStructure,
  metadata: handleMetadata,
  styles: handleStyles,
  tables: handleTables,
  comments: handleComments,
  revisions: handleRevisions,
  sections: handleSections,
  inspect: handleInspect,
  beautify: handleBeautify,
  // 2026-08-03: 生成能力——docx 库原生生成（无需 Python）
  create: handleCreate,
};

function _normalizeInput(input, params) {
  if (input && typeof input === 'object') {
    return {
      filePath: input.filePath || input.path || input.file || (params && (params.filePath || params.path)) || null,
      action: (input.action || input.op || 'read').toLowerCase(),
      maxLength: input.maxLength || input.limit || 50000,
      includeTables: input.includeTables !== false,
      includeComments: !!input.includeComments,
      includeRevisions: !!input.includeRevisions,
    };
  }
  return {
    filePath: typeof input === 'string' ? input : null,
    action: 'read',
    maxLength: 50000,
    includeTables: true,
    includeComments: false,
    includeRevisions: false,
  };
}

function _error(message, hint) {
  return {
    error: message,
    hint: hint || null,
  };
}

async function _loadDocx(filePath) {
  if (!filePath) {
    return { error: '请提供 docx 文件路径（filePath）' };
  }
  if (!fs.existsSync(filePath)) {
    return { error: `文件不存在: ${filePath}` };
  }
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { error: '文件为空' };
  }
  // 解压到内存
  const tmpDir = path.join(
    require('os').tmpdir(),
    `crabpaw-docx-${Date.now()}-${process.pid}-${crypto.randomUUID().slice(2, 8)}`
  );
  try {
    if (!safeExtractZip) throw new Error('safe-zip 模块不可用');
    await safeExtractZip(filePath, tmpDir);
    // 预读关键 XML 部件，避免每个 handler 重复 IO
    const documentXml = _readXmlPart(tmpDir, 'word/document.xml');
    return {
      tmpDir,
      size: stat.size,
      documentXml,
      partNames: fs.existsSync(tmpDir)
        ? fs.readdirSync(tmpDir, { recursive: true }).filter(f => typeof f === 'string')
        : [],
    };
  } catch (e) {
    // 清理
    if (fs.existsSync(tmpDir)) _rmrf(tmpDir);
    return { error: `docx 解压失败: ${e.message}`, hint: '文件可能已损坏或不是有效的 zip/docx' };
  }
}

function _rmrf(p) {
  try {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const f of fs.readdirSync(p)) _rmrf(path.join(p, f));
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  } catch (_) {
    console.warn('[WordDocx] failed to remove temp path:', p);
  }
}

function _readXmlPart(tmpDir, relPath) {
  const p = path.join(tmpDir, relPath);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (_) {
    return null;
  }
}

function _parseXml(xml) {
  if (!xml) return null;
  // 简单的命名空间移除 + 标签/属性解析
  const cleaned = xml.replace(/<\?xml[^?]*\?>/g, '').replace(/xmlns(:[\w-]+)?="[^"]*"/g, '');
  return cleaned;
}

function _extractTextFromDocumentXml(xml) {
  if (!xml) return { paragraphs: [], tables: [] };
  const text = _parseXml(xml);

  // 提取段落
  const paragraphRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const paragraphs = [];
  let pMatch;
  while ((pMatch = paragraphRegex.exec(text)) !== null) {
    const inner = pMatch[1];
    // 提取所有 <w:t>...</w:t>
    const tRegex = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    const runs = [];
    let tMatch;
    while ((tMatch = tRegex.exec(inner)) !== null) {
      runs.push(_decodeXml(tMatch[1]));
    }
    // 检测标题样式
    const styleMatch = /<w:pStyle\s+w:val="([^"]+)"/.exec(inner);
    const headingMatch = /w:val="(Heading\d|Title|Subtitle)"/.exec(inner);
    const isList = /<w:numPr\b/.test(inner);
    paragraphs.push({
      style: styleMatch ? styleMatch[1] : null,
      isHeading: !!headingMatch,
      isList,
      text: runs.join(''),
    });
  }

  // 提取表格（粗略：每个 <w:tbl> 内所有 <w:tr>，每行 <w:tc> 内文本）
  const tables = [];
  const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
  let tblMatch;
  while ((tblMatch = tblRegex.exec(text)) !== null) {
    const rows = [];
    const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
    let trMatch;
    while ((trMatch = trRegex.exec(tblMatch[1])) !== null) {
      const cells = [];
      const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
      let tcMatch;
      while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
        const cellParagraphs = [];
        const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
        let pM;
        while ((pM = pRegex.exec(tcMatch[1])) !== null) {
          const ts = [];
          const tR = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
          let tM;
          while ((tM = tR.exec(pM[1])) !== null) ts.push(_decodeXml(tM[1]));
          cellParagraphs.push(ts.join(''));
        }
        cells.push(cellParagraphs.join('\n'));
      }
      rows.push(cells);
    }
    tables.push(rows);
  }

  return { paragraphs, tables };
}

function _decodeXml(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function _paragraphsToText(paragraphs, maxLength) {
  const out = [];
  let total = 0;
  for (const p of paragraphs) {
    if (!p.text) continue;
    if (total + p.text.length > maxLength) {
      out.push(p.text.slice(0, Math.max(0, maxLength - total)) + '…[已截断]');
      break;
    }
    out.push(p.text);
    total += p.text.length;
  }
  return out.join('\n');
}

async function handleRead(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const { paragraphs, tables } = _extractTextFromDocumentXml(ctx.documentXml);
  const text = _paragraphsToText(paragraphs, input.maxLength);
  let combined = text;
  if (input.includeTables && tables.length) {
    combined += '\n\n## 表格\n';
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      combined += `\n### 表格 ${i + 1}（${t.length} 行 × ${t[0]?.length || 0} 列）\n`;
      t.forEach((row, ri) => {
        combined += `| ${row.map(c => (c || '').replace(/\|/g, '\\|')).join(' | ')} |\n`;
      });
    }
  }
  return {
    success: true,
    text: combined,
    paragraphCount: paragraphs.length,
    tableCount: tables.length,
    fileSize: ctx.size,
  };
}

async function handleStructure(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const { paragraphs, tables } = _extractTextFromDocumentXml(ctx.documentXml);
  const outline = [];
  for (const p of paragraphs) {
    if (p.isHeading || p.text.length === 0) {
      outline.push({ type: p.isHeading ? 'heading' : 'empty', style: p.style, text: p.text });
    } else {
      outline.push({ type: p.isList ? 'list' : 'paragraph', style: p.style, text: p.text.slice(0, 100) });
    }
  }
  return {
    success: true,
    outline,
    totalElements: outline.length,
    tableCount: tables.length,
    fileSize: ctx.size,
  };
}

async function handleMetadata(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const coreXml = _readXmlPart(ctx.tmpDir, 'docProps/core.xml');
  const appXml = _readXmlPart(ctx.tmpDir, 'docProps/app.xml');
  const meta = {};

  if (coreXml) {
    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(coreXml);
      return m ? _decodeXml(m[1].trim()) : null;
    };
    meta.title = get('dc:title') || get('title');
    meta.subject = get('dc:subject') || get('subject');
    meta.creator = get('dc:creator') || get('creator');
    meta.lastModifiedBy = get('cp:lastModifiedBy') || get('lastModifiedBy');
    meta.created = get('dcterms:created') || get('created');
    meta.modified = get('dcterms:modified') || get('modified');
    meta.revision = get('cp:revision') || get('revision');
    meta.description = get('dc:description') || get('description');
    meta.keywords = get('cp:keywords') || get('keywords');
  }

  if (appXml) {
    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(appXml);
      return m ? _decodeXml(m[1].trim()) : null;
    };
    meta.application = get('Application');
    meta.appVersion = get('AppVersion');
    meta.company = get('Company');
    meta.manager = get('Manager');
    meta.pages = get('Pages');
    meta.words = get('Words');
    meta.characters = get('Characters');
    meta.lines = get('Lines');
    meta.paragraphs = get('Paragraphs');
  }

  // 兜底：如果 app.xml 没有 words/paragraphs（或为 0），从 document.xml 实时计算
  const isReal = (v) => v && v !== '0' && v !== 0;
  if (!isReal(meta.words) || !isReal(meta.paragraphs)) {
    const { paragraphs } = _extractTextFromDocumentXml(ctx.documentXml);
    let totalChars = 0;
    let totalTextChars = 0;
    for (const p of paragraphs) {
      const t = p.text || '';
      // 中英文字符混合统计（中文字符算 1 词，英文按空格分词）
      const cnChars = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
      const enWords = (t.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
      totalChars += t.length;
      totalTextChars += cnChars + enWords;
    }
    meta.words = isReal(meta.words) ? parseInt(meta.words, 10) : totalTextChars;
    meta.paragraphs = isReal(meta.paragraphs) ? parseInt(meta.paragraphs, 10) : paragraphs.length;
    meta.characters = isReal(meta.characters) ? parseInt(meta.characters, 10) : totalChars;
  }

  return {
    success: true,
    metadata: meta,
    fileSize: ctx.size,
  };
}

async function handleStyles(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const stylesXml = _readXmlPart(ctx.tmpDir, 'word/styles.xml');
  if (!stylesXml) {
    return { success: true, styles: [], message: 'styles.xml 不存在' };
  }
  const styles = [];
  const re = /<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = re.exec(stylesXml)) !== null) {
    const id = m[1];
    const body = m[2];
    const typeMatch = /w:type="([^"]+)"/.exec(m[0]);
    const nameMatch = /<w:name\s+w:val="([^"]+)"/.exec(body);
    styles.push({
      id,
      type: typeMatch ? typeMatch[1] : null,
      name: nameMatch ? _decodeXml(nameMatch[1]) : null,
    });
    if (styles.length >= 200) break;
  }
  return { success: true, styles, total: styles.length, fileSize: ctx.size };
}

async function handleTables(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const { tables } = _extractTextFromDocumentXml(ctx.documentXml);
  return { success: true, tables, count: tables.length, fileSize: ctx.size };
}

async function handleComments(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const commentsXml = _readXmlPart(ctx.tmpDir, 'word/comments.xml');
  if (!commentsXml) {
    return { success: true, comments: [], message: 'comments.xml 不存在（无批注）' };
  }
  const comments = [];
  const re = /<w:comment\b[^>]*w:id="([^"]+)"[^>]*w:author="([^"]*)"[^>]*(?:w:date="([^"]*)")?[^>]*>([\s\S]*?)<\/w:comment>/g;
  let m;
  while ((m = re.exec(commentsXml)) !== null) {
    const ts = [];
    const tR = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tM;
    while ((tM = tR.exec(m[4])) !== null) ts.push(_decodeXml(tM[1]));
    comments.push({
      id: m[1],
      author: m[2] || null,
      date: m[3] || null,
      text: ts.join(''),
    });
  }
  return { success: true, comments, count: comments.length, fileSize: ctx.size };
}

async function handleRevisions(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const documentXml = ctx.documentXml || '';
  const insRe = /<w:ins\b[^>]*w:id="([^"]+)"[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:ins>/g;
  const delRe = /<w:del\b[^>]*w:id="([^"]+)"[^>]*w:author="([^"]*)"[^>]*>([\s\S]*?)<\/w:del>/g;
  const revisions = [];

  let m;
  while ((m = insRe.exec(documentXml)) !== null) {
    const ts = [];
    const tR = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tM;
    while ((tM = tR.exec(m[3])) !== null) ts.push(_decodeXml(tM[1]));
    revisions.push({ type: 'insert', id: m[1], author: m[2] || null, text: ts.join('') });
  }
  while ((m = delRe.exec(documentXml)) !== null) {
    const ts = [];
    const tR = /<w:delText(?:\s[^>]*)?>([\s\S]*?)<\/w:delText>/g;
    let tM;
    while ((tM = tR.exec(m[3])) !== null) ts.push(_decodeXml(tM[1]));
    revisions.push({ type: 'delete', id: m[1], author: m[2] || null, text: ts.join('') });
  }

  return { success: true, revisions, count: revisions.length, fileSize: ctx.size };
}

async function handleSections(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const documentXml = ctx.documentXml || '';
  const sectionRe = /<w:sectPr\b[^>]*>([\s\S]*?)<\/w:sectPr>/g;
  const sections = [];
  let m;
  let idx = 0;
  while ((m = sectionRe.exec(documentXml)) !== null) {
    idx += 1;
    const body = m[1];
    const pgSz = /<w:pgSz\s+([^/]+)\/>/.exec(body);
    const pgMar = /<w:pgMar\s+([^/]+)\/>/.exec(body);
    const headerRefs = [];
    const headerRe = /<w:headerReference\b[^>]*w:type="([^"]+)"\s+r:id="([^"]+)"/g;
    let hM;
    while ((hM = headerRe.exec(body)) !== null) {
      headerRefs.push({ type: hM[1], rId: hM[2] });
    }
    const footerRefs = [];
    const footerRe = /<w:footerReference\b[^>]*w:type="([^"]+)"\s+r:id="([^"]+)"/g;
    let fM;
    while ((fM = footerRe.exec(body)) !== null) {
      footerRefs.push({ type: fM[1], rId: fM[2] });
    }
    sections.push({
      index: idx,
      pageSize: pgSz ? pgSz[1].trim() : null,
      pageMargin: pgMar ? pgMar[1].trim() : null,
      headers: headerRefs,
      footers: footerRefs,
    });
  }
  return { success: true, sections, count: sections.length, fileSize: ctx.size };
}

async function handleInspect(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const parts = ctx.partNames || [];
  const meta = await handleMetadata(input);
  const tables = await handleTables(input);
  const styles = await handleStyles(input);
  const sections = await handleSections(input);

  return {
    success: true,
    summary: {
      fileSize: ctx.size,
      partCount: parts.length,
      parts: parts.slice(0, 50),
      metadata: meta.metadata || null,
      tableCount: tables.count,
      styleCount: styles.total,
      sectionCount: sections.count,
    },
    metadata: meta.metadata,
    tables: tables.tables?.slice(0, 5),
    styles: styles.styles?.slice(0, 20),
    sections: sections.sections,
  };
}

async function handleBeautify(input, _options, _params) {
  const ctx = input._ctx;
  if (!ctx || ctx.error) return _error(ctx?.error || '上下文缺失', ctx?.hint);

  const { paragraphs, tables } = _extractTextFromDocumentXml(ctx.documentXml);
  const text = _paragraphsToText(paragraphs, input.maxLength || 100000);

  // Build simple markdown from extracted content
  let md = '';
  for (const p of paragraphs) {
    if (!p.text) { md += '\n'; continue; }
    if (p.isHeading) {
      const level = (p.style && p.style.match(/Heading(\d)/)) ? parseInt(p.style.match(/Heading(\d)/)[1]) : 1;
      md += '#'.repeat(Math.min(level, 6)) + ' ' + p.text + '\n\n';
    } else if (p.isList) {
      md += '- ' + p.text + '\n';
    } else {
      md += p.text + '\n\n';
    }
  }

  if (tables.length > 0) {
    for (const t of tables) {
      if (t.length === 0) continue;
      md += '\n';
      for (let ri = 0; ri < t.length; ri++) {
        md += '| ' + t[ri].join(' | ') + ' |\n';
        if (ri === 0) {
          md += '|' + t[ri].map(() => ' --- ').join('|') + '|\n';
        }
      }
      md += '\n';
    }
  }

  const beautifyStyle = input.style || input.beautifyStyle || '商务报告';
  const validStyles = ['商务报告', '中国公文', '学术论文', '简约现代'];
  if (!validStyles.includes(beautifyStyle)) {
    return _error(`未知的美化模板: ${beautifyStyle}`, `可用模板: ${validStyles.join(', ')}`);
  }

  // Write temp markdown file
  const tmpDir = require('os').tmpdir();
  const tmpMd = path.join(tmpDir, `crabpaw-beautify-${Date.now()}-${process.pid}.md`);
  const tmpDocx = path.join(tmpDir, `crabpaw-beautify-${Date.now()}-${process.pid}.docx`);

  try {
    fs.writeFileSync(tmpMd, md, 'utf-8');

    // Call Python md_to_docx.py
    const { execSync } = require('child_process');
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'md_to_docx.py');

    let pythonCmd = 'python';
    try { execSync('python3 --version', { stdio: 'pipe', windowsHide: true }); pythonCmd = 'python3'; } catch (_) {}

    const cmd = `${pythonCmd} "${scriptPath}" "${tmpMd}" "${tmpDocx}" --style ${beautifyStyle}`;
    execSync(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 60000, encoding: 'utf-8', windowsHide: true });

    if (!fs.existsSync(tmpDocx)) {
      return _error('美化后的文件生成失败', 'Python 脚本未生成输出文件');
    }

    // Copy to output path if specified, otherwise return temp path
    let outputPath = input.outputPath || input.output || null;
    if (outputPath) {
      fs.copyFileSync(tmpDocx, outputPath);
      try { fs.unlinkSync(tmpDocx); } catch (_) {}
    } else {
      outputPath = tmpDocx;
    }

    const stats = fs.statSync(outputPath);
    return {
      success: true,
      beautified: true,
      style: beautifyStyle,
      path: outputPath,
      size: stats.size,
      sizeKB: (stats.size / 1024).toFixed(1),
      message: `文档已按「${beautifyStyle}」模板美化`,
    };
  } catch (e) {
    return _error(`美化失败: ${e.message}`, '请确认 Python 和 python-docx 已安装 (pip install python-docx)');
  } finally {
    try { if (fs.existsSync(tmpMd)) fs.unlinkSync(tmpMd); } catch (_) {}
  }
}

// ─── 2026-08-03: DOCX 生成（docx 库原生实现，无 Python 依赖） ───

/** 极简 markdown 解析：标题 / 列表 / 表格 / 代码块 / 段落 → 结构化块 */
function _mdToBlocks(md) {
  const blocks = [];
  const lines = String(md || '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    // 代码块
    if (/^```/.test(trimmed)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { code.push(lines[i]); i++; }
      i++; // 跳过闭合 ```
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    // 标题
    const hm = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (hm) { blocks.push({ type: 'heading', level: hm[1].length, text: hm[2] }); i++; continue; }
    // 表格（连续行）
    if (trimmed.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().split('|').slice(1, -1).map(c => c.trim());
        if (!cells.every(c => /^:?-{2,}:?$/.test(c))) rows.push(cells); // 跳过分隔行
        i++;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    // 列表（连续行）
    if (/^[-*•]\s+/.test(trimmed) || /^\d+[.、]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const t = lines[i].trim();
        const lm = /^[-*•]\s+(.*)$/.exec(t) || /^\d+[.、]\s+(.*)$/.exec(t);
        if (!lm) break;
        items.push(lm[1]);
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    blocks.push({ type: 'paragraph', text: trimmed });
    i++;
  }
  return blocks;
}

async function handleCreate(input, _options, _params) {
  const title = input.title || input.name || '未命名文档';
  const content = input.content || input.text || input.markdown || '';
  const outputPath = input.outputPath || input.output || null;
  if (!content) {
    return _error('请提供文档内容（content / markdown 文本）');
  }

  let docxLib;
  try {
    docxLib = require('docx');
  } catch (e) {
    return _error('docx 库未安装', '请运行: npm install docx');
  }
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } = docxLib;

  const FONT = '微软雅黑';
  const children = [];

  // 标题段落
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title, font: FONT, size: 36, bold: true })],
  }));
  children.push(new Paragraph({ children: [new TextRun({ text: '', font: FONT })] }));

  // 结构化内容
  for (const block of _mdToBlocks(content)) {
    if (block.type === 'heading') {
      const map = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
      children.push(new Paragraph({
        heading: map[Math.min(block.level - 1, 5)],
        children: [new TextRun({ text: block.text, font: FONT, bold: true })],
      }));
    } else if (block.type === 'paragraph') {
      children.push(new Paragraph({ children: [new TextRun({ text: block.text, font: FONT, size: 22 })] }));
    } else if (block.type === 'list') {
      for (const item of block.items) {
        children.push(new Paragraph({
          text: item,
          bullet: { level: 0 },
          children: [new TextRun({ text: item, font: FONT, size: 22 })],
        }));
      }
    } else if (block.type === 'table') {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: block.rows.map((row, ri) => new TableRow({
          children: row.map((cell) => new TableCell({
            shading: ri === 0 ? { fill: 'EEF2FF' } : undefined,
            children: [new Paragraph({ children: [new TextRun({ text: cell, font: FONT, size: 20, bold: ri === 0 })] })],
          })),
        })),
      }));
      children.push(new Paragraph({ children: [new TextRun({ text: '', font: FONT })] }));
    } else if (block.type === 'code') {
      for (const cl of block.text.split('\n')) {
        children.push(new Paragraph({
          children: [new TextRun({ text: cl || ' ', font: 'Consolas', size: 18, color: '1F2937' })],
          spacing: { after: 0 },
        }));
      }
    }
  }

  const doc = new Document({
    creator: 'CrabPaw',
    title,
    sections: [{ properties: {}, children }],
  });

  const buf = await Packer.toBuffer(doc);
  // 2026-08-22: 与 src/core/filename-utils.js sanitizeFilename 保持一致的简化内联规则
  // （技能是独立单元，只依赖内置模块，不 require 项目模块）。旧规则把空白替换成 '-' 且
  // 无中文字段——中文标题产物文件名不可读；新规则保留中文、空白→'_'。
  const safeName = String(title || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/[^\p{L}\p{N}._\-\s]/gu, ' ')
    .replace(/\s+/g, '_').replace(/_+/g, '_').replace(/-+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '').slice(0, 60) || 'document';
  const finalPath = outputPath || path.join(
    process.env.CRABPAW_DATA_DIR || path.join(__dirname, '../..'),
    `${safeName}-${Date.now()}.docx`
  );
  fs.writeFileSync(finalPath, buf);

  const size = fs.statSync(finalPath).size;
  return {
    success: true,
    docxPath: finalPath,
    size,
    sizeKB: (size / 1024).toFixed(1),
    url: `file:///${finalPath.replace(/\\/g, '/')}`,
    message: `Word 文档已生成 (${(size / 1024).toFixed(1)} KB)`,
  };
}

async function execute(input, options, params) {
  const normalized = _normalizeInput(input, params);
  // 2026-08-03: create 操作不需要已有文件
  if (normalized.action === 'create') {
    normalized.title = (input && typeof input === 'object') ? (input.title || input.name) : null;
    normalized.content = (input && typeof input === 'object') ? (input.content || input.text || input.markdown) : null;
    normalized.outputPath = (input && typeof input === 'object') ? (input.outputPath || input.output) : null;
    return handleCreate(normalized, options, params);
  }
  if (!normalized.filePath) {
    return _error('请提供 docx 文件路径（filePath / path / file）');
  }
  const action = normalized.action;
  if (!ACTION_HANDLERS[action]) {
    return _error(
      `未知操作: ${action}`,
      `可用操作: ${Object.keys(ACTION_HANDLERS).join(', ')}`
    );
  }

  const ctx = await _loadDocx(normalized.filePath);
  try {
    normalized._ctx = ctx;
    const result = await ACTION_HANDLERS[action](normalized, options, params);
    return result;
  } finally {
    if (ctx && ctx.tmpDir && fs.existsSync(ctx.tmpDir)) {
      _rmrf(ctx.tmpDir);
    }
  }
}

const schema = {
  name: 'word-docx',
  description: 'Word 文档处理：创建/编辑/美化 DOCX 文档',
  capabilities: ['document_formatting', 'content_structure'],
  input: {
    content: { type: 'string', description: '文档内容（Markdown 格式）' },
    template: { type: 'string', description: '模板：商务报告/中国公文/学术论文/简约现代' },
  },
  output: {
    docxPath: { type: 'file', description: '生成的 DOCX 文件路径' },
  },
};

module.exports = { execute, schema };
module.exports.execute = execute;
