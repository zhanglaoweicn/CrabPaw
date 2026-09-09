import { X, ExternalLink, Play, ZoomIn, ZoomOut, RotateCw, Maximize2, Minimize2, Music } from 'lucide-react'
import { useState, useCallback, useRef } from 'react'
import { isElectron } from '../../lib/api'
import { sanitizeHtml } from '../../lib/sanitize'

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

export interface FilePreviewItem {
  type: string
  path: string
  name: string
  size?: number
  mdSourcePath?: string
}

interface Props {
  imagePreview: string | null
  videoPreview: string | null
  filePreview: FilePreviewItem | null
  mdPreviewHtml: string | null
  audioPreview: string | null
  onCloseImage: () => void
  onCloseVideo: () => void
  onCloseFile: () => void
  onCloseAudio: () => void
  extractLocalPath: (url: string) => string | null
  openWithSystemPlayer: (url: string) => Promise<void>
}

function ImagePreviewWithZoom({ src, onClose }: { src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [isFullSize, setIsFullSize] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const imgRef = useRef<HTMLImageElement>(null)

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      const factor = e.deltaY * 0.01
      setZoom(z => Math.max(0.1, Math.min(5, z - factor)))
    } else if (zoom > 1) {
      setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
    }
  }, [zoom])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (zoom > 1) {
      setIsDragging(true)
      dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    }
  }, [zoom, pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging || zoom <= 1) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }, [isDragging, zoom])

  const handleMouseUp = useCallback(() => setIsDragging(false), [])

  const toggleFullSize = () => {
    setIsFullSize(f => !f)
    if (!isFullSize) { setZoom(1); setPan({ x: 0, y: 0 }) }
  }

  const resetZoom = () => { setZoom(1); setPan({ x: 0, y: 0 }); setRotation(0) }

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/80" onClick={onClose}
      onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
      <div className="relative flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
        {/* 顶部工具栏 */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-3 py-1.5 rounded-full bg-black/60 text-white select-none">
          <button onClick={() => setZoom(z => Math.max(0.1, z - 0.25))} className="p-1 hover:bg-white/20 rounded"><ZoomOut className="w-4 h-4" /></button>
          <span className="text-xs min-w-[3rem] text-center select-none">{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom(z => Math.min(5, z + 0.25))} className="p-1 hover:bg-white/20 rounded"><ZoomIn className="w-4 h-4" /></button>
          <span className="w-px h-4 bg-white/30 mx-1" />
          <button onClick={() => setRotation(r => (r + 90) % 360)} className="p-1 hover:bg-white/20 rounded" title="旋转"><RotateCw className="w-4 h-4" /></button>
          <button onClick={toggleFullSize} className="p-1 hover:bg-white/20 rounded" title={isFullSize ? '适应窗口' : '原始尺寸'}>
            {isFullSize ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
          {zoom !== 1 && <button onClick={resetZoom} className="p-1 hover:bg-white/20 rounded text-xs" title="重置">重置</button>}
          <span className="w-px h-4 bg-white/30 mx-1" />
          <button onClick={() => window.open(src, '_blank')} className="p-1 hover:bg-white/20 rounded" title="在新窗口打开"><ExternalLink className="w-4 h-4" /></button>
          <button onClick={onClose} className="p-1 hover:bg-white/20 rounded" title="关闭"><X className="w-4 h-4" /></button>
        </div>

        {/* 加载骨架占位 */}
        {!isLoaded && (
          <div className="flex items-center justify-center rounded-lg" style={{ width: 400, height: 300 }}>
            <div className="animate-pulse flex flex-col items-center gap-2 text-white/40">
              <div className="w-12 h-12 rounded-full bg-white/10" />
              <span className="text-xs">加载中...</span>
            </div>
          </div>
        )}

        <div style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
          maxWidth: isFullSize ? 'none' : '90vw',
          maxHeight: isFullSize ? 'none' : '90vh',
          display: isLoaded ? 'block' : 'none',
          cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
        }}>
          <img
            ref={imgRef}
            src={src} alt="图片预览"
            onLoad={() => setIsLoaded(true)}
            onWheel={handleWheel}
            onMouseDown={handleMouseDown}
            draggable={false}
            className="rounded-lg transition-none select-none block max-w-full max-h-full"
          />
        </div>

        {/* 缩放提示 */}
        {zoom > 1 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-2 py-1 rounded bg-black/50 text-white text-[10px] pointer-events-none select-none">
            拖拽平移 · Ctrl+滚轮缩放
          </div>
        )}
      </div>
    </div>
  )
}

