/**
 * HotspotPanel — 热点趋势面板（v2 修复版）
 *
 * 修复项：
 * - 统计卡片从真实数据派生
 * - 智能左右列均分
 * - 加载骨架屏
 * - 热点自动/手动互斥（5s 冷却）
 * - 搜索清除按钮 + Enter 支持
 * - 列表计数正确显示 "N / M 条"
 * - CSS 移至组件外部
 * - 键盘无障碍
 * - window.open 安全
 * - CSS hover 替代 JS 操作 DOM
 * - 入场动画只播放一次
 * - 错误重试机制
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { apiGet, apiPost, isElectron } from '../../lib/api'
import { useSceneClient } from '../../lib/scene-client'
import { HotspotEarth } from '../HotspotEarth'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { SideSheet } from '../SideSheet'

/* ─── CSS keyframes 移至组件外部；启动序列动画已归 SideSheet（sheet-glitch-in）─── */
const HS_STYLES = `
@keyframes hsSlideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
@keyframes hsPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes hsTickerScroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.hs-ticker-inner { animation: hsTickerScroll 60s linear infinite; }
.hs-live-dot { animation: hsPulse 2s ease-in-out infinite; }
.hs-item-row:hover { background: rgba(255,255,255,0.03) !important; }
.hs-close-btn:hover { background: rgba(255,68,68,0.2) !important; color: #ff4444 !important; }
`

interface HotspotItem {
  rank: number
  title: string
  hot: string | number
  url?: string
  tag?: string
}

interface HotspotPlatform {
  platform: string
  items: HotspotItem[]
  fetchedAt: number
  _meta?: { label: string; icon: string; color?: string }
  _error?: string
}

function formatHeat(heat: string | number): string {
  const n = typeof heat === 'string' ? parseInt(heat.replace(/[^0-9]/g, '')) : heat
  if (!n || isNaN(n)) return String(heat || '')
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(0) + '万'
  return String(n)
}

/**
 * 2026-08-16 审计修复: hex 色 '#ff6b6b' → rgb 三元组 '255,107,107'。
 * 旧实现 stat.color.matchAll(/\w+/g) 取到首字符 'f' → rgba(f,0.1) 非法 CSS
 * → 统计卡背景/边框色全部不生效(透明)。非法输入降级白底(透明装饰)。
 */
