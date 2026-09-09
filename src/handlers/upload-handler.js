const fs = require('fs');
const path = require('path');
const { sendError, sendJson } = require('./http-utils');
const { DATA_DIR } = require('../core/config');

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.html', '.css', '.scss', '.less', '.xml', '.yaml', '.yml', '.toml', '.ini',
  '.csv', '.tsv', '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.log', '.env', '.gitignore', '.dockerignore', '.editorconfig',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.pem', '.crt', '.key'
]);

function parseMultipartBoundary(contentType) {
  const match = contentType.match(/boundary=(.+)/);
  return match ? match[1].trim().replace(/"/g, '') : null;
}

function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundary = Buffer.from(`--${boundary}--`);
  
  let start = 0;
  let boundaryIndex;
  
  while ((boundaryIndex = body.indexOf(boundaryBuffer, start)) !== -1) {
    const nextBoundary = body.indexOf(boundaryBuffer, boundaryIndex + boundaryBuffer.length);
    const endMarker = body.indexOf(endBoundary, boundaryIndex);

    let partEnd;
    if (endMarker !== -1 && (nextBoundary === -1 || endMarker < nextBoundary)) {
      partEnd = endMarker;
    } else if (nextBoundary !== -1) {
      partEnd = nextBoundary;
    } else {
      break;
    }

    // 2026-08-04: 死循环防护——partEnd 不前进即视为结束边界(如 '--boundary--' 收尾时
    // 第二次匹配 boundaryIndex===start,endMarker===nextBoundary===start)。此前 start 原地
    // 打转 → 无限循环占满事件循环 → 后端整体假死(所有 HTTP 请求无响应,仅定时器存活)。
    if (partEnd <= start) break;

    const partStart = boundaryIndex + boundaryBuffer.length + 2;
    const partData = body.slice(partStart, partEnd - 2);

    const headerEnd = partData.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = partData.slice(0, headerEnd).toString();
      const content = partData.slice(headerEnd + 4);

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

      parts.push({
        name: nameMatch ? nameMatch[1] : '',
        filename: filenameMatch ? filenameMatch[1] : null,
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
        content: content
      });
    }

    start = partEnd;
  }

  return parts;
}

async function handleFileUpload(req, res, ctx) {
  const contentType = req.headers['content-type'] || '';
  
  if (!contentType.includes('multipart/form-data')) {
    return sendError(res, 400, 'Content-Type must be multipart/form-data');
  }
  
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) {
    return sendError(res, 400, 'Invalid multipart boundary');
  }
  
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE_SIZE) {
        req.destroy();
        reject(new Error('File size exceeds limit'));
      }
      chunks.push(chunk);
    });
    
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  
  const parts = parseMultipart(body, boundary);
  const uploadedFiles = [];
  const workspaceDir = ctx.WORKSPACE_DIR || path.join(DATA_DIR, 'workspace');
  const uploadsDir = path.join(workspaceDir, 'uploads');
  
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  
  for (const part of parts) {
    if (!part.filename) continue;
    
    const ext = path.extname(part.filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      console.warn('⚠️ 不允许的文件类型:', ext);
      continue;
    }
    
    const timestamp = Date.now();
    const baseName = path.basename(part.filename);
    const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const savedName = `${timestamp}_${safeName}`;
    
    // Path traversal protection: resolve and verify path stays within uploadsDir
    const resolvedUploadsDir = path.resolve(uploadsDir);
    const filePath = path.resolve(resolvedUploadsDir, savedName);
    
    if (!filePath.startsWith(resolvedUploadsDir + path.sep) && filePath !== resolvedUploadsDir) {
      console.warn('⚠️ 路径遍历尝试被阻止:', { filename: part.filename, resolved: filePath });
      continue;
    }
    
    fs.writeFileSync(filePath, part.content);
    
    uploadedFiles.push({
      originalName: part.filename,
      savedName,
      path: filePath,
      size: part.content.length,
      type: part.contentType
    });
    
    console.log('📁 文件已上传:', savedName, `(${Math.round(part.content.length / 1024)}KB)`);
  }
  
  if (uploadedFiles.length === 0) {
    return sendError(res, 400, 'No valid files uploaded');
  }
  
  sendJson(res, 200, {
    success: true,
    files: uploadedFiles
  });
}

async function handleUploadBase64(req, res, ctx) {
  const { readJsonBody } = require('./http-utils');
  
  console.log('📥 收到 base64 上传请求');
  
  try {
    const data = await readJsonBody(req, { maxSize: MAX_FILE_SIZE });
    const { files } = data;
    
    console.log('📦 解析到的文件数量:', files?.length || 0);
    
    if (!files || !Array.isArray(files) || files.length === 0) {
      console.log('❌ 没有提供文件');
      return sendError(res, 400, 'No files provided');
    }
    
    const uploadedFiles = [];
    const workspaceDir = ctx.WORKSPACE_DIR || path.join(DATA_DIR, 'workspace');
    const uploadsDir = path.join(workspaceDir, 'uploads');
    
    console.log('📂 上传目录:', uploadsDir);
    
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log('📁 创建上传目录:', uploadsDir);
    }
    
    for (const file of files) {
      const { name, content, type } = file;
      
      console.log('📄 处理文件:', name, '类型:', type, '内容长度:', content?.length || 0);
      
      if (!name || !content) {
        console.log('⚠️ 跳过无效文件:', name);
        continue;
      }
      
      const ext = path.extname(name).toLowerCase();
      console.log('📄 文件扩展名:', ext);
      
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        console.warn('⚠️ 不允许的文件类型:', ext);
        continue;
      }
      
      let buffer;
      if (content.startsWith('data:')) {
        const base64Data = content.split(',')[1];
        buffer = Buffer.from(base64Data, 'base64');
      } else {
        buffer = Buffer.from(content, 'base64');
      }
      
      const timestamp = Date.now();
      const baseName = path.basename(name);
      const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const savedName = `${timestamp}_${safeName}`;
      const filePath = path.join(uploadsDir, savedName);
      
      if (!filePath.startsWith(uploadsDir)) {
        console.warn('⚠️ 路径遍历尝试:', name);
        continue;
      }
      
      fs.writeFileSync(filePath, buffer);
      
      uploadedFiles.push({
        originalName: name,
        savedName,
        path: filePath,
        size: buffer.length,
        type: type || 'application/octet-stream'
      });
      
      console.log('📁 文件已上传 (base64):', savedName, `(${Math.round(buffer.length / 1024)}KB)`);
    }
    
    if (uploadedFiles.length === 0) {
      console.log('❌ 没有成功上传任何文件');
      return sendError(res, 400, 'No valid files uploaded');
    }
    
    console.log('✅ 上传完成，文件数:', uploadedFiles.length);
    
    sendJson(res, 200, {
      success: true,
      files: uploadedFiles
    });
    
  } catch (err) {
    console.error('❌ 上传错误:', err.message);
    console.error('❌ 错误堆栈:', err.stack);
    sendError(res, 500, err.message);
  }
}

module.exports = {
  handleFileUpload,
  handleUploadBase64
};
