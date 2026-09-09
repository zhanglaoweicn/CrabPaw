/**
 * File Tools - 文件操作工具集
 * 自动注册到中心注册表
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const filegen = require('../core/filegen-events');
const { exec } = require('child_process');
const { promisify } = require('util');

const getDataDir = () => {
  if (process.env.CRABPAW_DATA_DIR) return process.env.CRABPAW_DATA_DIR;
  // 2026-08-08 fix: 此前多一级 '..' 解析成 D:\data\.crabpaw(与 src/cli 的
  // 默认路径不一致)——无 CRABPAW_DATA_DIR env 时数据目录错位
  return path.join(__dirname, '..', '..', 'data', '.crabpaw');
};
const execAsync = promisify(exec);
const { registry } = require('./registry');
// SP-4 SA-1: 产物落盘目录单轨统一（2 处拼接 → getDocumentArtifactsDir）
const { getDocumentArtifactsDir } = require('../core/doc-artifacts/registry');
// eslint-disable-next-line no-unused-vars
const { isWriteDenied, isReadSensitive } = require('../core/file-safety');
// 2026-08-28 M1: 生成器 outputPath 过权限门(与 Write 同源, 见 permissions/path-rules.js)
const { canWriteGeneratorOutput } = require('../core/permissions/path-rules');

/** 生成类工具产物路径权限断言（PLAN 只读/系统保护路径拦截） */
function assertGeneratorOutputAllowed(outputPath) {
  if (!canWriteGeneratorOutput(outputPath)) {
    throw new Error(`安全限制：不允许写入该输出路径（PLAN 只读模式或系统保护路径）: ${outputPath}`);
  }
}

const DANGEROUS_FILES = [
  '.env', 'credentials', 'secrets', 'private_key',
  'id_rsa', 'id_ed25519', '.pem', '.key',
  '.gitconfig', '.bashrc', '.bash_profile',
  '.zshrc', '.zprofile', '.profile'
];

const DANGEROUS_DIRS = ['.git', '.ssh'];


const MAX_GLOB_RESULTS = 100;
const MAX_GREP_RESULTS = 250;

function isDangerousPath(filePath) {
  const normalized = path.normalize(filePath).toLowerCase();
  
  // 路径遍历检测：resolve 后检查是否包含 .. 跳出
  const resolved = path.resolve(filePath);
  const cwd = process.cwd();
  const dataDir = getDataDir();
  // 允许的根目录：项目根目录 + data 目录
  const allowedRoots = [cwd, path.resolve(dataDir)];
  const isWithinAllowed = allowedRoots.some(root =>
    resolved.startsWith(root + path.sep) || resolved === root
  );
  if (!isWithinAllowed) {
    return true;
  }
  
  for (const dir of DANGEROUS_DIRS) {
    if (normalized.includes(path.sep + dir.toLowerCase() + path.sep) ||
        normalized.includes('/' + dir.toLowerCase() + '/') ||
        normalized.endsWith(path.sep + dir.toLowerCase()) ||
        normalized.endsWith('/' + dir.toLowerCase())) {
      return true;
    }
  }
  
  const basename = path.basename(normalized);
  for (const file of DANGEROUS_FILES) {
    if (basename === file.toLowerCase()) return true;
  }
  
  return false;
}

async function handleRead(params, _context) {
  // 2026-08-22 实机修复: path/filePath 别名三兼容（checkFn 已放行；模型在 DocRead
  // 上学到驼峰 filePath 后会套用到 Read——19:20 实测 file_path 下划线+驼峰混合）
  const file_path = params.file_path || params.path || params.filePath;
  const { offset, limit } = params;
  
  // 路径遍历防护
  if (isDangerousPath(file_path)) {
    throw new Error(`安全限制：拒绝访问路径 ${file_path}`);
  }
  const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
    '.sqlite', '.db', '.woff', '.woff2', '.eot', '.ttf', '.otf',
    '.pyc', '.pyo', '.class', '.o', '.obj'
  ]);
  
  const DOCUMENT_EXTENSIONS = new Set([
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
  ]);
  
  const ext = path.extname(file_path).toLowerCase();
  
  // 解析文档文件
  if (DOCUMENT_EXTENSIONS.has(ext)) {
    try {
      // 尝试加载 markitdown（npm 包），如果不可用则降级
      let MarkItDown;
      try {
        MarkItDown = require('markitdown').MarkItDown;
      } catch (_e) {
        // markitdown npm 包未安装，返回格式提示
        return {
          content: `[Document file: ${ext} format, ${path.basename(file_path)}]\n\n文档解析需要安装 markitdown 库。\n请运行：npm install markitdown`,
          path: file_path,
          size: 0,
          lines: 0,
          document: true,
          format: ext,
          unsupported: true,
        };
      }
      const md = new MarkItDown();
      const result = await md.convert(file_path);
      let content = result.text_content || '';
      
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        const start = offset || 0;
        const end = limit !== undefined ? start + limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      
      return {
        content,
        path: file_path,
        size: content.length,
        lines: content.split('\n').length,
        document: true,
        format: ext
      };
    } catch (err) {
      // markitdown 加载成功但转换失败
      return {
        content: `[Document file: ${ext} format, ${path.basename(file_path)}]\n\n文档解析失败: ${err.message}`,
        path: file_path,
        size: 0,
        lines: 0,
        document: true,
        format: ext,
        error: true,
      };
    }
  }
  
  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      content: `[Binary file: ${ext} format, ${path.basename(file_path)}]`,
      path: file_path,
      size: 0,
      lines: 0,
      binary: true
    };
  }
  
  let content = await fs.readFile(file_path, 'utf8');
  
  if (offset !== undefined || limit !== undefined) {
    const lines = content.split('\n');
    const start = offset || 0;
    const end = limit !== undefined ? start + limit : lines.length;
    content = lines.slice(start, end).join('\n');
  }
  
  return {
    content,
    path: file_path,
    size: content.length,
    lines: content.split('\n').length
  };
}

async function handleWrite(params, _context) {
  // 2026-08-22 实机修复: filePath 驼峰三兼容（同 Read——模型会混用两种拼写）
  const file_path = params.file_path || params.path || params.filePath;
  const { content } = params;
  
  if (!file_path) {
    throw new Error('file_path or path is required');
  }
  
  const writeCheck = isWriteDenied(file_path);
  if (writeCheck.denied) {
    throw new Error(`写入被拒绝: ${writeCheck.reason} - ${writeCheck.path}`);
  }
  
  const dir = path.dirname(file_path);
  await fs.mkdir(dir, { recursive: true });
  // 2026-08-22: html 产物加 UTF-8 BOM——WPS 文字对无 BOM 的 UTF-8 文件按系统 ANSI(GBK)
  // 检测导致中文乱码（实测：智能体的_Harness_给_AI_套上缰绳.html）。浏览器/iframe
  // 忽略 BOM（meta charset 仍生效）；已带 BOM 不重复加（幂等）。
  const isHtml = /\.html?$/i.test(file_path);
  const writeContent = isHtml && !content.startsWith('﻿') ? '﻿' + content : content;
  await fs.writeFile(file_path, writeContent, 'utf8');

  const stats = await fs.stat(file_path);

  // 2026-08-17: filegen 插桩——文件生成任务事件（不阻塞写文件）。
  // ensureFileGenTask：生成意图请求开始(ai.js)已开任务(①资料搜集)→复用推进③内容撰写；
  // 无活跃任务(直接写文件)→新建。多文件写作同属一个任务，不再每次 newTaskId 顶掉。
  // 2026-09-06 状态机 v2: Write 不再即 done——改发 filegen:artifact（产物登记），
  // 任务级 done 只来自转换完成或回合收敛（settleTurn），治多文件写作 phase 震荡。
  try {
    const fgFormat = filegen.formatFromPath(file_path);
    const fgPreFormat = filegen.getFileGenStatus()?.format || null;
    const fgTaskId = filegen.ensureFileGenTask({
      title: path.basename(file_path),
      format: fgFormat,
      phase: 'writing',
      label: `正在撰写 ${path.basename(file_path)}…`,
    });
    filegen.artifactFileGen(fgTaskId, {
      path: file_path,
      name: path.basename(file_path),
      size: stats.size,
      format: fgFormat,
      url: filegen.previewUrlFor(fgFormat, file_path),
    });
    // 2026-09-06: 结构化预览单一事实源——写 md 源且任务目标是 pptx/xlsx 时，
    // 广播后端解析结构（filegen:doc-structure），前端载体视图直接渲染
    if (fgFormat === 'md' && (fgPreFormat === 'pptx' || fgPreFormat === 'xlsx')) {
      filegen.broadcastDocStructure(fgTaskId, fgPreFormat, content);
    }

    // 2026-08-22: autoDocx——文章类意图(ai.js maybeStartFileGenTask 标记 autoDocx)：
    // Write 写 md 后自动同步生成 Word 文档（用户场景: 写文章不主动提 WORD 也要出 WORD）。
    // 仅 Write 触发（Edit 的 new_string 是片段, 转出来是残缺文档）；converting 阶段推进
    // 四步指示器「④文档生成」闭环；转换失败只 log 不阻塞——md 仍是产物, 面板正常。
    if (fgFormat === 'md' && filegen.getFileGenStatus()?.autoDocx) {
      try {
        const baseName = path.basename(file_path, path.extname(file_path));
        filegen.ensureFileGenTask({ title: baseName, format: 'docx', phase: 'converting', label: '正在生成 Word 文档…' });
        const { _generateDocx } = require('./document-tools');
        const buffer = await _generateDocx(content, baseName, '商务报告');
        const workspaceDir = getDocumentArtifactsDir();
        await fs.mkdir(workspaceDir, { recursive: true });
        const { sanitizeFilename } = require('../core/filename-utils');
        const outPath = path.join(workspaceDir, `${sanitizeFilename(baseName, 'document')}_${Date.now()}.docx`);
        await fs.writeFile(outPath, buffer);
        filegen.doneFileGen(fgTaskId, {
          path: outPath,
          name: outPath.split(/[/\\]/).pop(),
          size: buffer.length,
          format: 'docx',
          url: null,
        });
        console.log(`✅ autoDocx: ${outPath}`);
      } catch (fgErr) {
        console.error('[filegen] 自动生成 Word 失败(不阻塞):', fgErr.message);
      }
    }
  } catch (fgErr) {
    console.error('[filegen] Write 插桩失败(不阻塞写文件):', fgErr.message);
  }

  return { path: file_path, size: stats.size, created: true };
}

