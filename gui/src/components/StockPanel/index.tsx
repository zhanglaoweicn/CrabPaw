/**
 * StockPanel — 股票行情侧滑面板（2026-08-14 新增；08-15 组合布局改造）
 *
 * 数据源：Scene surface 'stock-panel'（AI 调 ShowStock → panels/stock.js
 * 真实行情（东方财富四源冗余）+ K线（新浪源）→ upsertSurface）。
 * 布局（70vw 大面板组合模式，同热点/台风）：
 *   左列行情列表（名称/代码/现价/涨跌，A股惯例红涨绿跌）+ 大盘指数 + 免责声明
 *   右列 K线大图（复用 SceneShell kinds/chart.tsx ChartCard, 大尺寸参数）
 * 交互：语音/文本"打开股票/关闭股票"；发 crabpaw:hotspot-panel-visibility
 * (name:'stock') → VoiceShell 组合布局让位（语音球 compact + 对话窗右移）。
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { apiPost, apiGet, apiDelete } from '../../lib/api'
import { useSceneClient } from '../../lib/scene-client'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { SideSheet } from '../SideSheet'
import { ChartCard } from '../SceneShell/kinds/chart'
import { NewsBlock, FundamentalsBlock, EventsBlock } from './insights'
import type { StockNewsItem, StockEventItem, StockFundamentalsSummary } from './insights'

interface StockItem {
  code: string; name: string; price: number; change: number | null; changePct: number | null
  /** 2026-08-15 P2: 持仓联动(后端合并 holdings.json 注入) */
  holding?: { shares: number; cost: number }
  holdingPnl?: number
  holdingPnlPct?: number | null
  /** 2026-08-16: 深度分析 + LLM 解读（单股查询时附加；失败为 null） */
  analysis?: AnalysisData | null
  interpret?: InterpretData | null
}
/** 2026-08-16: 深度分析（analyzeStockFull 结构化结果——仅消费渲染所需字段） */
interface AnalysisData {
  momentum?: { rsi?: string; rsiStatus?: string; ma5?: string; ma10?: string; ma20?: string; trendStatus?: string; volumeRatio?: string } | null
  supportResistance?: { support?: string[]; resistance?: string[]; currentPrice?: string } | null
  multiTimeframe?: { shortTerm?: { trend?: string }; midTerm?: { trend?: string }; longTerm?: { trend?: string }; alignment?: string } | null
  pattern?: { patterns?: Array<{ name: string; reliability?: string; implication?: string }> } | null
  volatility?: { annualVolatility?: string; level?: string } | null
  quantitative?: Record<string, unknown> | null
  risks?: { risks?: Array<{ level?: string; type?: string; message?: string }>; warnings?: Array<{ level?: string; type?: string; message?: string }> } | null
  overallScore?: { finalScore?: number } | null
  macroEnv?: Record<string, unknown> | null
  industryProspects?: Record<string, unknown> | null
  capitalFlowFactor?: Record<string, unknown> | null
}
/** 2026-08-16: LLM 解读（source=llm 或 fallback 规则兜底） */
interface InterpretData {
  policy?: string
  market?: string
  technical?: string
  verdict?: {
    rating?: string; buyPoint?: number | null; sellPoint?: number | null
    position?: string; riskNote?: string; summary?: string
  }
  source?: 'llm' | 'fallback'
  disclaimer?: string
}
interface StockPanelData {
  items: StockItem[]
  kline: { labels: string[]; ohlc: Array<{ o: number; h: number; l: number; c: number }>; period?: string } | null
  index: { name: string; price: number | null; changePct: number | null } | null
  /** 2026-08-15 P2: 持仓摘要(总市值/成本) */
  holdingSummary?: { count: number; marketValue: number; costValue: number } | null
  updatedAt: string
  disclaimer: string
  failed: string[]
  /** 2026-08-21 P4: 卡片搜索增强（两路径统一注入；缺省 null → 前端整块隐藏） */
  news?: StockNewsItem[] | null
  events?: StockEventItem[] | null
  fundamentalsSummary?: StockFundamentalsSummary | null
}

