import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  TrendingUp, Zap, BarChart3, RefreshCw,
  PiggyBank, Activity, Clock,
  ChevronDown, ChevronUp, Flame, Coins, AlertTriangle
} from 'lucide-react'
import { apiGet } from '../../lib/api'
// P6(GUI 全量修复 P1): 汇总卡随周期联动——后端 period 只裁剪图表 byDay,
// total 恒全时段 → 切"今日"显示全量数据的口径错误
import { aggregatePeriodMetrics } from '../../lib/usage-period'
// 2026-08-27 A6: 预算三态 chip 迁移 CockpitUI StatusBadge(超限=danger/预警=warn/正常=success)
import { StatusBadge } from '../CockpitUI'


// ============================================================================
// 类型定义
// ============================================================================

interface DayData {
  date: string
  costCny: number
  costUsd: number
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  cacheSavings?: number
}

interface ModelData {
  costCny: number
  costUsd: number
  calls: number
  promptTokens: number
  completionTokens: number
}

interface ProviderData {
  requests: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  totalTokens: number
  estimatedCost: number
  cacheSavings: number
}

interface CostSummary {
  totalCostCny: number
  totalCostUsd: number
  todayCostCny: number
  todayCostUsd: number
  monthCostCny: number
  monthCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  todayTokens: number
  monthTokens: number
  totalRequests?: number
  totalCacheSavings?: number
  byModel: Record<string, ModelData>
  byDay: DayData[]
  byProvider?: Record<string, ProviderData>
  byType?: Record<string, { requests: number; units: number; estimatedCost: number }>
  total?: {
    requests: number
    promptTokens: number
    completionTokens: number
    cachedTokens: number
    totalTokens: number
    estimatedCost: number
    cacheSavings: number
  }
}

interface TokenUsagePillProps {
  inputTokens?: number
  outputTokens?: number
  costCny?: number
  compact?: boolean
}

// ============================================================================
// 工具函数
// ============================================================================

function formatCost(cny: number): string {
  if (!Number.isFinite(cny) || cny <= 0) return '¥0'
  if (cny >= 1) return `¥${cny.toFixed(2)}`
  if (cny >= 0.01) return `¥${cny.toFixed(4)}`
  if (cny >= 0.0001) return `¥${cny.toFixed(6)}`
  return `¥${cny.toFixed(8)}`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n >= 1000000000) return `${(n / 1000000000).toFixed(2)}B`
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function getCostLevel(cny: number): 'low' | 'medium' | 'high' {
  if (cny > 10) return 'high'
  if (cny > 1) return 'medium'
  return 'low'
}

const COST_COLORS = {
  low: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/20', bar: 'bg-green-500/60' },
  medium: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/20', bar: 'bg-yellow-500/60' },
  high: { bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/20', bar: 'bg-red-500/60' },
}

// A5: 环形图供应商配色(与堆叠条 bg-*-500 同色系的十六进制)
const PROVIDER_RING_COLORS: Record<string, string> = {
  deepseek: '#3b82f6', zhipu: '#a855f7', qwen: '#f97316',
  openai: '#22c55e', anthropic: '#f59e0b', doubao: '#06b6d4',
}

// ============================================================================
// A5: 每日柱状图覆盖层几何(4日均值趋势线 + 累计曲线)
// ============================================================================
// 柱容器 h-28=112px, SVG viewBox="0 0 100 112" + preserveAspectRatio="none" 映射:
//   x 用 0-100 数值(viewBox 单位)——勿带 '%' 后缀(带 % 会被解析为非法坐标);
//   y = 112*(1-v); 柱高 pct*0.9(≤100.8px), 故累计线限高 0.7(≤78.4px) 避让;
//   柱 x 中点=(i+0.5)*step 为近似(柱宽受 gap-[2px] 影响, 偏差<1%, 可接受)。
function computeOverlay(displayDays: DayData[], max: number, value: (d: DayData) => number) {
  const n = displayDays.length
  const step = 100 / n
  const pts = displayDays.map((d, i) => ({ x: (i + 0.5) * step, v: value(d) / max }))
  // 4 日均值(含当日, 前 4 个点用可用窗口)
  const ma = pts.map((_p, i) => {
    const from = Math.max(0, i - 3)
    const win = pts.slice(from, i + 1)
    return win.reduce((s, q) => s + q.v, 0) / win.length
  })
  // 累计(归一到最终累计值, 限高 70% 与柱 90% 避让)
  const cum = (() => {
    let acc = 0
    const vals = pts.map(p => { acc += p.v; return Math.min(acc, 1) })
    const maxAcc = vals[vals.length - 1] || 1
    return vals.map(v => (v / maxAcc) * 0.7)
  })()
  const yOf = (v: number) => 112 * (1 - v) // 容器 h-28 = 112px
  return {
    maPath: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${yOf(Math.max(0.02, ma[i])).toFixed(1)}`).join(' '),
    cumPath: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${yOf(cum[i]).toFixed(1)}`).join(' '),
  }
}

// ============================================================================
// TokenUsagePill (复用组件)
// ============================================================================