// ─── 模糊匹配策略 ───

/**
 * 模糊匹配策略枚举
 * 当精确匹配失败时，按顺序尝试以下策略
 */
const FUZZY_STRATEGIES = {
  // 1. 忽略空白差异
  whitespace: (content, search) => {
    const normalizeWS = (s) => s.replace(/\s+/g, ' ').trim();
    const normalizedContent = normalizeWS(content);
    const normalizedSearch = normalizeWS(search);
    const idx = normalizedContent.indexOf(normalizedSearch);
    if (idx === -1) return null;
    // 找到大致位置，在原文中定位
    return { strategy: 'whitespace', confidence: 0.8 };
  },

  // 2. 忽略尾随空白
  trailingWhitespace: (content, search) => {
    const lines = search.split('\n');
    const contentLines = content.split('\n');
    for (let i = 0; i <= contentLines.length - lines.length; i++) {
      let match = true;
      for (let j = 0; j < lines.length; j++) {
        if (contentLines[i + j].replace(/\s+$/, '') !== lines[j].replace(/\s+$/, '')) {
          match = false;
          break;
        }
      }
      if (match) {
        return { strategy: 'trailingWhitespace', startLine: i, endLine: i + lines.length - 1, confidence: 0.9 };
      }
    }
    return null;
  },

  // 3. 缩进无关匹配
  indentation: (content, search) => {
    const stripIndent = (s) => s.split('\n').map(l => l.trimStart()).join('\n');
    const strippedContent = stripIndent(content);
    const strippedSearch = stripIndent(search);
    const idx = strippedContent.indexOf(strippedSearch);
    if (idx === -1) return null;
    return { strategy: 'indentation', confidence: 0.7 };
  },

  // 4. 单行模糊匹配（去除行内空白差异）
  singleLineFuzzy: (content, search) => {
    const normalizeLine = (s) => s.replace(/\s+/g, ' ').replace(/\s*([,;{}()[\]=<>+\-*/|&!?:])\s*/g, '$1');
    const normalizedContent = normalizeLine(content);
    const normalizedSearch = normalizeLine(search);
    const idx = normalizedContent.indexOf(normalizedSearch);
    if (idx === -1) return null;
    return { strategy: 'singleLineFuzzy', confidence: 0.6 };
  },

  // 5. 逐行最佳匹配（找到匹配度最高的连续行段）
  lineByLine: (content, search) => {
    const searchLines = search.split('\n');
    const contentLines = content.split('\n');
    if (searchLines.length === 0) return null;

    let bestScore = 0;
    let bestStart = -1;

    for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
      let score = 0;
      for (let j = 0; j < searchLines.length; j++) {
        const c = contentLines[i + j].trim();
        const s = searchLines[j].trim();
        if (c === s) {
          score += 1;
        } else if (c.includes(s) || s.includes(c)) {
          score += 0.5;
        } else {
          // 简单字符重叠率
          const commonChars = [...s].filter(ch => c.includes(ch)).length;
          score += commonChars / Math.max(c.length, s.length) * 0.3;
        }
      }
      score /= searchLines.length;
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
      }
    }

    if (bestScore >= 0.5) {
      return { strategy: 'lineByLine', startLine: bestStart, endLine: bestStart + searchLines.length - 1, confidence: bestScore };
    }
    return null;
  },
};

/**
 * 使用模糊匹配策略查找文本位置
 * 返回 { start, end, strategy, confidence } 或 null
 */
function fuzzyFindInContent(content, search) {
  // 策略按精度从高到低尝试
  const strategyOrder = ['trailingWhitespace', 'indentation', 'whitespace', 'singleLineFuzzy', 'lineByLine'];

  for (const name of strategyOrder) {
    const strategy = FUZZY_STRATEGIES[name];
    const result = strategy(content, search);
    if (result) {
      return result;
    }
  }

  return null;
}

/**
 * 基于模糊匹配结果执行替换
 */
function applyFuzzyReplace(content, search, replace, fuzzyResult) {
  const contentLines = content.split('\n');
  const replaceLines = replace.split('\n');

  if (fuzzyResult.startLine !== undefined) {
    // 行级匹配（trailingWhitespace, lineByLine）
    const before = contentLines.slice(0, fuzzyResult.startLine);
    const after = contentLines.slice(fuzzyResult.endLine + 1);
    return [...before, ...replaceLines, ...after].join('\n');
  }

  // 对于其他策略，尝试在原文中找到最接近的片段
  // 回退到逐行搜索
  const strippedSearch = search.split('\n').map(l => l.trimStart()).join('\n');
  const strippedContent = content.split('\n').map(l => l.trimStart()).join('\n');
  const idx = strippedContent.indexOf(strippedSearch);
  if (idx !== -1) {
    // 找到位置，但需要映射回原文
    // 简单策略：用替换内容替换
    // 这个映射不完美，但作为回退方案足够
  }

  // 最终回退：直接替换
  return content.replace(search, replace);
}

