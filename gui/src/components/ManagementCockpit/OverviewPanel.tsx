/**
 * OverviewPanel — 管理舱总览主屏（2026-08-27 管理舱全轮 A3）。
 * 消费 GET /api/cockpit/overview（Task A1）：六张健康卡（插件/技能/专家/今日用量/MCP/后端）
 * + 告警聚合条 + 数据源降级详情 + 快捷动作。
 * onNavigate 由 ManagementCockpit 传入（切 tab）；预算阈值读 localStorage.costDashboard.*。
 * 单源失败对应 data 段为 null → 卡片显示「—」+「降级」副题。
 */
import { useEffect, useState } from 'react'
import { Puzzle, Sparkles, BrainCircuit, Gauge, Cpu, Plug, ArrowRight, RefreshCw, AlertTriangle } from 'lucide-react'
import { apiGet } from '../../lib/api'
import { StatusBadge, Skeleton, EmptyState } from '../CockpitUI'
import type { CockpitTab } from '.'

interface OverviewSource { ok: boolean; detail?: string }
interface OverviewData {
  plugins?: { loaded: number; known: number; disabled: string[]; panels: number; dataSources: number } | null
  usage?: { todayCostCny: number; monthCostCny: number; totalRequests: number; totalCostCny: number } | null
  skills?: { total: number; active: number; disabled: number; totalMerged: number } | null
  experts?: { total: number; activeName: string | null } | null
  mcp?: { total: number; connected: number; error: number } | null
  backend?: { pid: number; nodeVersion: string; uptime: number; memHeapMb: number } | null
  sources?: Record<string, OverviewSource>
}

function Card({ label, value, sub, tone, icon: Icon, onClick }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode
  tone: 'success' | 'warn' | 'danger' | 'neutral'
  icon: React.ElementType; onClick: () => void
}) {
  return (
    <button onClick={onClick}
      className="theme-card rounded-xl p-4 text-left hover:border-zinc-500/30 transition-all">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs theme-text-muted flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5" />{label}
        </span>
        <StatusBadge tone={tone} label={tone === 'success' ? '正常' : tone === 'danger' ? '异常' : tone === 'warn' ? '注意' : '停用'} />
      </div>
      <div className="text-lg font-bold theme-text-primary">{value}</div>
      {sub && <div className="text-[11px] theme-text-muted mt-1">{sub}</div>}
    </button>
  )
}

