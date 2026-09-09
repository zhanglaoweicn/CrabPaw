/**
 * attachment.ts — 对话附件 URL/展示 helper（2026-08-21）
 *
 * 附件上传后后端只回磁盘路径（{DATA_DIR}/workspace/uploads/{ts}_{name}），
 * 对话气泡需把它转成可渲染的 URL：
 *   - Electron：local:// 协议（主进程 protocol.handle 白名单已放行 DATA_DIR/workspace）
 *   - 浏览器 dev：/files/ 静态服务（相对 DATA_DIR，需放行 workspace/uploads，见
 *     src/handlers/local-handlers/files.js）
 */
import { isElectron } from './api'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])

export function isImageAttachment(name: string): boolean {
  const dot = (name || '').lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTS.has(name.slice(dot).toLowerCase())
}

/** 磁盘绝对路径 → 文件名（兼容 / 与 \ 分隔） */
export function baseNameOf(filePath: string): string {
  const parts = String(filePath || '').split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

/**
 * 附件磁盘路径 → 渲染 URL。
 * - Electron：local:///D:/...（主进程协议已放行 workspace 目录）
 * - 浏览器：/files/workspace/uploads/{basename}（经 vite proxy 到后端静态服务）
 */
export function fileUrlFor(filePath: string): string {
  if (!filePath) return ''
  if (isElectron()) {
    return `local:///${filePath.replace(/\\/g, '/')}`
  }
  const base = baseNameOf(filePath)
  return base ? `/files/workspace/uploads/${encodeURIComponent(base)}` : ''
}

/** 附件大小格式化（字节 → KB/MB，0/缺失 → ''） */
export function formatFileSize(size?: number): string {
  if (!size || !Number.isFinite(size) || size <= 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
