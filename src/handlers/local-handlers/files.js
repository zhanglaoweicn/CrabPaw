// files.js — 从 src/cli/request-handler.js 机械抽取（Task 6，零行为变化）。
// 方法体逐字迁移；相对 require 路径按新模块位置平移；LOCAL_HANDLERS 交叉引用改为模块内直调。

const fs = require('fs');
const path = require('path');
const { getDataDir, getApiKey, isLocalSocket, isLocalBrowserContext } = require('./_shared');
const { verifyApiToken } = require('../../core/http-middleware');

// 2026-08-01: memory-handlers.js 已合并入 handlers/memory-handler.js（单一实现），
// 此引用移除，避免同一路由下两套重复实现被 Object.assign 覆盖

/**
 * 简单的 HTML 消毒函数 - 防止 XSS 攻击
 * 使用白名单方式只允许安全的标签和属性 */
function sanitizeHtml(html) {
  const ALLOWED_TAGS = new Set([
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'a', 'img', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'div', 'span', 'article', 'section', 'header', 'footer', 'nav',
    'details', 'summary', 'figure', 'figcaption'
  ]);
  const ALLOWED_ATTRS = {
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
  };

  const DANGEROUS_PROTOCOLS = ['javascript:', 'vbscript:', 'data:text/html', 'file:'];

  let result = (html || '').replace(/\0/g, ''); // strip null bytes

  for (let i = 0; i < 3; i++) {
    const prev = result;
    // 1. 移除所有 script 标签
    result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
    // 2. 移除所有 style 标签
    result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
    if (result === prev) break; // 无变化则停止
  }

  result = result.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  result = result.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');

  for (const protocol of DANGEROUS_PROTOCOLS) {
    const regex = new RegExp(`(href|src|action)\\s*=\\s*["']\\s*${protocol.replace(':', '\\:')}[^"']*["']`, 'gi');
    result = result.replace(regex, '');
  }

  // Process all tags, strip disallowed tags and attributes
  result = result.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (match, tagName) => {

    const lowerTag = tagName.toLowerCase();

    // Block SVG/MathML namespace tags and unknown namespace tags
    if (lowerTag.includes(':') || lowerTag.includes('xml')) {
      return '';
    }


    // Skip tags not in whitelist
    if (!ALLOWED_TAGS.has(lowerTag)) {
      return '';
    }

    // 处理属性
    const isSelfClosing = match.endsWith('/>');
    const attrs = match.match(/\s+[a-zA-Z][a-zA-Z0-9-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g) || [];
    const safeAttrs = [];

    const allowedForTag = ALLOWED_ATTRS[lowerTag] || [];
    const allAllowed = [...ALLOWED_ATTRS['*'], ...allowedForTag];

    for (const attr of attrs) {
      const attrMatch = attr.match(/^\s+([a-zA-Z][a-zA-Z0-9-]*)/);
      if (attrMatch) {
        const attrName = attrMatch[1].toLowerCase();
        if (allAllowed.includes(attrName)) {
          // 额外检查属性值中是否包含危险协议
          const valMatch = attr.match(/=\s*["']?([^"'\s>]+)/);
          if (valMatch) {
            const val = valMatch[1].toLowerCase().trim();
            if (DANGEROUS_PROTOCOLS.some(p => val.startsWith(p))) continue;
          }
          safeAttrs.push(attr);
        }
      }
    }

    // 重建标签
    if (isSelfClosing) {
      return `<${lowerTag}${safeAttrs.join('')}/>`;
    } else {
      return `<${lowerTag}${safeAttrs.join('')}>`;
    }
  });

  return result;
}

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

const ALLOWED_FILE_DIRS = [];

function getAllowedFileDirs() {
  if (ALLOWED_FILE_DIRS.length > 0) return ALLOWED_FILE_DIRS;
  const dataDir = getDataDir();
  ALLOWED_FILE_DIRS.push(
    path.join(dataDir, 'generated-images'),
    path.join(dataDir, 'generated-videos'),
    path.join(dataDir, 'uploads'),
    path.join(dataDir, 'screenshots'),
    // 2026-08-21: 对话附件上传目录（upload-handler 存 {DATA_DIR}/workspace/uploads，
    // 与 dataDir/uploads 不同段）——放行后浏览器 dev 模式 /files/workspace/uploads/{name}
    // 可访问（Electron 走 local:// 协议，白名单已含 workspace）
    path.join(dataDir, 'workspace', 'uploads'),
  );
  return ALLOWED_FILE_DIRS;
}

function isPathAllowed(filePath) {
  const resolved = path.resolve(filePath);
  return getAllowedFileDirs().some(dir => {
    const allowed = path.resolve(dir);
    return resolved === allowed || resolved.startsWith(allowed + path.sep);
  });
}

async function handleStaticFile(req, res, ctx) {
  // 2026-08-07 (M4 安全): /files/ 静态服务此前免认证可读 generated-images/uploads/
  // screenshots 全部文件。现要求本机回环来源 +（合法 token 或 Electron 代理 X-Electron 头）
  // ——Electron 代理转发带 X-Api-Key，渲染层直连/旧版页面带 X-Electron；远端一律拒绝。
  if (!isLocalSocket(req) || !(verifyApiToken(req, getApiKey()) || isLocalBrowserContext(req))) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
    return;
  }

  const pathname = ctx.url.pathname;
  const relativePath = decodeURIComponent(pathname.replace(/^\/files\//, ''));

  if (relativePath.includes('..') || path.isAbsolute(relativePath)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: invalid path' }));
    return;
  }

  const dataDir = getDataDir();
  const safeRelative = path.normalize(relativePath).replace(/^(\.\.(\/|\\))+/, '');
  const filePath = path.resolve(path.join(dataDir, safeRelative));

  if (!filePath.startsWith(dataDir + path.sep) && filePath !== dataDir) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
    return;
  }
  
  if (!isPathAllowed(filePath)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Directory not allowed' }));
    return;
  }
  
  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'File not found' }));
      return;
    }
    
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Not a file' }));
      return;
    }
    
    if (stat.size > 50 * 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'File too large' }));
      return;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileContent = fs.readFileSync(filePath);
    
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': String(fileContent.length),
      'Cache-Control': 'no-cache',
    });
    res.end(fileContent);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
  }
}

async function handleMarkdownPreview(req, res, ctx) {
  const { marked } = require('marked');
  const filePath = ctx.url.searchParams.get('path');

  if (!filePath) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'path parameter is required' }));
    return;
  }

  const resolvedPath = path.resolve(filePath);
  const dataDir = getDataDir();
  const crabpawDir = path.resolve(dataDir);
  const projectDir = path.resolve(path.join(dataDir, '..'));

  // 2026-08-07 (M3): 前缀判断补 path.sep——防止 /data/.crabpaw-evil 这类同前缀目录越权
  const insideCrabpaw = resolvedPath === crabpawDir || resolvedPath.startsWith(crabpawDir + path.sep);
  const insideData = resolvedPath === projectDir || resolvedPath.startsWith(projectDir + path.sep);
  if (!insideCrabpaw && !insideData) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Forbidden: path not allowed' }));
    return;
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'File not found' }));
      return;
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Invalid file' }));
      return;
    }

    const mdContent = fs.readFileSync(resolvedPath, 'utf-8');
    const rawHtml = await marked(mdContent);
    // XSS 防护：消毒 HTML 内容
    const htmlContent = sanitizeHtml(rawHtml);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(htmlContent);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Internal server error: ' + e.message }));
  }
}

module.exports = {
  handleStaticFile,
  handleMarkdownPreview,
};
