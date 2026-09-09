const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;

async function readRequestBody(req, options = {}) {
  const maxSize = options.maxSize || DEFAULT_MAX_BODY_SIZE;
  
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let exceeded = false;
    
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    
    const onData = (chunk) => {
      if (exceeded) return;
      
      size += chunk.length;
      
      if (size > maxSize) {
        exceeded = true;
        cleanup();
        const error = new Error(`请求体大小超过限制 (${maxSize} bytes)`);
        error.code = 'PAYLOAD_TOO_LARGE';
        error.maxSize = maxSize;
        error.actualSize = size;
        reject(error);
        return;
      }
      
      body += chunk;
    };
    
    const onEnd = () => {
      cleanup();
      resolve(body);
    };
    
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

async function readJsonBody(req, options = {}) {
  const body = await readRequestBody(req, options);
  
  try {
    return JSON.parse(body);
  } catch (error) {
    const parseError = new Error(`JSON 解析失败: ${error.message}`);
    parseError.code = 'INVALID_JSON';
    parseError.originalError = error;
    throw parseError;
  }
}

function sendError(res, statusCode, message, code = null) {
  if (res.headersSent || res.writableEnded) {
    console.warn('⚠️ HTTP 响应已发送，跳过 sendError');
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  const errorBody = { success: false, error: message };
  if (code) errorBody.code = code;
  res.end(JSON.stringify(errorBody));
}

function sendJson(res, statusCode, data) {
  if (res.headersSent || res.writableEnded) {
    console.warn('⚠️ HTTP 响应已发送，跳过 sendJson');
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

module.exports = {
  DEFAULT_MAX_BODY_SIZE,
  readRequestBody,
  readJsonBody,
  sendError,
  sendJson
};
