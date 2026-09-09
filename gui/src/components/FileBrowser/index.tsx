/**
 * FileBrowser — 生成文件管理（v2 增强版）
 *
 * UI/UX 优化：
 *   分类筛选 | 排序切换 | 网格/列表视图 | 搜索 | 文件大小/时间显示
 *
 * 打开方式：
 *   预览弹窗（图片/视频/文档）| 系统应用打开 | 复制路径 | 引用到对话
 *   右键操作菜单
 *
 * HTML 内置浏览器：
 *   iframe 渲染 | 地址栏 + 导航按钮 | 新窗口打开 | 响应式
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Search, FileText, Image, Video, Music, Archive,
  Globe, File, ExternalLink, Eye, Clock, FolderOpen, MessageSquare, X,
  LayoutGrid, List, ArrowUp, ArrowDown, Copy, Trash2,
  Download, RefreshCw, AlertTriangle,
} from 'lucide-react'
import { apiDelete, apiGet, getApiBaseUrl, isElectron, resolveApiUrl } from '../../lib/api'
import { toast } from 'sonner'
import { FilePreviewModal, type FilePreviewItem } from '../FilePreviewModal'
import { useConfirm } from '../useConfirm'

// ─── Types ──────────────────────────────────────────────
interface FileEntry {
  name: string
  path: string
  size: number
  ext: string
  modifiedAt: number
  dir: string
}

type FileCategory = 'image' | 'html' | 'document' | 'video' | 'audio' | 'archive' | 'other'
type SortKey = 'name' | 'modifiedAt' | 'size'
type ViewMode = 'list' | 'grid'

const CAT_ICONS: Record<FileCategory, any> = { image: Image, html: Globe, document: FileText, video: Video, audio: Music, archive: Archive, other: File }
const CAT_LABELS: Record<FileCategory, string> = { image: '图片', html: '网页', document: '文档', video: '视频', audio: '音频', archive: '压缩包', other: '其他' }
const CAT_COLORS: Record<FileCategory, string> = { image: '#ec4899', html: '#f59e0b', document: '#3b82f6', video: '#8b5cf6', audio: '#10b981', archive: '#f97316', other: '#6b7280' }
const EXT_COLORS: Record<string, string> = { png: '#ec4899', jpg: '#ec4899', jpeg: '#ec4899', gif: '#a855f7', webp: '#06b6d4', svg: '#f59e0b', html: '#f59e0b', htm: '#f59e0b', pdf: '#ef4444', docx: '#2563eb', xlsx: '#16a34a', pptx: '#dc2626', txt: '#6b7280', md: '#6366f1', json: '#eab308', csv: '#16a34a', mp3: '#10b981', wav: '#10b981', mp4: '#8b5cf6', zip: '#f97316' }

function categorize(ext: string): FileCategory {
  const e = ext.toLowerCase()
  if (['png','jpg','jpeg','gif','webp','svg','bmp','ico'].includes(e)) return 'image'
  if (['html','htm'].includes(e)) return 'html'
  if (['pdf','docx','xlsx','pptx','doc','xls','ppt','txt','md','json','csv','yaml','yml','xml'].includes(e)) return 'document'
  if (['mp4','webm','mov','avi','mkv'].includes(e)) return 'video'
  if (['mp3','wav','ogg','flac','aac'].includes(e)) return 'audio'
  if (['zip','tar','gz','rar','7z'].includes(e)) return 'archive'
  return 'other'
}

function formatSize(b: number): string {
  if (!b) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`
  if (b < 1024*1024*1024) return `${(b/(1024*1024)).toFixed(1)} MB`
  return `${(b/(1024*1024*1024)).toFixed(1)} GB`
}

function formatTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + d.toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })
  return d.toLocaleDateString('zh-CN', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
}

// ─── HTML 内置浏览器组件 ──────────────────────────────
function HtmlViewer({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [iframeLoading, setIframeLoading] = useState(true)
  const [currentUrl, setCurrentUrl] = useState(url)

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#0a0a0f' }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0" style={{ background: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
          <X className="w-4 h-4" style={{ color: '#888' }} />
        </button>
        <span className="text-xs font-medium truncate max-w-[200px]" style={{ color: '#ccc' }}>{title}</span>
        <div className="flex-1 flex items-center gap-1 px-2">
          <div className="flex gap-0.5">
            <button onClick={() => window.open(currentUrl, '_blank')}
              className="p-1 rounded hover:bg-white/10 transition-colors" title="浏览器打开">
              <ExternalLink className="w-3.5 h-3.5" style={{ color: '#888' }} />
            </button>
          </div>
          <div className="flex-1 flex items-center gap-1 px-2 py-1 rounded-lg" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <Globe className="w-3 h-3 shrink-0" style={{ color: '#f59e0b' }} />
            <span className="text-[11px] truncate" style={{ color: '#666' }}>{currentUrl}</span>
          </div>
          <div className="flex gap-0.5">
            <button onClick={() => { setIframeLoading(true); setCurrentUrl(url) }} className="p-1 rounded hover:bg-white/10 transition-colors" title="刷新">
              <RefreshCw className="w-3 h-3" style={{ color: '#888' }} />
            </button>
          </div>
        </div>
      </div>
      {/* Iframe */}
      <div className="flex-1 relative">
        {iframeLoading && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: '#0a0a0f' }}>
            <div className="w-6 h-6 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(255,255,255,0.1)', borderTopColor: '#f59e0b' }} />
          </div>
        )}
        <iframe
          src={currentUrl}
          className="w-full h-full border-0"
          style={{ background: '#fff' }}
          onLoad={() => setIframeLoading(false)}
          // sandbox 不含 allow-same-origin：Agent 生成的 HTML 为不可信内容，禁止同源访问；若含相对路径资源会加载失败（独立源），未来可用 blob/data URL 渲染
          sandbox="allow-scripts"
        />
      </div>
    </div>
  )
}