async function handleEdit(params, _context) {
  // 2026-08-22 实机修复: path/filePath 别名三兼容（同 Read/Write）
  const file_path = params.file_path || params.path || params.filePath;
  const { old_string, new_string, fuzzy = false } = params;
  
  const writeCheck = isWriteDenied(file_path);
  if (writeCheck.denied) {
    throw new Error(`编辑被拒绝: ${writeCheck.reason} - ${writeCheck.path}`);
  }
  
  let content = await fs.readFile(file_path, 'utf8');
  
  // 精确匹配
  if (content.includes(old_string)) {
    content = content.replace(old_string, new_string);
    await fs.writeFile(file_path, content, 'utf8');

    // 2026-08-17: filegen 插桩——编辑写入成功广播（不阻塞编辑）
    try {
      const fgFormat = filegen.formatFromPath(file_path);
      const fgTaskId = filegen.ensureFileGenTask({
        title: path.basename(file_path),
        format: fgFormat,
        phase: 'writing',
        label: `正在撰写 ${path.basename(file_path)}…`,
      });
      const fgStats = await fs.stat(file_path);
      // 2026-09-06 状态机 v2: Edit 同 Write——artifact 登记替代即 done
      filegen.artifactFileGen(fgTaskId, {
        path: file_path,
        name: path.basename(file_path),
        size: fgStats.size,
        format: fgFormat,
        url: filegen.previewUrlFor(fgFormat, file_path),
      });
    } catch (fgErr) {
      console.error('[filegen] Edit 插桩失败(不阻塞编辑):', fgErr.message);
    }

    return { success: true, path: file_path, matchType: 'exact' };
  }

  // 精确匹配失败，尝试模糊匹配
  if (fuzzy) {
    const fuzzyResult = fuzzyFindInContent(content, old_string);
    if (fuzzyResult) {
      const newContent = applyFuzzyReplace(content, old_string, new_string, fuzzyResult);
      if (newContent !== content) {
        await fs.writeFile(file_path, newContent, 'utf8');

        // 2026-08-17: filegen 插桩——模糊编辑写入成功广播（不阻塞编辑）
        try {
          const fgFormat = filegen.formatFromPath(file_path);
          const fgTaskId = filegen.ensureFileGenTask({
            title: path.basename(file_path),
            format: fgFormat,
            phase: 'writing',
            label: `正在撰写 ${path.basename(file_path)}…`,
          });
          const fgStats = await fs.stat(file_path);
          // 2026-09-06 状态机 v2: 模糊编辑同 Write——artifact 登记替代即 done
          filegen.artifactFileGen(fgTaskId, {
            path: file_path,
            name: path.basename(file_path),
            size: fgStats.size,
            format: fgFormat,
            url: filegen.previewUrlFor(fgFormat, file_path),
          });
        } catch (fgErr) {
          console.error('[filegen] Edit 插桩失败(不阻塞编辑):', fgErr.message);
        }

        return {
          success: true,
          path: file_path,
          matchType: 'fuzzy',
          strategy: fuzzyResult.strategy,
          confidence: fuzzyResult.confidence,
          warning: `模糊匹配 (${fuzzyResult.strategy}, 置信度: ${(fuzzyResult.confidence * 100).toFixed(0)}%)，请检查结果`,
        };
      }
    }
  }

  throw new Error('old_string not found in file' + (fuzzy ? ' (模糊匹配也未找到)' : '。提示: 设置 fuzzy=true 启用模糊匹配'));
}

async function handleGlob(params, _context) {
  const { pattern, path: searchPath = '.' } = params;
  const results = [];
  
  await globSearch(searchPath, pattern, results, MAX_GLOB_RESULTS, searchPath);
  
  return {
    filenames: results,
    numFiles: results.length,
    truncated: results.length >= MAX_GLOB_RESULTS
  };
}

async function globSearch(dir, pattern, results, maxResults, baseDir) {
  if (results.length >= maxResults) return;
  // 2026-09-07: baseDir 固定为搜索根——旧实现只拿文件名(最后一段)与整个
  // glob 模式匹配, '**/compositions/index.tsx' 这类多段模式永远匹配不到
  // (宣传片实测: 智能体所有 Glob 全空, 烧光预算盲搜)。现在同时匹配相对
  // 路径与文件名, 单段 '*.js' 与多段 '**/x/y' 模式都可用。
  const root = baseDir || dir;
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await globSearch(fullPath, pattern, results, maxResults, root);
        }
      } else if (entry.isFile()) {
        const relPath = path.relative(root, fullPath).split(path.sep).join('/');
        if (matchGlobPattern(relPath, pattern) || matchGlobPattern(entry.name, pattern)) {
          results.push(fullPath);
        }
      }
    }
  } catch (e) {
    console.warn('Glob 搜索失败:', e.message);
  }
}

function matchGlobPattern(filename, pattern) {
  // 2026-09-07: '**/' 先于 '**' 处理并转为 (?:.*/)?——零层或多层目录。
  // 旧转换 '**/*.js' → '.*\/[^/]*\.js' 强制要求一个斜杠, 根目录文件
  // 永远匹配不上。注意占位符展开必须放在点号转义之后, 否则展开出的
  // '.*' 里的点会被二次转义成 '\.*'。
  const regex = pattern
    .replace(/\*\*\//g, '<<<GLOBSTAR_SLASH>>>')
    .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\./g, '\\.')
    .replace(/<<<GLOBSTAR_SLASH>>>/g, '(?:.*/)?')
    .replace(/<<<DOUBLESTAR>>>/g, '.*');

  return new RegExp(`^${regex}$`, 'i').test(filename);
}

async function handleGrep(params, _context) {
  const {
    pattern,
    path: searchPath = '.',
    glob: globPattern,
    output_mode = 'files_with_matches',
    '-i': caseInsensitive = false,
    '-n': showLineNumbers = true,
    '-C': contextLines = 0
  } = params;
  
  const results = [];
  const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
  
  await grepSearch(searchPath, regex, globPattern, output_mode, showLineNumbers, contextLines, results, MAX_GREP_RESULTS);
  
  return { results, count: results.length, mode: output_mode };
}

async function grepSearch(dir, regex, globPattern, outputMode, showLineNumbers, contextLines, results, maxResults) {
  if (results.length >= maxResults) return;
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await grepSearch(fullPath, regex, globPattern, outputMode, showLineNumbers, contextLines, results, maxResults);
        }
      } else if (entry.isFile()) {
        if (globPattern && !matchGlobPattern(entry.name, globPattern)) continue;
        
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          const lines = content.split('\n');
          
          for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              if (outputMode === 'files_with_matches') {
                results.push(fullPath);
                break;
              } else {
                const lineNum = showLineNumbers ? `${i + 1}:` : '';
                results.push(`${fullPath}:${lineNum}${lines[i]}`);
              }
            }
          }
        } catch (e) {
          console.warn('Grep 读取文件失败:', fullPath, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('Grep 搜索失败:', e.message);
  }
}

async function handleLS(params, _context) {
  const { path: dirPath = '.', ignore = [] } = params;
  
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  
  return entries
    .filter(e => !ignore.some(pattern => e.name.match(new RegExp(pattern))))
    .map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file'
    }));
}

async function handleDeleteFile(params, _context) {
  const { file_paths } = params;
  const dataDir = getDataDir();
  
  for (const filePath of file_paths) {
    if (isDangerousPath(filePath)) {
      throw new Error(`拒绝删除危险文件: ${filePath}`);
    }
    
    // 安全检查：只允许删除 DATA_DIR 内的文件
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(dataDir) + path.sep) && resolvedPath !== path.resolve(dataDir)) {
      throw new Error(`安全限制：只允许删除数据目录内的文件。当前路径: ${resolvedPath}`);
    }
    
    await fs.unlink(filePath);
  }
  
  return { deleted: file_paths.length, paths: file_paths };
}

async function handleCreateDirectory(params, _context) {
  const { path: dirPath } = params;
  await fs.mkdir(dirPath, { recursive: true });
  return { path: dirPath, created: true };
}