// A 股惯例：红涨绿跌（颜色定义在 styles.css .stock-pct--up/--down，与
// kinds/chart.tsx candlestick 同口径）
function PctBadge({ value }: { value: number | null }) {
  if (value == null || !Number.isFinite(value)) {
    return <span className="stock-pct stock-pct--flat">—</span>
  }
  const up = value >= 0
  return (
    <span className={`stock-pct ${up ? 'stock-pct--up' : 'stock-pct--down'}`}>
      {up ? '▲' : '▼'} {up ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}

/** 2026-08-16: 综合建议卡——评级徽章 + 买卖点 + 仓位 + 摘要/风险 */
function VerdictCard({ item }: { item: StockItem }) {
  const v = item.interpret?.verdict
  const rating = v?.rating || '中性'
  const cls = rating === '强烈关注' ? '--hot' : rating === '关注' ? '--focus' : rating === '回避' ? '--avoid' : '--neutral'
  const src = item.interpret?.source === 'fallback'
  return (
    <div className="stock-verdict-card">
      <div className="stock-verdict-head">
        <span className={`stock-verdict-rating${cls}`}>{rating}</span>
        <span className="stock-verdict-score">
          {item.analysis?.overallScore?.finalScore != null ? `量化评分 ${item.analysis.overallScore.finalScore}` : ''}
        </span>
        {src && <span className="stock-verdict-fallback" title={item.interpret?.disclaimer}>规则摘要</span>}
      </div>
      <div className="stock-verdict-points">
        <div className="stock-verdict-point stock-verdict-point--buy">
          <span className="stock-verdict-point-label">买入点</span>
          <span className="stock-verdict-point-val">{v?.buyPoint != null ? v.buyPoint : '--'}</span>
        </div>
        <div className="stock-verdict-point stock-verdict-point--sell">
          <span className="stock-verdict-point-label">卖出点</span>
          <span className="stock-verdict-point-val">{v?.sellPoint != null ? v.sellPoint : '--'}</span>
        </div>
        <div className="stock-verdict-point stock-verdict-point--pos">
          <span className="stock-verdict-point-label">建议仓位</span>
          <span className="stock-verdict-point-val">{v?.position ? `${v.position}%` : '--'}</span>
        </div>
      </div>
      {v?.summary && <div className="stock-verdict-summary">{v.summary}</div>}
      {v?.riskNote && <div className="stock-verdict-risk">⚠ {v.riskNote}</div>}
      {src && <div className="stock-verdict-src">{item.interpret?.disclaimer}</div>}
    </div>
  )
}

/** 2026-08-16: 分析四卡——技术面/估值/资金流/政策市场 */
function AnalysisGrid({ item }: { item: StockItem }) {
  const a = item.analysis
  const i = item.interpret
  const sr = a?.supportResistance
  return (
    <div className="stock-analysis-grid">
      <div className="stock-analysis-card">
        <div className="stock-analysis-title">📐 技术面</div>
        <div className="stock-analysis-rows">
          <span>RSI {a?.momentum?.rsi ?? '--'}（{a?.momentum?.rsiStatus ?? '—'}）</span>
          <span>均线 {a?.momentum?.trendStatus ?? '—'}（MA5 {a?.momentum?.ma5 ?? '--'} / MA10 {a?.momentum?.ma10 ?? '--'} / MA20 {a?.momentum?.ma20 ?? '--'}）</span>
          <span>支撑 {sr?.support?.join(' / ') ?? '--'} · 压力 {sr?.resistance?.join(' / ') ?? '--'}</span>
          <span>形态 {a?.pattern?.patterns?.map(p => p.name).join('、') || '无'}</span>
          <span>多周期 {a?.multiTimeframe?.alignment ?? '—'} · 波动 {a?.volatility?.level ?? '—'}</span>
        </div>
        {i?.technical && <div className="stock-analysis-text">{i.technical}</div>}
      </div>
      <div className="stock-analysis-card">
        <div className="stock-analysis-title">💰 估值</div>
        <div className="stock-analysis-rows">
          <span>PE {(a?.quantitative as any)?.pe ?? '--'} · PB {(a?.quantitative as any)?.pb ?? '--'}</span>
          <span>估值结论 {(a?.quantitative as any)?.conclusion ?? '—'}</span>
        </div>
        <div className="stock-analysis-text">
          {(a?.quantitative as any)?.valuationSummary || '估值数据不足'}
        </div>
      </div>
      <div className="stock-analysis-card">
        <div className="stock-analysis-title">💧 资金流</div>
        <div className="stock-analysis-rows">
          <span>资金因子 {(a?.capitalFlowFactor as any)?.compositeScore != null ? `评分 ${(a?.capitalFlowFactor as any)?.compositeScore}` : '—'}</span>
          <span>主力资金 {(a?.capitalFlowFactor as any)?.summary || '—'}</span>
        </div>
      </div>
      <div className="stock-analysis-card">
        <div className="stock-analysis-title">🏛 政策 · 市场</div>
        {i?.policy
          ? <div className="stock-analysis-text">{i.policy}</div>
          : <div className="stock-analysis-rows"><span>政策面解读暂不可用（LLM 不可用时为规则摘要）</span></div>}
        {i?.market && <div className="stock-analysis-text">{i.market}</div>}
        <div className="stock-analysis-rows">
          <span>宏观 {(a?.macroEnv as any)?.summary || '—'} · 行业 {(a?.industryProspects as any)?.summary || '—'}</span>
        </div>
      </div>
      {a == null && (
        <div className="stock-analysis-card stock-analysis-card--empty">
          <div className="stock-analysis-title">📊 深度分析</div>
          <div className="stock-analysis-text">分析暂不可用（行情已加载）——点刷新重试。</div>
        </div>
      )}
    </div>
  )
}

function StockContent({ data, onClose, onRefresh, refreshing, refreshError, watchlist, onRemoveWatch }: {
  data: StockPanelData
  onClose: () => void
  onRefresh: (force: boolean, tfid?: string) => void
  refreshing: boolean
  refreshError: string
  watchlist: Array<{ code: string; name: string; addedAt?: number }>
  onRemoveWatch: (code: string) => void
}) {
  const items = Array.isArray(data.items) ? data.items : []
  const primary = items[0]
  // 2026-08-15 P2: 涨跌统计摘要 + 周期状态
  const upCount = items.filter(it => (it.changePct ?? 0) > 0).length
  const downCount = items.filter(it => (it.changePct ?? 0) < 0).length
  const avgPct = items.length > 0 && items.every(it => it.changePct != null)
    ? items.reduce((s, it) => s + (it.changePct ?? 0), 0) / items.length
    : null
  const period = data.kline?.period === 'week' ? 'week' : 'day'
  return (
    <div className="stock-panel">
      {/* 头部 */}
      <header className="stock-panel-header sheet-boot" style={{ ['--boot-delay' as any]: '40ms' }}>
        <div className="stock-panel-header-left">
          <span aria-hidden="true">📈</span>
          <span className="stock-panel-title">股票行情</span>
          <span className="stock-panel-updated">
            {data.updatedAt ? `更新于 ${new Date(data.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* 2026-08-15 P2: K线周期切换(周K由日线聚合, 后端标注口径)
              2026-08-31: 独立 stock-period-btn 类——此前误用 stock-panel-close
              (为单字符×设计: width:28px 固定宽 + font-size:16px)，双字中文被挤变形 */}
          <div className="stock-period-group" role="group" aria-label="K线周期">
            <button
              type="button"
              className={`stock-period-btn${period === 'day' ? ' is-active' : ''}`}
              onClick={() => onRefresh(false, 'period:day')}
              aria-label="日K线"
              aria-pressed={period === 'day'}
              title="日K线"
            >日K</button>
            <button
              type="button"
              className={`stock-period-btn${period === 'week' ? ' is-active' : ''}`}
              onClick={() => onRefresh(false, 'period:week')}
              aria-label="周K线"
              aria-pressed={period === 'week'}
              title="周K线（日线聚合）"
            >周K</button>
          </div>
          {/* 2026-08-15 交互对齐: 手动刷新按钮(?refresh=1 绕过缓存) */}
          <button
            type="button"
            className="stock-panel-close"
            onClick={() => onRefresh(true)}
            aria-label="刷新股票行情"
            title="刷新行情"
            disabled={refreshing}
          >{refreshing ? '…' : '⟳'}</button>
          <button
            data-close-btn
            type="button"
            className="stock-panel-close"
            onClick={onClose}
            aria-label="关闭股票面板"
            title="关闭"
          >×</button>
        </div>
      </header>
      {/* 2026-08-15: 刷新失败提示(透明错误态) */}
      {refreshError && (
        <div className="typhoon-refresh-error" role="alert">⚠ {refreshError}</div>
      )}

      {/* 2026-08-16: 收藏条（分析过的股票自动收藏，点击切换） */}
      {watchlist.length > 0 && (
        <div className="stock-watchlist-bar sheet-boot" style={{ ['--boot-delay' as any]: '90ms' }}>
          <span className="stock-watchlist-label">⭐ 自选</span>
          <div className="stock-watchlist-scroll">
            {watchlist.map(w => (
              <button
                key={w.code}
                type="button"
                className={`stock-watch-chip${primary && primary.code === w.code ? ' is-active' : ''}`}
                onClick={() => onRefresh(false, 'select:' + w.code)}
                title={`切换分析 ${w.name}`}
              >
                <span className="stock-watch-chip-name">{w.name}</span>
                <span
                  className="stock-watch-chip-remove"
                  role="button"
                  tabIndex={0}
                  aria-label={`取消收藏${w.name}`}
                  onClick={(e) => { e.stopPropagation(); onRemoveWatch(w.code) }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onRemoveWatch(w.code) }
                  }}
                >×</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 主体：左行情列表 + 右 K线大图（08-15 组合布局双列） */}
      <div className="stock-panel-body sheet-boot" style={{ ['--boot-delay' as any]: '130ms' }}>
        {items.length === 0 ? (
          <div className="stock-panel-empty">暂无行情数据</div>
        ) : (
          <>
            {/* 左列：行情列表 + 指数 + 失败提示 */}
            <div className="stock-list-col">
              {/* 2026-08-16: 综合建议卡（评级/买卖点/仓位/摘要/风险） */}
              {primary && (primary.interpret || primary.analysis) && (
                <VerdictCard item={primary} />
              )}
              {/* 2026-08-15 P2: 涨跌统计摘要行(一眼看懂盘面) */}
              <div className="stock-summary-row">
                <span className="stock-summary-up">▲ {upCount} 涨</span>
                <span className="stock-summary-down">▼ {downCount} 跌</span>
                {avgPct != null && (
                  <span className={avgPct >= 0 ? 'stock-summary-up' : 'stock-summary-down'}>
                    均 {avgPct >= 0 ? '+' : ''}{avgPct.toFixed(2)}%
                  </span>
                )}
              </div>
              {/* 2026-08-15 P2: 持仓摘要卡(与行情同源合并, 盈亏由现价×持仓计算) */}
              {data.holdingSummary && (
                <div className="stock-holdings-card">
                  <div className="stock-holdings-title">📦 持仓 {data.holdingSummary.count} 只</div>
                  <div className="stock-holdings-row">
                    <span>市值 {Math.round(data.holdingSummary.marketValue).toLocaleString('zh-CN')}</span>
                    {(() => {
                      const pnl = data.holdingSummary.marketValue - data.holdingSummary.costValue
                      const pct = data.holdingSummary.costValue > 0 ? (pnl / data.holdingSummary.costValue) * 100 : 0
                      return (
                        <span className={pnl >= 0 ? 'stock-summary-up' : 'stock-summary-down'}>
                          {pnl >= 0 ? '浮盈' : '浮亏'} {Math.abs(Math.round(pnl)).toLocaleString('zh-CN')}（{pnl >= 0 ? '+' : ''}{pct.toFixed(1)}%）
                        </span>
                      )
                    })()}
                  </div>
                </div>
              )}
              <div className="stock-list">
                {items.map(it => (
                  /* 2026-08-15 P2: 行点击切换K线(选中股排首位由后端首只附K线) */
                  <div
                    key={it.code}
                    className={`stock-row${primary && it.code === primary.code ? ' is-selected' : ''}`}
                    onClick={() => onRefresh(false, it.code)}
                    title="点击切换K线"
                    // 2026-08-15 a11y: 行点击无 role/tabIndex/keydown, 键盘不可达——
                    // 对齐 HotspotPanel hs-item-row 模式补键盘可达
                    role="button"
                    tabIndex={0}
                    aria-label={`切换K线到${it.name}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRefresh(false, it.code)
                      }
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <div className="stock-row-name">
                      <span className="stock-row-name-main">{it.name}</span>
                      <span className="stock-row-code">{it.code}</span>
                      {it.holding && (
                        <span className="stock-holding-badge" title={`持仓 ${it.holding.shares} 股 · 成本 ${it.holding.cost}`}>持</span>
                      )}
                    </div>
                    <div className="stock-row-price">
                      {it.holding && it.holdingPnl != null && (
                        <span className={it.holdingPnl >= 0 ? 'stock-summary-up' : 'stock-summary-down'} style={{ fontSize: 10 }}>
                          {it.holdingPnl >= 0 ? '+' : ''}{it.holdingPnl.toLocaleString('zh-CN')}
                        </span>
                      )}
                      <span className="stock-row-price-main">{Number(it.price) || '--'}</span>
                      <PctBadge value={it.changePct} />
                    </div>
                  </div>
                ))}
              </div>

              {data.index && (
                <div className="stock-index-row">
                  <span className="stock-index-name">{data.index.name || '上证指数'}</span>
                  <span className="stock-index-price">{data.index.price != null ? Number(data.index.price).toFixed(2) : '--'}</span>
                  <PctBadge value={data.index.changePct} />
                </div>
              )}

              {data.failed.length > 0 && (
                <div className="stock-failed">未取到行情：{data.failed.join('、')}</div>
              )}
              {/* 2026-08-21 P4: 搜索增强三块——相关资讯默认展开/基本面摘要/事件时间线折叠；null 整块隐藏 */}
              <NewsBlock news={data.news ?? null} />
              <FundamentalsBlock f={data.fundamentalsSummary ?? null} />
              <EventsBlock events={data.events ?? null} />
              <div className="stock-disclaimer">{data.disclaimer || '数据仅供参考，不构成投资建议。'}</div>
            </div>

            {/* 右列：K线大图（仅首只股票） */}
            {data.kline && data.kline.labels && data.kline.labels.length > 0 && primary && (
              <div className="stock-kline">
                <ChartCard
                  width={560}
                  height={320}
                  data={{
                    type: 'candlestick',
                    title: `${primary.name}（${primary.code}）K线`,
                    labels: data.kline.labels,
                    ohlc: data.kline.ohlc,
                    // 2026-08-16: 买卖点虚线（LLM 建议价优先，规则支撑/压力兜底）
                    markLines: (() => {
                      const i = primary.interpret?.verdict
                      const sr = primary.analysis?.supportResistance
                      const buy = i?.buyPoint ?? (sr?.support?.[0] != null ? Number(sr.support[0]) : null)
                      const sell = i?.sellPoint ?? (sr?.resistance?.[0] != null ? Number(sr.resistance[0]) : null)
                      const lines: Array<{ value: number; label: string; color: string }> = []
                      if (Number.isFinite(buy)) lines.push({ value: buy as number, label: '买入点', color: '#10b981' })
                      if (Number.isFinite(sell)) lines.push({ value: sell as number, label: '卖出点', color: '#f43f5e' })
                      return lines
                    })(),
                  }}
                />
              </div>
            )}

            {/* 2026-08-16: 分析四卡（技术面/估值/资金流/政策市场）——
                analysis 为 null 时 AnalysisGrid 内部渲染"分析暂不可用"占位卡，
                外层不得再按 primary.analysis 过滤（否则占位卡死代码不可达） */}
            {primary && (
              <AnalysisGrid item={primary} />
            )}
          </>
        )}
      </div>
    </div>
  )
}