// ─── 缩略图 ────────────────────────────────────────────
// 修复：此前 src 用相对路径 /api/files/read...——Electron file:// 协议下无法加载，
// 统一走 resolveApiUrl 补全（主进程 streamUrl 注入 token）
function ThumbImg({ path, className }: { path: string; className: string }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    let cancelled = false
    resolveApiUrl(`/api/files/read?path=${encodeURIComponent(path)}&thumb=1`)
      .then(u => { if (!cancelled) setUrl(u) })
      .catch(e => { console.warn('[FileBrowser] 缩略图地址解析失败:', e) })
    return () => { cancelled = true }
  }, [path])
  if (!url) return <div className={className} />
  return (
    <img src={url} alt="" className={className} loading="lazy"
      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
  )
}

// ─── 右键菜单 ──────────────────────────────────────────
function ContextMenu({ x, y, file, onClose, onAction }: { x: number; y: number; file: FileEntry; onClose: () => void; onAction: (action: string, file: FileEntry) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const click = () => onClose()
    document.addEventListener('click', click)
    return () => document.removeEventListener('click', click)
  }, [onClose])

  const items = [
    { icon: Eye, label: '预览', action: 'preview' },
    { icon: Download, label: '下载', action: 'download' },
    { icon: ExternalLink, label: '系统打开', action: 'system' },
    { icon: Copy, label: '复制路径', action: 'copypath' },
    { icon: MessageSquare, label: '引用到对话', action: 'reference' },
    { icon: Trash2, label: '删除', action: 'delete', danger: true },
  ]

  return (
    <div ref={ref} className="fixed z-50 rounded-xl py-1 shadow-2xl" style={{ left: x, top: y, minWidth: 160, background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(16px)' }}>
      {items.map(item => (
        <button key={item.action} onClick={() => onAction(item.action, file)}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors"
          style={{ color: item.danger ? '#ef4444' : '#ccc' }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <item.icon className="w-3.5 h-3.5" />
          {item.label}
        </button>
      ))}
    </div>
  )
}

// ─── 主组件 ────────────────────────────────────────────
export function FileBrowser({ onReferenceFile, onClose, onFilePreviewOpen }: {
  onReferenceFile?: (name: string, path: string) => void
  onClose?: () => void
  onFilePreviewOpen?: () => void
}) {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  // 2026-08-12 (搜索落地 4a 缺陷 2): 加载失败不再静默——置错误态,渲染可读文案 + 重试按钮
  //（此前接口挂掉时渲染"暂无生成文件",老板误以为没文件）
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState<FileCategory | 'all'>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sortKey, setSortKey] = useState<SortKey>('modifiedAt')
  const [sortAsc, setSortAsc] = useState(false)

  // Preview states
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [videoPreview, setVideoPreview] = useState<string | null>(null)
  const [audioPreview, setAudioPreview] = useState<string | null>(null)
  const [filePreview, setFilePreview] = useState<FilePreviewItem | null>(null)
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)

  // HTML built-in browser
  const [htmlViewer, setHtmlViewer] = useState<{ url: string; title: string } | null>(null)

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null)
  const { confirmNode, askConfirm } = useConfirm()

  // Refresh trigger
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  const mountedRef = useRef(true)
  // audio 播放引用——卸载时 pause（防组件卸载后音频继续播放）
  const audioPlayRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    return () => { audioPlayRef.current?.pause() }
  }, [])

  const loadFiles = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await apiGet('/api/files/list')
      if (res.success && res.data?.files) {
        if (mountedRef.current) setFiles(res.data.files)
      } else if (mountedRef.current) {
        // 业务层失败（HTTP 错误/接口返回 success:false）→ 错误态,原文进日志
        setLoadError(res.error || '文件服务返回异常')
        console.error('[FileBrowser] 加载文件列表失败:', res.error || 'success:false')
      }
    } catch (e: any) {
      // 网络层/代理层异常（apiGet 理论上归一为 success:false,此处兜底）
      if (mountedRef.current) {
        setLoadError(e?.message || String(e))
        console.error('[FileBrowser] 加载文件列表失败:', e?.message || e)
      }
    }
    finally { if (mountedRef.current) setLoading(false) }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    loadFiles()
    return () => { mountedRef.current = false }
  }, [loadFiles, refreshTrigger])

  const filtered = useMemo(() => {
    let list = files
    if (catFilter !== 'all') list = list.filter(f => categorize(f.ext) === catFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(f => f.name.toLowerCase().includes(q) || f.dir.toLowerCase().includes(q))
    }
    return list.sort((a, b) => {
      const dir = sortAsc ? 1 : -1
      if (sortKey === 'name') return a.name.localeCompare(b.name) * dir
      if (sortKey === 'size') return (a.size - b.size) * dir
      return (a.modifiedAt - b.modifiedAt) * dir
    })
  }, [files, search, catFilter, sortKey, sortAsc])

  const categories: { key: FileCategory | 'all'; label: string; count: number }[] = useMemo(() => {
    const cats: FileCategory[] = ['image','html','document','video','audio','archive','other']
    return [
      { key: 'all', label: '全部', count: files.length },
      ...cats.map(c => ({ key: c, label: CAT_LABELS[c], count: files.filter(f => categorize(f.ext) === c).length })),
    ]
  }, [files])

  const handleAction = async (action: string, f: FileEntry) => {
    setContextMenu(null)
    const baseUrl = await getApiBaseUrl()
    const resolvedUrl = `${baseUrl}/api/files/read?path=${encodeURIComponent(f.path)}`

    switch (action) {
      case 'preview': openFile(f); break
      case 'download': window.open(resolvedUrl, '_blank'); break
      case 'system':
        if (isElectron() && window.electronAPI?.file?.open) {
          await window.electronAPI.file.open(f.path)
        } else { window.open(resolvedUrl, '_blank') }
        break
      case 'copypath':
        navigator.clipboard.writeText(f.path)
        toast.success('路径已复制')
        break
      case 'reference':
        onReferenceFile?.(f.name, f.path)
        toast.success(`已引用: ${f.name}`)
        break
      case 'delete':
        if (!(await askConfirm({ title: '删除确认', message: `确定要删除文件「${f.name}」吗？此操作不可撤销。`, confirmLabel: '删除', danger: true }))) return
        try {
          const delRes = await apiDelete(`/api/files/delete?path=${encodeURIComponent(f.path)}`)
          if (delRes.success) {
            setFiles(prev => prev.filter(x => x.path !== f.path))
            toast.success('文件已删除')
          } else {
            toast.error('删除失败: ' + (delRes.error || '未知错误'))
          }
        } catch (e: any) {
          toast.error('删除失败: ' + (e.message || '网络错误'))
        }
        break
    }
  }

  const openFile = async (f: FileEntry) => {
    const cat = categorize(f.ext)
    const baseUrl = await getApiBaseUrl()
    const resolvedUrl = `${baseUrl}/api/files/read?path=${encodeURIComponent(f.path)}`
    const ext = f.ext.toLowerCase()

    // 通知外部（Dashboard）关闭自身的预览状态，防止叠加
    onFilePreviewOpen?.()

    if (cat === 'image') { setImagePreview(resolvedUrl); return }
    if (cat === 'video') { setVideoPreview(resolvedUrl); return }
    if (cat === 'audio') {
      // 修复：此前 new Audio 后不留引用——切换/卸载时旧音频仍在播放
      if (audioPlayRef.current) audioPlayRef.current.pause()
      const audio = new Audio(resolvedUrl)
      audioPlayRef.current = audio
      audio.play().catch(e => { console.warn('[FileBrowser] 音频播放失败:', e) })
      return
    }
    if (cat === 'html') {
      setHtmlViewer({ url: resolvedUrl, title: f.name })
      return
    }
    // MD 文件：应用内渲染预览
    if (ext === 'md') {
      try {
        const res = await apiGet(`/api/preview/markdown?path=${encodeURIComponent(f.path)}`)
        if (res.success && res.data?.html) {
          setFilePreview({ type: 'document', name: f.name, path: f.path, size: f.size })
          setPreviewHtml(res.data.html)
          return
        }
      } catch { console.warn('[FileBrowser] markdown preview failed, fallback to system open') }
    }
    // 其他文件：系统应用打开
    if (isElectron() && window.electronAPI?.file?.open) {
      await window.electronAPI.file.open(f.path)
      return
    }
    window.open(resolvedUrl, '_blank')
  }

  const handleContextMenu = (e: React.MouseEvent, f: FileEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, file: f })
  }

  const getColor = (f: FileEntry): string => {
    const c = categorize(f.ext)
    return EXT_COLORS[f.ext.toLowerCase()] || CAT_COLORS[c] || '#6b7280'
  }

  // ─── HTML 内置浏览器 ───
  // （渲染为浮层叠加在文件列表上方）

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
      {confirmNode}
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b shrink-0" style={{ borderColor: 'var(--border-primary)' }}>
        <span className="text-sm font-semibold theme-text-primary flex items-center gap-2">
          <FolderOpen className="w-4 h-4" />
          生成文件
          <span className="text-[10px] font-normal theme-text-muted ml-1">({files.length})</span>
        </span>
        <div className="flex items-center gap-1">
          <button onClick={() => setRefreshTrigger(t => t + 1)} className="p-1.5 rounded-lg hover:theme-bg-tertiary transition-colors" title="刷新">
            <RefreshCw className="w-3.5 h-3.5 theme-text-muted" />
          </button>
          <button onClick={() => setViewMode(v => v === 'list' ? 'grid' : 'list')} className="p-1.5 rounded-lg hover:theme-bg-tertiary transition-colors" title={viewMode === 'list' ? '网格视图' : '列表视图'}>
            {viewMode === 'list' ? <LayoutGrid className="w-3.5 h-3.5 theme-text-muted" /> : <List className="w-3.5 h-3.5 theme-text-muted" />}
          </button>
          {onClose && (
            <button onClick={onClose} className="p-1.5 rounded-lg hover:theme-bg-tertiary transition-colors">
              <X className="w-3.5 h-3.5 theme-text-muted" />
            </button>
          )}
        </div>
      </div>

      {/* Search + Filter */}
      <div className="px-3 py-2 space-y-2 border-b shrink-0" style={{ borderColor: 'var(--border-primary)' }}>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 theme-text-muted" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索文件名或路径..." className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg theme-input" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {categories.map(c => (
            <button key={c.key} onClick={() => setCatFilter(c.key)}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all ${
                catFilter === c.key ? 'text-white shadow-sm' : 'theme-text-muted hover:theme-bg-tertiary'
              }`}
              style={catFilter === c.key ? { background: CAT_COLORS[c.key as FileCategory] || '#3b82f6' } : {}}>
              {c.label} <span className="opacity-60">{c.count}</span>
            </button>
          ))}
        </div>
        {/* Sort bar */}
        <div className="flex items-center gap-3 text-[10px] theme-text-muted">
          <span>排序:</span>
          {(['modifiedAt', 'name', 'size'] as SortKey[]).map(key => (
            <button key={key} onClick={() => { if (sortKey === key) setSortAsc(!sortAsc); else { setSortKey(key); setSortAsc(key === 'modifiedAt' ? false : true) } }}
              className="flex items-center gap-0.5 hover:theme-text-primary transition-colors">
              {sortKey === key && (sortAsc ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />)}
              {key === 'modifiedAt' ? '修改时间' : key === 'name' ? '名称' : '大小'}
            </button>
          ))}
        </div>
      </div>

      {/* File List */}
      <div className="flex-1 overflow-y-auto px-2 py-1"
        onContextMenu={e => e.preventDefault()}>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: 'var(--border-primary)', borderTopColor: 'var(--accent-primary)' }} />
          </div>
        ) : loadError ? (
          /* 2026-08-12 (搜索落地 4a 缺陷 2): 加载失败错误态——与空态区分,可重试 */
          <div className="text-center py-16">
            <AlertTriangle className="w-10 h-10 mx-auto mb-2" style={{ color: '#ef4444', opacity: 0.6 }} />
            <p className="text-xs theme-text-muted">加载失败：{loadError}</p>
            <button
              type="button"
              onClick={() => { void loadFiles() }}
              className="mt-3 px-4 py-1.5 text-xs rounded-lg text-white transition-colors"
              style={{ background: 'var(--accent-primary)' }}
              title="重新加载文件列表"
            >
              重试
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <FileText className="w-10 h-10 mx-auto mb-2 theme-text-muted opacity-30" />
            <p className="text-xs theme-text-muted">{files.length === 0 ? '暂无生成文件' : '没有匹配的文件'}</p>
          </div>
        ) : viewMode === 'list' ? (
          <div className="space-y-0.5">
            {filtered.map(f => {
              const cat = categorize(f.ext)
              const color = getColor(f)
              const Icon = CAT_ICONS[cat]
              return (
                <div key={f.path} onClick={() => openFile(f)}
                  onContextMenu={e => handleContextMenu(e, f)}
                  className="flex items-center gap-3 px-2.5 py-2 rounded-lg cursor-pointer transition-all group"
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  {/* Thumbnail or Icon */}
                  {cat === 'image' ? (
                    <ThumbImg path={f.path} className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}15` }}>
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium theme-text-primary truncate group-hover:theme-accent transition-colors">{f.name}</p>
                    <div className="flex items-center gap-2.5 mt-0.5 text-[10px] theme-text-muted">
                      <span>{formatSize(f.size)}</span>
                      <span className="w-1 h-1 rounded-full theme-bg-tertiary" />
                      <span className="flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{formatTime(f.modifiedAt)}</span>
                    </div>
                  </div>
                  {/* Quick action buttons */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={e => { e.stopPropagation(); handleAction('preview', f) }}
                      className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="预览">
                      <Eye className="w-3 h-3 theme-text-muted" />
                    </button>
                    {onReferenceFile && (
                      <button onClick={e => { e.stopPropagation(); handleAction('reference', f) }}
                        className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="引用到对话">
                        <MessageSquare className="w-3 h-3 theme-text-muted" />
                      </button>
                    )}
                    <button onClick={e => { e.stopPropagation(); handleAction('copypath', f) }}
                      className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="复制路径">
                      <Copy className="w-3 h-3 theme-text-muted" />
                    </button>
                  </div>
                  <ExternalLink className="w-3 h-3 theme-text-muted opacity-0 group-hover:opacity-40 transition-opacity flex-shrink-0" />
                </div>
              )
            })}
          </div>
        ) : (
          /* Grid View */
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 p-1">
            {filtered.map(f => {
              const cat = categorize(f.ext)
              const color = getColor(f)
              const Icon = CAT_ICONS[cat]
              return (
                <div key={f.path} onClick={() => openFile(f)}
                  onContextMenu={e => handleContextMenu(e, f)}
                  className="rounded-xl p-3 cursor-pointer transition-all hover:scale-[1.02] group"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
                  {cat === 'image' ? (
                    <ThumbImg path={f.path} className="w-full aspect-square rounded-lg object-cover mb-2" />
                  ) : (
                    <div className="w-full aspect-square rounded-lg flex items-center justify-center mb-2" style={{ background: `${color}10` }}>
                      <Icon className="w-8 h-8" style={{ color }} />
                    </div>
                  )}
                  <p className="text-xs font-medium theme-text-primary truncate">{f.name}</p>
                  <p className="text-[10px] theme-text-muted mt-0.5">{formatSize(f.size)}</p>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} file={contextMenu.file}
          onClose={() => setContextMenu(null)}
          onAction={handleAction} />
      )}

      {/* HTML 内置浏览器浮层（叠加在文件列表上方） */}
      {htmlViewer && (
        <HtmlViewer url={htmlViewer.url} title={htmlViewer.title} onClose={() => setHtmlViewer(null)} />
      )}

      {/* Preview Modal */}
      <FilePreviewModal imagePreview={imagePreview} videoPreview={videoPreview}
        audioPreview={audioPreview}
        filePreview={filePreview} mdPreviewHtml={previewHtml}
        onCloseImage={() => setImagePreview(null)}
        onCloseVideo={() => setVideoPreview(null)}
        onCloseAudio={() => setAudioPreview(null)}
        onCloseFile={() => { setFilePreview(null); setPreviewHtml(null) }}
        extractLocalPath={url => {
          if (url.startsWith('/api/files/read?path=')) return decodeURIComponent(url.replace('/api/files/read?path=', ''))
          if (isElectron()) return url
          return null
        }}
        openWithSystemPlayer={async (url) => {
          if (isElectron() && window.electronAPI?.file?.open) {
            const path = decodeURIComponent(url.replace('/api/files/read?path=', ''))
            await window.electronAPI.file.open(path)
          }
        }} />
    </div>
  )
}