async function handleMarkdownToWord(params, _context) {
  const { input_path, output_path, title, style, author, send_to_wecom, wecom_user_id } = params;

  if (!input_path) {
    throw new Error('input_path is required');
  }

  const inputExt = path.extname(input_path).toLowerCase();
  if (inputExt !== '.md') {
    throw new Error('Input file must be a Markdown file (.md)');
  }

  let outputPath = output_path;
  if (!outputPath) {
    outputPath = input_path.replace(/\.md$/i, '.docx');
  }
  // 2026-08-28 M1: outputPath 过权限门
  assertGeneratorOutputAllowed(outputPath);

  const scriptPath = path.join(__dirname, '../../scripts/md_to_docx.py');

  let pythonCmd = 'python';
  try {
    await execAsync('python3 --version');
    pythonCmd = 'python3';
  } catch (e) {

    // python3 not found, use python

    console.warn('[file-tools.js] 空 catch 补日志:', e && e.message);
  }


  const titleArg = title ? `"${title.replace(/"/g, '\\"')}"` : '';
  const styleArg = style ? `--style ${style}` : '';
  const authorArg = author ? `--author "${author.replace(/"/g, '\\"')}"` : '';
  const cmd = `${pythonCmd} "${scriptPath}" "${input_path}" "${outputPath}" ${titleArg} ${styleArg} ${authorArg}`.trim();

  console.log('📄 执行 Markdown → Word 转换:', cmd);

  // 2026-08-17: filegen 插桩——转换任务开始
  let fgTaskId = null;
  try {
    // 2026-08-17: ensureFileGenTask——写作流程中复用活跃任务推进④文档生成；
    // 无活跃任务（直接转格式）则新建。不再每次 newTaskId 顶掉流程任务。
    fgTaskId = filegen.ensureFileGenTask({
      title: outputPath.split(/[/\\]/).pop(),
      format: 'docx',
      phase: 'converting',
      label: '正在转换为 Word…',
    });
  } catch (fgErr) {
    console.error('[filegen] MarkdownToWord 插桩失败(不阻塞):', fgErr.message);
  }

  try {
    // eslint-disable-next-line no-unused-vars
    const { stdout, stderr } = await execAsync(cmd, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000
    });

    if (stderr && !stderr.includes('✅')) {
      console.warn('Markdown to Word 警告:', stderr);
    }

    const stats = await fs.stat(outputPath);

    // 2026-08-17: filegen 插桩——转换完成
    if (fgTaskId) {
      try {
        filegen.doneFileGen(fgTaskId, {
          path: outputPath,
          name: outputPath.split(/[/\\]/).pop(),
          size: stats.size,
          format: 'docx',
          url: null,
        });
      } catch (fgErr) {
        console.error('[filegen] MarkdownToWord 插桩失败(不阻塞):', fgErr.message);
      }
    }

    const result = {
      success: true,
      input_path,
      output_path: outputPath,
      size: stats.size,
      style: style || '商务报告',
      message: `Word 文档已生成${style ? '（模板: ' + style + '）' : ''}`
    };

    if (send_to_wecom) {
      try {
        const { getMediaNotifier } = require('../core/file-notifier');
        const notifyResults = await getMediaNotifier().notify({
          mediaType: 'docx',
          filePath: outputPath,
          name: outputPath.split(/[/\\]/).pop(),
          size: stats.size,
          // SP3: 按会话发起人定向投递（有值时优先于默认用户链）
          chatId: wecom_user_id || '',
        });
        const wecomResult = notifyResults.find(r => r.channel === 'wecom');
        if (wecomResult) {
          result.wecom_sent = wecomResult.success;
          if (wecomResult.success) {
            result.message += '，已发送到企业微信';
          } else {
            result.message += `，企业微信发送失败: ${wecomResult.error}`;
          }
        }
        const larkResult = notifyResults.find(r => r.channel === 'lark');
        if (larkResult) {
          result.lark_sent = larkResult.success;
          if (larkResult.success) {
            result.message += '，已发送到飞书';
          }
        }
      } catch (notifyErr) {
        console.warn('⚠️ FileNotifier通知失败，回退到直接发送:', notifyErr.message);
        let wecomChatId = '';
        try {
          const configPath = path.join(getDataDir(), 'config.json');
          if (fsSync.existsSync(configPath)) {
            const appConfig = JSON.parse(fsSync.readFileSync(configPath, 'utf-8'));
            wecomChatId = appConfig.wecom?.defaultChatId || appConfig.wecom?.defaultUserId || '';
          }
        } catch (e) { console.warn('读取企微配置失败:', e.message) }
        if (!wecomChatId) {
          try {
            const userConfigPath = path.join(getDataDir(), 'config', 'user.json');
            if (fsSync.existsSync(userConfigPath)) {
              const userConfig = JSON.parse(fsSync.readFileSync(userConfigPath, 'utf-8'));
              wecomChatId = userConfig.wecomUserId || '';
            }
          } catch (e) { console.warn('读取用户配置失败:', e.message) }
        }
        if (!wecomChatId && wecom_user_id) {
          wecomChatId = wecom_user_id;
        }
        if (wecomChatId) {
          const wecomResult = await sendFileToWecom(outputPath, wecomChatId);
          result.wecom_sent = wecomResult.success;
          if (wecomResult.success) {
            result.message += '，已发送到企业微信';
          } else {
            result.message += `，企业微信发送失败: ${wecomResult.error}`;
          }
        }
      }
    }

    return result;
  } catch (error) {
    console.error('Markdown to Word 失败:', error.message);
    // 2026-08-17: filegen 插桩——转换失败（自身失败不阻塞/不掩盖原始错误）
    if (fgTaskId) {
      try {
        filegen.failFileGen(fgTaskId, error.message);
      } catch (fgErr) {
        console.error('[filegen] MarkdownToWord 插桩失败(不阻塞):', fgErr.message);
      }
    }
    throw new Error(`Markdown to Word 转换失败: ${error.message}`);
  }
}

async function sendFileToWecom(filePath, userId) {
  const http = require('http');
  const fsSync = require('fs');
  const resolvedPath = path.resolve(filePath);

  if (!fsSync.existsSync(resolvedPath)) {
    return { success: false, error: `文件不存在: ${resolvedPath}` };
  }

  const stats = fsSync.statSync(resolvedPath);
  if (stats.size > 50 * 1024 * 1024) {
    return { success: false, error: `文件过大: ${(stats.size / 1024 / 1024).toFixed(1)}MB，企业微信限制 50MB` };
  }

  const WECOM_SEND_PORT_PATH = path.join(getDataDir(), '.wecom_send_port');
  let portFileValue = null;
  try {
    if (fsSync.existsSync(WECOM_SEND_PORT_PATH)) {
      portFileValue = fsSync.readFileSync(WECOM_SEND_PORT_PATH, 'utf-8').trim();
    }
  } catch (e) { console.warn('读取企微发送端口失败:', e.message) }
  // SP3: 统一端口解析 env > 端口文件 > 38769（与 wecom channel 同源）
  const sendPort = require('../channels/wecom/index').resolveWecomSendPort(process.env, portFileValue);

  // SP3: 本地发送服务强制鉴权——X-Api-Key 取自 data/.crabpaw/.api_token
  let apiToken = '';
  try {
    const tokenPath = path.join(getDataDir(), '.api_token');
    if (fsSync.existsSync(tokenPath)) {
      apiToken = fsSync.readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch (e) { console.warn('读取企微 API token 失败:', e.message) }

  const chatId = userId || '';

  const postData = JSON.stringify({
    chat_id: chatId,
    file_path: resolvedPath,
    chat_type: 'single'
  });

  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: sendPort,
      path: '/wecom/send-file',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...(apiToken ? { 'X-Api-Key': apiToken } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result);
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    });

    req.on('error', (e) => {
      console.error('❌ 发送文件到企业微信失败:', e.message);
      resolve({ success: false, error: e.message });
    });

    req.write(postData);
    req.end();
  });
}

async function handleSendWecomFile(params, _context) {
  const { file_path, user_id, chat_id } = params;

  let chatId = '';
  try {
    const configPath = path.join(getDataDir(), 'config.json');
    if (fsSync.existsSync(configPath)) {
      const appConfig = JSON.parse(fsSync.readFileSync(configPath, 'utf-8'));
      chatId = appConfig.wecom?.defaultChatId || appConfig.wecom?.defaultUserId || '';
    }
  } catch (e) { console.warn('读取企微配置失败:', e.message) }
  if (!chatId) {
    try {
      const userConfigPath = path.join(getDataDir(), 'config', 'user.json');
      if (fsSync.existsSync(userConfigPath)) {
        const userConfig = JSON.parse(fsSync.readFileSync(userConfigPath, 'utf-8'));
        chatId = userConfig.wecomUserId || '';
      }
    } catch (e) { console.warn('读取用户配置失败:', e.message) }
  }
  if (!chatId) {
    chatId = user_id || chat_id || '';
  }
  if (!chatId) {
    throw new Error('未配置企微接收人：请在 设置→用户信息 填写"企微用户 ID"保存后重试，或在本次调用中显式传入 user_id/chat_id');
  }

  if (!file_path) {
    throw new Error('file_path 是必填参数');
  }

  const resolvedPath = path.resolve(file_path);
  if (!fsSync.existsSync(resolvedPath)) {
    throw new Error(`文件不存在: ${resolvedPath}`);
  }

  // 发布 S-2b 安全(2026-09-07 扩展): 与 wecom 代理层共用同一白名单判定——
  // 允许 DATA_DIR/uploads 与 data/workspace 产物目录；config/.env/密钥等
  // 敏感文件无论位于何处一律拒绝（isSensitivePath 黑名单）。
  const { isAllowedSendPath } = require('../core/upload-path');
  if (!isAllowedSendPath(resolvedPath, getDataDir())) {
    throw new Error(`安全限制：只允许发送 uploads 与 data/workspace 产物目录内的文件。当前路径: ${resolvedPath}`);
  }

  const result = await sendFileToWecom(resolvedPath, chatId);

  if (!result.success) {
    throw new Error(`发送文件到企业微信失败: ${result.error}`);
  }

  return {
    success: true,
    file_path: resolvedPath,
    media_id: result.media_id || null,
    message: '文件已发送到企业微信'
  };
}

