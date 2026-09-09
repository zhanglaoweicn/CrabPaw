/**
 * music-player-logic — FloatingMusicPlayer 纯逻辑（可单测）
 *
 * 2026-08-15 抽取: AI 控制指令应用(next 决策 + control surface 解析)从组件闭包中
 * 剥离为纯函数——组件内被 effect/键盘/按钮多处复用的分支逻辑单点维护。
 *
 * 修复记录:
 * - computeNextTrack: 旧 else-if 顺序("repeat off 末尾停止"先于 shuffle 判断)导致
 *   repeatMode='off' + shuffle 时列表末尾停止而非随机续播——shuffle 优先。
 * - resolveMusicControl: 旧 FMP 对无 tracks 的 control surface 无条件 return,
 *   AI 的 pause/set_volume/seek 及面板打开时的 next/prev 全部无效——统一解析应用。
 */

/** 网易云 outer url 外链（PlayMusic 工具直出,不含 id 时无意义）——必须改走 proxy-audio */
const NETEASTE_OUTER_RE = /^https?:\/\/music\.163\.com\/song\/media\/outer\/url\?id=(\d+)/i

/**
 * 归一化网易云外链为后端代理端点。
 * 背景: PlayMusic/Music action=play 直接把 https://music.163.com/song/media/outer/url?id=X.mp3
 * 作为 track.url;FMP 对 http(s) 绝对 URL 短路跳过主进程 crabpaw-audio:// 代理 → 渲染进程
 * 直连 → 网易云 302 到 404 页 → 每首必"无法播放"。归一化后走 /api/proxy-audio 代理
 * （含 outer url 失效时 player/url API 兜底）。非网易外链原样返回。
 */
export function normalizeNetEaseOuterUrl(url: string): string {
  if (!url) return url
  const m = url.match(NETEASTE_OUTER_RE)
  if (m) return '/api/proxy-audio?id=' + m[1]
  return url
}

export type RepeatMode = 'off' | 'one' | 'all'

/** MusicControl 工具的 action 全集（'stop' 由调用方在 surface 分支前置处理） */
export type MusicControlStatus = 'play' | 'pause' | 'next' | 'prev' | 'stop' | 'set_volume' | 'seek'

export interface NextTrackInput {
  currentIndex: number
  tracksLength: number
  repeatMode: RepeatMode
  shuffle: boolean
  /** 单曲循环时跳过原地重播（播放失败跳歌场景，next(true)） */
  skipOne?: boolean
  /** 可注入随机源（默认 Math.random，便于测试） */
  rand?: () => number
}

export type NextTrackResult =
  | { action: 'play'; index: number }
  | { action: 'stop' }
  | { action: 'replay' }

/**
 * 计算下一首的目标索引。
 * - repeatMode='one' 且非跳歌 → 'replay'（调用方负责 audio.currentTime=0 重播）
 * - shuffle → 随机索引（优先于 repeatMode——off + shuffle 末尾仍随机续播）
 * - repeatMode='off' 且越界 → 'stop'
 * - 其余 → (currentIndex+1) 环形取模
 */
export function computeNextTrack(input: NextTrackInput): NextTrackResult {
  const { currentIndex, tracksLength, repeatMode, shuffle, skipOne, rand } = input
  if (tracksLength <= 0) return { action: 'stop' }
  if (repeatMode === 'one' && !skipOne) return { action: 'replay' }
  if (shuffle) {
    const r = rand ? rand() : Math.random()
    return { action: 'play', index: Math.floor(r * tracksLength) }
  }
  const nextIdx = currentIndex + 1
  if (repeatMode === 'off' && nextIdx >= tracksLength) return { action: 'stop' }
  return { action: 'play', index: nextIdx % tracksLength }
}

export interface MusicControlData {
  volume?: number
  currentTime?: number
}

/** 控制操作应用结果——副作用（setState/audio 操作）由调用方执行 */
export interface MusicControlResult {
  /** 面板关闭时 play/next/prev 重开面板 */
  reopenPanel?: boolean
  /** 应用播放状态（undefined = 不改变） */
  setPlaying?: boolean
  goNext?: boolean
  goPrev?: boolean
  /** 音量 0-1（已 clamp） */
  volume?: number
  /** 音量 >0 时取消静音 */
  unmute?: boolean
  /** 跳转时间（秒） */
  seekTime?: number
}

/**
 * 解析 AI 控制 surface（无 tracks、source='control'）应执行的动作。
 * panelVisible 为 true 时 play/next/prev 不重开面板、仅应用状态。
 */
export function resolveMusicControl(status: string, data: MusicControlData, panelVisible: boolean): MusicControlResult {
  switch (status) {
    case 'play':
      return { setPlaying: true, reopenPanel: !panelVisible }
    case 'pause':
      return { setPlaying: false }
    case 'next':
      return { goNext: true, reopenPanel: !panelVisible }
    case 'prev':
      return { goPrev: true, reopenPanel: !panelVisible }
    case 'set_volume': {
      if (typeof data.volume !== 'number' || Number.isNaN(data.volume)) return {}
      const v = Math.max(0, Math.min(1, data.volume))
      return { volume: v, unmute: v > 0 }
    }
    case 'seek': {
      if (typeof data.currentTime !== 'number' || Number.isNaN(data.currentTime) || data.currentTime < 0) return {}
      return { seekTime: data.currentTime }
    }
    default:
      // 'stop' 等未在此处理的状态 → 无操作（stop 由调用方前置分支负责）
      return {}
  }
}
