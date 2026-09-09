/**
 * StockPanel insights — 卡片搜索增强三块（2026-08-21 P4）
 *
 * 后端两路径（panel/StockQuery）data 顶层统一注入：
 *   news: 相关资讯（三源合并，默认展开前 5 条）
 *   fundamentalsSummary: 基本面摘要（默认折叠）
 *   events: 事件时间线（默认折叠）
 * 缺省 null → 对应 Block 整块隐藏（不影响行情主体）。
 *
 * 设计红线（计划）：结构化呈现（标题+来源+时间，绝不用 WebSearch 原始文本）；
 * 搜索是补充不是替代（折叠/次要位置）；A 股语境红涨绿跌（pos 红▲ / neg 绿▼）。
 */
import { useState } from 'react'
import { isElectron } from '../../lib/api'

export interface StockNewsItem {
  title: string
  url: string | null
  source: '新闻' | '股吧' | '公告' | string
  time: string | null
  sentiment: 'pos' | 'neg' | 'neu' | null
}
export interface StockEventItem {
  type: string
  date: string
  detail: string
  direction: 'pos' | 'neg' | 'neu' | string
  url: string | null
}
export interface StockFundamentalsSummary {
  company: {
    businessModel?: string; pricing?: string; moat?: string; management?: string
    overallScore?: number; summary?: string
  } | null
  industry: {
    name?: string; prosperity?: string; supplyDemand?: string; lifecycle?: string; summary?: string
  } | null
  metrics: Array<{ name: string; value: string; status?: string; score?: number }> | null
  score: number | null
  summary: string | null
}

/** A 股语境情绪三角：pos 红▲ / neg 绿▼ / neu 与 null 不渲染 */
function SentimentMark({ sentiment }: { sentiment: StockNewsItem['sentiment'] }) {
  if (sentiment === 'pos') return <span className="stock-sentiment stock-sentiment--pos" title="利好">▲</span>
  if (sentiment === 'neg') return <span className="stock-sentiment stock-sentiment--neg" title="利空">▼</span>
  return null
}

/** 事件类型 emoji 集中映射（仿 daily_stock_analysis 集中定义模式） */
const EVENT_ICONS: Record<string, string> = {
  '业绩超预期': '📊', '业绩不及预期': '📊', '财报披露': '📊',
  '回购': '💰', '高管增持': '📈', '高管减持': '📉', '解禁': '🔓', '风险': '⚠️',
}
const EVENT_ICON_FALLBACK = '📌'

/** 相对时间（本地 helper，仿 News/ArticleCard 写法）；解析失败返回空串 */
function timeAgo(time: string | null): string {
  if (!time) return ''
  const ts = new Date(time.replace(' ', 'T')).getTime()
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 60 * 1000) return '刚刚'
  const min = Math.floor(diff / 60000)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  return day <= 30 ? `${day}天前` : new Date(ts).toLocaleDateString('zh-CN')
}

