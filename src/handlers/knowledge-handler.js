const crypto = require('crypto');
/**
 * Knowledge Base Handler - 知识库文件上传
 *
 * 将文件上传到火山方舟(豆包)知识库
 * API: POST https://ark.cn-beijing.volces.com/api/v3/knowledge/{kb_id}/documents
 */



const { loadConfig } = require("../core/config");

const ARK_HOST = "ark.cn-beijing.volces.com";
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

function sendJson(res, statusCode, data) { // returns true for routing chain
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
  return true;
}

function parseMultipartBoundary(contentType) {
  const match = contentType.match(/boundary=(.+)/);
  return match ? match[1].trim().replace(/"/g, "") : null;
}

function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from("--" + boundary);
  const endBoundary = Buffer.from("--" + boundary + "--");

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

    const partStart = boundaryIndex + boundaryBuffer.length + 2;
    const partData = body.slice(partStart, partEnd - 2);

    const headerEnd = partData.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headers = partData.slice(0, headerEnd).toString();
      const content = partData.slice(headerEnd + 4);

      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

      parts.push({
        name: nameMatch ? nameMatch[1] : "",
        filename: filenameMatch ? filenameMatch[1] : null,
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
        content: content,
      });
    }

    start = partEnd;
  }

  return parts;
}

/**
 * Read raw request body
 */
function readRequestBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("File size exceeds " + (maxSize / 1024 / 1024) + "MB limit"));
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Get API Key from config (same logic as monitor knowledge search)
 */
function getArkApiKey() {
  const cfg = loadConfig();

  // Try visionGeneration providers
  const visionCfg = cfg.visionGeneration || {};
  const visionProv = visionCfg.providers || {};
  for (const [key, val] of Object.entries(visionProv)) {
    if (val.apiKey && (key.includes("doubao") || key.includes("ark") || (val.baseUrl && val.baseUrl.includes("volces")))) {
      return val.apiKey;
    }
  }

  // Try models providers
  const modelProv = cfg.models?.providers || {};
  for (const [key, val] of Object.entries(modelProv)) {
    if (val.apiKey && (key.includes("doubao") || key.includes("ark") || (val.baseUrl && val.baseUrl.includes("volces")))) {
      return val.apiKey;
    }
  }

  return null;
}

/**
 * Build multipart form data for Volcano Ark API
 */
function buildArkMultipart(knowledgeId, fileName, fileBuffer) {
  const boundary = "----CrabPawArk" + Date.now() + crypto.randomBytes(4).toString("hex");
  const CRLF = "\r\n";

  const parts = [];

  // knowledge_id field (form field, not file)
  parts.push("--" + boundary + CRLF);
  parts.push('Content-Disposition: form-data; name="knowledge_id"' + CRLF);
  parts.push(CRLF);
  parts.push(knowledgeId + CRLF);

  // File field
  parts.push("--" + boundary + CRLF);
  parts.push('Content-Disposition: form-data; name="file"; filename="' + fileName + '"' + CRLF);
  parts.push("Content-Type: application/octet-stream" + CRLF);
  parts.push(CRLF);
  // Binary content will be added as Buffer

  const header = Buffer.from(parts.join(""), "utf-8");
  const footer = Buffer.from(CRLF + "--" + boundary + "--" + CRLF, "utf-8");

  // Content-Length for the constructed multipart body
  const body = Buffer.concat([header, fileBuffer, footer]);

  return {
    boundary,
    body,
  };

}

/**
 * Upload file to Volcano Ark knowledge base
 */
function uploadToArk(knowledgeId, fileName, fileBuffer) {
  return new Promise((resolve, reject) => {
    const apiKey = getArkApiKey();
    if (!apiKey) {
      return reject(new Error("未找到火山方舟 API Key。请在配置中设置豆包/方舟模型的 API Key"));
    }

    const { boundary, body } = buildArkMultipart(knowledgeId, fileName, fileBuffer);

    const https = require("https");
    const req = https.request(
      {
        hostname: ARK_HOST,
        path: "/api/v3/knowledge/" + encodeURIComponent(knowledgeId) + "/documents",
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=" + boundary,
          "Content-Length": body.length,
          Authorization: "Bearer " + apiKey,
        },
        timeout: 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, data: json });
            } else {
              resolve({ success: false, error: json.message || json.error || "HTTP " + res.statusCode, data: json });
            }
          } catch {
            resolve({ success: false, error: "解析响应失败: " + data.substring(0, 200) });
          }
        });
      }
    );

    req.on("error", (e) => reject(new Error("上传请求失败: " + e.message)));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("上传超时(60s)"));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Main handler for knowledge base API
 */
async function handleKnowledgeApi(req, res, pathname) {
  // POST /api/knowledge/upload - upload file to knowledge base
  if (req.method === "POST" && pathname === "/api/knowledge/upload") {
    const contentType = req.headers["content-type"] || "";

    if (!contentType.includes("multipart/form-data")) {
      sendJson(res, 400, { success: false, error: "需要 multipart/form-data" });
      return true;
    }

    const boundary = parseMultipartBoundary(contentType);
    if (!boundary) {
      sendJson(res, 400, { success: false, error: "无效的 multipart boundary" });
      return true;
    }

    try {
      const rawBody = await readRequestBody(req, MAX_FILE_SIZE);
      const parts = parseMultipart(rawBody, boundary);

      // Find file and knowledgeBaseId fields
      let filePart = null;
      let knowledgeBaseId = "";

      for (const part of parts) {
        if (part.filename) {
          filePart = part;
        }
        if (part.name === "knowledgeBaseId" && !part.filename) {
          knowledgeBaseId = part.content.toString("utf-8").trim();
        }
      }

      if (!filePart) {
        sendJson(res, 400, { success: false, error: "未找到上传文件" });
        return true;
      }

      if (!knowledgeBaseId) {
        sendJson(res, 400, { success: false, error: "缺少 knowledgeBaseId" });
        return true;
      }

      console.log("[知识库上传] 开始上传:", filePart.filename, "到知识库:", knowledgeBaseId,
        "大小:", (filePart.content.length / 1024).toFixed(1) + "KB");

      const result = await uploadToArk(knowledgeBaseId, filePart.filename, filePart.content);

      if (result.success) {
        console.log("[知识库上传] 成功:", filePart.filename);
        sendJson(res, 200, {
          success: true,
          message: "文件已上传到知识库，正在索引中",
          fileName: filePart.filename,
          knowledgeBaseId,
          data: result.data,
        });
      } else {
        console.error("[知识库上传] 失败:", result.error);
        sendJson(res, 500, result);
      }
      return true;
    } catch (e) {
      console.error("[知识库上传] 异常:", e.message);
      sendJson(res, 500, { success: false, error: e.message });
      return true;
    }
  }

  // GET /api/knowledge/status - check knowledge base status
  if (req.method === "GET" && pathname === "/api/knowledge/status") {
    const apiKey = getArkApiKey();
    if (!apiKey) {
      sendJson(res, 200, { configured: false, message: "未配置火山方舟 API Key" });
      return true;
    }
    sendJson(res, 200, { configured: true, message: "API Key 已配置" });
    return true;
  }

  return false;
}

module.exports = { handleKnowledgeApi };