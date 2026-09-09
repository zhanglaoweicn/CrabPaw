/**
 * wecom_message SSE payload 构建（P3: 补文件元数据，激活前端 wecom_doc 面板链路）
 *
 * 增量契约：原 payload { senderId, content, timestamp } 保持不变，
 * 仅在存在有效附件时追加 file 对象与 fileCount 计数。
 */
const fs = require('fs')

/**
 * @param {string} senderId
 * @param {string} content
 * @param {Array<{ fileName?: string, fileKey?: string }>} files 企微附件（fileKey 为本地已下载路径）
 * @returns {{ senderId: string, content: string, timestamp: number, file?: { name: string, path: string, size: number }, fileCount?: number }}
 */
function buildWecomMessagePayload(senderId, content, files = []) {
  const payload = { senderId, content, timestamp: Date.now() }
  const valid = []
  for (const f of files) {
    if (!f || !f.fileName || !f.fileKey) continue
    let size = 0
    try {
      size = fs.statSync(f.fileKey).size
    } catch (err) {
      console.warn(`[wecom-payload] 附件 stat 失败(${f.fileKey}):`, err?.message || err)
    }
    valid.push({ name: f.fileName, path: f.fileKey, size })
  }
  if (valid.length > 0) {
    payload.file = valid[0] // v1: 单文件语义（TaskPanelHost 已按 data.file.name 渲染）
    payload.fileCount = valid.length
  }
  return payload
}

module.exports = { buildWecomMessagePayload }
