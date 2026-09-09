import { computeNextTrack, resolveMusicControl, normalizeNetEaseOuterUrl } from './music-player-logic'

describe('computeNextTrack', () => {
  it('repeatMode=off 且当前已是最后一首 → stop', () => {
    expect(computeNextTrack({ currentIndex: 4, tracksLength: 5, repeatMode: 'off', shuffle: false }))
      .toEqual({ action: 'stop' })
  })

  it('repeatMode=off 非末尾 → 顺序下一首', () => {
    expect(computeNextTrack({ currentIndex: 1, tracksLength: 5, repeatMode: 'off', shuffle: false }))
      .toEqual({ action: 'play', index: 2 })
  })

  it('repeatMode=all 末尾 → 环形回到 0', () => {
    expect(computeNextTrack({ currentIndex: 4, tracksLength: 5, repeatMode: 'all', shuffle: false }))
      .toEqual({ action: 'play', index: 0 })
  })

  it('repeatMode=one 非跳歌 → replay（原地重播）', () => {
    expect(computeNextTrack({ currentIndex: 2, tracksLength: 5, repeatMode: 'one', shuffle: false }))
      .toEqual({ action: 'replay' })
  })

  it('repeatMode=one + skipOne（跳坏曲）→ 顺序下一首', () => {
    expect(computeNextTrack({ currentIndex: 2, tracksLength: 5, repeatMode: 'one', shuffle: false, skipOne: true }))
      .toEqual({ action: 'play', index: 3 })
  })

  it('shuffle 优先于 repeatMode——off + shuffle 末尾仍随机续播（2026-08-15 修复）', () => {
    const rand = () => 0.5
    const r = computeNextTrack({ currentIndex: 4, tracksLength: 5, repeatMode: 'off', shuffle: true, rand })
    expect(r.action).toBe('play')
    if (r.action === 'play') expect(r.index).toBe(Math.floor(0.5 * 5))
  })

  it('shuffle 结果恒在有效区间内', () => {
    const rand = () => 0.999
    const r = computeNextTrack({ currentIndex: 0, tracksLength: 3, repeatMode: 'all', shuffle: true, rand })
    expect(r).toEqual({ action: 'play', index: 2 })
  })

  it('空列表 → stop', () => {
    expect(computeNextTrack({ currentIndex: -1, tracksLength: 0, repeatMode: 'all', shuffle: false }))
      .toEqual({ action: 'stop' })
  })
})

describe('resolveMusicControl', () => {
  it('play + 面板关闭 → 重开面板并播放', () => {
    expect(resolveMusicControl('play', {}, false)).toEqual({ setPlaying: true, reopenPanel: true })
  })

  it('play + 面板打开 → 只应用播放不重开', () => {
    expect(resolveMusicControl('play', {}, true)).toEqual({ setPlaying: true, reopenPanel: false })
  })

  it('pause → 仅暂停，面板保留', () => {
    expect(resolveMusicControl('pause', {}, true)).toEqual({ setPlaying: false })
    expect(resolveMusicControl('pause', {}, false)).toEqual({ setPlaying: false })
  })

  it('next/prev + 面板关闭 → 重开面板', () => {
    expect(resolveMusicControl('next', {}, false)).toEqual({ goNext: true, reopenPanel: true })
    expect(resolveMusicControl('prev', {}, true)).toEqual({ goPrev: true, reopenPanel: false })
  })

  it('set_volume → clamp 到 0-1；>0 时取消静音', () => {
    expect(resolveMusicControl('set_volume', { volume: 1.5 }, true)).toEqual({ volume: 1, unmute: true })
    expect(resolveMusicControl('set_volume', { volume: -0.3 }, true)).toEqual({ volume: 0, unmute: false })
    expect(resolveMusicControl('set_volume', { volume: 0.6 }, true)).toEqual({ volume: 0.6, unmute: true })
  })

  it('set_volume 缺/非法 volume → 无操作', () => {
    expect(resolveMusicControl('set_volume', {}, true)).toEqual({})
    expect(resolveMusicControl('set_volume', { volume: NaN }, true)).toEqual({})
  })

  it('seek → 返回跳转时间；负数/缺失 → 无操作', () => {
    expect(resolveMusicControl('seek', { currentTime: 120 }, true)).toEqual({ seekTime: 120 })
    expect(resolveMusicControl('seek', {}, true)).toEqual({})
    expect(resolveMusicControl('seek', { currentTime: -1 }, true)).toEqual({})
  })

  it('未知状态（含 stop 交由调用方前置处理）→ 无操作', () => {
    expect(resolveMusicControl('stop', {}, false)).toEqual({})
    expect(resolveMusicControl('whatever', {}, false)).toEqual({})
  })
})

describe('normalizeNetEaseOuterUrl', () => {
  it('网易云 outer url 外链 → 归一化为 /api/proxy-audio?id= 代理端点', () => {
    expect(normalizeNetEaseOuterUrl('https://music.163.com/song/media/outer/url?id=186016.mp3'))
      .toBe('/api/proxy-audio?id=186016')
  })

  it('http 变体同样归一化（大小写不敏感）', () => {
    expect(normalizeNetEaseOuterUrl('http://Music.163.com/song/media/outer/url?id=123.mp3'))
      .toBe('/api/proxy-audio?id=123')
  })

  it('无数字 id 的网易外链 → 原样返回（正则需数字 id，异常 URL 不猜测）', () => {
    expect(normalizeNetEaseOuterUrl('https://music.163.com/song/media/outer/url?id=.mp3'))
      .toBe('https://music.163.com/song/media/outer/url?id=.mp3')
  })

  it('相对 proxy 端点 → 原样返回', () => {
    expect(normalizeNetEaseOuterUrl('/api/proxy-audio?id=186016')).toBe('/api/proxy-audio?id=186016')
  })

  it('其他绝对 URL/空串 → 原样返回', () => {
    expect(normalizeNetEaseOuterUrl('https://other.example.com/a.mp3')).toBe('https://other.example.com/a.mp3')
    expect(normalizeNetEaseOuterUrl('')).toBe('')
  })
})