export default function OverviewPanel({ onNavigate }: { onNavigate: (tab: CockpitTab, section?: string | null) => void }) {
  const [data, setData] = useState<OverviewData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const res = await apiGet<OverviewData>('/api/cockpit/overview')
      if (res?.success && res.data) { setData(res.data); setError('') }
      else { setError(res?.error || '总览加载失败'); setData(null) }
    } catch (e: any) {
      setError('总览加载失败: ' + (e?.message || '网络错误')); setData(null)
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const dailyBudget = Number(localStorage.getItem('costDashboard.dailyBudget') || 0)
  const monthlyBudget = Number(localStorage.getItem('costDashboard.monthlyBudget') || 0)

  if (loading) return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
    </div>
  )
  if (!data) return (
    <div className="h-full flex items-center justify-center">
      <EmptyState icon={AlertTriangle} title="总览加载失败" sub={error}
        action={<button onClick={load} className="flex items-center gap-1 text-xs theme-accent hover:underline"><RefreshCw className="w-3 h-3" />重试</button>} />
    </div>
  )

  const alerts: { text: string; tab: CockpitTab; tone: 'danger' | 'warn' }[] = []
  const p = data.plugins, u = data.usage, s = data.skills, m = data.mcp
  if (p && p.known > p.loaded) alerts.push({ text: `${p.known - p.loaded} 个插件未加载`, tab: 'plugin', tone: 'warn' })
  if (u && ((dailyBudget > 0 && u.todayCostCny >= dailyBudget) || (monthlyBudget > 0 && u.monthCostCny >= monthlyBudget)))
    alerts.push({ text: '预算已超限', tab: 'cost', tone: 'danger' })
  if (m && m.error > 0) alerts.push({ text: `${m.error} 个 MCP 服务报错`, tab: 'mcp', tone: 'danger' })
  const sources = data.sources || {}

  return (
    <div className="space-y-5">
      {/* 告警聚合条 */}
      <div className="flex flex-wrap gap-2">
        {alerts.length === 0 && <span className="text-xs theme-text-muted px-3 py-1.5 rounded-lg theme-bg-tertiary">无告警，系统运行正常</span>}
        {alerts.map(a => (
          <button key={a.text} onClick={() => onNavigate(a.tab)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border ${a.tone === 'danger' ? 'bg-red-500/10 text-red-400 border-red-500/20 hover:bg-red-500/15' : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20 hover:bg-yellow-500/15'}`}>
            <AlertTriangle className="w-3 h-3" />{a.text}<ArrowRight className="w-3 h-3" />
          </button>
        ))}
      </div>

      {/* 健康矩阵 */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {/* 2026-08-27 面板禁用开关: overview 的 panels 数=启用数(registry 读面过滤后), 副题如实标注「（启用）」 */}
        <Card label="插件" icon={Puzzle} tone={!p ? 'warn' : (p.known > p.loaded ? 'warn' : 'success')}
          value={p ? `${p.loaded} / ${p.known}` : '—'}
          sub={p ? `禁用 ${p.disabled.length} · 卡片 ${p.panels}（启用） · 数据源 ${p.dataSources}` : '降级'}
          onClick={() => onNavigate('plugin')} />
        <Card label="技能" icon={Sparkles} tone={!s ? 'warn' : (s.active === 0 && s.total > 0 ? 'warn' : 'success')}
          value={s ? `${s.active} 活跃 / ${s.total}` : '—'} sub={s ? `禁用 ${s.disabled}` : '降级'}
          onClick={() => onNavigate('skills')} />
        <Card label="专家" icon={BrainCircuit} tone={data.experts ? 'success' : 'warn'}
          value={data.experts ? `${data.experts.total} 位` : '—'}
          sub={data.experts?.activeName ? `● ${data.experts.activeName} 正在作答` : '当前无激活专家'}
          onClick={() => onNavigate('expert')} />
        <Card label="今日用量" icon={Gauge} tone={!u ? 'warn' : (dailyBudget > 0 && u.todayCostCny >= dailyBudget ? 'danger' : 'success')}
          value={u ? `¥${u.todayCostCny.toFixed(2)}` : '—'}
          sub={u ? `本月 ¥${u.monthCostCny.toFixed(2)} · ${u.totalRequests} 次` : '降级'}
          onClick={() => onNavigate('cost')} />
        <Card label="MCP" icon={Plug} tone={!m ? 'warn' : (m.error > 0 ? 'danger' : 'success')}
          value={m ? `${m.connected}/${m.total} 已连接` : '—'} sub={m ? `${m.error} 个错误` : '降级'}
          onClick={() => onNavigate('mcp')} />
        <Card label="后端" icon={Cpu} tone={data.backend ? 'success' : 'warn'}
          value={data.backend ? `运行 ${data.backend.uptime}s` : '—'}
          sub={data.backend ? `Node ${data.backend.nodeVersion} · 内存 ${data.backend.memHeapMb}MB` : '降级'}
          onClick={() => onNavigate('settings')} />
      </div>

      {/* 源降级详情 */}
      {Object.entries(sources).filter(([, s]) => !s.ok).length > 0 && (
        <div className="text-[11px] theme-text-muted">
          部分数据源不可用：{Object.entries(sources).filter(([, s]) => !s.ok).map(([name, s]) => `${name}(${s.detail?.slice(0, 40) || '未知'})`).join('，')}
        </div>
      )}

      {/* 快捷动作 */}
      <h3 className="text-sm font-medium theme-text-primary mb-2">快捷操作</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          // 2026-08-28 CK3: 带 section 直达设置分区(旧实现只落 settings 默认页);
          // 「插件市场」更名「插件管理」——本地插件管理器, 与发布口径(无市场)一致。
          { label: '模型配置', tab: 'settings' as CockpitTab, section: 'model' },
          { label: '安全配置', tab: 'settings' as CockpitTab, section: 'security' },
          { label: '插件管理', tab: 'plugin' as CockpitTab, section: null },
          { label: '技能仓库', tab: 'skills' as CockpitTab, section: null },
        ].map(a => (
          <button key={a.label} className="theme-btn theme-btn-secondary text-xs px-3 py-2 rounded-lg hover:opacity-90"
            onClick={() => onNavigate(a.tab, a.section)}>{a.label}</button>
        ))}
      </div>
    </div>
  )
}