registry.register({
  name: 'Read',
  toolset: 'file',
  category: 'filesystem',
  description: '读取文件内容',
  schema: {
    description: '读取本地文件系统的文件内容',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' },
        // 2026-08-22 实机修复: path/filePath 别名——与 DocRead 同型契约漂移
        // （deepseek 混用 {"path":...} 与 {"filePath":...}），checkFn 只认 file_path
        // → 「工具参数检查失败: Read」连续失败 → 模型被迫换 ShellExec 中文路径卡死
        // （用户 GUI 实测 18:43 Read / 19:20 Write 两轮实锤）
        path: { type: 'string', description: '文件的绝对路径（别名；与 file_path 任选其一）' },
        filePath: { type: 'string', description: '文件的绝对路径（兼容别名；与 file_path 任选其一）' },
        offset: { type: 'integer', description: '起始行号' },
        limit: { type: 'integer', description: '读取行数' }
      },
      required: ['file_path']
    }
  },
  handler: handleRead,
  checkFn: (params) => (params.file_path || params.path || params.filePath) && typeof (params.file_path || params.path || params.filePath) === 'string',
  timeout: 30000,
  isReadOnly: true
});

registry.register({
  name: 'Write',
  toolset: 'file',
  category: 'filesystem',
  description: '写入文件内容（生成类产物——网页/文档——请写入 data/workspace/ 目录，文件生成面板可实时预览；工具类脚本可写在项目其他位置）',
  schema: {
    description: '写入文件到本地文件系统',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径（网页/文档类产物建议 data/workspace/ 目录，可面板内预览）' },
        path: { type: 'string', description: '文件的绝对路径（别名；网页/文档类产物建议 data/workspace/ 目录，可面板内预览）' },
        filePath: { type: 'string', description: '文件的绝对路径（兼容别名；网页/文档类产物建议 data/workspace/ 目录，可面板内预览）' },
        content: { type: 'string', description: '要写入的内容' }
      },
      required: ['content']
    }
  },
  handler: handleWrite,
  checkFn: (params) => (params.file_path || params.path || params.filePath) && params.content !== undefined,
  timeout: 30000,
  isDangerous: true,
  selfApproval: true,
  isReadOnly: false
});

registry.register({
  name: 'Edit',
  toolset: 'file',
  category: 'filesystem',
  description: '编辑文件内容',
  schema: {
    description: '通过字符串替换编辑文件内容，支持模糊匹配',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件的绝对路径' },
        // 2026-08-22 实机修复: path/filePath 别名（同 Read——checkFn 曾只认 file_path）
        path: { type: 'string', description: '文件的绝对路径（别名；与 file_path 任选其一）' },
        filePath: { type: 'string', description: '文件的绝对路径（兼容别名；与 file_path 任选其一）' },
        old_string: { type: 'string', description: '要查找的文本' },
        new_string: { type: 'string', description: '替换后的文本' },
        fuzzy: { type: 'boolean', description: '精确匹配失败时启用模糊匹配（忽略空白/缩进差异）' }
      },
      required: ['file_path', 'old_string', 'new_string']
    }
  },
  handler: handleEdit,
  checkFn: (params) => (params.file_path || params.path || params.filePath) && params.old_string,
  timeout: 30000,
  isDangerous: true,
  selfApproval: true,
  isReadOnly: false
});

registry.register({
  name: 'Glob',
  toolset: 'file',
  category: 'filesystem',
  description: '按模式查找文件',
  schema: {
    description: '使用 glob 模式查找文件',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式 (如 *.js, **/*.ts)' },
        path: { type: 'string', description: '搜索目录' }
      },
      required: ['pattern']
    }
  },
  handler: handleGlob,
  checkFn: (params) => params.pattern,
  timeout: 60000,
  isReadOnly: true
});

registry.register({
  name: 'Grep',
  toolset: 'file',
  category: 'filesystem',
  description: '搜索文件内容',
  schema: {
    description: '使用正则表达式搜索文件内容',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式模式' },
        path: { type: 'string', description: '搜索路径' },
        glob: { type: 'string', description: '文件过滤模式' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        '-i': { type: 'boolean', description: '忽略大小写' },
        '-n': { type: 'boolean', description: '显示行号' },
        '-C': { type: 'integer', description: '上下文行数' }
      },
      required: ['pattern']
    }
  },
  handler: handleGrep,
  checkFn: (params) => params.pattern,
  timeout: 60000,
  isReadOnly: true
});

registry.register({
  name: 'LS',
  toolset: 'file',
  category: 'filesystem',
  description: '列出目录内容',
  schema: {
    description: '列出目录中的文件和子目录',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' },
        ignore: { type: 'array', items: { type: 'string' }, description: '忽略模式' }
      }
    }
  },
  handler: handleLS,
  checkFn: () => true,
  timeout: 30000,
  isReadOnly: true
});

registry.register({
  name: 'DeleteFile',
  toolset: 'file',
  category: 'filesystem',
  description: '删除文件',
  schema: {
    description: '删除指定的文件',
    parameters: {
      type: 'object',
      properties: {
        file_paths: { type: 'array', items: { type: 'string' }, description: '要删除的文件路径列表' }
      },
      required: ['file_paths']
    }
  },
  handler: handleDeleteFile,
  checkFn: (params) => Array.isArray(params.file_paths) && params.file_paths.length > 0,
  timeout: 30000,
  isDangerous: true,
  selfApproval: true,
  isReadOnly: false
});

registry.register({
  name: 'CreateDirectory',
  toolset: 'file',
  category: 'filesystem',
  description: '创建目录',
  schema: {
    description: '创建目录（包括父目录）',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径' }
      },
      required: ['path']
    }
  },
  handler: handleCreateDirectory,
  checkFn: (params) => params.path,
  timeout: 30000,
  isReadOnly: false
});

registry.register({
  name: 'MarkdownToWord',
  toolset: 'file',
  category: 'document',
  description: '将 Markdown 文件转换为 Word 文档，支持专业排版美化，可选发送到企业微信',
  schema: {
    description: '将 Markdown 文件转换为 Word (.docx) 文档。支持标题、列表、表格、代码块、引用等格式，内置专业排版模板。可同时发送到企业微信。',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string', description: 'Markdown 文件的绝对路径' },
        output_path: { type: 'string', description: '输出的 Word 文件路径（可选，默认与输入同目录）' },
        title: { type: 'string', description: '文档标题（可选）' },
        style: { type: 'string', enum: ['商务报告', '中国公文', '学术论文', '简约现代'], description: '美化模板（可选，默认「商务报告」）。商务报告=深蓝标题+微软雅黑；中国公文=红头文件格式；学术论文=宋体+标准行距；简约现代=Arial+宽松间距' },
        author: { type: 'string', description: '文档作者（可选）' },
        send_to_wecom: { type: 'boolean', description: '是否将生成的 Word 文件发送到企业微信（默认 false）。如未指定 wecom_user_id，将自动从配置中读取' },
        wecom_user_id: { type: 'string', description: '企业微信用户 ID（可选，未指定时自动从配置中读取）' }
      },
      required: ['input_path']
    }
  },
  handler: handleMarkdownToWord,
  checkFn: (params) => params.input_path,
  timeout: 120000,
  isReadOnly: false
});

registry.register({
  name: 'SendWecomFile',
  toolset: 'file',
  category: 'communication',
  description: '发送文件到企业微信',
  schema: {
    description: '将本地文件发送到企业微信。支持 Word、PDF、Excel 等各类文件，文件大小不超过 50MB。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要发送的文件的绝对路径' },
        user_id: { type: 'string', description: '企业微信用户 ID（接收者）' },
        chat_id: { type: 'string', description: '企业微信会话 ID（与 user_id 二选一）' }
      },
      required: ['file_path']
    }
  },
  handler: handleSendWecomFile,
  checkFn: (params) => params.file_path,
  timeout: 60000,
  isReadOnly: false
});

// ============================================================
// SendLarkFile — 发送本地文件到飞书（2026-09-06，对齐 SendWecomFile；
// 上传走 im/v1/files，filegen 生成的本地文档可直发飞书）
// ============================================================
let _larkFileChannel = null;
async function handleSendLarkFile(params) {
  if (!params.file_path) return { success: false, error: '缺少 file_path' };
  const filePath = path.resolve(params.file_path);
  if (!fsSync.existsSync(filePath)) return { success: false, error: `文件不存在: ${filePath}` };

  try {
    // channel 内部 _getCreds 每次直读磁盘（config.json + .api_keys.json），与主服务同源
    if (!_larkFileChannel) {
      _larkFileChannel = require('../channels/lark').createChannel({ lark: {} });
    }
    // 接收者优先级: 显式指定 > 用户配置 larkUserId > 最近一次飞书来消息的发送者
    let receiveId = params.receive_id || '';
    if (!receiveId) {
      try {
        const cfgDir = process.env.CRABPAW_DATA_DIR || getDataDir();
        const userPath = path.join(cfgDir, 'config', 'user.json');
        if (fsSync.existsSync(userPath)) {
          receiveId = JSON.parse(fsSync.readFileSync(userPath, 'utf-8')).larkUserId || '';
        }
      } catch (e) { console.warn('[SendLarkFile] 读取用户配置失败:', e.message); }
    }
    if (!receiveId) {
      try { receiveId = require('../cli/request-handler').getLastLarkSenderId() || ''; } catch (e) { /* 可选依赖 */ }
    }
    if (!receiveId) return { success: false, error: '缺少 receive_id（且无法从用户配置/最近消息推断）' };

    await _larkFileChannel.sendFile(receiveId, filePath);
    return { success: true, content: `文件已发送到飞书: ${path.basename(filePath)}` };
  } catch (e) {
    console.error('❌ 发送文件到飞书失败:', e.message);
    return { success: false, error: e.message || '飞书文件发送失败' };
  }
}

