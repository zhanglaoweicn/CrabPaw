const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERENCE_PATTERN = /(?<![\w/])@(?:(?:file|folder|url):(?:["'][^"']+["']|\S+)|diff\b|staged\b)/g;

const QUOTED_VALUE_PATTERN = /^["'](.+)["']$/;

const MAX_FILE_SIZE = 512 * 1024;
const MAX_URL_CONTENT_SIZE = 256 * 1024;
const MAX_URL_FETCH_TIMEOUT = 15000;
const MAX_INJECTED_TOKENS = 20000;
const CHARS_PER_TOKEN = 4;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flv',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.pyc', '.pyo', '.class', '.o', '.obj',
  '.woff', '.woff2', '.ttf', '.eot',
  '.sqlite', '.db', '.lock',
]);

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.html', '.htm', '.css', '.scss', '.less', '.svg',
  '.xml', '.sql', '.r', '.lua', '.pl', '.ex', '.exs',
  '.dockerfile', '.makefile', '.cmake',
  '.gitignore', '.env', '.editorconfig', '.prettierrc', '.eslintrc',
  '.properties', '.gradle',
]);

class ContextReferenceResult {
  constructor(message, originalMessage, injectedTokens = 0, warnings = []) {
    this.message = message;
    this.originalMessage = originalMessage;
    this.injectedTokens = injectedTokens;
    this.warnings = warnings;
  }
}

function parseContextReferences(message) {
  const refs = [];
  let match;
  const pattern = new RegExp(REFERENCE_PATTERN.source, REFERENCE_PATTERN.flags);

  while ((match = pattern.exec(message)) !== null) {
    const full = match[0];
    const afterAt = full.slice(1);

    if (afterAt === 'diff' || afterAt === 'staged') {
      refs.push({ kind: afterAt, value: null, lineRange: null });
      continue;
    }

    const colonIdx = afterAt.indexOf(':');
    if (colonIdx < 0) continue;

    const kind = afterAt.slice(0, colonIdx);
    let rawValue = afterAt.slice(colonIdx + 1);

    if (!rawValue) continue;

    const quotedMatch = rawValue.match(QUOTED_VALUE_PATTERN);
    if (quotedMatch) {
      rawValue = quotedMatch[1];
    }

    let lineRange = null;
    const lineRangeMatch = rawValue.match(/^(.+):(\d+)(?:-(\d+))?$/);
    if (lineRangeMatch && kind === 'file') {
      rawValue = lineRangeMatch[1];
      const start = parseInt(lineRangeMatch[2], 10);
      const end = lineRangeMatch[3] ? parseInt(lineRangeMatch[3], 10) : start;
      lineRange = { start, end };
    }

    refs.push({ kind, value: rawValue, lineRange });
  }

  return refs;
}

function _isAllowedPath(filePath, allowedRoot) {
  const resolved = path.resolve(filePath);
  if (!allowedRoot) return true;
  const root = path.resolve(allowedRoot);
  return resolved.startsWith(root + path.sep) || resolved === root;
}

function _isBinaryFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function _isLikelyTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (BINARY_EXTENSIONS.has(ext)) return false;

  const basename = path.basename(filePath).toLowerCase();
  const textBasenames = [
    'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile',
    'vagrantfile', 'jenkinsfile', '.gitignore', '.env', '.editorconfig',
    'license', 'readme', 'changelog', 'authors', 'contributors',
    'cmakelists.txt', '.npmrc', '.yarnrc', '.babelrc', '.prettierrc',
  ];
  if (textBasenames.some(b => basename === b || basename.startsWith(b))) return true;

  return false;
}

function _estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const rest = text.length - chineseChars;
  return Math.ceil(chineseChars * 1.5 + rest / CHARS_PER_TOKEN);
}

function _truncateToTokenBudget(content, maxTokens) {
  const currentTokens = _estimateTokens(content);
  if (currentTokens <= maxTokens) return content;

  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN * 0.9);
  if (content.length <= maxChars) return content;

  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = Math.floor(maxChars * 0.25);
  return content.slice(0, headChars)
    + '\n\n... [内容已截断，原始大小: ' + content.length + ' 字符] ...\n\n'
    + content.slice(-tailChars);
}