export function FilePreviewModal({
  imagePreview, videoPreview, filePreview, mdPreviewHtml, audioPreview,
  onCloseImage, onCloseVideo, onCloseFile, onCloseAudio,
  extractLocalPath, openWithSystemPlayer,
}: Props) {
  return (
    <>
      {imagePreview && <ImagePreviewWithZoom src={imagePreview} onClose={onCloseImage} />}

      {videoPreview && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/80" onClick={onCloseVideo}>
          <div className="relative max-w-[90vw] max-h-[90vh]">
            <video src={videoPreview} className="max-w-full max-h-[85vh] rounded-lg" controls autoPlay onClick={(e) => e.stopPropagation()}>您的浏览器不支持视频播放</video>
            <button onClick={onCloseVideo} className="absolute top-2 right-2 p-2 rounded-full bg-black/50 text-white hover:bg-black/70"><X className="w-6 h-6" /></button>
            <div className="absolute bottom-2 right-2 flex gap-1">
              {isElectron() && extractLocalPath(videoPreview) && (
                <button onClick={() => openWithSystemPlayer(videoPreview)} className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70" title="用系统播放器打开"><Play className="w-5 h-5" /></button>
              )}
              <button onClick={() => window.open(videoPreview, '_blank')} className="p-2 rounded-full bg-black/50 text-white hover:bg-black/70" title="在新窗口打开"><ExternalLink className="w-5 h-5" /></button>
            </div>
          </div>
        </div>
      )}

      {filePreview && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/80" onClick={onCloseFile}>
          <div className="relative rounded-xl shadow-2xl w-full mx-4 flex flex-col overflow-hidden"
            style={{ backgroundColor: 'var(--bg-card)', maxWidth: mdPreviewHtml ? '900px' : '420px', maxHeight: '85vh', border: '1px solid var(--border-primary)' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: 'var(--border-primary)' }}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-lg flex-shrink-0">{filePreview.type === 'docx' ? '📄' : filePreview.type === 'pdf' ? '📕' : filePreview.type === 'html' ? '🌐' : '📁'}</span>
                <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{filePreview.name}</h3>
                {filePreview.size != null && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-muted)' }}>
                    {formatSize(filePreview.size)}
                  </span>
                )}
              </div>
              <button onClick={onCloseFile} className="p-1.5 rounded-full hover:opacity-70 transition-colors flex-shrink-0" style={{ color: 'var(--text-secondary)' }}><X className="w-4 h-4" /></button>
            </div>
            {mdPreviewHtml && (
              <div className="flex-1 overflow-auto px-6 py-4 min-h-0">
                <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: sanitizeHtml(mdPreviewHtml) }} />
              </div>
            )}
          </div>
        </div>
      )}

      {audioPreview && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/80" onClick={onCloseAudio}>
          <div className="relative rounded-xl p-6 max-w-md w-full mx-4"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Music className="w-5 h-5" style={{ color: '#10b981' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>音频播放</span>
              </div>
              <button onClick={onCloseAudio} className="p-1.5 rounded-full hover:opacity-70 transition-colors" style={{ color: 'var(--text-secondary)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <audio src={audioPreview} controls autoPlay className="w-full" style={{ outline: 'none' }}>
              您的浏览器不支持音频播放
            </audio>
          </div>
        </div>
      )}
    </>
  )
}