registry.register({
  name: 'SendLarkFile',
  toolset: 'file',
  category: 'communication',
  description: '发送本地文件到飞书（自动上传 im/v1/files 后发送）。支持 Word/PDF/Excel/图片/音视频等，文件不超过 30MB。receive_id 缺省时发给用户配置的 larkUserId 或最近一次飞书来消息的用户。',
  schema: {
    description: '将本地文件发送到飞书。文件大小不超过 30MB。',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '要发送的文件的绝对路径' },
        receive_id: { type: 'string', description: '飞书接收者 open_id（可选；缺省自动推断）' }
      },
      required: ['file_path']
    }
  },
  handler: handleSendLarkFile,
  checkFn: (params) => params.file_path,
  timeout: 120000,
  isReadOnly: false
});

console.log('📁 文件工具集已注册:', registry.getByToolset('file').map(t => t.name).join(', '));

// ============================================================
// MarkdownToExcel — 将 Markdown 文件转为 Excel（含格式化）
// ============================================================

// 2026-09-06: 解析单一事实源——两个解析器抽取至 src/core/markdown-slides.js
// （前端载体视图经 filegen:doc-structure 渲染同一份结构，消除预览/产物漂移）。
// 此处保留原名别名，转换工具调用点零改动。
const _parseMarkdownTables = require('../core/markdown-slides').parseMarkdownTables;
const _parseMarkdownToSlides = require('../core/markdown-slides').parseMarkdownToSlides;

async function handleMarkdownToExcel(params, _context) {
  const { input_path, output_path, title, colorScheme } = params;

  if (!input_path) {
    throw new Error('input_path is required');
  }

  const inputExt = path.extname(input_path).toLowerCase();
  if (inputExt !== '.md') {
    throw new Error('Input file must be a Markdown file (.md)');
  }

  let outputPath = output_path;
  if (!outputPath) {
    outputPath = input_path.replace(/\.md$/i, '.xlsx');
  }
  // 2026-08-28 M1: outputPath 过权限门
  assertGeneratorOutputAllowed(outputPath);

  // 2026-08-17: filegen 插桩——转换任务开始
  let fgTaskId = null;
  try {
    // 2026-08-17: ensureFileGenTask——写作流程中复用活跃任务推进④文档生成
    fgTaskId = filegen.ensureFileGenTask({
      title: outputPath.split(/[/\\]/).pop(),
      format: 'xlsx',
      phase: 'converting',
      label: '正在转换为 Excel…',
    });
  } catch (fgErr) {
    console.error('[filegen] MarkdownToExcel 插桩失败(不阻塞):', fgErr.message);
  }

  try {
    const mdContent = await fs.readFile(input_path, 'utf-8');
    const tables = _parseMarkdownTables(mdContent);

    if (tables.length === 0) {
      throw new Error('未在 Markdown 文件中找到任何表格');
    }

    // Detect numeric columns for formatting
    const sheets = tables.map((table, idx) => {
      const columnFormats = {};
      table.headers.forEach((header, colIdx) => {
        const values = table.rows.map(r => r[colIdx] || '');
        const numCount = values.filter(v => v !== '' && v !== null
          && !isNaN(String(v).replace(/[,%¥$€£\s]/g, ''))
          && String(v).trim() !== '').length;
        if (numCount >= values.length * 0.7) {
          // Determine if currency, percent, or plain number
          const sample = values.filter(v => v !== '' && v !== null)[0] || '';
          const str = String(sample);
          if (str.includes('¥') || str.includes('$') || str.includes('€') || str.includes('£')) {
            columnFormats[header] = 'currency';
          } else if (str.includes('%')) {
            columnFormats[header] = 'percent';
          } else {
            columnFormats[header] = 'number';
          }
        }
      });

      return {
        name: (table.title || `Table${idx + 1}`).substring(0, 31),
        title: table.title || null,
        headers: table.headers,
        data: table.rows,
        columnFormats,
        totalRow: Object.keys(columnFormats).length > 0,
      };
    });

    // Import _generateXlsx from document-tools
    const { _generateXlsx } = require('./document-tools');
    const scheme = colorScheme || 'corporate';
    const buffer = await _generateXlsx({ sheets, colorScheme: scheme, title: title || tables[0]?.title });

    await fs.writeFile(outputPath, buffer);

    const stats = await fs.stat(outputPath);

    // 2026-08-17: filegen 插桩——转换完成
    if (fgTaskId) {
      try {
        filegen.doneFileGen(fgTaskId, {
          path: outputPath,
          name: outputPath.split(/[/\\]/).pop(),
          size: stats.size,
          format: 'xlsx',
          url: null,
        });
      } catch (fgErr) {
        console.error('[filegen] MarkdownToExcel 插桩失败(不阻塞):', fgErr.message);
      }
    }

    const result = {
      success: true,
      input_path,
      output_path: outputPath,
      size: stats.size,
      tables: tables.length,
      sheets: sheets.length,
      colorScheme: scheme,
      message: `Excel 文件已生成 (${tables.length} 个表格, ${sheets.length} 个工作表, 配色: ${scheme})`,
    };

    return result;
  } catch (error) {
    console.error('MarkdownToExcel 失败:', error.message);
    // 2026-08-17: filegen 插桩——转换失败（自身失败不阻塞/不掩盖原始错误）
    if (fgTaskId) {
      try {
        filegen.failFileGen(fgTaskId, error.message);
      } catch (fgErr) {
        console.error('[filegen] MarkdownToExcel 插桩失败(不阻塞):', fgErr.message);
      }
    }
    throw new Error(`MarkdownToExcel 转换失败: ${error.message}`);
  }
}

registry.register({
  name: 'MarkdownToExcel',
  toolset: 'file',
  category: 'document',
  description: 'Convert a Markdown file containing tables to a professionally formatted Excel (.xlsx) file with auto-detected number/currency formatting',
  schema: {
    description: '将包含表格的 Markdown 文件转换为专业格式的 Excel (.xlsx) 工作簿。自动识别数字/货币/百分比列并应用格式，支持多表格/多工作表。',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string', description: 'Markdown 文件的绝对路径（需包含表格）' },
        output_path: { type: 'string', description: '输出的 Excel 文件路径（可选，默认与输入同目录，.md→.xlsx）' },
        title: { type: 'string', description: '工作簿标题（可选）' },
        colorScheme: { type: 'string', enum: ['corporate', 'green', 'blue', 'red', 'purple', 'dark'], description: '配色方案（默认 corporate 深蓝商务风）' },
      },
      required: ['input_path'],
    },
  },
  handler: handleMarkdownToExcel,
  checkFn: (params) => params.input_path,
  timeout: 120000,
  isReadOnly: false,
});

// ============================================================
// MarkdownToPPT — 将 Markdown 文件转为 PowerPoint 演示文稿
// ============================================================

/**
 * 从 Markdown 内容解析幻灯片结构
 * 规则: # → 封面, ## → 内容页标题, - → 项目符号, | → 表格, --- → 分页
 */