function _readFileContent(filePath, lineRange, allowedRoot) {
  const resolved = path.resolve(filePath);

  if (!_isAllowedPath(resolved, allowedRoot)) {
    return { content: null, warning: `路径超出允许范围: ${filePath}` };
  }

  if (!fs.existsSync(resolved)) {
    return { content: null, warning: `文件不存在: ${filePath}` };
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { content: null, warning: `路径是目录而非文件: ${filePath}` };
  }

  if (stat.size > MAX_FILE_SIZE) {
    return { content: null, warning: `文件过大 (${(stat.size / 1024).toFixed(1)} KB，上限 ${MAX_FILE_SIZE / 1024} KB): ${filePath}` };
  }

  if (_isBinaryFile(resolved) && !_isLikelyTextFile(resolved)) {
    return { content: null, warning: `二进制文件，跳过: ${filePath}` };
  }

  try {
    let content = fs.readFileSync(resolved, 'utf-8');

    if (lineRange) {
      const lines = content.split('\n');
      const start = Math.max(1, lineRange.start) - 1;
      const end = Math.min(lines.length, lineRange.end);
      const selected = lines.slice(start, end);
      const lineNums = selected.map((line, i) => {
        const num = start + i + 1;
        return `${num.toString().padStart(4)} | ${line}`;
      });
      content = lineNums.join('\n');
    }

    return { content, warning: null };
  } catch (e) {
    return { content: null, warning: `读取文件失败: ${e.message}` };
  }
}

function _listFolderContents(folderPath, allowedRoot) {
  const resolved = path.resolve(folderPath);

  if (!_isAllowedPath(resolved, allowedRoot)) {
    return { content: null, warning: `路径超出允许范围: ${folderPath}` };
  }

  if (!fs.existsSync(resolved)) {
    return { content: null, warning: `目录不存在: ${folderPath}` };
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { content: null, warning: `路径是文件而非目录: ${folderPath}` };
  }

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const lines = [];
    lines.push(`📁 ${folderPath}/`);

    const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      lines.push(`  📁 ${d.name}/`);
    }
    for (const f of files) {
      const fPath = path.join(resolved, f.name);
      try {
        const fStat = fs.statSync(fPath);
        const size = fStat.size < 1024 ? `${fStat.size}B` : `${(fStat.size / 1024).toFixed(1)}KB`;
        lines.push(`  📄 ${f.name} (${size})`);
      } catch {
        lines.push(`  📄 ${f.name}`);
      }
    }

    lines.push(`  (${dirs.length} 目录, ${files.length} 文件)`);

    const contextFiles = ['.context.md', 'CONTEXT.md', '.context.txt', 'context.txt', '.clinerules', '.cursorrules', '.windsurfrules'];
    for (const cf of contextFiles) {
      const cfPath = path.join(resolved, cf);
      if (fs.existsSync(cfPath)) {
        try {
          const cfContent = fs.readFileSync(cfPath, 'utf-8');
          lines.push('');
          lines.push(`📄 ${cf}:`);
          lines.push(cfContent.slice(0, 2000));
          if (cfContent.length > 2000) lines.push('... [截断]');
        } catch { console.warn('[context-references] 读取上下文规则文件失败'); }
      }
    }

    return { content: lines.join('\n'), warning: null };
  } catch (e) {
    return { content: null, warning: `列出目录失败: ${e.message}` };
  }
}