/** 严格复刻 HotspotPanel openHotspotUrl（:118-125）——Electron shell 优先，window.open 兜底 */
export function openInsightUrl(url: string) {
  const shell = window.electronAPI?.shell
  if (isElectron() && shell?.openExternal) {
    shell.openExternal(url).catch((e) => console.warn('[StockPanel] openExternal 失败:', e))
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/** 折叠头（showDetails state + Chevron，仿 CostDashboard 模式） */
function CollapseHead({ title, badge, defaultOpen = false, children }: {
  title: string; badge?: string; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="stock-insight-block">
      <button
        type="button"
        className="stock-insight-head"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span className="stock-insight-title">{title}</span>
        {badge && <span className="stock-insight-badge">{badge}</span>}
        <span className={`stock-insight-chevron${open ? ' is-open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open && <div className="stock-insight-body">{children}</div>}
    </div>
  )
}

/** A 相关资讯——默认展开，前 5 条，>5 展开全部；行可点跳原文 */
export function NewsBlock({ news }: { news: StockNewsItem[] | null }) {
  const [expanded, setExpanded] = useState(false)
  if (!Array.isArray(news) || news.length === 0) return null
  const shown = expanded ? news : news.slice(0, 5)
  return (
    <CollapseHead title="相关资讯" badge={`${news.length}条`} defaultOpen>
      <div className="stock-news-list">
        {shown.map((n, i) => (
          <div
            key={`${n.title}-${i}`}
            className={`stock-news-item${n.url ? ' is-link' : ''}`}
            role={n.url ? 'button' : undefined}
            tabIndex={n.url ? 0 : undefined}
            aria-label={n.url ? `打开新闻：${n.title}` : undefined}
            onClick={() => { if (n.url) openInsightUrl(n.url) }}
            onKeyDown={n.url ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInsightUrl(n.url as string) }
            } : undefined}
          >
            <SentimentMark sentiment={n.sentiment} />
            <span className="stock-news-title">{n.title}</span>
            <span className="stock-news-meta">
              <span className={`stock-news-src stock-news-src--${n.source}`}>{n.source}</span>
              {timeAgo(n.time) && <span className="stock-news-time">{timeAgo(n.time)}</span>}
            </span>
          </div>
        ))}
      </div>
      {news.length > 5 && (
        <button type="button" className="stock-news-more" onClick={() => setExpanded(e => !e)}>
          {expanded ? '收起' : `展开全部 ${news.length} 条`}
        </button>
      )}
    </CollapseHead>
  )
}

/** B 基本面摘要——默认折叠：公司/行业 chip + 估值 metrics + 综合 summary */
export function FundamentalsBlock({ f }: { f: StockFundamentalsSummary | null }) {
  if (!f) return null
  return (
    <CollapseHead title="基本面摘要" badge={f.score != null ? `评分 ${f.score}` : undefined}>
      {f.company && (
        <div className="stock-fund-section">
          <div className="stock-fund-chips">
            {f.company.businessModel && <span className="stock-fund-chip">模式 {f.company.businessModel}</span>}
            {f.company.pricing && <span className="stock-fund-chip">定价 {f.company.pricing}</span>}
            {f.company.moat && <span className="stock-fund-chip">护城河 {f.company.moat}</span>}
            {f.company.management && <span className="stock-fund-chip">管理 {f.company.management}</span>}
          </div>
          {f.company.summary && <div className="stock-fund-text">{f.company.summary}</div>}
        </div>
      )}
      {f.industry && (
        <div className="stock-fund-section">
          <div className="stock-fund-chips">
            {f.industry.name && <span className="stock-fund-chip">行业 {f.industry.name}</span>}
            {f.industry.prosperity && <span className="stock-fund-chip">景气 {f.industry.prosperity}</span>}
            {f.industry.supplyDemand && <span className="stock-fund-chip">供需 {f.industry.supplyDemand}</span>}
            {f.industry.lifecycle && <span className="stock-fund-chip">周期 {f.industry.lifecycle}</span>}
          </div>
          {f.industry.summary && <div className="stock-fund-text">{f.industry.summary}</div>}
        </div>
      )}
      {Array.isArray(f.metrics) && f.metrics.length > 0 && (
        <div className="stock-fund-metrics">
          {f.metrics.map(m => (
            <div key={m.name} className="stock-fund-metric">
              <span className="stock-fund-metric-name">{m.name}</span>
              <span className="stock-fund-metric-val">{m.value}{m.status ? `（${m.status}）` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {f.summary && <div className="stock-fund-summary">{f.summary}</div>}
    </CollapseHead>
  )
}

/** C 事件时间线——默认折叠：竖线+圆点，direction 三色（pos 红/neg 绿/neu 灰），url 整行可点 */
export function EventsBlock({ events }: { events: StockEventItem[] | null }) {
  if (!Array.isArray(events) || events.length === 0) return null
  return (
    <CollapseHead title="事件时间线" badge={`${events.length}个`}>
      <div className="stock-events-list">
        {events.map((ev, i) => (
          <div
            key={`${ev.type}-${ev.date}-${i}`}
            className={`stock-events-row${ev.url ? ' is-link' : ''}`}
            role={ev.url ? 'button' : undefined}
            tabIndex={ev.url ? 0 : undefined}
            aria-label={ev.url ? `打开公告：${ev.type}` : undefined}
            onClick={() => { if (ev.url) openInsightUrl(ev.url) }}
            onKeyDown={ev.url ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openInsightUrl(ev.url as string) }
            } : undefined}
          >
            <div className={`stock-events-dot stock-events-dot--${ev.direction || 'neu'}`} />
            <div className="stock-events-body">
              <div className="stock-events-type">
                <span className="stock-events-icon">{EVENT_ICONS[ev.type] || EVENT_ICON_FALLBACK}</span>
                <span className="stock-events-type-name">{ev.type}</span>
                {ev.date && <span className="stock-events-date">{ev.date}</span>}
              </div>
              {ev.detail && <div className="stock-events-detail">{ev.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </CollapseHead>
  )
}