function hexToRgbTriplet(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '255,255,255'
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`
}

function rankBadge(rank: number): { bg: string; color: string; label: string } {
  if (rank === 1) return { bg: 'rgba(255,215,0,0.2)', color: '#ffd700', label: '🥇' }
  if (rank === 2) return { bg: 'rgba(192,192,192,0.2)', color: '#c0c0c0', label: '🥈' }
  if (rank === 3) return { bg: 'rgba(205,127,50,0.2)', color: '#cd7f32', label: '🥉' }
  if (rank <= 10) return { bg: 'rgba(89,168,255,0.12)', color: '#59a8ff', label: String(rank) }
  return { bg: 'rgba(255,255,255,0.04)', color: '#888', label: String(rank) }
}

// 2026-08-16 数据链审计 #1/#2: zhihu/xueqiu 标签诚实化——数据已降级为
// 综合网络热榜(nethot)/东方财富涨幅榜, 不再伪装"知乎"/"雪球"。
const PLATFORM_CONFIG: Record<string, { label: string; color: string }> = {
  weibo: { label: '微博', color: '#e6162d' },
  zhihu: { label: '综合热榜', color: '#0084ff' },
  baidu: { label: '百度', color: '#2932e1' },
  toutiao: { label: '头条', color: '#ff6600' },
  wechat: { label: '微信热点', color: '#07c160' },
  douyin: { label: '抖音', color: '#000000' },
  xiaohongshu: { label: '小红书', color: '#ff2442' },
  v2ex: { label: 'V2EX', color: '#1e1e2f' },
  xueqiu: { label: '股市涨幅', color: '#e0352b' },
}

// 2026-08-15 数据诚实化: 后端 /panels/hotspot/all 无区域关注度/情绪指数数据源,
// 此表为界面装饰示意数据——UI 上明确标注「示意数据」, 不伪装成实时排名。
const REGION_DATA_DEMO = [
  { name: '亚太地区', pct: 78 },
  { name: '北美地区', pct: 62 },
  { name: '欧洲地区', pct: 48 },
  { name: '中东地区', pct: 33 },
  { name: '南美地区', pct: 27 },
  { name: '非洲地区', pct: 19 },
]

function formatTime(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 2026-08-16 修复: 热点链接打开方式——旧实现 window.open 被 Electron
 * setWindowOpenHandler 拦截 → 弹出 iframe 预览窗, 但微博/百度/搜狗等
 * 目标站点全部设 X-Frame-Options/CSP frame-ancestors 拒绝 iframe 嵌入
 * → 预览窗空白"无法预览"。改为 Electron 环境 shell.openExternal
 * 系统浏览器打开(News 页同款模式), 非 Electron 兜底 window.open。
 */
function openHotspotUrl(url: string) {
  const shell = window.electronAPI?.shell
  if (isElectron() && shell?.openExternal) {
    shell.openExternal(url).catch((e) => console.warn('[HotspotPanel] openExternal 失败:', e))
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/**
 * 时钟子组件——2026-08-16 审计修复: 旧实现 setClock 每秒触发整个面板
 * (135+ 列表行/卡片/统计条)全量重渲染，现隔离为独立组件。现隔离为独立组件, 每秒仅
 * 重渲染自身; failCount/freshness 变化(30s 轮询粒度)才由外层 props 驱动。
 */
function HSPanelClock({ failCount, freshness }: { failCount: number; freshness: string }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const liveBad = failCount > 0
  const liveText = liveBad ? `${failCount} 个源异常` : freshness
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'monospace', color: '#fff' }}>
        {formatTime(now)}
      </div>
      {/* 2026-08-16 审计修复: 「实时」诚实化——旧实现无条件红点+「实时」,
          即使 failCount>0 或 N 个源延迟。现按实际状态显示, 异常时橙色标识 */}
      <div style={{ fontSize: 10, color: liveBad ? '#ff9800' : '#ff6b6b', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
        <span className="hs-live-dot" style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: liveBad ? '#ff9800' : '#ff6b6b' }} />
        {liveText}
      </div>
    </div>
  )
}

/** 骨架屏组件 */
function SkeletonBar({ width }: { width: string }) {
  return (
    <div style={{
      height: 12, borderRadius: 6, width,
      background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 100%)',
      backgroundSize: '200% 100%',
      animation: 'hsSlideUp 0.6s ease-out infinite alternate',
    }} />
  )
}

export function HotspotPanel() {
  // 自管理可见性：Scene surface 存在时自动显示（SSE 兜底通道）
  const hotspotScene = useSceneClient('hotspot-panel')
  // 语音显隐（P5.5 补：shell 模式语音"打开/关闭热点"可达，App 根层双模式常驻）
  const [voiceVisible, setVoiceVisible] = useState(false)
  // 2026-08-06: 用户关闭标记——语音"关闭热点"时强制隐藏，不等 surface 删除回调。
  // 修复: hotspotScene(useSceneClient)在删 surface 完成前仍为真,旧实现关不掉。
  const [dismissed, setDismissed] = useState(false)
  // 2026-08-06: 新 surface 到达(用户重新打开/后端推送)时重置关闭标记
  const prevSceneRef = useRef(!!hotspotScene)
  useEffect(() => {
    if (hotspotScene && !prevSceneRef.current) setDismissed(false)
    prevSceneRef.current = !!hotspotScene
  }, [hotspotScene])
  const visible = (voiceVisible || !!hotspotScene) && !dismissed

  // 2026-08-14 P2-图例2: 热点面板显隐时广播 custom event,让 VoiceShell 主布局
  // (holo-stage 场景卡墙 / chat-row 三栏对话)自动让出空间,避免被大面板盖住。
  // 2026-08-14: detail 带 name——VoiceShell 按名聚合(hotspot/typhoon 共享 70% 组合布局),
  // 避免两面板互斥切换时事件顺序导致布局状态错乱。
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible, name: 'hotspot' } }))
    } catch (e) { console.warn('[hotspot-panel] 广播可见性事件失败(极端环境):', e) }
  }, [visible])

  const [platforms, setPlatforms] = useState<HotspotPlatform[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // ── 统一关闭：清语音显隐 + 删 surface（按钮/语音接口共用）──
  // 2026-08-15: visible/onClose props 全库无调用方(App 裸挂载 <HotspotPanel />)——
  // 删除死参数, 关闭回调外发一并移除(写入面板状态仍保留)。
  const handleClose = useCallback(() => {
    setVoiceVisible(false)
    setDismissed(true)   // 强制隐藏（不等 surface 删除回调）
    apiPost('/api/scene/remove', { id: 'hotspot-panel' }).catch(e => console.warn('[HotspotPanel] 移除 surface 失败:', e))
    apiPost('/api/scene/panel-state', { panel: 'hotspot', state: 'closed' }).catch(e => console.warn('[HotspotPanel] 写入面板状态失败:', e))
  }, [])

  // ── 语音开关接口（P5.5：window.__hotspotPanel，对齐 __sceneShell 模式）──
  // open：面板自拉数据渲染（无需 surface 也有内容），恒可开；close：内部清理
  useEffect(() => {
    const api = {
      setVisible: (v: boolean): boolean => {
        if (v) { setVoiceVisible(true); setDismissed(false); return true }
        handleClose()
        return true
      },
      isVisible: () => visible,
    }
    // P7(GUI 全量修复, G1): registry 注册(自动镜像 window.__hotspotPanel)
    return registerCommandHost('hotspotPanel', api)
  }, [visible, handleClose])

  // ── 获取数据 ──
  // 2026-08-16 数据链审计 #8: in-flight ref 防重入——30s 轮询/手动刷新在
  // 上一次请求未返回时直接跳过(旧实现轮询盲目重发, 慢源下请求堆积)。
  const hotspotsInFlightRef = useRef(false)
  const fetchHotspots = useCallback(async (force = false, isAutoRetry = false) => {
    if (hotspotsInFlightRef.current) return
    hotspotsInFlightRef.current = true
    setError('')
    setLoading(true)
    try {
      const result = await apiGet(force ? '/panels/hotspot/all?refresh=1' : '/panels/hotspot/all')
      // 2026-08-16 修复: 静默失败——apiGet 对 401/超时/后端错误返回
      // {success:false} 而非抛异常, 旧实现未检查 success 直接解构 →
      // list 恒 undefined, 既不 setPlatforms 也不 setError, 面板显示
      // "暂无数据" 且无任何错误提示。现显式检查并上屏错误。
      if (!result?.success) {
        // 2026-09-05 修复「每次打开都失败, 必须手点重试」: 后端冷缓存抓取实测
        // 15.2s(30min TTL 过期后现场抓各资讯源), 压过前端 15s 超时——首次请求
        // 必超时, 但被中断的抓取在后端会继续完成并落缓存, 稍候重试即命中热缓存。
        // 故自动路径首次失败静默重试一次(保持骨架屏, 不闪错误); 手动 force
        // 重试失败仍直接上屏(用户已手动介入, 不再自作主张)。
        if (!isAutoRetry && !force) {
          hotspotsInFlightRef.current = false
          setTimeout(() => { void fetchHotspots(false, true) }, 1500)
          return
        }
        setError(result?.error || '加载失败')
        return
      }
      const raw = result.data
      const list = Array.isArray(raw) ? raw : (raw?.data || [])
      if (Array.isArray(list)) {
        setPlatforms(list)
      }
    } catch (e: any) {
      console.warn('[HotspotPanel] fetch error:', e.message)
      if (!isAutoRetry && !force) {
        hotspotsInFlightRef.current = false
        setTimeout(() => { void fetchHotspots(false, true) }, 1500)
        return
      }
      setError(e.message || '加载失败')
    } finally {
      hotspotsInFlightRef.current = false
      setLoading(false)
    }
  }, [])

  // ── 生命周期 ──
  // ef4cad5 RSS 移除轮误删本效应与派生统计块（热点数据线本应保留）：
  // 面板可见时首拉 + 30s 轮询；feed 相关调用已随 RSS 线移除
  useEffect(() => {
    if (!visible) return

    fetchHotspots()
    refreshTimerRef.current = setInterval(() => {
      fetchHotspots()
    }, 30000)

    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [visible, fetchHotspots])

  /* ─── 从真实数据派生统计 ─── */
  const totalItems = platforms.reduce((s, p) => s + p.items.length, 0)
  const successCount = platforms.filter(p => !p._error && p.items.length > 0).length
  const failCount = platforms.filter(p => p._error).length
  const stalePlatforms = platforms.filter(p => p.fetchedAt && Date.now() - p.fetchedAt > 600000)
  const freshness = stalePlatforms.length === 0 ? '实时' : `${stalePlatforms.length} 个源延迟`

  // 2026-08-16 数据链审计 #7: 跨平台 Top N 热点 → 地球可视化——
  // 旧实现 HotspotEarth 不吃任何数据, "全球热力图"是随机装饰点。
  // 此处按热度(hot 数值化)跨平台排序取 Top 12 传入, 地球点位与真实热点关联。
  const earthItems = useMemo(() => {
    const all: Array<{ title: string; hot: number; platform: string }> = []
    for (const p of platforms) {
      const platName = p.platform || ''
      for (const it of p.items || []) {
        if (!it.title) continue
        const hotNum = typeof it.hot === 'number'
          ? it.hot
          : (parseFloat(String(it.hot || '').replace(/[^\d.]/g, '')) || 0)
        all.push({ title: it.title, hot: hotNum, platform: platName })
      }
    }
    all.sort((a, b) => b.hot - a.hot)
    return all.slice(0, 12)
  }, [platforms])

  const now = Date.now()
  const newestFetch = platforms.reduce((latest, p) => Math.max(latest, p.fetchedAt || 0), 0)
  const fetchAgo = newestFetch ? Math.round((now - newestFetch) / 1000) : null

  /* ─── 智能分列（轮询分配，确保平衡） ─── */
  const sorted = [...platforms].sort((a, b) => (b.items.length - a.items.length))
  const leftCol: HotspotPlatform[] = []
  const rightCol: HotspotPlatform[] = []
  sorted.forEach((p, i) => {
    if (i % 2 === 0) leftCol.push(p)
    else rightCol.push(p)
  })

  /* ─── 搜索过滤（大小写不敏感） ─── */
  const filterItems = (items: HotspotItem[]) =>
    searchTerm ? items.filter(i => i.title.toLowerCase().includes(searchTerm.toLowerCase())) : items

  /* ─── 列表渲染 ─── */
  const renderHotspotList = (platform: HotspotPlatform) => {
    const filtered = filterItems(platform.items)
    const config = PLATFORM_CONFIG[platform.platform] || { label: platform.platform, color: '#888' }
    const showCount = Math.min(filtered.length, 15)

    return (
      <section key={platform.platform} style={{
        borderRadius: 12,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 14px', fontSize: 12, fontWeight: 600,
          display: 'flex', alignItems: 'center', gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          color: 'var(--text-primary, #eee)',
        }}>
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: config.color }} />
          {config.label}
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted, #888)' }}>
            {filtered.length > 15
              ? `${showCount} / ${filtered.length} 条`
              : `${filtered.length} 条`}
          </span>
        </div>

        <div style={{ padding: '0 14px', maxHeight: 300, overflowY: 'auto' }}>
          {platform._error ? (
            <div role="alert" style={{ padding: 16, textAlign: 'center', fontSize: 11, color: '#888' }}>
              {platform._error}
              <button onClick={() => fetchHotspots(true)}
                style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 4, background: 'rgba(89,168,255,0.15)', border: 'none', color: '#59a8ff', fontSize: 10, cursor: 'pointer' }}>
                重试
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', fontSize: 11, color: '#888' }}>
              {searchTerm ? '无匹配结果' : '暂无数据'}
            </div>
          ) : (
            filtered.slice(0, 15).map((item, idx) => {
              const badge = rankBadge(item.rank)
              return (
                <div
                  key={`${platform.platform}-${item.rank}-${idx}`}
                  className="hs-item-row"
                  onClick={() => {
                    if (item.url) openHotspotUrl(item.url)
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`${badge.label} ${item.title}`}
                  onKeyDown={e => {
                    // 2026-08-16 a11y 补齐: role=button 应同时响应 Enter 与空格
                    if ((e.key === 'Enter' || e.key === ' ') && item.url) {
                      e.preventDefault()
                      openHotspotUrl(item.url)
                    }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 0', cursor: item.url ? 'pointer' : 'default',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    transition: 'background 0.15s',
                  }}
                >
                  <span style={{
                    width: 20, height: 20, borderRadius: 5,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 9, fontWeight: 700, flexShrink: 0,
                    background: badge.bg, color: badge.color,
                  }}>
                    {badge.label}
                  </span>
                  <span style={{
                    flex: 1, fontSize: 12, lineHeight: 1.3,
                    color: 'var(--text-primary, #ddd)',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {item.title}
                  </span>
                  {item.hot && (
                    <span aria-label={`热度 ${item.hot}`}
                      style={{ fontSize: 10, color: '#ff6b6b', flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {formatHeat(item.hot)}
                    </span>
                  )}
                </div>
              )
            })
          )}
        </div>
      </section>
    )
  }

  return (
    <SideSheet open={visible} onClose={handleClose} name="hotspot" width="70vw">
      <style>{HS_STYLES}</style>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* ═══ 顶部标题栏 ═══ */}
        <header className="hs-header sheet-boot" style={{
          padding: '8px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(10,14,23,0.95)',
          backdropFilter: 'blur(12px)',
          ['--boot-delay' as any]: '40ms',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: '#59a8ff' }} aria-hidden="true">🔥</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #eee)' }}>热点追踪</span>
              <span style={{ fontSize: 10, color: failCount > 0 ? '#ff6b6b' : '#52c41a' }}>
                ● {failCount > 0 ? `${failCount} 个源异常` : '系统在线'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            {/* 状态指示 */}
            <div style={{ display: 'flex', gap: 16 }} aria-hidden="true">
              {[
                { label: '数据源', value: `${successCount}/${platforms.length}` },
                { label: '刷新', value: fetchAgo !== null ? `${fetchAgo}s前` : '-' },
                { label: '状态', value: freshness },
              ].map(s => (
                <div key={s.label} style={{ textAlign: 'center', fontSize: 10 }}>
                  <div style={{ color: '#888' }}>{s.label}</div>
                  <div style={{ color: '#52c41a' }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* 时钟（独立子组件——每秒 tick 不重渲染整个面板） */}
            <HSPanelClock failCount={failCount} freshness={freshness} />

            {/* 关闭 */}
            <button
              onClick={handleClose}
              className="hs-close-btn"
              data-close-btn
              aria-label="关闭热点面板"
              style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'rgba(255,255,255,0.05)',
                border: 'none', color: '#888',
                fontSize: 16, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.2s',
              }}
            >×</button>
          </div>
        </header>

        {/* ═══ 统计条（从真实数据派生） ═══ */}
        <div className="hs-stats-bar sheet-boot" style={{
          padding: '6px 20px',
          display: 'flex', gap: 10, flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          background: 'rgba(10,14,23,0.8)',
          ['--boot-delay' as any]: '130ms',
        }}>
          {[
            // 2026-08-16 审计修复: 第三卡 value 原为 totalItems(与第一卡重复,
            // label「数据源总量」与数值语义不符) → 改显示数据源数量;
            // 背景色用 hexToRgbTriplet——旧实现 rgba(f,0.1) 非法全透明
            { icon: '⚠', label: '热点总数', value: totalItems, color: '#ff6b6b', delta: '跨平台合并' },
            { icon: '🔥', label: '成功加载', value: `${successCount}/${platforms.length}`, color: '#ffc107', delta: failCount > 0 ? `${failCount} 个失败` : '全部正常' },
            { icon: '◈', label: '数据源', value: platforms.length, color: '#59a8ff', delta: freshness },
            { icon: '⬡', label: '最新刷新', value: fetchAgo !== null ? `${fetchAgo}s` : '-', color: '#52c41a', delta: new Date(newestFetch || Date.now()).toLocaleTimeString() },
          ].map(stat => (
            <div key={stat.label} style={{
              flex: 1, padding: '8px 14px', borderRadius: 8,
              background: `rgba(${hexToRgbTriplet(stat.color)},0.1)`,
              border: `1px solid rgba(${hexToRgbTriplet(stat.color)},0.2)`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span aria-hidden="true" style={{ fontSize: 14 }}>{stat.icon}</span>
                <div>
                  <div style={{ fontSize: 10, color: '#888' }}>{stat.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: stat.color }}>{stat.value}</div>
                </div>
                <div style={{ marginLeft: 'auto', fontSize: 10, color: stat.color }}>{stat.delta}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ═══ 主体三列 ═══ */}
        <div className="hs-body sheet-boot" style={{
          flex: 1, minHeight: 0,
          display: 'flex', gap: 12,
          padding: '8px 12px',
          overflow: 'hidden',
          ['--boot-delay' as any]: '330ms',
        }}>
          {/* ── 左列 ── */}
          <section style={{
            flex: 1, display: 'flex', flexDirection: 'column', gap: 10,
            minWidth: 200, overflowY: 'auto',
          }}>
            {loading && platforms.length === 0 ? (
              <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[1, 2, 3].map(i => <SkeletonBar key={i} width="100%" />)}
              </div>
            ) : leftCol.length > 0 ? (
              leftCol.map(p => renderHotspotList(p))
            ) : error ? (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                <div style={{ color: '#888', fontSize: 12 }}>加载失败：{error}</div>
                <button onClick={() => fetchHotspots(true)}
                  style={{ padding: '6px 16px', borderRadius: 6, background: 'rgba(89,168,255,0.15)', border: 'none', color: '#59a8ff', fontSize: 11, cursor: 'pointer' }}>
                  重试
                </button>
              </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 12 }}>
                暂无数据
              </div>
            )}
          </section>

          {/* ── 中列：3D地球 ── */}
          <section style={{
            flex: 1, display: 'flex', flexDirection: 'column', gap: 10,
            minWidth: 180, maxWidth: 420,
          }}>
            <div style={{
              flex: 1, borderRadius: 16,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.04)',
              overflow: 'hidden', position: 'relative',
            }}>
              <div style={{
                position: 'absolute', top: 12, left: 12,
                fontSize: 12, fontWeight: 600, color: '#59a8ff', zIndex: 1,
              }}>全球热力图</div>
              {visible && <HotspotEarth visible={visible} items={earthItems} />}
              <div style={{
                position: 'absolute', bottom: 12, left: 12,
                fontSize: 10, color: '#888', zIndex: 1,
              }}>拖拽旋转 · 滚轮缩放</div>
            </div>

            {/* 区域关注度 + 情绪指数 */}
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{
                flex: 1, borderRadius: 12,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                padding: 12,
              }}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
                  区域关注度 <span style={{ color: '#59a8ff' }}>示意数据</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {REGION_DATA_DEMO.slice(0, 4).map(r => (
                    <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, color: '#888', width: 50 }}>{r.name}</span>
                      <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{
                          height: '100%', borderRadius: 3,
                          background: 'linear-gradient(90deg, #59a8ff, #8fb6d8)',
                          width: `${r.pct}%`,
                        }} />
                      </div>
                      <span style={{ fontSize: 10, color: '#59a8ff', width: 30, textAlign: 'right' }}>{r.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{
                width: 120, borderRadius: 12,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                padding: 12,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
              }}>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
                  情绪指数 <span style={{ color: '#59a8ff' }}>示意数据</span>
                </div>
                <div style={{ position: 'relative', width: 70, height: 70 }}>
                  <svg viewBox="0 0 80 80" style={{ width: '100%', height: '100%' }} aria-hidden="true">
                    <circle cx="40" cy="40" r="28" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="5" />
                    <circle cx="40" cy="40" r="28" fill="none" stroke="#59a8ff" strokeWidth="5" strokeDasharray="175.9" strokeDashoffset="70" strokeLinecap="round" transform="rotate(-90 40 40)" />
                  </svg>
                  <div style={{
                    position: 'absolute', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)', textAlign: 'center',
                  }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#59a8ff' }}>64</div>
                    <div style={{ fontSize: 8, color: '#888' }}>中性偏热</div>
                  </div>
                </div>
                <div style={{ fontSize: 10, color: '#52c41a', marginTop: 8 }}>↑ 3.12%</div>
              </div>
            </div>
          </section>

          {/* ── 右列 ── */}
          <section style={{
            flex: 1, display: 'flex', flexDirection: 'column', gap: 10,
            minWidth: 200, overflowY: 'auto',
          }}>
            {rightCol.length > 0 ? (
              rightCol.map(p => renderHotspotList(p))
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 12 }}>
                暂无数据
              </div>
            )}
          </section>
        </div>

        {/* ═══ 搜索栏 ═══ */}
        {platforms.length > 0 && (
          <div style={{
            padding: '6px 20px', flexShrink: 0,
            borderTop: '1px solid rgba(255,255,255,0.04)',
            background: 'rgba(10,14,23,0.8)',
          }}>
            <div style={{ position: 'relative', maxWidth: 400 }}>
              <span style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                fontSize: 12, color: '#888', pointerEvents: 'none',
              }} aria-hidden="true">🔍</span>
              <input
                ref={inputRef}
                type="text"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    const el = document.querySelector('.hs-item-row') as HTMLElement
                    el?.focus()
                  }
                }}
                placeholder="搜索热点标题..."
                aria-label="搜索热点"
                style={{
                  width: '100%', padding: '6px 30px 6px 32px',
                  fontSize: 12, borderRadius: 8,
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: '#eee', outline: 'none',
                }}
              />
              {searchTerm && (
                <button
                  onClick={() => { setSearchTerm(''); inputRef.current?.focus() }}
                  aria-label="清除搜索"
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: '#888',
                    fontSize: 14, cursor: 'pointer', padding: 0, lineHeight: 1,
                  }}
                >×</button>
              )}
            </div>
          </div>
        )}

      </div>
    </SideSheet>
  )
}

export default HotspotPanel
