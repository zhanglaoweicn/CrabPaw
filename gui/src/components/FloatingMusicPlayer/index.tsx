/**
 * FloatingMusicPlayer — 浮动音乐播放器
 *
 * AI 唤起式播放器。用户在聊天中说"放首歌" → AI 调用工具 → 此面板浮出。
 * 浮动在聊天区右侧，不打断对话流程。Escape 或 X 关闭。
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Search, Music, X, Repeat, Shuffle } from 'lucide-react'
import { apiGet, apiPost } from '../../lib/api'
import { SideSheet } from '../SideSheet'
import { useSceneSurfaces } from '../../lib/scene-client'
import { playSound } from '../../hooks/useSoundEffects'
import { computeNextTrack, resolveMusicControl, normalizeNetEaseOuterUrl } from '../../lib/music-player-logic'
import { registerCommandHost } from '../../lib/ui-command-registry'

interface Track {
  id: string
  title: string
  artist?: string
  url?: string
  duration?: number
  cover?: string
  lrc?: string
}

interface FloatingMusicPlayerProps {
  visible: boolean
  onClose: () => void
  initialQuery?: string
  /** 2026-08-15: 查询 nonce——同 query 重复请求（再次说"放周杰伦的歌"）React 相同
   * state 不触发重渲染 → initialQuery effect 不重跑。nonce 变化强制重新搜索。 */
  queryNonce?: number
}

interface LyricLine {
  time: number
  text: string
}

/** FM1: detect if text has mojibake (garbled Chinese from wrong encoding) */
function detectMojibake(text: string): boolean {
  // Common mojibake patterns: replacement character U+FFFD, or sequences of
  // Latin-1 Supplement characters that indicate GBK misread as UTF-8
  if (text.includes('\uFFFD')) return true
  // Check for common GBK-as-UTF-8 mojibake: sequences of Ã, Â, Ä etc. followed by lowercase
  const mojibakePattern = /[\u00C0-\u00DF][\u0080-\u00BF]{1,2}/
  return mojibakePattern.test(text)
}

/** FM1: try to fix encoding for Chinese lyrics — attempt TextDecoder with GBK fallback */
function tryFixEncoding(text: string): string {
  if (!detectMojibake(text)) return text
  // In browser, we can't easily re-encode from string. If the text came from
  // a binary source, we would use TextDecoder('gbk'). Here we mark it as
  // potentially garbled and return as-is — the backend should handle encoding.
  // If raw bytes are available, use: new TextDecoder('gbk').decode(uint8array)
  console.warn('[FloatingMusicPlayer] Lyrics may have encoding issues (possible GBK/GB2312 misread as UTF-8)')
  return text
}

function parseLRC(lrc: string): LyricLine[] {
  const lines = lrc.split('\n')
  const result: LyricLine[] = []
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/
  
  for (const line of lines) {
    const match = line.match(timeRegex)
    if (match) {
      const minutes = parseInt(match[1], 10)
      const seconds = parseInt(match[2], 10)
      const milliseconds = parseInt(match[3].padEnd(3, '0'), 10)
      const time = minutes * 60 + seconds + milliseconds / 1000
      const text = line.replace(timeRegex, '').trim()
      if (text) {
        result.push({ time, text })
      }
    }
  }
  
  return result.sort((a, b) => a.time - b.time)
}

function nameToColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  const h = hash % 360
  return `hsl(${Math.abs(h)}, 65%, 35%)`
}

