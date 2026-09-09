/**
 * 文件浏览 API — 统一扫描所有生成文件（.crabpaw 子目录 + 项目目录）
 */
const fs = require('fs')
const path = require('path')

// Directories under .crabpaw/ to scan
const SCAN_DIRS = ['generated-images', 'generated-videos', 'exports', 'tts-output', 'screenshots', 'uploads', 'workspace']
// User-facing file extensions
const SCAN_EXTS = new Set([
  'png','jpg','jpeg','gif','webp','svg','bmp',
  'html','htm','pdf','docx','xlsx','pptx',
  'mp4','webm','mov','avi','mkv',
  'mp3','wav','ogg','flac','aac',
  'zip','tar','gz',
  'txt','md','csv',
])
// 系统文件 — 不在文件浏览器中显示
const SKIP_NAMES = new Set([
  '.gitkeep', 'config.json', 'package.json',
  'USER.md', 'IDENTITY.md', 'MEMORY.md', 'SOUL.md', 'HEARTBEAT.md', 'AGENT.md',
  'ppt-history.json', 'ppt-preferences.json',
  'test-doc.md', 'DESCRIPTION.md',
  'crabpaw.log', 'crash.log', '.api_token', '.api_port',
  // 所有 .crabpaw 下的系统 JSON
  'audit-log.json', 'config-evolution.json', 'evolution-feedback.json',
  'evolution-system.json', 'lark-status.json', 'memory-evolution.json',
  'plugins-data.json', 'schedule.json', 'schedules.json',
  'skill-content-cache.json', 'skill-evolution.json', 'skill-recommender.json',
  'skill-trajectory.json', 'task-evolution.json', 'test-evolution.json',
  'tool-orchestration.json', 'tts-evolution.json', 'usage-stats.json',
  'voice-cache.json', 'voice-evolution.json', 'wecom-status.json',
  'dream.json', 'archive-index.json', 'access-log.json',
  'data-sources.json', 'onboarding.json', 'patterns.json',
  'skill-lifecycle.json', 'skill-usage.json',
])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', 'backups', '.exports', 'logs', 'memories', 'memory', 'memory-snapshot', 'sessions', 'commitments', 'announcements', 'plugins'])

function getDataDir() {
  return process.env.CRABPAW_DATA_DIR || path.join(__dirname, '..', '..', 'data', '.crabpaw')
}

/** Get the project root directory (sibling of .crabpaw/) */
function getProjectsRoot() {
  return path.join(path.dirname(getDataDir()), 'projects')
}

function scanDir(dirPath, sourceLabel, results) {
  if (!fs.existsSync(dirPath)) return
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (SKIP_NAMES.has(entry.name)) continue
      const ext = path.extname(entry.name).toLowerCase().replace('.', '')
      if (!SCAN_EXTS.has(ext)) continue
      const filePath = path.join(entry.parentPath || dirPath, entry.name)
      const stat = fs.statSync(filePath)
      results.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        ext,
        modifiedAt: stat.mtimeMs,
        dir: sourceLabel,
      })
    }
  } catch (e) {
    console.warn('[file-handler] 扫描目录失败:', dirPath, e.message)
  }
}

/** Find project name from its meta file */
function getProjectName(projectDir) {
  try {
    const metaPath = path.join(projectDir, 'project.json')
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      return meta.name || path.basename(projectDir)
    }
  } catch (e) { console.warn('[file-handler] failed to read project meta:', e.message); }
  return path.basename(projectDir)
}

function scanAllFiles(dataDir) {
  const results = []

  // 1. Scan .crabpaw/ generated directories
  for (const dir of SCAN_DIRS) {
    scanDir(path.join(dataDir, dir), dir, results)
  }

  // 2. Scan data/workspace/ (user-facing workspace)
  const workspaceDir = path.join(path.dirname(dataDir), 'workspace')
  scanDir(workspaceDir, '工作区', results)

  // 3. Scan project directories (data/projects/*/proj_xxx/)
  const projectsRoot = getProjectsRoot()
  if (fs.existsSync(projectsRoot)) {
    try {
      const userDirs = fs.readdirSync(projectsRoot, { withFileTypes: true })
      for (const userDir of userDirs) {
        if (!userDir.isDirectory()) continue
        const userPath = path.join(projectsRoot, userDir.name)
        const projectEntries = fs.readdirSync(userPath, { withFileTypes: true })
        for (const projEntry of projectEntries) {
          if (!projEntry.isDirectory() || SKIP_DIRS.has(projEntry.name)) continue
          const projPath = path.join(userPath, projEntry.name)
          const projName = getProjectName(projPath)
          scanDir(projPath, `📁 ${projName}`, results)
        }
      }
    } catch (e) {
      console.warn('[file-handler] 扫描项目目录失败:', e.message)
    }
  }

  return results
}

// ── HTTP Handlers ──