// 2026-09-06: 兼容别名见文件顶部（原函数体已抽取至 src/core/markdown-slides.js）

async function handleMarkdownToPPT(params, _context) {
  // 2026-08-27 eslint 修复：该函数曾调 sanitizeFilename 而无导入(no-undef)——与 230 行同款局部 require。
  const { sanitizeFilename } = require('../core/filename-utils');
  // 2026-08-23 别名兼容：deepseek 实机直接传 markdownContent 文本（无文件路径）→ 原契约只认 input_path 拒
  const { input_path, output_path, title, style, markdownContent } = params;
  const hasInline = typeof markdownContent === 'string' && markdownContent.trim().length > 0;

  if (!input_path && !hasInline) {
    throw new Error('input_path or markdownContent is required');
  }

  let mdContent = null;
  let outputPath = output_path;
  if (hasInline) {
    // 内联文本模式：直接使用 markdown 内容，产物落到 workspace/documents
    mdContent = markdownContent;
    if (!outputPath) {
      const workspaceDir = getDocumentArtifactsDir();
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
      const firstHeading = (markdownContent.match(/^#\s+(.+)$/m) || [])[1] || 'presentation';
      const safeName = sanitizeFilename(firstHeading, 'presentation');
      outputPath = path.join(workspaceDir, `${safeName}_${Date.now()}.pptx`);
    }
  } else {
    const inputExt = path.extname(input_path).toLowerCase();
    if (inputExt !== '.md') {
      throw new Error('Input file must be a Markdown file (.md)');
    }
    if (!outputPath) {
      outputPath = input_path.replace(/\.md$/i, '.pptx');
    }
  }
  // 2026-08-28 M1: outputPath 过权限门（内联/文件两分支解析完统一过门）
  assertGeneratorOutputAllowed(outputPath);

  // 2026-08-17: filegen 插桩——转换任务开始
  let fgTaskId = null;
  try {
    // 2026-08-17: ensureFileGenTask——写作流程中复用活跃任务推进④文档生成
    fgTaskId = filegen.ensureFileGenTask({
      title: outputPath.split(/[/\\]/).pop(),
      format: 'pptx',
      phase: 'converting',
      label: '正在转换为 PPT…',
    });
  } catch (fgErr) {
    console.error('[filegen] MarkdownToPPT 插桩失败(不阻塞):', fgErr.message);
  }

  try {
    if (mdContent === null) {
      mdContent = await fs.readFile(input_path, 'utf-8');
    }
    const slides = _parseMarkdownToSlides(mdContent);

    if (slides.length === 0) {
      throw new Error('未能从 Markdown 文件中解析出幻灯片结构');
    }

    // Import _generatePptx from document-tools
    const { _generatePptx } = require('./document-tools');
    const scheme = style || 'business_blue';
    const buffer = await _generatePptx({ slides, style: scheme, title: title || slides[0]?.title });

    await fs.writeFile(outputPath, buffer);
    const stats = await fs.stat(outputPath);

    // 2026-08-17: filegen 插桩——转换完成
    if (fgTaskId) {
      try {
        filegen.doneFileGen(fgTaskId, {
          path: outputPath,
          name: outputPath.split(/[/\\]/).pop(),
          size: stats.size,
          format: 'pptx',
          url: null,
        });
      } catch (fgErr) {
        console.error('[filegen] MarkdownToPPT 插桩失败(不阻塞):', fgErr.message);
      }
    }

    return {
      success: true,
      input_path,
      output_path: outputPath,
      size: stats.size,
      slides: slides.length,
      style: scheme,
      message: `PPT 已生成 (${slides.length} 页, 配色: ${scheme})`,
    };
  } catch (error) {
    console.error('MarkdownToPPT 失败:', error.message);
    // 2026-08-17: filegen 插桩——转换失败（自身失败不阻塞/不掩盖原始错误）
    if (fgTaskId) {
      try {
        filegen.failFileGen(fgTaskId, error.message);
      } catch (fgErr) {
        console.error('[filegen] MarkdownToPPT 插桩失败(不阻塞):', fgErr.message);
      }
    }
    throw new Error(`MarkdownToPPT 转换失败: ${error.message}`);
  }
}

registry.register({
  name: 'MarkdownToPPT',
  toolset: 'file',
  category: 'document',
  description: 'Convert a Markdown file to a professionally formatted PowerPoint (.pptx) presentation. Headings become slides, bullets become bullet points, tables become table slides.',
  schema: {
    description: '将 Markdown 文件转换为专业格式的 PowerPoint (.pptx) 演示文稿。# 标题→封面页，## 标题→内容页，- 列表→项目符号，| 表格→表格页。',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string', description: 'Markdown 文件的绝对路径' },
        // 2026-08-23 别名兼容：deepseek 实机直接传 markdownContent 文本 → 新增内联入口（与 input_path 二选一）
        markdownContent: { type: 'string', description: 'Markdown 文本内容（与 input_path 二选一；提供时无需文件，产物自动保存到 workspace/documents）' },
        output_path: { type: 'string', description: '输出的 PPT 文件路径（可选，默认与输入同目录，.md→.pptx）' },
        title: { type: 'string', description: '演示文稿标题（可选，默认使用第一个 # 标题）' },
        style: { type: 'string', enum: ['business_blue', 'academic_white', 'creative_purple', 'tech_dark', 'minimal_gray'], description: '配色方案（默认 business_blue 商务蓝）' },
      },
      required: [],
    },
  },
  handler: handleMarkdownToPPT,
  checkFn: (params) => !!(params.input_path || (typeof params.markdownContent === 'string' && params.markdownContent.trim())),
  timeout: 120000,
  isReadOnly: false,
});

// ============================================================
// MarkdownToPDF — 将 Markdown 文件转为格式化 PDF（Playwright 渲染）
// ============================================================

/**
 * 将 Markdown 转换为 HTML（基础转换，用于 PDF 渲染）
 */
function _mdToHtml(mdContent) {
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
    if (inTable) { html += '<table>' + tableHtml + '</table>\n'; inTable = false; tableHtml = ''; }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code block
    if (trimmed.startsWith('```')) {
      closeList(); closeTable();
      inCodeBlock = !inCodeBlock;
      if (inCodeBlock) { html += '<pre>'; }
      else { html += '</pre>\n'; }
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
      tableHtml += '<tr>' + cells.map(c => isFirst ? `<th>${c}</th>` : `<td>${c}</td>`).join('') + '</tr>';
      continue;
    } else if (inTable) { closeTable(); }

    // Headings
    const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      closeList();
      const level = hMatch[1].length;
      const text = hMatch[2];
      html += `<h${level}>${text}</h${level}>\n`;
      continue;
    }

    // HR
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(trimmed)) {
      closeList();
      html += '<hr>\n';
      continue;
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

    // Bold standalone line (section divider)
    const boldLine = trimmed.match(/^\*\*(.+)\*\*\s*$/);
    if (boldLine) {
      closeList();
      html += `<h4>${boldLine[1]}</h4>\n`;
      continue;
    }

    // Empty line
    if (trimmed === '') { closeList(); html += '\n'; continue; }

    // Regular paragraph
    closeList();
    html += `<p>${_inlineMdToHtml(trimmed)}</p>\n`;
  }

  closeList();
  closeTable();
  if (inCodeBlock) html += '</pre>\n';
  return html;
}