export function FloatingMusicPlayer({ visible, onClose, initialQuery, queryNonce }: FloatingMusicPlayerProps) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolume] = useState(0.5)
  const [muted, setMuted] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [repeatMode, setRepeatMode] = useState<'off' | 'one' | 'all'>('all')
  const [shuffle, setShuffle] = useState(false)
  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  // 2026-08-03: 播放失败提示（版权/格式限制）——此前静默跳歌，用户以为"无法播放"
  const [playError, setPlayError] = useState('')
  // 2026-08-15 a11y/反馈修复: 搜索与歌词失败此前仅 console.error, 用户无感知——
  // 补 playError 式错误横幅(数据诚实: 失败必须可见)
  const [searchError, setSearchError] = useState('')
  const [lyricError, setLyricError] = useState('')
  const [currentLyricIndex, setCurrentLyricIndex] = useState(-1)
  const [showLyrics, setShowLyrics] = useState(false)
  const [selfVisible, setSelfVisible] = useState(false)  // 自管理的可见性
  // 2026-08-15: 可拖动位置（SideSheet draggable）——localStorage 持久化, 刷新后恢复
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    try {
      const raw = localStorage.getItem('crabpaw.music.dragOffset')
      if (raw) setDragOffset(JSON.parse(raw))
    } catch (e) { console.warn('[FMP] 读取拖拽位置失败:', e instanceof Error ? e.message : e) }
  }, [])
  useEffect(() => {
    try {
      if (dragOffset) localStorage.setItem('crabpaw.music.dragOffset', JSON.stringify(dragOffset))
    } catch (e) { console.warn('[FMP] 保存拖拽位置失败:', e instanceof Error ? e.message : e) }
  }, [dragOffset])
  const audioRef = useRef<HTMLAudioElement>(null)
  const lyricsRef = useRef<HTMLDivElement>(null)
  const trackListRef = useRef<HTMLDivElement>(null)
  const lastSearchedQueryRef = useRef('')  // 记录已搜索过的 query，避免重复搜索

  const current = currentIndex >= 0 ? tracks[currentIndex] : null
  const prevPlayingRef = useRef(playing)
  const tracksRef = useRef<Track[]>(tracks)  // ref 同步 tracks 供 effect 闭包使用
  useEffect(() => { tracksRef.current = tracks }, [tracks])
  const { surfaces } = useSceneSurfaces()

  // 合并可见性：外部 visible 或自管理 selfVisible
  const isVisible = visible || selfVisible
  const userDismissedRef = useRef(false)  // 用户手动关闭过面板（下次新 tracks 到达前不自动打开）
  // P5.5: 语音"打开音乐"入口用 — 用户主动打开标记（无 music surface 时不被"自动关闭"撤销）
  const userOpenRef = useRef(false)
  const handleClose = useCallback(() => {
    console.log('[FloatingMusicPlayer] handleClose called, selfVisible=%s visible=%s', selfVisible, visible)
    // 2026-08-06: 关闭面板同时暂停音频——唤醒词万能打断时音乐真正停止
    try { audioRef.current?.pause() } catch (e) { console.error('[FMP] 关闭时暂停音频失败:', e) }
    userDismissedRef.current = true
    // 2026-08-14 竞态修复: 关闭(含被天气/热点互斥顶掉)时同时清除"用户主动打开"标记——
    // 防止互斥顶掉后标记残留, surfaces 抖动期间情况1 的保持分支语义失效边界扩大
    userOpenRef.current = false
    setSelfVisible(false)
    onClose()
  }, [onClose, selfVisible, visible])

  const handleOpen = useCallback(() => {
    userOpenRef.current = true
    userDismissedRef.current = false
    setSelfVisible(true)
  }, [])

  // 2026-08-15 修复: App __openMusicWithQuery(visible prop 路径, R8 歌名语音/文本命令 +
  // SSE music_search 广播)打开面板时不设 userOpenRef → 情况1(无 music surface 自动
  // 关闭)立即闪关: 用户说"放首歌"→ 面板一闪而过, 音乐在播但播放器不弹。
  // 外部 visible=true = 用户/AI 显式打开 → 置 userOpenRef 持续保持(与 handleOpen/
  // __openMusicPanel 语义对齐), 由情况4 新 tracks 到达时消费置 false(line 310),
  // 此后 surface 移除/用户关闭均可正常生效。
  useEffect(() => {
    if (visible) {
      userOpenRef.current = true
    }
  }, [visible])

  // 暴露全局状态供语音命令拦截器检查 + 打开/关闭/暂停函数
  useEffect(() => {
    // 2026-08-15: __pauseMusicPanel——"暂停音乐"本地即时暂停但保留面板
    // （旧语义走 close-music 规则 → 关面板，用户想"暂停待会继续听"被整卡关掉）
    const pauseMusicPanel = () => {
      try { audioRef.current?.pause() } catch (e) { console.warn('[FMP] 暂停音频失败:', e) }
      setPlaying(false)
    }
    // A1(2026-09-05): musicPanel 宿主经 ui-command-registry 注册——旧
    // __openMusicPanel/__closeMusicPanel/__pauseMusicPanel/__musicPanelVisible
    // 四个散键合并为一个 PanelHandle(isVisible 闭包随 effect 重挂取最新值)
    const unregisterMusic = registerCommandHost('musicPanel', {
      open: handleOpen,
      close: handleClose,
      pause: pauseMusicPanel,
      isVisible: () => isVisible,
    })
    return () => { unregisterMusic() }
  }, [isVisible, handleClose, handleOpen])

  // 音效：面板展开/收起
  const prevVisibleRef = useRef(false)
  useEffect(() => {
    if (isVisible && !prevVisibleRef.current) playSound('panel-open')
    if (!isVisible && prevVisibleRef.current) playSound('panel-close')
    prevVisibleRef.current = isVisible
  }, [isVisible])

  // Voice-Media Coordination: suspend voice when music plays, resume when paused
  // 2026-08-15 S8 修复: 旧实现调全库无定义的 __voiceSuspendForMedia__/__voiceResumeAfterMedia__
  // (死代码, 幻听修复对音乐面板不生效)——改为 VoiceIntegration 承重墙暴露的
  // crabpawVoice 接口, mediaActive 配对语义在 crabpawVoice 内部完成(与
  // useVoicePlayConsumer 同款样板)。关闭面板暂停音频走下方 !isVisible effect
  // → setPlaying(false) → 本 effect playing=false 分支自动 resume。
  useEffect(() => {
    if (playing === prevPlayingRef.current) return
    prevPlayingRef.current = playing
    const cv = (window as any).crabpawVoice
    if (playing) {
      if (cv && typeof cv.suspendForMedia === 'function') {
        try { cv.suspendForMedia() } catch (e: any) { console.warn('[FloatingMusicPlayer] suspendForMedia 失败:', e?.message || e) }
      }
    } else {
      if (cv && typeof cv.resumeAfterMedia === 'function') {
        try { cv.resumeAfterMedia() } catch (e: any) { console.warn('[FloatingMusicPlayer] resumeAfterMedia 失败:', e?.message || e) }
      }
    }
  }, [playing])

  // 监听 Scene surface 变化：打开/关闭/控制播放面板
  const lastMusicDataHashRef = useRef<string>('')
  const initialSurfaceIdsRef = useRef<Set<string> | null>(null)  // 首次 mount 时的 surface ID 集合
  const initialConsumedRef = useRef(false)  // 初始 snapshot 的旧数据已消费过（后续不再进 case 3）
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => {
    // 首次运行时捕获当前 ID 集合。仅当 surfaces 有数据时才算——空数组说明 scene-client 还未同步 snapshot
    if (initialSurfaceIdsRef.current === null && surfaces.length > 0) {
      initialSurfaceIdsRef.current = new Set(surfaces.map(s => s.id))
    }

    const musicSurface = surfaces.find(s => s.kind === 'music' || s.kind === 'music_player')

    // 情况1: surface 已从列表中移除 → 关闭面板，重置 hash
    if (!musicSurface && (selfVisible || visible)) {
      // P5.5: 用户主动打开（语音"打开音乐"）— 无 surface 时保持打开显示搜索界面，不被自动关闭撤销
      // 2026-08-14 修复: 此前标记单次消费(置 false 后 return)——surfaces 流任意
      // 后续更新(如天气/热点互斥关闭引发的 scene 事件)再次进入本分支时误判
      // "surface 被移除" → 音乐面板被自动闪关。改为持续保持(不消费标记),
      // 直至真正 tracks 到达(情况4 会话内消费)或用户手动 handleClose 置 false。
      if (userOpenRef.current) {
        return
      }
      console.log('[FMP] ★ music surface 已移除，关闭面板')
      lastMusicDataHashRef.current = ''  // 重置 hash，下次新的 surface 会触发打开
      setSelfVisible(false)
      onCloseRef.current()
      return
    }

    if (!musicSurface) {         // 无 surface 且面板已关闭 → 确保 hash 重置以备后续
      lastMusicDataHashRef.current = ''
      return
    }

    const data = musicSurface.data || {}

    // 情况2: 收到 stop 信号 → 关闭面板，重置 hash
    if (data.status === 'stop') {
      if (selfVisible || visible) {
        console.log('[FMP] ★ 收到 stop 信号，关闭面板')
        lastMusicDataHashRef.current = ''
        setSelfVisible(false)
        onCloseRef.current()
      }
      return
    }

    // 以下需要 tracks 数据
    // 注：面板关闭后 AI 的 MusicControl 操作可能不带 tracks（surface 已被删除），
    // 此时用组件本地的 tracksRef 作为备选
    const effectiveTracks = data.tracks?.length ? data.tracks : tracksRef.current
    if (!effectiveTracks || effectiveTracks.length === 0) return

    // 如果 surface 无 tracks 但依赖本地 tracks，按控制操作处理
    if (!data.tracks?.length && tracksRef.current.length > 0) {
      if (data.source === 'control' && data.status) {
        // 2026-08-15 修复: 旧实现此处无条件 return——面板打开时 AI 的
        // pause/next/prev/play/set_volume/seek 全部无效（用户说"暂停一下"走
        // LLM → MusicControl(pause) → 前端无反应音乐继续放）。统一经
        // resolveMusicControl 应用；play/next/prev 在面板关闭时保留"重开面板"语义。
        const c = resolveMusicControl(data.status, data, selfVisible || visible)
        if (c.reopenPanel) {
          console.log('[FMP] ★ 控制操作 %s 到来（本地 tracks），重新打开面板', data.status)
          setSelfVisible(true)
        }
        if (c.setPlaying !== undefined) {
          if (c.setPlaying && currentIndex < 0 && tracksRef.current.length > 0) setCurrentIndex(0)
          setPlaying(c.setPlaying)
        }
        if (c.goNext) next()
        if (c.goPrev) prev()
        if (c.volume !== undefined) {
          setVolume(c.volume)
          if (c.unmute) setMuted(false)
        }
        if (c.seekTime !== undefined) {
          const a = audioRef.current
          if (a) {
            try { a.currentTime = c.seekTime } catch (e) { console.warn('[FMP] seek 跳转失败:', e) }
          }
          setProgress(c.seekTime)
        }
      }
      return
    }

    const dataHash = data.tracks!.map((t: any) => t.id).join(',')
    const isFromInitialSnapshot = initialSurfaceIdsRef.current?.has('music-player') ?? false

    // 情况3: 仅在初始 snapshot 中存在且从未消费过 → 加载数据但不开面板
    // 后续 AI 推送新数据（hash 变化）时通过 case 4 自动打开
    if (isFromInitialSnapshot && !initialConsumedRef.current) {
      initialConsumedRef.current = true
      lastMusicDataHashRef.current = dataHash
      // 2026-08-16 修复: 用户已主动打开(visible/selfVisible/userOpenRef)时 snapshot 抢跑
      // 覆盖——"播放周杰伦的歌"本地命令 → doSearch 返回新歌后, scene 首帧 snapshot(上次
      // 会话遗留旧 surface)才到达 → case 3 把 tracks 覆盖回旧歌、面板显示旧数据。
      // 消费掉初始快照语义(置 initialConsumedRef)但不覆盖用户正在看的/听的。
      if (visible || selfVisible || userOpenRef.current) {
        console.log('[FMP] 初始 snapshot 到达但面板已开/用户已打开，跳过旧数据加载 (hash=%s)', dataHash.substring(0, 30))
        return
      }
      setTracks(data.tracks)
      setCurrentIndex(0)
      // 2026-08-15 修复: 初始快照(上次会话遗留 surface)不再自动播放——旧实现
      // setPlaying(true) 在面板未打开时后台播歌: App 启动清理 remove 是 fire-and-forget,
      // 与初始快照存在竞态(快照先到则遗留歌曲直接响), 用户重启 app 后突闻音乐声
      // 却不见播放器("直接播放了音乐, 没弹播放器")。数据照常加载不播,
      // 由用户打开面板手动播放或 AI 新指令(case 4)接管。
      // P3(GUI 全量修复 P0): 不自动打开, 也不清用户关闭标记(初始化不该推翻用户意图)
      console.log('[FMP] 初始 snapshot 中的旧 tracks，加载数据但不开面板不播放 (hash=%s)', dataHash.substring(0, 30))
      return
    }

    // 情况4: hash 变化 → 新数据到达（AI 推送），更新 tracks 并自动打开
    if (dataHash !== lastMusicDataHashRef.current) {
      lastMusicDataHashRef.current = dataHash
      setTracks(data.tracks)
      setCurrentIndex(0)
      setPlaying(true)
      // 2026-08-14: surface 真正到达 → 消费"用户主动打开"标记(情况1 的持续保持至此结束)
      userOpenRef.current = false
      // 2026-08-15 修复: 新 tracks 到达 = 用户/AI 明确的新播放请求 → 清 dismissed 标记
      // 并打开面板。旧实现(8-14 P3)用 userDismissedRef 守卫本分支: 手动关过面板后
      // 再说"播放XX"→ 音乐在后台播放但面板永不弹出(用户反馈"直接播放了音乐,
      // 没弹播放器")。本分支只进带 tracks 的新数据(search/play), control 类无 tracks
      // 走上方 control 分支 → "关了又弹"的 control 抖动仍由 case 5 守卫, 不回归。
      userDismissedRef.current = false
      if (!selfVisible && !visible) {
        console.log('[FMP] ★ 新 tracks 到达，自动打开面板 (hash=%s)', dataHash.substring(0, 30))
        setSelfVisible(true)
      }
      return
    }

    // 情况5: source=control 且面板已关闭 → 用已有 tracks 重开（如 next/prev/play 控制操作）
    // P3(GUI 全量修复 P0): 用户手动关闭后 control 操作也不重开(守卫与 case 4 一致)
    if (data.source === 'control' && data.status && !selfVisible && !visible && !userDismissedRef.current) {
      if (['play', 'next', 'prev'].includes(data.status)) {
        console.log('[FMP] ★ 控制操作 %s 到来，重新打开面板', data.status)
        setSelfVisible(true)
      }
    }
  }, [surfaces, visible, selfVisible])  // 注意：onClose 通过 ref 引用，不在 deps 中

  /** 解析音频 URL：Electron file:// 协议下相对路径无法加载，补全为绝对 URL */
  // 2026-08-04 修复: <audio> 元素无法携带 X-Api-Key header → 后端 401 → 歌曲全部无法播放。
  // 改用 token 查询参数（后端 queryToken 鉴权），与 TTS 预取同机制；就绪后触发重播。
  const [audioToken, setAudioToken] = useState('')
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { getCredentials } = await import('../../lib/api')
        const creds = await getCredentials()
        if (!cancelled && creds?.token) setAudioToken(creds.token)
      } catch (e) {
        /* best-effort */
        console.warn('[index.tsx] 空 catch 补日志:', e instanceof Error ? e.message : e);
      }

    })()
    return () => { cancelled = true }
  }, [])

  const resolveAudioUrl = useCallback((url: string): string => {
    if (!url) return url
    // 2026-08-15: 网易云 outer url 外链(PlayMusic 直出)一律改走 /api/proxy-audio
    // 代理——直连必 302 到 404 页。须在 http(s) 短路之前归一化。
    url = normalizeNetEaseOuterUrl(url)
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) return url
    // 后端始终运行在 localhost:38767（Electron 子进程），用此补全。
    // R14: 优先走主进程 streamUrl(和 TTS GET 流式一致)——Electron 渲染进程直连
    // 38767 的 audio 加载被 webSecurity 跨源策略阻止,音乐无法播放。streamUrl 经
    // 主进程注入 token + 转发,绕过渲染进程网络限制。
    const base = 'http://localhost:38767' + (url.startsWith('/') ? url : '/' + url)
    return audioToken ? base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(audioToken) : base
  }, [audioToken])

  // R14: 经主进程 streamUrl 解析音频 URL(异步)——resolveAudioUrl 直连可能被
  // webSecurity 拦,用主进程代理拿带 token 的可靠 URL。非 Electron 用原 URL。
  const resolveAudioUrlViaMain = useCallback(async (url: string): Promise<string> => {
    if (!url) return url
    url = normalizeNetEaseOuterUrl(url)
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) return url
    try {
      if (typeof window !== 'undefined' && window.electronAPI?.api?.streamUrl) {
        const info = await window.electronAPI.api.streamUrl(url)
        if (info?.url) return info.url
      }
    } catch (e) {
      console.warn('[Music] streamUrl 解析失败,降级直连:', e)
    }
    return resolveAudioUrl(url)
  }, [resolveAudioUrl])

  // 关闭面板时暂停播放
  useEffect(() => {
    if (!isVisible && playing) {
      setPlaying(false)
      audioRef.current?.pause()
    }
  }, [isVisible])


  const doSearch = async (query?: string) => {
    const q = query || searchQuery
    if (!q.trim()) return
    setSearching(true)
    setSearchError('')
    // 2026-08-15: 清 playError——旧实现搜索成功后上次"无法播放"横幅残留，盖在新结果上
    setPlayError('')
    try {
      const result = await apiGet("/api/search/music?query=" + encodeURIComponent(q))
      const tracks = result.data?.tracks
      if (tracks) {
        setTracks(tracks)
        setCurrentIndex(0)
        setPlaying(true)
        setLyrics([])
        setCurrentLyricIndex(-1)
      }
    } catch (e: any) {
      console.error('[FloatingMusicPlayer] 搜索失败:', e?.message || e)
      setSearchError('搜索失败，请稍后重试')
    } finally {
      setSearching(false)
    }
  }

  // 当 isVisible=true 且传入 initialQuery 时自动搜索
  // 用 lastSearchedQueryRef 记录已搜索过的词，防止同个 query 重复搜索
  // 2026-08-15: queryNonce 变化强制重搜——React 相同 state（同歌名再次请求）
  // 不触发重渲染，App 层经 nonce 显式告知（"再放一次周杰伦的歌"此前静默无响应）
  const lastQueryNonceRef = useRef(0)
  useEffect(() => {
    if (queryNonce && queryNonce !== lastQueryNonceRef.current) {
      lastQueryNonceRef.current = queryNonce
      if (initialQuery) {
        lastSearchedQueryRef.current = initialQuery
        setSearchQuery(initialQuery)
        doSearch(initialQuery)
      }
      return
    }
    if (isVisible && initialQuery && lastSearchedQueryRef.current !== initialQuery) {
      lastSearchedQueryRef.current = initialQuery
      setSearchQuery(initialQuery)
      doSearch(initialQuery)
    }
  }, [isVisible, initialQuery, queryNonce]) // 故意不把 doSearch 放依赖里——它只读 state/ref 不闭包过时



  // 歌词请求序号——快速切歌时旧请求返回不覆盖新歌词（防乱序）
  const lyricSeqRef = useRef(0)
  const fetchLyrics = async (songId: string) => {
    const mySeq = ++lyricSeqRef.current
    setLyricError('')
    try {
      const result = await apiPost('/api/search/music/lyrics', { id: songId })
      if (mySeq !== lyricSeqRef.current) return  // 已有更新的请求，丢弃过期结果
      if (result.success && result.data?.lrc) {
        // FM1: detect and fix encoding issues before parsing
        const fixedLrc = tryFixEncoding(result.data.lrc)
        setLyrics(parseLRC(fixedLrc))
        setShowLyrics(true)
      } else {
        setLyricError('这首歌暂无歌词')
      }
    } catch (e: any) {
      console.error('[FloatingMusicPlayer] 歌词获取失败:', e?.message || e)
      if (mySeq === lyricSeqRef.current) setLyricError('歌词获取失败')
    }
  }

  const playTrack = (idx: number) => {
    setCurrentIndex(idx)
    setPlaying(true)
    setLyrics([])
    setCurrentLyricIndex(-1)
    setShowLyrics(false)
    setPlayError('')
    // 修复：此前用 current（state 尚未更新，仍是旧曲目）拉歌词——切歌显示上一首的歌词
    const t = tracks[idx]
    if (t?.id) {
      fetchLyrics(t.id)
    }
  }

  const togglePlay = () => {
    if (currentIndex < 0 && tracks.length > 0) {
      setCurrentIndex(0)
      setPlaying(true)
      return
    }
    setPlaying(!playing)
  }

  const next = (skipOne = false) => {
    if (tracks.length === 0) return
    if (repeatMode === 'one' && !skipOne) {
      // 2026-08-08(审计 P1): 单曲循环——setCurrentIndex(同曲)+setPlaying(true) 无状态
      // 变化,播放 effect 不重跑,音频停在 ended 态但 UI 显示"播放中"(转盘转却无声)。
      // 直接重播当前曲。
      const a = audioRef.current
      if (a) {
        try {
          a.currentTime = 0
          a.play().catch((e) => { console.warn('[Music] 单曲循环重播失败:', e?.message || e); setPlaying(false) })
        } catch (e) { console.warn('[Music] 单曲循环重播异常:', e); setPlaying(false) }
      }
      return
    }
    // 2026-08-15: 切歌决策下沉纯函数（computeNextTrack 可单测）——
    // 修复 repeat off + shuffle 在列表末尾停止而非随机续播的 else-if 顺序问题
    const r = computeNextTrack({ currentIndex, tracksLength: tracks.length, repeatMode, shuffle, skipOne })
    if (r.action === 'stop') {
      setPlaying(false)
      return
    }
    const nextIdx = r.action === 'play' ? r.index : currentIndex
    setCurrentIndex(nextIdx)
    setPlaying(true)
    setLyrics([])
    setCurrentLyricIndex(-1)
    setShowLyrics(false)
    const nextTrack = tracks[nextIdx]
    if (nextTrack?.id) {
      fetchLyrics(nextTrack.id)
    }
  }

  const prev = () => {
    if (tracks.length === 0) return
    let prevIdx = currentIndex - 1
    if (prevIdx < 0) {
      prevIdx = tracks.length - 1
    }
    setCurrentIndex(prevIdx)
    setPlaying(true)
    setLyrics([])
    setCurrentLyricIndex(-1)
    setShowLyrics(false)
    const prevTrack = tracks[prevIdx]
    if (prevTrack?.id) {
      fetchLyrics(prevTrack.id)
    }
  }

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (playing && current?.url) {
      // R14: 异步经主进程 streamUrl 解析音频 URL,绕过渲染进程跨源限制
      let cancelled = false
      resolveAudioUrlViaMain(current.url).then((resolvedUrl) => {
        if (cancelled) return
        if (a.src !== resolvedUrl) a.src = resolvedUrl
        a.play().catch(() => {
          // 播放失败（VIP/404/格式），自动跳过到下一首；全部失败时提示
          // 2026-08-08: next(true)——跳过当前坏曲(含 repeatMode='one',否则单曲循环
          // 会对同一首坏曲无限重试)
          if (currentIndex < tracks.length - 1) {
            setPlayError(`「${current.title}」无法播放（版权或格式限制），已跳至下一首`)
            next(true)
          } else {
            setPlaying(false)
            setPlayError('这些歌曲暂时无法播放（版权限制），换个歌名试试')
          }
        })
      }).catch(() => {
        // streamUrl 失败: 降级直连
        if (current.url) {
          const resolvedUrl = resolveAudioUrl(current.url)
          if (a.src !== resolvedUrl) a.src = resolvedUrl
          a.play().catch(() => { setPlayError('这些歌曲暂时无法播放,换个歌名试试') })
        }
      })
      return () => { cancelled = true }
    } else {
      a.pause()
    }
    // audioToken 就绪时重新 resolve（token 查询参数修复 401 后重播）
  }, [playing, current?.url, audioToken, resolveAudioUrl, resolveAudioUrlViaMain])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    a.volume = muted ? 0 : volume
  }, [volume, muted])

  useEffect(() => {
    const a = audioRef.current
    if (!a || !current?.id) return
    fetchLyrics(current.id)
  }, [current?.id])

  useEffect(() => {
    if (!lyrics.length) return
    let idx = lyrics.length - 1
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time > progress) {
        idx = i - 1
        break
      }
    }
    idx = Math.max(0, Math.min(idx, lyrics.length - 1))
    if (idx !== currentLyricIndex && idx >= 0) {
      setCurrentLyricIndex(idx)
    }
  }, [progress, lyrics, currentLyricIndex])

  useEffect(() => {
    if (lyricsRef.current && currentLyricIndex >= 0) {
      const activeLine = lyricsRef.current.querySelector('.lyric-active')
      if (activeLine) {
        activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [currentLyricIndex])

  // 自动滚动到当前播放曲目（切歌/自动跳过VIP时触发）
  useEffect(() => {
    if (trackListRef.current && currentIndex >= 0) {
      const activeTrack = trackListRef.current.querySelector('.track-active')
      if (activeTrack) {
        activeTrack.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [currentIndex])

  // 2026-08-14 审计: 键盘监听 effect 依赖稳定化——此前依赖 [isVisible, togglePlay,
  // prev, next, handleClose],任一变化即重订阅监听器(每次渲染 churn)。
  // 改为 ref 持有最新值,监听器只注册一次。
  const keyHandlerRef = useRef({ isVisible, togglePlay, prev, next, handleClose })
  keyHandlerRef.current = { isVisible, togglePlay, prev, next, handleClose }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const h = keyHandlerRef.current
      if (!h.isVisible) return
      // 2026-08-15 修复: 豁免范围从仅 INPUT 扩展到全部交互控件——焦点在 button 时
      // 按 Space 此前被本 handler 劫持为 togglePlay, 按钮原生激活被阻断(播放按钮
      // 按空格无反应)。INPUT/TEXTAREA/SELECT/BUTTON/A/contentEditable 均由浏览器
      // 原生键盘行为接管; Esc 关闭仍由 SideSheet 的全局 Esc handler 负责。
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
        || t.tagName === 'BUTTON' || t.tagName === 'A' || t.isContentEditable)) return
      switch (e.code) {
        case 'Space':
          e.preventDefault()
          h.togglePlay()
          break
        case 'ArrowLeft':
          e.preventDefault()
          h.prev()
          break
        case 'ArrowRight':
          e.preventDefault()
          h.next()
          break
        case 'Escape':
          h.handleClose()
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const coverBg = current ? nameToColor(current.title) : 'var(--bg-tertiary)'

  return (
    <SideSheet
      open={isVisible}
      onClose={handleClose}
      name="music"
      // 2026-08-15: 内容驱动宽度档——歌词双列需要更宽(参考实现音乐面板 360px 窄卡,
      // 我方有歌词时给足阅读宽度, 无歌词收窄)
      // 2026-08-15 实机反馈: 720px 档太大——收窄为 480px/380px 两档; 二次反馈仍大
      // → 420px/320px; 三次反馈再收窄 → 360px/280px(接近参考实现窄卡)
      width={showLyrics && lyrics.length > 0 ? 'min(32vw, 360px)' : 'min(24vw, 280px)'}
      fitContent
      draggable
      dragOffset={dragOffset ?? undefined}
      onDragOffsetChange={setDragOffset}
    >
      <div
        className="flex flex-col overflow-hidden flex-1 min-h-0"
        style={{ minHeight: 0 }}
      >
        <audio
          ref={audioRef}
          // R10: onTimeUpdate 高频(约 4次/秒)setState → React 18 并发渲染偶发
          // "Should have a queue" 错误。降频: 仅在变化 >1s 时更新进度条,
          // 减少渲染压力(进度条精度 1s 足够)。
          onTimeUpdate={() => {
            const t = audioRef.current?.currentTime || 0
            setProgress(prev => Math.abs(prev - t) >= 1 ? t : prev)
          }}
          onLoadedMetadata={() => setDuration(audioRef.current?.duration || 0)}
          onEnded={() => next()}
        />

        <div className="flex items-center justify-between px-4 py-3 shrink-0 sheet-boot" style={{ ['--boot-delay' as any]: '40ms' }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--accent-muted)' }}>
              <Music className="w-3.5 h-3.5 theme-accent" />
            </div>
            <span className="text-sm font-semibold theme-text-primary">音乐</span>
          </div>
          <button
            onClick={handleClose}
            data-close-btn
            aria-label="关闭音乐面板"
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5 theme-text-muted" />
          </button>
        </div>

        {current && (
          <div className="px-4 pb-3 shrink-0 sheet-boot" style={{ ['--boot-delay' as any]: '130ms' }}>
            <div
              className="w-full aspect-[5/4] rounded-xl mb-3 flex items-center justify-center overflow-hidden relative"
              style={{ background: coverBg }}
            >
              <div
                className="w-32 h-32 rounded-full flex items-center justify-center"
                style={{
                  background: `conic-gradient(from 0deg, ${coverBg}, rgba(255,255,255,0.15), ${coverBg})`,
                  animation: playing ? 'vinly-spin 3s linear infinite' : 'none',
                }}
              >
                <div className="w-12 h-12 rounded-full" style={{ background: 'rgba(0,0,0,0.3)' }} />
              </div>
              {playing && (
                <div
                  className="absolute inset-0 rounded-xl"
                  style={{
                    background: `radial-gradient(circle at center, ${coverBg}44 0%, transparent 70%)`,
                    animation: 'pulse-glow 2s ease-in-out infinite',
                  }}
                />
              )}
            </div>
            <div className="text-sm font-semibold theme-text-primary truncate">{current.title}</div>
            {current.artist && <div className="text-xs theme-text-muted truncate mt-0.5">{current.artist}</div>}
          </div>
        )}

        {current && (
          <div className="px-4 pb-3 shrink-0">
            <div className="h-1 rounded-full bg-white/10 overflow-hidden mb-1 cursor-pointer"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const x = e.clientX - rect.left
                const percent = x / rect.width
                const newTime = percent * duration
                if (audioRef.current) {
                  audioRef.current.currentTime = newTime
                  setProgress(newTime)
                }
              }}
            >
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{
                  width: `${duration > 0 ? (progress / duration) * 100 : 0}%`,
                  background: 'var(--accent-primary)',
                }}
              />
            </div>
            <div className="flex justify-between text-[10px] theme-text-muted mb-2">
              <span>
                {Math.floor(progress / 60)}:{String(Math.floor(progress % 60)).padStart(2, '0')}
              </span>
              <span>
                {Math.floor(duration / 60)}:{String(Math.floor(duration % 60)).padStart(2, '0')}
              </span>
            </div>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => setShuffle(!shuffle)}
                aria-label={shuffle ? '关闭随机播放' : '开启随机播放'}
                aria-pressed={shuffle}
                className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors ${shuffle ? 'theme-text-accent' : 'theme-text-muted'}`}
              >
                <Shuffle className="w-3.5 h-3.5" />
              </button>
              <button onClick={prev} disabled={currentIndex <= 0} aria-label="上一首" className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30 transition-colors">
                <SkipBack className="w-4 h-4 theme-text-secondary" />
              </button>
              <button
                onClick={togglePlay}
                aria-label={playing ? '暂停' : '播放'}
                className="w-10 h-10 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95"
                style={{ background: 'var(--accent-primary)' }}
              >
                {playing ? <Pause className="w-5 h-5 text-white" /> : <Play className="w-5 h-5 text-white ml-0.5" />}
              </button>
              <button onClick={() => next()} disabled={currentIndex >= tracks.length - 1} aria-label="下一首" className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30 transition-colors">
                <SkipForward className="w-4 h-4 theme-text-secondary" />
              </button>
              <button
                onClick={() => {
                  if (repeatMode === 'off') setRepeatMode('all')
                  else if (repeatMode === 'all') setRepeatMode('one')
                  else setRepeatMode('off')
                }}
                aria-label={repeatMode === 'off' ? '循环模式：关闭' : repeatMode === 'one' ? '循环模式：单曲循环' : '循环模式：列表循环'}
                aria-pressed={repeatMode !== 'off'}
                className={`p-1.5 rounded-lg hover:bg-white/10 transition-colors ${repeatMode !== 'off' ? 'theme-text-accent' : 'theme-text-muted'}`}
              >
                <Repeat className={`w-3.5 h-3.5 ${repeatMode === 'one' ? 'fill-current' : ''}`} />
              </button>
            </div>
          </div>
        )}

        {current && (
          <div className="px-4 pb-2 shrink-0">
            <div className="flex items-center gap-2">
              <Volume2 className="w-3 h-3 theme-text-muted" />
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const val = parseFloat(e.target.value)
                  setVolume(val)
                  if (val > 0) setMuted(false)
                }}
                aria-label="音量"
                className="flex-1 h-1 rounded-full appearance-none cursor-pointer"
                style={{
                  background: 'rgba(255,255,255,0.1)',
                  accentColor: 'var(--accent-primary)',
                }}
              />
              <button onClick={() => setMuted(!muted)} aria-label={muted ? '取消静音' : '静音'} className="p-1 rounded hover:bg-white/10 transition-colors">
                {muted ? <VolumeX className="w-3 h-3 theme-text-muted" /> : <Volume2 className="w-3 h-3 theme-text-muted" />}
              </button>
            </div>
          </div>
        )}

        {current && lyrics.length > 0 && (
          <div className="px-4 pb-2 shrink-0">
            <button
              onClick={() => setShowLyrics(!showLyrics)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${showLyrics ? 'theme-bg-active' : 'hover:bg-white/5'}`}
            >
              📝 歌词 {showLyrics ? '(隐藏)' : '(显示)'}
            </button>
          </div>
        )}

        {showLyrics && lyrics.length > 0 && (
          <div
            ref={lyricsRef}
            className="flex-1 overflow-y-auto px-4 pb-2 max-h-48"
            data-no-drag
          >
            {lyrics.map((line, i) => (
              <div
                key={i}
                className={`text-xs py-1 text-center transition-all ${
                  i === currentLyricIndex
                    ? 'lyric-active theme-text-primary font-medium text-sm'
                    : 'theme-text-muted/60'
                }`}
              >
                {line.text}
              </div>
            ))}
          </div>
        )}

        <div className="px-4 pb-2 shrink-0">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 theme-text-muted" />
              <input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                placeholder="搜索歌曲..."
                className="w-full text-xs pl-8 pr-3 py-2 rounded-xl theme-text-primary outline-none"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.06)' }}
              />
            </div>
            <button
              onClick={() => doSearch()}
              disabled={searching}
              className="text-xs px-4 py-2 rounded-xl font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: 'var(--accent-primary)' }}
            >
              {searching ? '搜索...' : '搜索'}
            </button>
          </div>
        </div>

        <div ref={trackListRef} data-no-drag className="flex-1 overflow-y-auto px-2 pb-3 sheet-boot" style={{ ['--boot-delay' as any]: '330ms' }}>
          {playError && (
            <div role="alert" className="mx-2 mt-2 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: '#fb7185' }}>
              ⚠️ {playError}
            </div>
          )}
          {searchError && (
            <div role="alert" className="mx-2 mt-2 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: '#fb7185' }}>
              ⚠️ {searchError}
            </div>
          )}
          {lyricError && (
            <div role="alert" className="mx-2 mt-2 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: '#fb7185' }}>
              ⚠️ {lyricError}
            </div>
          )}
          {tracks.length === 0 && !searching && (
            <div className="text-center py-8 text-xs theme-text-muted">
              <Music className="w-8 h-8 mx-auto mb-2 opacity-30" />
              说"放首歌"让 AI 搜索，或手动搜索
            </div>
          )}
          {tracks.map((track, i) => (
            <div
              key={track.id || i}
              onClick={() => playTrack(i)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl cursor-pointer transition-all mb-0.5 ${
                i === currentIndex
                  ? 'theme-bg-active track-active'
                  : 'hover:bg-white/5'
              }`}
            >
              <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center" style={{ background: nameToColor(track.title) }}>
                <Music className="w-3.5 h-3.5 text-white/70" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium theme-text-primary truncate">{track.title}</div>
                {track.artist && <div className="text-[10px] theme-text-muted truncate">{track.artist}</div>}
              </div>
              {i === currentIndex && playing && (
                <span className="flex gap-0.5">
                  <span className="w-0.5 h-3 rounded-full animate-pulse" style={{ background: 'var(--accent-primary)', animationDelay: '0s' }} />
                  <span className="w-0.5 h-3 rounded-full animate-pulse" style={{ background: 'var(--accent-primary)', animationDelay: '0.2s' }} />
                  <span className="w-0.5 h-3 rounded-full animate-pulse" style={{ background: 'var(--accent-primary)', animationDelay: '0.4s' }} />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </SideSheet>
  )
}