async function handleFileList(req, res, _ctx) {
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return }
  try {
    const files = scanAllFiles(getDataDir())
    const { sendJson } = require('./http-utils')
    sendJson(res, 200, { success: true, files })
  } catch (e) {
    res.writeHead(500)
    res.end(JSON.stringify({ success: false, error: e.message }))
  }
}

async function handleFileRead(req, res, ctx) {
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return }
  try {
    const url = new URL(req.url, `http://localhost:${ctx.PORT || 38767}`)
    const filePath = url.searchParams.get('path')
    if (!filePath) { res.writeHead(400); res.end(JSON.stringify({ error: '缺少 path' })); return }
    const dataDir = getDataDir()
    const projectsRoot = getProjectsRoot()
    const workspaceDir = path.join(path.dirname(dataDir), 'workspace')
    // 2026-08-07 (S3 安全): 此前 allowlist 含整个项目根（BASE_DIR，递归任意文件）——
    // src/gui/脚本/配置(.env 等)全部可读。收紧为：
    // 1) data/ 相关目录：.crabpaw/、projects/、data/workspace/（GUI 浏览上传/生成文件全在 data/ 内，不受影响）；
    // 2) 例外：BASE_DIR 根目录下的"生成文档"（仅一层深 + 文档/媒体扩展名）——
    //    2026-08-03 DocReader 预览 LLM 直接落在根目录的 HTML/报告（commit 6002010）。
    //    子目录、源码、配置（.env/config.yaml/.js/.json 等）一律拒绝。
    const baseDir = path.join(__dirname, '..', '..')
    // 仅当文件恰好位于根目录一层（非子目录）且为生成文档类型时放行
    const ROOT_DOC_EXTS = new Set(['.html', '.htm', '.md', '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.csv', '.zip', '.mp4', '.mp3', '.wav'])
    const resolved = path.resolve(filePath)
    const isWithin = (dir) => {
      const abs = path.resolve(dir)
      return resolved === abs || resolved.startsWith(abs + path.sep)
    }
    const isRootDoc = (() => {
      if (path.dirname(resolved) !== path.resolve(baseDir)) return false
      return ROOT_DOC_EXTS.has(path.extname(resolved).toLowerCase())
    })()
    if (!isWithin(dataDir) && !isWithin(projectsRoot) && !isWithin(workspaceDir) && !isRootDoc) {
      res.writeHead(403); res.end(JSON.stringify({ error: '越权访问' })); return
    }
    if (!fs.existsSync(resolved)) { res.writeHead(404); res.end(JSON.stringify({ error: '文件不存在' })); return }
    const stat = fs.statSync(resolved)
    const ext = path.extname(resolved).toLowerCase()
    const mimeMap = {
      '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
      '.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp',
      '.html':'text/html','.htm':'text/html','.pdf':'application/pdf',
      '.json':'application/json','.txt':'text/plain','.csv':'text/csv',
      '.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav',
    }
    const mime = mimeMap[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' })
    const readStream = fs.createReadStream(resolved)
    // 流错误处理
    readStream.on('error', (err) => {
      console.error('[file-handler] read stream error:', err.message)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(JSON.stringify({ success: false, error: '读取文件失败' }))
      } else {
        res.destroy()
      }
    })
    // 客户端断连时清理文件句柄
    res.on('close', () => {
      if (!readStream.destroyed) readStream.destroy()
    })
    readStream.pipe(res)
  } catch (e) {
    res.writeHead(500)
    res.end(JSON.stringify({ success: false, error: e.message }))
  }
}

async function handleFileDelete(req, res, _ctx) {
  const url = new URL(req.url, 'http://localhost')
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    res.writeHead(400)
    res.end(JSON.stringify({ success: false, error: '缺少 path 参数' }))
    return
  }
  try {
    const fs = require('fs')
    const path = require('path')
    const dataDir = getDataDir()
    const projectsRoot = getProjectsRoot()
    const workspaceDir = path.join(path.dirname(dataDir), 'workspace')
    const resolved = path.resolve(decodeURIComponent(filePath))
    // 路径鉴权：只允许删除 .crabpaw/、projects/、data/workspace/ 内的文件
    // 2026-08-07 (M3): 前缀判断补 path.sep，防 /data/.crabpaw-evil 同前缀目录越权
    const isWithin = (dir) => {
      const abs = path.resolve(dir)
      return resolved === abs || resolved.startsWith(abs + path.sep)
    }
    if (!isWithin(dataDir) && !isWithin(projectsRoot) && !isWithin(workspaceDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, error: '越权访问' }))
      return
    }
    if (!fs.existsSync(resolved)) {
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: '文件不存在' }))
      return
    }
    fs.unlinkSync(resolved)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
  } catch (e) {
    res.writeHead(500)
    res.end(JSON.stringify({ success: false, error: e.message }))
  }
}

module.exports = { handleFileList, handleFileRead, handleFileDelete }