export function StockPanel() {
  const surface = useSceneClient('stock-panel')
  const [dismissed, setDismissed] = useState(false)
  const [voiceVisible, setVoiceVisible] = useState(false)
  // 新 surface 到达重置关闭标记（对齐 HotspotPanel 模式）
  const prevSceneRef = useRef(!!surface)
  useEffect(() => {
    if (surface && !prevSceneRef.current) {
      setDismissed(false)
      closedRef.current = false // 2026-08-15: 新一轮推送 → 允许刷新
    }
    prevSceneRef.current = !!surface
  }, [surface])
  const visible = (voiceVisible || !!surface) && !dismissed
  // surface 数据守卫——items 非数组视为畸形数据不渲染
  const data: StockPanelData | null = surface?.data && Array.isArray(surface.data.items)
    ? surface.data as StockPanelData
    : null

  // 2026-08-15: 组合布局联动——与 HotspotPanel/TyphoonPanel 同款广播,
  // VoiceShell 按 name 聚合大面板状态（语音球 compact + 对话窗右移 + 右栏隐藏）
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible, name: 'stock' } }))
    } catch (e) { console.warn('[stock-panel] 广播可见性事件失败(极端环境):', e) }
  }, [visible])

  // 2026-08-15 交互对齐: 面板打开期间每 5 分钟自动刷新行情(行情实时性),
  // 失败置错误提示; 手动刷新按钮走 ?refresh=1 绕过 30s 缓存。
  // queries 由当前数据条目代码反推, 保持"刷新同一批股票"语义。
  // 2026-08-15 P2: option 支持 'period:day'/'period:week'(周期切换)与
  // 股票代码(点击行切换K线——选中股排首位, 后端首只附K线)。
  const [refreshError, setRefreshError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async (force: boolean, option?: string) => {
    if (!data || closedRef.current) return
    let queries = data.items.map(it => it.code)
    let period = data.kline?.period === 'week' ? 'week' : 'day'
    if (option === 'period:day') period = 'day'
    else if (option === 'period:week') period = 'week'
    else if (option?.startsWith('select:')) {
      // 2026-08-17: 收藏 chip 切换——单股查询（后端仅 queries.length===1 时附深度分析，
      // 走通用 option 分支会重组多股 → 分析链永久断裂无法恢复）
      queries = [option.slice('select:'.length)]
    }
    else if (option) {
      // 点击个股: 选中股排首位(后端首只附K线)
      queries = [option, ...queries.filter(c => c !== option)]
    }
    const params = new URLSearchParams({ queries: queries.join(',') })
    if (force) params.set('refresh', '1')
    if (period !== 'day') params.set('period', 'week')
    setRefreshing(true)
    try {
      const res = await apiGet<{ updatedAt?: string }>(`/panels/stock?${params.toString()}`)
      if (res?.data?.updatedAt) setRefreshError('')
      else setRefreshError('数据刷新返回异常')
    } catch (e) {
      console.error('[StockPanel] 数据刷新失败:', e)
      setRefreshError('行情刷新失败，点击重试')
    } finally {
      setRefreshing(false)
    }
  }, [data])
  useEffect(() => {
    if (!visible) return
    const t = setInterval(() => { refresh(false).catch((e) => console.warn('[StockPanel] 定时刷新失败:', e?.message || e)) }, 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [visible, refresh])

  // 2026-08-16: 收藏列表（自动收藏由后端完成；面板负责拉取与切换/移除）
  const [watchlist, setWatchlist] = useState<Array<{ code: string; name: string; addedAt?: number }>>([])
  useEffect(() => {
    let alive = true
    apiGet<{ list?: Array<{ code: string; name: string; addedAt?: number }> }>('/panels/stock/watchlist')
      .then(res => { if (alive && Array.isArray(res?.data?.list)) setWatchlist(res.data.list) })
      .catch(e => console.warn('[StockPanel] 收藏列表拉取失败:', e))
    return () => { alive = false }
  }, [visible])
  const onRemoveWatch = useCallback((code: string) => {
    setWatchlist(prev => prev.filter(w => w.code !== code))   // 乐观更新
    apiDelete(`/panels/stock/watchlist?code=${encodeURIComponent(code)}`)
      .catch(e => {
        console.error('[StockPanel] 取消收藏失败:', e)
        apiGet<{ list?: Array<{ code: string; name: string; addedAt?: number }> }>('/panels/stock/watchlist')
          .then(res => { if (Array.isArray(res?.data?.list)) setWatchlist(res.data.list) })
          .catch(e2 => console.warn('[StockPanel] 收藏列表重拉失败:', e2))
      })
  }, [])

  // 2026-08-15 修复"关闭按钮无效": 关闭后刷新请求(5min 轮询/行点击/手动刷新)
  // 落地会重新 upsert surface → 面板被"复活"。closedRef 守卫: 关闭后刷新直接跳过;
  // 新 surface 到达(重新打开)时复位。
  const closedRef = useRef(false)

  const handleClose = useCallback(() => {
    closedRef.current = true
    setDismissed(true)
    setVoiceVisible(false)
    apiPost('/api/scene/remove', { id: 'stock-panel' }).catch(e => console.warn('[StockPanel] 移除 surface 失败:', e))
    apiPost('/api/scene/panel-state', { panel: 'stock', state: 'closed' }).catch(e => console.warn('[StockPanel] 写入面板状态失败:', e))
  }, [])

  // 语音/文本开关接口（window.__stockPanel，对齐 __weatherPanel/__typhoonPanel 模式）
  useEffect(() => {
    const api = {
      setVisible: (v: boolean): boolean => {
        if (v) {
          if (!data) return false
          setDismissed(false)
          setVoiceVisible(true)
          return true
        }
        handleClose()
        return true
      },
      isVisible: () => visible,
    }
    return registerCommandHost('stockPanel', api)
  }, [data, visible, handleClose])

  return (
    <SideSheet open={visible} onClose={handleClose} name="stock" width="70vw">
      {data && <StockContent data={data} onClose={handleClose} onRefresh={refresh} refreshing={refreshing} refreshError={refreshError} watchlist={watchlist} onRemoveWatch={onRemoveWatch} />}
    </SideSheet>
  )
}

export default StockPanel