export function TokenUsagePill({ inputTokens = 0, outputTokens = 0, costCny = 0, compact = false }: TokenUsagePillProps) {
  const totalTokens = inputTokens + outputTokens
  const utilization = totalTokens > 100000 ? 'high' : totalTokens > 30000 ? 'medium' : 'low'
  const colors = COST_COLORS[utilization]

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${colors.bg} ${colors.text} ${colors.border}`}>
        <Zap className="w-3 h-3" />
        {totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens}
      </span>
    )
  }

  return (
    <div className={`inline-flex items-center gap-2 text-xs px-3 py-1 rounded-full border ${colors.bg} ${colors.text} ${colors.border}`}>
      <Zap className="w-3 h-3" />
      <span>入 {inputTokens > 1000 ? `${(inputTokens / 1000).toFixed(1)}k` : inputTokens}</span>
      <span>出 {outputTokens > 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : outputTokens}</span>
      {costCny > 0 && <span>¥{costCny.toFixed(4)}</span>}
    </div>
  )
}

// ============================================================================
// 概览卡片
// ============================================================================

function StatCard({ label, value, icon: Icon, iconColor, sub, trend: _trend }: {
  label: string
  value: string
  icon: React.ElementType
  iconColor: string
  sub?: string
  trend?: 'up' | 'down' | 'flat'
}) {
  return (
    <div className="theme-card rounded-xl p-4 hover:border-zinc-500/30 transition-all duration-200">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs theme-text-muted">{label}</span>
        <Icon className={`w-4 h-4 ${iconColor}`} />
      </div>
      <div className="text-xl font-bold theme-text-primary">{value}</div>
      {sub && <div className="text-[11px] theme-text-muted mt-1">{sub}</div>}
    </div>
  )
}

// ============================================================================
// 每日成本柱状图 (增强版)
// ============================================================================
// 按类型用量分布（chat/vision/image/video/tts/asr）
// ============================================================================

const TYPE_META: Record<string, { label: string; icon: string; color: string; unitLabel: (u: number) => string }> = {
  chat:   { label: '对话',     icon: 'MessageSquare', color: 'text-blue-400',    unitLabel: (u) => `${formatTokens(u)} tokens` },
  vision: { label: '视觉理解', icon: 'Eye',           color: 'text-purple-400',  unitLabel: (u) => `${formatTokens(u)} tokens` },
  image:  { label: '图片生成', icon: 'Image',         color: 'text-pink-400',    unitLabel: (u) => `${u} 张` },
  video:  { label: '视频生成', icon: 'Film',          color: 'text-orange-400',  unitLabel: (u) => `${u.toFixed(1)} 秒` },
  tts:    { label: '语音合成', icon: 'Volume2',       color: 'text-emerald-400', unitLabel: (u) => `${u.toFixed(1)} 秒` },
  asr:    { label: '语音识别', icon: 'Mic',           color: 'text-yellow-400',  unitLabel: (u) => `${u.toFixed(1)} 秒` },
};

function TypeBreakdown({ byType }: { byType?: Record<string, { requests: number; units: number; estimatedCost: number }> }) {
  if (!byType) return null;
  const entries = Object.entries(byType).filter(([, v]) => v && v.requests > 0);
  if (entries.length === 0) {
    return (
      <div className="theme-card rounded-xl p-5">
        <div className="text-sm theme-text-muted text-center py-4">暂无多模态调用</div>
      </div>
    );
  }
  return (
    <div className="theme-card rounded-xl p-5">
      <div className="text-sm font-medium theme-text-primary mb-4">按模型类型分布</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {entries.map(([type, v]) => {
          const meta = TYPE_META[type] || { label: type, icon: 'Box', color: 'text-zinc-400', unitLabel: (u: number) => String(u) };
          return (
            <div key={type} className="theme-bg-tertiary rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`text-xs font-medium ${meta.color}`}>{meta.label}</span>
                <span className="text-[10px] theme-text-muted">×{v.requests}</span>
              </div>
              <div className="text-sm theme-text-primary">{meta.unitLabel(v.units || 0)}</div>
              {v.estimatedCost > 0 && (
                <div className="text-[11px] theme-text-muted mt-1">估算费用 {formatCost(v.estimatedCost)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================

function DailyChart({ byDay }: { byDay: DayData[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [viewDays, setViewDays] = useState<14 | 30>(14)
  const [metric, setMetric] = useState<'tokens' | 'cost'>('tokens')

  const displayDays = byDay.slice(-viewDays)
  const maxTokens = Math.max(...displayDays.map(d => d.totalTokens || 0), 1)
  const maxCost = Math.max(...displayDays.map(d => d.costCny || 0), 0.001)

  // A5: 趋势线/累计曲线覆盖层几何(随 metric/窗口/数据变化重算)
  const overlay = useMemo(() => computeOverlay(
    displayDays,
    metric === 'tokens' ? maxTokens : maxCost,
    d => (metric === 'tokens' ? d.totalTokens : d.costCny),
  ), [displayDays, metric, maxTokens, maxCost])

  if (displayDays.length === 0) {
    return (
      <div className="theme-card rounded-xl p-5">
        <div className="text-sm theme-text-muted text-center py-8">暂无每日用量数据</div>
      </div>
    )
  }

  return (
    <div className="theme-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm font-medium theme-text-primary">
          <BarChart3 className="w-4 h-4" />
          每日用量趋势
        </div>
        <div className="flex items-center gap-2">
          <div className="flex theme-bg-tertiary rounded-md overflow-hidden text-[10px]">
            <button
              onClick={() => setMetric('tokens')}
              className={`px-2.5 py-1 transition-colors ${metric === 'tokens' ? 'bg-blue-500/30 text-blue-300' : 'theme-text-muted hover:theme-text-secondary'}`}
            >
              Tokens
            </button>
            <button
              onClick={() => setMetric('cost')}
              className={`px-2.5 py-1 transition-colors ${metric === 'cost' ? 'bg-blue-500/30 text-blue-300' : 'theme-text-muted hover:theme-text-secondary'}`}
            >
              成本
            </button>
          </div>
          <div className="flex theme-bg-tertiary rounded-md overflow-hidden text-[10px]">
            <button
              onClick={() => setViewDays(14)}
              className={`px-2.5 py-1 transition-colors ${viewDays === 14 ? 'bg-blue-500/30 text-blue-300' : 'theme-text-muted hover:theme-text-secondary'}`}
            >
              14天
            </button>
            <button
              onClick={() => setViewDays(30)}
              className={`px-2.5 py-1 transition-colors ${viewDays === 30 ? 'bg-blue-500/30 text-blue-300' : 'theme-text-muted hover:theme-text-secondary'}`}
            >
              30天
            </button>
          </div>
        </div>
      </div>

      {/* 柱状图 */}
      <div className="relative">
        <div className="flex items-end gap-[2px] h-28">
          {displayDays.map((day, idx) => {
            const value = metric === 'tokens' ? day.totalTokens : day.costCny
            const max = metric === 'tokens' ? maxTokens : maxCost
            const pct = (value / max) * 100
            const isHovered = hoveredIdx === idx
            const level = getCostLevel(day.costCny)
            const colors = COST_COLORS[level]

            return (
              <div
                key={day.date}
                className="flex-1 flex flex-col items-center gap-0.5 relative"
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                {/* Tooltip */}
                {isHovered && (
                  <div className="absolute -top-24 left-1/2 -translate-x-1/2 z-10 theme-card rounded-lg px-3 py-2 shadow-xl whitespace-nowrap pointer-events-none border theme-border">
                    <div className="text-[10px] theme-text-muted">{day.date}</div>
                    <div className="text-xs font-medium theme-text-primary">{formatTokens(day.totalTokens)} tokens</div>
                    <div className="text-[10px] theme-text-muted">入 {formatTokens(day.promptTokens)} · 出 {formatTokens(day.completionTokens)}</div>
                    <div className="text-[10px] theme-text-muted">{day.requests} 次 · {formatCost(day.costCny)}</div>
                  </div>
                )}
                <div
                  className={`w-full rounded-t transition-all duration-150 ${isHovered ? 'opacity-100 scale-x-110' : 'opacity-70'} ${colors.bar}`}
                  style={{ height: `${Math.max(3, pct * 0.9)}px` }}
                />
                {(viewDays <= 14 || idx % 2 === 0) && (
                  <span className="text-[9px] theme-text-muted select-none">{day.date.slice(-2)}</span>
                )}
              </div>
            )
          })}
        </div>

        {/* Y轴参考线 */}
        <div className="absolute left-0 top-0 h-28 flex flex-col justify-between pointer-events-none text-[9px] theme-text-muted -ml-1">
          <span>{metric === 'tokens' ? formatTokens(maxTokens) : formatCost(maxCost)}</span>
          <span>{metric === 'tokens' ? formatTokens(maxTokens / 2) : formatCost(maxCost / 2)}</span>
          <span>{metric === 'tokens' ? '0' : '¥0'}</span>
        </div>

        {/* A5: 趋势线(4日均值) + 累计曲线覆盖层。
            preserveAspectRatio=none 下横竖缩放比不同, vector-effect=non-scaling-stroke
            保证线宽/虚线在屏幕像素恒定; x 坐标一律 0-100 数值(勿带 % 后缀) */}
        <svg className="absolute inset-0 pointer-events-none w-full h-28" viewBox="0 0 100 112" preserveAspectRatio="none" aria-hidden="true">
          <polyline points={overlay.maPath} fill="none" stroke="var(--accent-primary)" strokeWidth="0.8" strokeDasharray="2 1.2" opacity="0.75" vectorEffect="non-scaling-stroke" />
          <polyline points={overlay.cumPath} fill="none" stroke="var(--accent-primary)" strokeWidth="0.6" opacity="0.45" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* A5: 图例(累计线用透明度区分, 不引入 --accent-secondary 新变量) */}
        <div className="flex items-center gap-3 text-[9px] theme-text-muted mt-1">
          <span className="flex items-center gap-1"><i style={{ width: 10, height: 2, background: 'var(--accent-primary)', display: 'inline-block' }} />4日均值</span>
          <span className="flex items-center gap-1"><i style={{ width: 10, height: 2, background: 'var(--accent-primary)', opacity: 0.45, display: 'inline-block' }} />累计</span>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// 模型成本对比 (增强版 - 带进度条)
// ============================================================================

function ModelComparison({ byModel }: { byModel: Record<string, ModelData> }) {
  const [sortBy, setSortBy] = useState<'tokens' | 'cost' | 'calls'>('tokens')

  const entries = useMemo(() => {
    return Object.entries(byModel)
      .map(([model, data]) => ({
        model,
        ...data,
        totalTokens: data.promptTokens + data.completionTokens,
      }))
      .sort((a, b) => {
        if (sortBy === 'cost') return b.costCny - a.costCny
        if (sortBy === 'calls') return b.calls - a.calls
        return b.totalTokens - a.totalTokens
      })
  }, [byModel, sortBy])

  const maxTokens = Math.max(...entries.map(e => e.totalTokens), 1)

  if (entries.length === 0) {
    return (
      <div className="theme-card rounded-xl p-5">
        <div className="text-sm theme-text-muted text-center py-8">暂无模型使用数据</div>
      </div>
    )
  }

  return (
    <div className="theme-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm font-medium theme-text-primary">
          <Zap className="w-4 h-4" />
          模型 Token 用量
        </div>
        <div className="flex theme-bg-tertiary rounded-md overflow-hidden text-[10px]">
          {(['tokens', 'cost', 'calls'] as const).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-2.5 py-1 transition-colors ${sortBy === s ? 'bg-blue-500/30 text-blue-300' : 'theme-text-muted hover:theme-text-secondary'}`}
            >
              {s === 'tokens' ? 'Token' : s === 'cost' ? '成本' : '调用'}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {entries.map(entry => {
          const pct = (entry.totalTokens / maxTokens) * 100

          return (
            <div key={entry.model} className="group">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="theme-text-primary truncate mr-2 max-w-[180px]" title={entry.model}>
                  {entry.model}
                </span>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="theme-text-primary font-medium min-w-[60px] text-right">
                    {formatTokens(entry.totalTokens)}
                  </span>
                  <span className="theme-text-muted min-w-[64px] text-right">
                    {formatCost(entry.costCny)}
                  </span>
                </div>
              </div>
              <div className="h-2 theme-bg-tertiary rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 bg-blue-500/70 group-hover:bg-blue-500`}
                  style={{ width: `${Math.max(2, pct)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] theme-text-muted mt-1">
                <span>{entry.calls} 次调用</span>
                <span>入 {formatTokens(entry.promptTokens)} · 出 {formatTokens(entry.completionTokens)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// Provider 分布
// ============================================================================

function ProviderBreakdown({ byProvider }: { byProvider?: Record<string, ProviderData> }) {
  // A5: 环形/堆叠视图切换——useState 必须在提前 return 之前(否则 hook 数跨渲染漂移, React 抛错)
  const [view, setView] = useState<'ring' | 'stack'>('ring')
  if (!byProvider || Object.keys(byProvider).length === 0) return null

  const entries = Object.entries(byProvider).sort((a, b) => b[1].totalTokens - a[1].totalTokens)
  const totalTokens = entries.reduce((s, [, d]) => s + d.totalTokens, 0) || 1
  const totalCost = entries.reduce((s, [, d]) => s + d.estimatedCost, 0)

  return (
    <div className="theme-card rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-sm font-medium theme-text-primary">
          <Activity className="w-4 h-4" />
          供应商 Token 分布
        </div>
        {/* A5: 环形/堆叠视图切换小 tab */}
        <div className="flex theme-bg-tertiary rounded-md overflow-hidden text-[10px]">
          <button
            onClick={() => setView('ring')}
            className={`px-2.5 py-1 transition-colors ${view === 'ring' ? 'bg-blue-500/30 text-blue-300' : 'theme-text-muted hover:theme-text-secondary'}`}
          >
            环形
          </button>
          <button
            onClick={() => setView('stack')}
            className={`px-2.5 py-1 transition-colors ${view === 'stack' ? 'bg-blue-500/30 text-blue-300' : 'theme-text-muted hover:theme-text-secondary'}`}
          >
            堆叠
          </button>
        </div>
      </div>

      {/* A5: 环形占比图(strokeDasharray 分段圆环, 中心显示总额) */}
      {view === 'ring' && (
        <div className="flex items-center gap-5 mb-4">
          <svg viewBox="0 0 42 42" className="w-24 h-24 flex-shrink-0" aria-label="供应商 Token 占比">
            {(() => {
              const C = 2 * Math.PI * 15.915
              let acc = 0
              return entries.map(([provider, data]) => {
                const pct = data.totalTokens / totalTokens
                const start = acc; acc += pct
                return <circle key={provider} cx="21" cy="21" r="15.915" fill="none"
                  stroke={PROVIDER_RING_COLORS[provider] || '#71717a'} strokeWidth="6" strokeDasharray={`${pct * C} ${C}`} strokeDashoffset={-start * C} />
              })
            })()}
          </svg>
          <div className="text-center">
            <div className="text-[11px] theme-text-muted">中心总额</div>
            <div className="text-lg font-bold theme-text-primary">{formatTokens(totalTokens)}</div>
          </div>
        </div>
      )}

      {/* 水平堆叠条视图 */}
      {view === 'stack' && (
        <div className="h-3 rounded-full overflow-hidden flex mb-4">
          {entries.map(([provider, data]) => {
            const pct = (data.totalTokens / totalTokens) * 100
            const providerColors: Record<string, string> = {
              deepseek: 'bg-blue-500',
              zhipu: 'bg-purple-500',
              qwen: 'bg-orange-500',
              openai: 'bg-green-500',
              anthropic: 'bg-amber-500',
              doubao: 'bg-cyan-500',
            }
            const color = providerColors[provider] || 'bg-zinc-500'
            return (
              <div
                key={provider}
                className={`${color} transition-all duration-300`}
                style={{ width: `${pct}%` }}
                title={`${provider}: ${formatTokens(data.totalTokens)} tokens (${pct.toFixed(1)}%)`}
              />
            )
          })}
        </div>
      )}

      <div className="space-y-2">
        {entries.map(([provider, data]) => {
          const pct = ((data.totalTokens / totalTokens) * 100).toFixed(1)
          return (
            <div key={provider} className="flex items-center justify-between text-xs py-0.5">
              <span className="theme-text-secondary">{provider}</span>
              <div className="flex items-center gap-3">
                <span className="theme-text-muted">{data.requests}次</span>
                <span className="theme-text-muted">{pct}%</span>
                <span className="theme-text-primary font-medium min-w-[64px] text-right">
                  {formatTokens(data.totalTokens)}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {totalCost > 0 && (
        <div className="text-[11px] theme-text-muted mt-3 pt-3 border-t theme-border">
          合计成本 {formatCost(totalCost)}
        </div>
      )}
    </div>
  )
}

// ============================================================================
// 近7天每日请求量条形图
// （2026-08-27 审计 C3: 曾名「时段热力图」——实现是每日请求量条形图而非小时热力,
//   名称与实现不符; 真要小时级热力需 usage-stats 按小时落库, 暂不引入。）
// ============================================================================

function WeeklyRequestBar({ byDay }: { byDay: DayData[] }) {
  // 近7天每日请求量条形图
  const recentDays = byDay.slice(-7)
  if (recentDays.length === 0) return null

  const maxRequests = Math.max(...recentDays.map(d => d.requests), 1)

  return (
    <div className="theme-card rounded-xl p-5">
      <div className="flex items-center gap-2 text-sm font-medium theme-text-primary mb-4">
        <Clock className="w-4 h-4" />
        近7天活跃度
      </div>
      <div className="flex items-end gap-1.5 h-16">
        {recentDays.map(day => {
          const intensity = day.requests / maxRequests
          const opacity = Math.max(0.15, intensity)
          return (
            <div key={day.date} className="flex-1 flex flex-col items-center gap-0.5">
              <div
                className="w-full rounded-sm bg-blue-500 transition-all"
                style={{ height: `${Math.max(3, intensity * 60)}px`, opacity }}
                title={`${day.date}: ${day.requests} 次请求`}
              />
              <span className="text-[9px] theme-text-muted">{day.date.slice(-2)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================================
// 缓存节省卡片
// ============================================================================

function CacheSavingsCard({ total }: { total?: CostSummary['total'] }) {
  if (!total) return null
  const savings = total.cacheSavings || 0
  const cachedTokens = total.cachedTokens || 0
  const totalTokens = total.totalTokens || 1
  const cacheHitRate = ((cachedTokens / totalTokens) * 100).toFixed(1)

  return (
    <div className="bg-emerald-900/20 rounded-xl p-4 border border-emerald-700/30">
      <div className="flex items-center gap-2 mb-2">
        <PiggyBank className="w-4 h-4 text-emerald-400" />
        <span className="text-xs text-emerald-300">缓存节省</span>
      </div>
      <div className="text-xl font-bold text-emerald-200">{formatCost(savings)}</div>
      <div className="flex items-center gap-3 mt-1.5">
        <span className="text-[11px] text-emerald-500">命中率 {cacheHitRate}%</span>
        <span className="text-[11px] text-emerald-600">{formatTokens(cachedTokens)} 缓存tokens</span>
      </div>
    </div>
  )
}

// ============================================================================
// 主面板
// ============================================================================

export function CostDashboardPanel() {
  const [summary, setSummary] = useState<CostSummary | null>(null)
  // 2026-08-08(审计 P1): 请求序号——丢弃过期响应(竞态守卫)
  const fetchSeqRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  // 2026-08-26 审计 P1: 加载失败态——接口故障不伪装成"暂无用量"
  const [loadError, setLoadError] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'all'>('all')
  // 2026-08-27 审计 C2: 预算阈值原硬编码 50/1000(假信号——用户从未设置也显示「预算正常/超限」)。
  // 改为用户可设置(localStorage), 未设置时仅显示真实成本, 不报预算状态。
  const [dailyBudget, setDailyBudget] = useState<number | null>(() => {
    const raw = localStorage.getItem('costDashboard.dailyBudget')
    const n = Number(raw)
    return raw !== null && Number.isFinite(n) && n > 0 ? n : null
  })
  const [monthlyBudget, setMonthlyBudget] = useState<number | null>(() => {
    const raw = localStorage.getItem('costDashboard.monthlyBudget')
    const n = Number(raw)
    return raw !== null && Number.isFinite(n) && n > 0 ? n : null
  })
  const [budgetEditing, setBudgetEditing] = useState(false)
  const [draftDaily, setDraftDaily] = useState('')
  const [draftMonthly, setDraftMonthly] = useState('')

  const fetchCost = useCallback(async () => {
    // 2026-08-08(审计 P1): 请求序号竞态守卫——切换 period 时旧请求仍在 in-flight,
    // 旧响应会覆盖新 summary;30s 轮询与手动刷新同样可乱序。仅最新请求落盘。
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const result = await apiGet(`/api/usage?period=${period}`)
      if (fetchSeqRef.current !== seq) return // 过期响应丢弃
      if (result.success && result.data) {
        // 安全处理 byDay
        const data: any = result.data
        if (data.byDay && !Array.isArray(data.byDay)) {
          data.byDay = Object.entries(data.byDay)
            .map(([date, d]: [string, any]) => ({
              date,
              costCny: d.estimatedCost || d.costCny || 0,
              costUsd: d.costUsd || (d.estimatedCost || 0) / 7.2,
              requests: d.requests || 0,
              promptTokens: d.promptTokens || 0,
              completionTokens: d.completionTokens || 0,
              totalTokens: d.totalTokens || 0,
              cacheSavings: d.cacheSavings || 0,
            }))
            .sort((a: DayData, b: DayData) => a.date.localeCompare(b.date))
        }
        if (!data.byDay) data.byDay = []

        // 派生 token 汇总
        const byDay: DayData[] = data.byDay
        const today = new Date().toISOString().split('T')[0]
        const monthPrefix = today.slice(0, 7)
        let todayTokens = 0
        let monthTokens = 0
        for (const d of byDay) {
          const tokens = d.totalTokens || (d.promptTokens + d.completionTokens) || 0
          if (d.date === today) todayTokens = tokens
          if (d.date.startsWith(monthPrefix)) monthTokens += tokens
        }
        data.totalTokens = data.total?.totalTokens || 0
        data.todayTokens = todayTokens
        data.monthTokens = monthTokens

        setSummary(data as CostSummary)
        setLoadError('')
        setLastRefresh(new Date()) // 2026-08-26 C4: 仅成功刷新时间戳——此前失败也更新("最后刷新: 刚刚"谎报新鲜度)
      }
    } catch (e) {
      if (fetchSeqRef.current !== seq) return // 过期请求的错误不提示
      console.error('获取用量数据失败:', e)
      // 2026-08-26 审计 P1: 失败必须区分空态——此前 catch 只 console.error + 走
      // !summary 分支 → "暂无用量数据"把接口故障伪装成没用量, 用户无法诊断。
      setLoadError('用量数据加载失败')
    } finally {
      if (fetchSeqRef.current === seq) {
        setLoading(false)
      }
    }
  }, [period])

  useEffect(() => {
    fetchCost()
    const interval = setInterval(() => {
      // Avoid polling when page is hidden
      if (document.hidden) return
      fetchCost()
    }, 30000)
    // Also listen for visibility change to refresh on tab focus
    const onVisible = () => { if (!document.hidden) fetchCost() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [fetchCost])

  // Token day-over-day (stable computation via JSON key)
  const dayOverDayTokens = useMemo(() => {
    if (!summary?.byDay || summary.byDay.length < 2) return null
    const days = summary.byDay
    const today = days[days.length - 1]?.totalTokens || 0
    const yesterday = days[days.length - 2]?.totalTokens || 0
    if (yesterday === 0) return null
    return ((today - yesterday) / yesterday * 100).toFixed(1)
  }, [summary?.byDay])

  // 2026-08-19 修复: periodMetrics useMemo 此前位于下方 loading/summary 提前 return 之后,
  // 条件调用 → 数据加载完成重渲染时 hook 数增加 → React 抛「Rendered more hooks than
  // during the previous render」(管理舱 用量 tab / 插件 cost-dashboard 必现)。
  // 上移至所有提前 return 之前,保持 hook 顺序跨渲染一致。
  const periodMetrics = useMemo(
    () => aggregatePeriodMetrics(summary?.byDay, period),
    [summary?.byDay, period],
  )

  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-500">
        <RefreshCw className="w-4 h-4 animate-spin mr-2" />
        加载用量数据...
      </div>
    )
  }

  // 2026-08-26 审计 P1/C4: 加载失败——黑箱错误≠暂无用量(接口故障伪装空态会误导诊断)。
  // 无数据时整页错误态; 已有数据(30s 轮询瞬断)时降级为顶部横幅保留仪表盘。
  if (loadError && !summary) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-zinc-500 gap-2">
        <AlertTriangle className="w-8 h-8 text-red-600/60" />
        <span className="text-red-400">{loadError}</span>
        <span className="text-[10px] text-zinc-600">请检查后端服务后重试</span>
        <button
          onClick={fetchCost}
          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" />
          重新加载
        </button>
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-zinc-500 gap-2">
        <BarChart3 className="w-8 h-8 text-zinc-700" />
        <span>暂无用量数据</span>
        <span className="text-[10px] text-zinc-600">开始对话后将自动统计 token 用量</span>
        <button
          onClick={fetchCost}
          className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" />
          重新加载
        </button>
      </div>
    )
  }

  // 2026-08-26 C1(P6 漏网): "共 N 次请求"按 period 从 periodMetrics 取——
  // 旧实现恒读 summary.total(全时段), 切今日/本周时与图表口径矛盾(实测 1730 vs 41)
  const totalRequests = period === 'all'
    ? (summary.total?.requests || summary.totalRequests || 0)
    : periodMetrics.requests
  // P6(GUI 全量修复 P1): 总 Token/总成本卡按 period 从 byDay 重新聚合——
  // 旧实现读后端 total(全时段), 切"今日/本周"时卡片与图表口径矛盾
  // (periodMetrics useMemo 已上移至提前 return 之前——见上方修复注释)
  const totalTokens = period === 'all' ? (summary.totalTokens || (summary.totalInputTokens + summary.totalOutputTokens)) : periodMetrics.tokens

  // Budget status（2026-08-27 C2: 未设置预算时为 null——不生成任何伪信号）
  const todayCost = summary?.todayCostCny || 0
  const monthCost = summary?.monthCostCny || 0
  const dailyPct = dailyBudget !== null && dailyBudget > 0 ? (todayCost / dailyBudget) * 100 : null
  const monthlyPct = monthlyBudget !== null && monthlyBudget > 0 ? (monthCost / monthlyBudget) * 100 : null
  const budgetWarning = (dailyPct !== null && dailyPct >= 80) || (monthlyPct !== null && monthlyPct >= 80)
  const budgetCritical = (dailyPct !== null && dailyPct >= 100) || (monthlyPct !== null && monthlyPct >= 100)
  const budgetConfigured = dailyBudget !== null || monthlyBudget !== null

  return (
    <div className="space-y-5">
      {/* 2026-08-26 C4: 轮询失败但有历史数据——顶部横幅保留仪表盘(而非整页替换) */}
      {loadError && summary && (
        <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <span className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />上次刷新失败，数据可能过时</span>
          <button onClick={fetchCost} className="text-red-300 hover:text-red-200 underline">重新加载</button>
        </div>
      )}
      {/* Period Selector & Budget Bar */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1 rounded-lg theme-bg-tertiary p-1" role="radiogroup" aria-label="统计周期">
          {(['today', 'week', 'month', 'all'] as const).map(p => (
            <button
              key={p}
              role="radio"
              aria-checked={period === p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-2 rounded-md text-xs font-medium transition-colors ${
                period === p ? 'theme-accent-bg text-white' : 'theme-text-muted hover:theme-text-primary'
              }`}
            >{{ today: '今日', week: '本周', month: '本月', all: '全部' }[p]}</button>
          ))}
        </div>

        {/* Budget Status（2026-08-27 C2: 未设置预算不报假状态, 可点击设置） */}
        <div className="flex items-center gap-2 ml-auto text-xs">
          {budgetEditing ? (
            <div className="flex items-center gap-1.5" role="group" aria-label="预算设置">
              <label className="theme-text-muted">日 ¥</label>
              <input
                type="number" min="0" step="1" value={draftDaily} placeholder="50"
                onChange={e => setDraftDaily(e.target.value)}
                className="w-16 px-1.5 py-0.5 rounded theme-bg-tertiary text-xs outline-none theme-text-primary"
                aria-label="每日预算（元）"
              />
              <label className="theme-text-muted">月 ¥</label>
              <input
                type="number" min="0" step="1" value={draftMonthly} placeholder="1000"
                onChange={e => setDraftMonthly(e.target.value)}
                className="w-16 px-1.5 py-0.5 rounded theme-bg-tertiary text-xs outline-none theme-text-primary"
                aria-label="每月预算（元）"
              />
              <button
                onClick={() => {
                  const d = Number(draftDaily), m = Number(draftMonthly)
                  const nd = Number.isFinite(d) && d > 0 ? d : null
                  const nm = Number.isFinite(m) && m > 0 ? m : null
                  setDailyBudget(nd)
                  setMonthlyBudget(nm)
                  localStorage.setItem('costDashboard.dailyBudget', nd !== null ? String(nd) : '')
                  localStorage.setItem('costDashboard.monthlyBudget', nm !== null ? String(nm) : '')
                  setBudgetEditing(false)
                }}
                className="px-2 py-0.5 rounded text-xs theme-accent-bg text-white hover:opacity-90"
              >保存</button>
              <button onClick={() => { setBudgetEditing(false) }} className="px-1.5 py-0.5 text-xs theme-text-muted hover:text-theme-text-primary">取消</button>
            </div>
          ) : (
            <>
              {budgetCritical ? (
                <StatusBadge tone="danger" label="预算超限" />
              ) : budgetWarning ? (
                <StatusBadge tone="warn" label="预算预警" />
              ) : budgetConfigured ? (
                <StatusBadge tone="success" label="预算正常" />
              ) : null}
              <span className="theme-text-muted">
                日 ¥{todayCost.toFixed(2)}{dailyBudget !== null ? ` / ¥${dailyBudget}` : ''} · 月 ¥{monthCost.toFixed(2)}{monthlyBudget !== null ? ` / ¥${monthlyBudget}` : ''}
              </span>
              <button
                onClick={() => { setDraftDaily(dailyBudget !== null ? String(dailyBudget) : ''); setDraftMonthly(monthlyBudget !== null ? String(monthlyBudget) : ''); setBudgetEditing(true) }}
                className="px-1.5 py-0.5 rounded text-xs theme-text-muted hover:theme-text-primary underline decoration-dotted"
                aria-label="设置预算"
              >{budgetConfigured ? '修改' : '设置预算'}</button>
            </>
          )}
        </div>
      </div>

      {/* Budget Progress Bars（仅显示已配置的项） */}
      {(dailyPct !== null || monthlyPct !== null) && (
        <div className="space-y-2 text-[11px]">
          {dailyPct !== null && (
            <div className="flex items-center gap-2">
              <span className="w-12 theme-text-muted flex-shrink-0">日预算</span>
              <div className="flex-1 h-2 rounded-full theme-bg-tertiary overflow-hidden">
                <div className={`h-full rounded-full transition-all ${dailyPct >= 100 ? 'bg-red-500' : dailyPct >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min(dailyPct, 100)}%` }} />
              </div>
              <span className={`w-10 text-right flex-shrink-0 ${dailyPct >= 80 ? 'text-yellow-400' : 'theme-text-muted'}`}>{dailyPct.toFixed(0)}%</span>
            </div>
          )}
          {monthlyPct !== null && (
            <div className="flex items-center gap-2">
              <span className="w-12 theme-text-muted flex-shrink-0">月预算</span>
              <div className="flex-1 h-2 rounded-full theme-bg-tertiary overflow-hidden">
                <div className={`h-full rounded-full transition-all ${monthlyPct >= 100 ? 'bg-red-500' : monthlyPct >= 80 ? 'bg-yellow-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min(monthlyPct, 100)}%` }} />
              </div>
              <span className={`w-10 text-right flex-shrink-0 ${monthlyPct >= 80 ? 'text-yellow-400' : 'theme-text-muted'}`}>{monthlyPct.toFixed(0)}%</span>
            </div>
          )}
        </div>
      )}

      {/* 概览卡片 - Token 优先 */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <StatCard
          label="今日 Token"
          value={formatTokens(summary.todayTokens)}
          icon={Flame}
          iconColor="text-orange-400"
          sub={dayOverDayTokens ? `${Number(dayOverDayTokens) >= 0 ? '+' : ''}${dayOverDayTokens}% 较昨日` : `${totalRequests} 次调用`}
        />
        <StatCard
          label="本月 Token"
          value={formatTokens(summary.monthTokens)}
          icon={Zap}
          iconColor="text-blue-400"
          sub={`入 ${formatTokens(summary.totalInputTokens)} · 出 ${formatTokens(summary.totalOutputTokens)}`}
        />
        <StatCard
          label="总 Token"
          value={formatTokens(totalTokens)}
          icon={BarChart3}
          iconColor="text-cyan-400"
          sub={`共 ${totalRequests} 次请求`}
        />
        <StatCard
          label="总成本"
          value={formatCost(period === 'all' ? summary.totalCostCny : periodMetrics.cost)}
          icon={Coins}
          iconColor="text-emerald-400"
          sub={`≈ $${(summary.totalCostUsd || 0).toFixed(4)}`}
        />
        <StatCard
          label="本月成本"
          value={formatCost(summary.monthCostCny)}
          icon={TrendingUp}
          iconColor="text-purple-400"
          sub={`日均 ${formatCost((summary.monthCostCny || 0) / Math.max(1, new Date().getDate()))}`}
        />
        <CacheSavingsCard total={period === 'all'
          ? summary.total
          : ({ // 2026-08-26 C1: period 口径下缓存节省按日聚合——旧实现恒读 total 全时段
              requests: periodMetrics.requests,
              promptTokens: 0,
              completionTokens: 0,
              cachedTokens: 0,   // 周期口径无 cachedTokens 源, 命中率缺省
              totalTokens: summary.total?.totalTokens || 0,
              estimatedCost: periodMetrics.cost,
              cacheSavings: periodMetrics.cacheSavings,
            })} />
      </div>

      {/* 按模型类型分布（多模态用量） */}
      <TypeBreakdown byType={summary.byType} />

      {/* 每日用量柱状图 */}
      <DailyChart byDay={summary.byDay} />

      {/* 模型 Token 用量 + 供应商分布 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <ModelComparison byModel={summary.byModel || {}} />
        <ProviderBreakdown byProvider={summary.byProvider} />
      </div>

      {/* 时段热力图 */}
      <WeeklyRequestBar byDay={summary.byDay} />

      {/* 详细数据表格 (可折叠) */}
      <div className="theme-card rounded-xl">
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="w-full flex items-center justify-between p-4 text-sm theme-text-secondary hover:theme-text-primary transition-colors"
        >
          <span className="flex items-center gap-2">
            <Activity className="w-4 h-4" />
            每日明细
          </span>
          {showDetails ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {showDetails && summary.byDay.length > 0 && (
          <div className="px-4 pb-4 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="theme-text-muted border-b theme-border">
                  <th className="text-left py-2 pr-3">日期</th>
                  <th className="text-right py-2 px-2">总 Token</th>
                  <th className="text-right py-2 px-2">输入</th>
                  <th className="text-right py-2 px-2">输出</th>
                  <th className="text-right py-2 px-2">请求</th>
                  <th className="text-right py-2 pl-2">成本</th>
                </tr>
              </thead>
              <tbody>
                {[...summary.byDay].reverse().slice(0, 30).map(day => {
                  const total = day.totalTokens || (day.promptTokens + day.completionTokens)
                  return (
                    <tr key={day.date} className="border-b theme-border hover:theme-bg-hover">
                      <td className="py-2 pr-3 theme-text-primary">{day.date}</td>
                      <td className="py-2 px-2 theme-text-primary text-right font-medium">{formatTokens(total)}</td>
                      <td className="py-2 px-2 theme-text-secondary text-right">{formatTokens(day.promptTokens)}</td>
                      <td className="py-2 px-2 theme-text-secondary text-right">{formatTokens(day.completionTokens)}</td>
                      <td className="py-2 px-2 theme-text-muted text-right">{day.requests}</td>
                      <td className="py-2 pl-2 theme-text-muted text-right">{formatCost(day.costCny)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between pt-1">
        <span className="text-[11px] theme-text-muted">
          最后刷新: {lastRefresh.toLocaleTimeString('zh-CN')}
        </span>
        <button
          onClick={fetchCost}
          disabled={loading}
          className="text-xs theme-text-muted hover:theme-text-primary flex items-center gap-1 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
    </div>
  )
}