function _fetchUrlSync(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => {
      reject(new Error('URL 抓取超时'));
    }, MAX_URL_FETCH_TIMEOUT);

    protocol.get(url, { headers: { 'User-Agent': 'CrabPaw/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        _fetchUrlSync(res.headers.location).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      let totalSize = 0;

      res.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > MAX_URL_CONTENT_SIZE) {
          clearTimeout(timeout);
          res.destroy();
          reject(new Error('URL 内容过大'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        clearTimeout(timeout);
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(body);
      });

      res.on('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    }).on('error', (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

function _stripHtmlTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}

async function _fetchUrlContent(url) {
  try {
    const content = await _fetchUrlSync(url);
    const isHtml = /<html[\s>]/i.test(content.slice(0, 500));
    if (isHtml) {
      const stripped = _stripHtmlTags(content);
      return { content: stripped, warning: null };
    }
    return { content, warning: null };
  } catch (e) {
    return { content: null, warning: `URL 抓取失败: ${e.message}` };
  }
}

async function _getGitDiff(cwd) {
  const exec = require('util').promisify(require('child_process').exec);
  try {
    const { stdout } = await exec('git diff', {
      cwd: cwd,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return { content: stdout, warning: null };
  } catch (e) {
    if (e.status === 128) {
      return { content: null, warning: '当前目录不是 Git 仓库' };
    }
    return { content: null, warning: `git diff 执行失败: ${e.message.slice(0, 200)}` };
  }
}

async function _getGitStaged(cwd) {
  const exec = require('util').promisify(require('child_process').exec);
  try {
    const { stdout } = await exec('git diff --cached', {
      cwd: cwd,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    });
    return { content: stdout, warning: null };
  } catch (e) {
    if (e.status === 128) {
      return { content: null, warning: '当前目录不是 Git 仓库' };
    }
    return { content: null, warning: `git diff --cached 执行失败: ${e.message.slice(0, 200)}` };
  }
}

async function _expandReference(ref, cwd, allowedRoot) {
  const { kind, value, lineRange } = ref;

  if (kind === 'file') {
    const filePath = path.isAbsolute(value) ? value : path.join(cwd, value);
    const { content, warning } = _readFileContent(filePath, lineRange, allowedRoot);
    if (warning) return { warning, block: null };
    const truncated = _truncateToTokenBudget(content, 8000);
    const header = `📄 @file:${value}${lineRange ? `:${lineRange.start}-${lineRange.end}` : ''}`;
    return { warning: null, block: `${header}\n\`\`\`\n${truncated}\n\`\`\`` };
  }

  if (kind === 'folder') {
    const folderPath = path.isAbsolute(value) ? value : path.join(cwd, value);
    const { content, warning } = _listFolderContents(folderPath, allowedRoot);
    if (warning) return { warning, block: null };
    const header = `📁 @folder:${value}`;
    return { warning: null, block: `${header}\n${content}` };
  }

  if (kind === 'url') {
    const { content, warning } = await _fetchUrlContent(value);
    if (warning) return { warning, block: null };
    const truncated = _truncateToTokenBudget(content, 6000);
    const header = `🌐 @url:${value}`;
    return { warning: null, block: `${header}\n\`\`\`\n${truncated}\n\`\`\`` };
  }

  if (kind === 'diff') {
    const { content, warning } = await _getGitDiff(cwd);
    if (warning) return { warning, block: null };
    if (!content || content.trim().length === 0) {
      return { warning: 'git diff 无输出（没有未暂存的更改）', block: null };
    }
    const truncated = _truncateToTokenBudget(content, 8000);
    return { warning: null, block: `📝 @diff (未暂存的更改)\n\`\`\`diff\n${truncated}\n\`\`\`` };
  }

  if (kind === 'staged') {
    const { content, warning } = await _getGitStaged(cwd);
    if (warning) return { warning, block: null };
    if (!content || content.trim().length === 0) {
      return { warning: 'git diff --cached 无输出（没有已暂存的更改）', block: null };
    }
    const truncated = _truncateToTokenBudget(content, 8000);
    return { warning: null, block: `📝 @staged (已暂存的更改)\n\`\`\`diff\n${truncated}\n\`\`\`` };
  }

  return { warning: `未知的引用类型: ${kind}`, block: null };
}

async function preprocessContextReferences(message, options = {}) {
  const cwd = options.cwd || process.cwd();
  const allowedRoot = options.allowedRoot || cwd;
  const maxInjectedTokens = options.maxInjectedTokens || MAX_INJECTED_TOKENS;

  const refs = parseContextReferences(message);
  if (refs.length === 0) {
    return new ContextReferenceResult(message, message, 0, []);
  }

  const warnings = [];
  const blocks = [];
  let injectedTokens = 0;

  for (const ref of refs) {
    const { warning, block } = await _expandReference(ref, cwd, allowedRoot);
    if (warning) {
      warnings.push(warning);
    }
    if (block) {
      const blockTokens = _estimateTokens(block);
      if (injectedTokens + blockTokens > maxInjectedTokens) {
        warnings.push(`@${ref.kind}:${ref.value || ''} 注入内容超出 token 预算，已跳过`);
        continue;
      }
      blocks.push(block);
      injectedTokens += blockTokens;
    }
  }

  if (blocks.length === 0) {
    return new ContextReferenceResult(message, message, 0, warnings);
  }

  const injectedContent = `\n\n--- 引用内容 ---\n${blocks.join('\n\n---\n\n')}\n--- 引用内容结束 ---\n`;

  const enhancedMessage = message + injectedContent;

  return new ContextReferenceResult(enhancedMessage, message, injectedTokens, warnings);
}

module.exports = {
  parseContextReferences,
  preprocessContextReferences,
  ContextReferenceResult,
  _estimateTokens: _estimateTokens,
  _isAllowedPath,
  _readFileContent,
  _listFolderContents,
  MAX_INJECTED_TOKENS,
};