function _inlineMdToHtml(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function _escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleMarkdownToPDF(params, _context) {
  const { input_path, output_path, title, style, author } = params;

  if (!input_path) {
    throw new Error('input_path is required');
  }

  const inputExt = path.extname(input_path).toLowerCase();
  if (inputExt !== '.md') {
    throw new Error('Input file must be a Markdown file (.md)');
  }

  let outputPath = output_path;
  if (!outputPath) {
    outputPath = input_path.replace(/\.md$/i, '.pdf');
  }
  // 2026-08-28 M1: outputPath 过权限门
  assertGeneratorOutputAllowed(outputPath);

  // 2026-08-17: filegen 插桩——转换任务开始
  let fgTaskId = null;
  try {
    // 2026-08-17: ensureFileGenTask——写作流程中复用活跃任务推进④文档生成
    fgTaskId = filegen.ensureFileGenTask({
      title: outputPath.split(/[/\\]/).pop(),
      format: 'pdf',
      phase: 'converting',
      label: '正在转换为 PDF…',
    });
  } catch (fgErr) {
    console.error('[filegen] MarkdownToPDF 插桩失败(不阻塞):', fgErr.message);
  }

  try {
    const mdContent = await fs.readFile(input_path, 'utf-8');
    const htmlContent = _mdToHtml(mdContent);

    if (!htmlContent.trim()) {
      throw new Error('未能从 Markdown 文件中提取内容');
    }

    const { _generatePdf } = require('./document-tools');
    const scheme = style || '商务报告';
    const buffer = await _generatePdf(htmlContent, { style: scheme, title: title, author: author });

    await fs.writeFile(outputPath, buffer);
    const stats = await fs.stat(outputPath);

    // 2026-08-17: filegen 插桩——转换完成
    if (fgTaskId) {
      try {
        filegen.doneFileGen(fgTaskId, {
          path: outputPath,
          name: outputPath.split(/[/\\]/).pop(),
          size: stats.size,
          format: 'pdf',
          url: null,
        });
      } catch (fgErr) {
        console.error('[filegen] MarkdownToPDF 插桩失败(不阻塞):', fgErr.message);
      }
    }

    return {
      success: true,
      input_path,
      output_path: outputPath,
      size: stats.size,
      style: scheme,
      message: `PDF 已生成 (${(stats.size / 1024).toFixed(1)} KB, 模板: ${scheme})`,
    };
  } catch (error) {
    console.error('MarkdownToPDF 失败:', error.message);
    // 2026-08-17: filegen 插桩——转换失败（自身失败不阻塞/不掩盖原始错误）
    if (fgTaskId) {
      try {
        filegen.failFileGen(fgTaskId, error.message);
      } catch (fgErr) {
        console.error('[filegen] MarkdownToPDF 插桩失败(不阻塞):', fgErr.message);
      }
    }
    throw new Error(`MarkdownToPDF 转换失败: ${error.message}`);
  }
}

registry.register({
  name: 'MarkdownToPDF',
  toolset: 'file',
  category: 'document',
  description: 'Convert a Markdown file to a professionally formatted PDF document with CSS-styled rendering via Playwright. Supports 4 style presets.',
  schema: {
    description: '将 Markdown 文件转换为专业排版的 PDF 文档。使用 Playwright 渲染 HTML+CSS，支持封面页、页码、4 种模板。',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string', description: 'Markdown 文件的绝对路径' },
        output_path: { type: 'string', description: '输出的 PDF 文件路径（可选，默认与输入同目录，.md→.pdf）' },
        title: { type: 'string', description: '文档标题（显示在封面页）' },
        style: { type: 'string', enum: ['商务报告', '中国公文', '学术论文', '简约现代'], description: '美化模板（默认 商务报告）' },
        author: { type: 'string', description: '文档作者（元数据）' },
      },
      required: ['input_path'],
    },
  },
  handler: handleMarkdownToPDF,
  checkFn: (params) => params.input_path,
  timeout: 120000,
  isReadOnly: false,
});

// ============================================================
// MarkdownToHTML — 将 Markdown 文件转为美化 HTML 网页
// ============================================================

async function handleMarkdownToHTML(params, _context) {
  const { input_path, output_path, title, style } = params;

  if (!input_path) {
    throw new Error('input_path is required');
  }

  const inputExt = path.extname(input_path).toLowerCase();
  if (inputExt !== '.md') {
    throw new Error('Input file must be a Markdown file (.md)');
  }

  // 2026-08-08 fix: 默认输出到 DATA_DIR/web-preview(而非输入文件同目录)——
  // 前端 web-preview 卡 iframe 只能通过 local:// 自定义协议加载
  // (file:// 被 webSecurity 硬性禁止, local:// 仅放行 DATA_DIR 内文件),
  // 生成在仓库根等任意目录的 HTML 卡片永远"预览加载失败"。
  let outputPath = output_path;
  if (!outputPath) {
    const previewDir = path.join(getDataDir(), 'web-preview');
    await fs.mkdir(previewDir, { recursive: true });
    outputPath = path.join(previewDir, path.basename(input_path).replace(/\.md$/i, '.html'));
  }
  // 2026-08-28 M1: outputPath 过权限门
  assertGeneratorOutputAllowed(outputPath);

  // 2026-08-17: filegen 插桩——转换任务开始
  let fgTaskId = null;
  try {
    // 2026-08-17: ensureFileGenTask——写作流程中复用活跃任务推进④文档生成
    fgTaskId = filegen.ensureFileGenTask({
      title: outputPath.split(/[/\\]/).pop(),
      format: 'html',
      phase: 'converting',
      label: '正在转换为网页…',
    });
  } catch (fgErr) {
    console.error('[filegen] MarkdownToHTML 插桩失败(不阻塞):', fgErr.message);
  }

  try {
    const mdContent = await fs.readFile(input_path, 'utf-8');
    const scheme = style || '商务报告';

    const { MarkdownRenderer } = require('../core/markdown-renderer');
    const renderer = new MarkdownRenderer();
    const html = renderer.render(mdContent, { style: scheme, title: title });

    await fs.writeFile(outputPath, html, 'utf-8');
    const stats = await fs.stat(outputPath);

    // 2026-08-17: filegen 插桩——转换完成
    if (fgTaskId) {
      try {
        filegen.doneFileGen(fgTaskId, {
          path: outputPath,
          name: outputPath.split(/[/\\]/).pop(),
          size: stats.size,
          format: 'html',
          // 2026-08-17 fix: 此前硬编码 null → html 开发模式 iframe 预览永不出现。
          // previewUrlFor 仅对 DATA_DIR 内 md/html 产出 local:// 地址（口径同 Write/Edit）
          url: filegen.previewUrlFor('html', outputPath),
        });
      } catch (fgErr) {
        console.error('[filegen] MarkdownToHTML 插桩失败(不阻塞):', fgErr.message);
      }
    }

    // 2026-08-17: web-preview 中央卡推送已移除——FileGenPanel 面板内 html
    // 开发模式分屏（左侧代码流 + 右侧 iframe 实时预览）承担预览职责, 不再
    // 弹中央全息卡破坏组合布局（用户实锤: 生成完成后面板退场 + 中央卡弹出）。
    // 预览 url 由 filegen:done 携带（previewUrlFor local:// 口径, 见上方插桩）。

    return {
      success: true,
      input_path,
      output_path: outputPath,
      size: stats.size,
      style: scheme,
      message: `HTML 网页已生成 (${(stats.size / 1024).toFixed(1)} KB, 模板: ${scheme})`,
    };
  } catch (error) {
    console.error('MarkdownToHTML 失败:', error.message);
    // 2026-08-17: filegen 插桩——转换失败（自身失败不阻塞/不掩盖原始错误）
    if (fgTaskId) {
      try {
        filegen.failFileGen(fgTaskId, error.message);
      } catch (fgErr) {
        console.error('[filegen] MarkdownToHTML 插桩失败(不阻塞):', fgErr.message);
      }
    }
    throw new Error(`MarkdownToHTML 转换失败: ${error.message}`);
  }
}

registry.register({
  name: 'MarkdownToHTML',
  toolset: 'file',
  category: 'document',
  description: 'Convert a Markdown file to a beautifully styled HTML webpage with responsive design. Features 5 CSS templates.',
  schema: {
    description: '将 Markdown 文件转换为带 CSS 美化的响应式 HTML 网页。支持 5 种模板：商务报告/技术文档/博客文章/落地页/简约暗色。',
    parameters: {
      type: 'object',
      properties: {
        input_path: { type: 'string', description: 'Markdown 文件的绝对路径' },
        output_path: { type: 'string', description: '输出的 HTML 文件路径（可选，默认 .md→.html）' },
        title: { type: 'string', description: '网页标题（可选，默认使用第一个 # 标题）' },
        style: { type: 'string', enum: ['商务报告', '技术文档', '博客文章', '落地页', '简约暗色'], description: '网页模板（默认 商务报告）' },
      },
      required: ['input_path'],
    },
  },
  handler: handleMarkdownToHTML,
  checkFn: (params) => params.input_path,
  timeout: 120000,
  isReadOnly: false,
});

module.exports = {
  handleRead,
  handleWrite,
  handleEdit,
  handleGlob,
  handleGrep,
  handleLS,
  handleDeleteFile,
  handleCreateDirectory,
  handleMarkdownToWord,
  handleMarkdownToExcel,
  handleMarkdownToPPT,
  handleMarkdownToPDF,
  handleMarkdownToHTML,
  handleSendWecomFile,
  sendFileToWecom,
  isDangerousPath
};
