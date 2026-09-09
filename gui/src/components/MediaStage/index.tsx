import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Music, Image, Film } from 'lucide-react'

export interface MediaItem {
  id: string
  type: 'image' | 'video' | 'music'
  title?: string
  url?: string
  thumbnail?: string
  source?: string
  artist?: string
  cover?: string
  lrc?: string
  autoplay?: boolean
  muted?: boolean
}

interface MediaStageProps {
  items?: MediaItem[]
  onClose?: () => void
}

function nameToColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  const h = hash % 360
  return `hsl(${Math.abs(h)}, 65%, 35%)`
}

export function MediaStage({ items = [], onClose }: MediaStageProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [muted, setMuted] = useState(false)
  const [imageScale, setImageScale] = useState(1) // MD1: zoom level for image viewer
  // 2026-08-16: 视频加载失败可见反馈——CSP/防盗链/断网失败此前是静默黑屏
  const [videoError, setVideoError] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)

  const active = items[activeIndex]

  // 2026-08-15 修复: 音频 src 此前直接用 surface url——Electron 渲染进程直连后端
  // 音频端口被 webSecurity 跨源策略拦截, 音乐无法播放。复刻 FMP 的
  // resolveAudioUrlViaMain: 优先经主进程 streamUrl 注入 token 转发, 失败降级直连。
  const resolveAudioUrlViaMain = useCallback(async (url: string): Promise<string> => {
    if (!url) return url
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) return url
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.api?.streamUrl) {
        const info = await window.electronAPI.api.streamUrl(url)
        if (info?.url) return info.url
      }
    } catch (e) {
      console.warn('[MediaStage] streamUrl 解析失败,降级直连:', e)
    }
    return 'http://localhost:38767' + (url.startsWith('/') ? url : '/' + url)
  }, [])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (playing && active?.type === 'music' && active.url) {
      let cancelled = false
      resolveAudioUrlViaMain(active.url).then((resolvedUrl) => {
        if (cancelled) return
        if (a.src !== resolvedUrl) a.src = resolvedUrl
        a.play().catch(() => setPlaying(false))
      })
      return () => { cancelled = true }
    } else {
      a.pause()
    }
  }, [playing, active?.type, active?.url, resolveAudioUrlViaMain])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    a.volume = muted ? 0 : 1
  }, [muted])

  // 切换媒体项时清除视频错误态(src 已变, 旧的失败提示不应残留)
  useEffect(() => {
    setVideoError(false)
  }, [activeIndex, active?.url])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (active?.type === 'video' && active.autoplay !== false) {
      // 2026-08-16 审计: 空 catch → console.warn(加载失败/自动播放被拒不可静默)。
      // 加载失败另走 video onError 显示可见提示; play 被拒(极罕见,Electron 已放开
      // autoplay-policy)仅告警——原生控制条仍可手动播放,不弹错误横幅。
      v.play().catch((err: unknown) => {
        console.warn('[MediaStage] 视频自动播放被拒绝:', err instanceof Error ? err.message : String(err))
      })
    }
  }, [active])

  // MD1: wheel zoom for image viewer, capped to 0.1x–10x
  useEffect(() => {
    const container = imageContainerRef.current
    if (!container) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      setImageScale(prev => {
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
        return Math.max(0.1, Math.min(10, prev * factor))
      })
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [active?.type, active?.url])

  // Reset zoom when switching images
  useEffect(() => {
    setImageScale(1)
  }, [activeIndex])

  const togglePlay = () => {
    setPlaying(!playing)
  }

  // 2026-08-15: 常驻宿主化——可见性由 MediaStageHost(SideSheet)控制,
  // 本组件只渲染内容; 无 items 早退(必须位于全部 hooks 之后, Rules of Hooks)
  if (items.length === 0) {
    return null
  }

  const coverBg = active?.title ? nameToColor(active.title) : 'var(--bg-tertiary)'

  const slideDirection = active?.type === 'image' ? 'left' : 'right'

  return (
    <div
      // 2026-08-16: fitContent 浮动卡容器——flex-1 min-h-0 与 FMP 同构,
      // 高度内容驱动, 超 100vh-32 时内部收缩不溢出
      className="flex flex-col flex-1 min-h-0 overflow-hidden"
      style={{
        width: '100%',
        background: 'rgba(20, 20, 28, 0.95)',
        // 2026-08-22 修复「播放视频→GUI 黑屏」: 移除 backdrop-filter blur。
        // 75vw 大面板上的 blur(24px) 触发 GPU 合成层巨型化(面板+视频层+模糊层),
        // 部分驱动/合成器下整个窗口停止绘制(JS 正常,页面黑屏,无崩溃无报错)。
        // 面板背景 0.95 不透明度本就把模糊效果几乎完全遮挡,视觉无损。
      }}
    >
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(${slideDirection === 'left' ? '-100%' : '100%'}); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes vinyl-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulse-glow {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
      `}</style>

      <audio
        ref={audioRef}
        onTimeUpdate={() => {
          // 2026-08-14 审计: onTimeUpdate 高频 setState 加 1s 门控
          // (参照 FloatingMusicPlayer R10 做法——变化 ≥1s 才更新进度,进度条精度 1s 足够)
          const t = audioRef.current?.currentTime || 0
          setProgress(prev => Math.abs(prev - t) >= 1 ? t : prev)
        }}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
        onEnded={() => {
          if (activeIndex < items.length - 1) {
            setActiveIndex(activeIndex + 1)
            setPlaying(true)
          } else {
            setPlaying(false)
          }
        }}
      />

      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          {active?.type === 'image' && <Image className="w-4 h-4 theme-accent" />}
          {active?.type === 'video' && <Film className="w-4 h-4 theme-accent" />}
          {active?.type === 'music' && <Music className="w-4 h-4 theme-accent" />}
          <span className="text-sm font-semibold theme-text-primary">
            {active?.type === 'image' ? '图片' : active?.type === 'video' ? '视频' : '音乐'}
          </span>
        </div>
        <button
          onClick={onClose}
          data-close-btn
          aria-label="关闭媒体面板"
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors"
        >
          <X className="w-4 h-4 theme-text-muted" />
        </button>
      </div>

      {items.length > 1 && (
        <div className="flex gap-2 px-4 py-3 overflow-x-auto border-b border-white/10">
          {items.map((item, i) => (
            <button
              key={item.id}
              onClick={() => {
                setActiveIndex(i)
                setProgress(0)
                setDuration(0)
                if (item.type === 'music') setPlaying(true)
              }}
              aria-label={`查看${item.title ? `「${item.title}」` : `第 ${i + 1} 项媒体`}`}
              className={`flex-shrink-0 w-16 h-12 rounded-lg overflow-hidden border-2 transition-all ${
                i === activeIndex ? 'border-accent-primary' : 'border-transparent opacity-60 hover:opacity-100'
              }`}
            >
              {item.thumbnail ? (
                <img src={item.thumbnail} alt={item.title || ''} className="w-full h-full object-cover" />
              ) : (
                <div
                  className="w-full h-full flex items-center justify-center text-lg"
                  style={{ background: item.type === 'music' ? nameToColor(item.title || '') : 'rgba(255,255,255,0.08)' }}
                >
                  {item.type === 'image' ? '🖼' : item.type === 'video' ? '🎬' : '🎵'}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {/* 2026-08-16: p-6 → px-4 py-2——水平边距与 header/缩略图/底部统一为 16px(边距平衡) */}
      <div className="flex-1 flex items-center justify-center px-4 py-2 min-h-0">
        {active?.type === 'image' && active.url && (
          <div ref={imageContainerRef} className="relative w-full h-full flex items-center justify-center overflow-auto">
            <img
              src={active.url}
              alt={active.title || ''}
              className="rounded-xl shadow-2xl"
              // 2026-08-16: fitContent 下 maxHeight 55vh——超大原图不再撑爆/裁切浮动卡
              style={{ transform: `scale(${imageScale})`, objectFit: 'contain', maxWidth: '100%', maxHeight: '55vh' }}
            />
          </div>
        )}

        {active?.type === 'image' && !active.url && (
          <div className="text-center theme-text-muted text-sm">
            无图片源
          </div>
        )}

        {active?.type === 'video' && active.url && (
          // 2026-08-16: 16:9 紧凑块(音乐卡封面同构, 内容驱动高度)——w-full aspect-video
          // 由卡片宽度定高, 高度收缩 ~60%(原 flex-1 撑满全高 Sheet), 黑底 letterbox 承载任意比例
          <div className="w-full aspect-video rounded-xl overflow-hidden bg-black shadow-2xl relative">
            <video
              ref={videoRef}
              controls
              // 2026-08-16 审计: SideSheet draggable 豁免名单无 video——点击视频暂停/播放
              // 会同时拖动面板; data-no-drag 让出点击区(视频区域不参与拖拽)
              data-no-drag
              className="w-full h-full object-contain"
              src={active.url}
              muted={active.muted}
              onError={() => {
                console.warn('[MediaStage] 视频加载失败:', active.url)
                setVideoError(true)
              }}
              onEnded={() => {
                // 2026-08-16 审计: 与 audio 对齐——视频播完自动切下一项
                if (activeIndex < items.length - 1) {
                  setActiveIndex(activeIndex + 1)
                  setPlaying(true)
                } else {
                  setPlaying(false)
                }
              }}
            />
            {videoError && (
              // pointer-events-none: 提示条只作信息展示, 不拦截下层原生控制条的重试点击
              <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-4 pointer-events-none">
                <div className="text-center">
                  <p className="text-sm theme-text-primary mb-1">视频加载失败</p>
                  <p className="text-xs theme-text-muted">可能是网络问题或该视频源需登录/防盗链限制，点击播放器重试</p>
                </div>
              </div>
            )}
          </div>
        )}

        {active?.type === 'music' && (
          <div className="text-center w-full flex flex-col items-center">
            {/* ── 唱片机转盘 ── */}
            <div className="relative w-44 h-44 mx-auto mb-4 flex-shrink-0">
              {/* 黑胶唱片 */}
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  background: 'radial-gradient(circle at 50% 50%, #222 0%, #111 38%, #0a0a0a 65%, #141414 100%)',
                  boxShadow: '0 0 0 2px rgba(255,255,255,0.04), 0 6px 32px rgba(0,0,0,0.65)',
                  animation: playing ? 'vinyl-spin 1.8s linear infinite' : 'none',
                }}
              >
                {/* 刻槽同心圆 */}
                <div className="absolute rounded-full border border-white/5 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '91%', height: '91%' }} />
                <div className="absolute rounded-full border border-white/5 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '76%', height: '76%' }} />
                <div className="absolute rounded-full border border-white/5 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '61%', height: '61%' }} />
                <div className="absolute rounded-full border border-white/5 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '46%', height: '46%' }} />
                
                {/* 中心封面标签 */}
                <div
                  className="absolute w-[32%] h-[32%] rounded-full top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center overflow-hidden z-10"
                  style={{ background: coverBg, backgroundSize: 'cover', backgroundPosition: 'center' }}
                >
                  <div className="text-[8px] font-semibold text-white/90 text-center leading-tight px-0.5 overflow-hidden max-w-full text-ellipsis whitespace-nowrap">
                    {active.title?.slice(0, 14) || '♪'}
                  </div>
                  {active.artist && (
                    <div className="text-[7px] text-white/55 text-center px-0.5 overflow-hidden max-w-full text-ellipsis whitespace-nowrap">
                      {active.artist}
                    </div>
                  )}
                </div>
                
                {/* 中心轴 */}
                <div className="absolute w-[7px] h-[7px] rounded-full bg-[#2a2a2a] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 shadow-[0_0_0_1px_rgba(255,255,255,0.12)]" />
              </div>
              
              {/* 播放光效 */}
              {playing && (
                <div
                  className="absolute inset-0 rounded-full pointer-events-none"
                  style={{
                    background: `radial-gradient(circle at center, ${coverBg}44 0%, transparent 70%)`,
                    animation: 'pulse-glow 2s ease-in-out infinite',
                  }}
                />
              )}
              
              {/* ── 唱臂 ── */}
              <div
                className="absolute z-30"
                style={{
                  right: '-8px',
                  top: '-8px',
                  width: '80px',
                  height: '170px',
                  transformOrigin: '38px 20px',
                  transform: playing ? 'rotate(3deg)' : 'rotate(24deg)',
                  transition: 'transform 1.6s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                {/* 唱臂转轴 */}
                <div className="absolute w-[14px] h-[14px] rounded-full bg-gray-600 top-[13px] left-[31px] shadow-[0_0_0_2px_rgba(255,255,255,0.08),0_2px_6px_rgba(0,0,0,0.5)] z-20" />
                {/* 唱臂杆 */}
                <div className="absolute w-[3px] bg-gradient-to-b from-gray-600 to-gray-600/70 top-[20px] left-[38px] h-[106px] rounded-sm -skew-x-2" />
                {/* 唱头壳 */}
                <div className="absolute w-[14px] h-[8px] bg-gray-600/85 rounded-t-sm rounded-b-md bottom-[40px] left-[32px]" />
                {/* 唱针 */}
                <div className="absolute w-[2px] h-[7px] bg-gray-400 rounded-b-sm bottom-[-7px] left-1/2 -translate-x-1/2" />
              </div>
            </div>
            
            <div className="text-lg font-semibold theme-text-primary truncate max-w-[90%]">{active.title || '未知曲目'}</div>
            {active.artist && <div className="text-sm theme-text-muted mt-0.5">{active.artist}</div>}

            {/* ── LRC 歌词同步显示 ── */}
            {active.lrc && (() => {
              const lines = (active.lrc || '').split('\n').map(line => {
                const m = line.match(/\[(\d+):(\d{1,2}(?:\.\d+)?)\](.*)/)
                return m ? { time: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() } : null
              }).filter(Boolean)
              const currentLine = lines.reduce((prev, line, i) => {
                return line!.time <= progress + 0.3 ? i : prev
              }, -1)
              return lines.length > 0 ? (
                <div className="mt-3 w-full max-h-[140px] overflow-y-auto px-4 scroll-smooth" style={{ scrollbarWidth: 'thin' }}>
                  {lines.map((line, i) => (
                    <div key={i} ref={i === currentLine ? (el: any) => el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }) : undefined}
                      style={{
                        fontSize: i === currentLine ? '13px' : '11px',
                        fontWeight: i === currentLine ? 600 : 400,
                        color: i === currentLine ? '#fff' : '#888',
                        padding: '3px 0',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {line!.text || '♪'}
                    </div>
                  ))}
                </div>
              ) : null
            })()}
          </div>
        )}
      </div>

      {active?.type === 'music' && (
        // 2026-08-16: px-6 → px-4——唯一剩余的水平边距失衡点, 统一 16px
        <div className="px-4 pb-3">
          <div className="h-1.5 rounded-full bg-white/10 overflow-hidden mb-2">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${duration > 0 ? (progress / duration) * 100 : 0}%`, background: 'var(--accent-primary)' }}
            />
          </div>
          <div className="flex justify-between text-xs theme-text-muted mb-4">
            <span>{Math.floor(progress / 60)}:{String(Math.floor(progress % 60)).padStart(2, '0')}</span>
            <span>{duration ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}` : '--:--'}</span>
          </div>
          <div className="flex items-center justify-center gap-4">
            <button
              onClick={() => activeIndex > 0 && setActiveIndex(activeIndex - 1)}
              disabled={activeIndex <= 0}
              className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 transition-colors"
            >
              <SkipBack className="w-5 h-5 theme-text-secondary" />
            </button>
            <button
              onClick={togglePlay}
              className="w-12 h-12 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95"
              style={{ background: 'var(--accent-primary)' }}
            >
              {playing ? <Pause className="w-6 h-6 text-white" /> : <Play className="w-6 h-6 text-white ml-0.5" />}
            </button>
            <button
              onClick={() => activeIndex < items.length - 1 && setActiveIndex(activeIndex + 1)}
              disabled={activeIndex >= items.length - 1}
              className="p-2 rounded-lg hover:bg-white/10 disabled:opacity-30 transition-colors"
            >
              <SkipForward className="w-5 h-5 theme-text-secondary" />
            </button>
            <button
              onClick={() => setMuted(!muted)}
              className="p-2 rounded-lg hover:bg-white/10 transition-colors"
            >
              {muted ? <VolumeX className="w-4 h-4 theme-text-muted" /> : <Volume2 className="w-4 h-4 theme-text-muted" />}
            </button>
          </div>
        </div>
      )}

      {active?.type !== 'music' && active?.title && (
        <div className="px-4 pb-4 text-center">
          <div className="text-sm theme-text-secondary truncate">{active.title}</div>
          {active.source && <div className="text-xs theme-text-muted mt-0.5">{active.source}</div>}
        </div>
      )}
    </div>
  )
}