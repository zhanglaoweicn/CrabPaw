import { useState, useEffect, useRef, useCallback } from "react"
import {
  History, Zap, GitBranch, RotateCcw, ChevronDown,
  ChevronRight, RefreshCw, Play, Filter, Search, X, Clock,
  CheckCircle, AlertTriangle, FileText, ArrowRight,
} from "lucide-react"
import { toast } from "sonner"
import { apiGet, apiPost } from "../../lib/api"

interface EvolutionRecord {
  id: string
  skillName: string
  type: "fix" | "derived" | "captured"
  timestamp: number
  summary: string
  success: boolean
  rollbackReason?: string
  changelog?: string[]
  generation?: number
  improvement?: number
  parentSkill?: string
}

interface EvolutionStatus {
  available: boolean
  isRunning: boolean
  evolverStats: { totalEvolutions: number; successfulEvolutions: number; failedEvolutions: number }
  engineStats: { totalImprovements: number; contentUpdates: number; skillCount: number }
}

interface EvolutionHistory {
  evolverHistory: EvolutionRecord[]
  engineHistory: Array<{
    skill: string
    timestamp: number
    totalImprovement: number
    contentEvolution: boolean
    changes?: string[]
  }>
}

interface EvolutionGraphStats {
  nodeCount: number
  maxGeneration: number
  relationCounts: Record<string, number>
}

const TYPE_CONFIG: Record<string, { label: string; color: string; bgColor: string; icon: any; letter: string }> = {
  fix: { label: "修复", color: "text-green-500", bgColor: "bg-green-500/20", icon: CheckCircle, letter: "F" },
  derived: { label: "衍生", color: "text-blue-500", bgColor: "bg-blue-500/20", icon: GitBranch, letter: "D" },
  captured: { label: "捕获", color: "text-orange-500", bgColor: "bg-orange-500/20", icon: Zap, letter: "C" },
}

export function EvolutionLog() {
  const [evolutionHistory, setEvolutionHistory] = useState<EvolutionHistory | null>(null)
  const [evolutionStatus, setEvolutionStatus] = useState<EvolutionStatus | null>(null)
  const [evolutionGraph, setEvolutionGraph] = useState<EvolutionGraphStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [evolving, setEvolving] = useState(false)
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set())
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [showRollbackConfirm, setShowRollbackConfirm] = useState<{ id: string; skillName: string } | null>(null)
  // 2026-08-08(审计 P1): 显式加载错误态——自动加载失败此前静默且 UI 落入
  // "暂无进化记录"空态(误导为无数据而非故障)
  const [loadError, setLoadError] = useState<string | null>(null)

  const mountedRef = useRef(true)

  const loadEvolutionData = useCallback(async (isManual = false) => {
    if (isManual) setLoading(true)
    try {
      const [historyResult, statusResult, graphResult] = await Promise.all([
        apiGet("/skills/evolution/history"),
        apiGet("/skills/evolution/status"),
        apiGet("/skills/evolution/graph"),
      ])
      if (!mountedRef.current) return
      if (historyResult.success && historyResult.data) {
        const history = (historyResult.data as any).history || historyResult.data
        setEvolutionHistory(history)
      }
      if (statusResult.success && statusResult.data) {
        const status = (statusResult.data as any).status || statusResult.data
        setEvolutionStatus(status)
      }
      if (graphResult.success && graphResult.data) {
        const graphData = graphResult.data as any
        const graph = graphData.graph || graphData
        setEvolutionGraph(graph.stats || null)
      }
    } catch (e: any) {
      const msg = e?.message || "未知错误"
      if (isManual) toast.error("加载进化数据失败: " + msg)
      else setLoadError(msg) // 自动加载失败 → 显式错误态(与空态区分)
    } finally {
      if (mountedRef.current) { setLoading(false); setLoadError(null) }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    loadEvolutionData()
    return () => { mountedRef.current = false }
  }, [loadEvolutionData])

  const handleTriggerEvolution = async () => {
    setEvolving(true)
    try {
      const result = await apiPost("/skills/evolution/trigger", {})
      if (result.success) { toast.success("进化已触发"); loadEvolutionData(true) }
      else { toast.error(result.error || "触发失败") }
    } catch (e: any) { toast.error("触发失败: " + (e.message || "未知错误")) }
    finally { setEvolving(false) }
  }

  const handleRollback = async (recordId: string, skillName: string) => {
    try {
      const result = await apiPost("/skills/evolution/rollback/" + recordId, { skillName })
      if (result.success) { toast.success("已回滚"); loadEvolutionData(true); setShowRollbackConfirm(null) }
      else { toast.error(result.error || "回滚失败") }
    } catch (e: any) { toast.error("回滚失败: " + (e.message || "未知错误")) }
  }

  const toggleExpand = (id: string) => {
    setExpandedEvents(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const allEvolverEvents = evolutionHistory?.evolverHistory || []
  const allEngineEvents = (evolutionHistory?.engineHistory || []).map(e => ({
    ...e,
    id: "engine-" + e.skill + "-" + e.timestamp,
    skillName: e.skill,
    type: "derived" as const,
    timestamp: e.timestamp,
    summary: `指标改进 +${((e.totalImprovement || 0) * 100).toFixed(1)}%` + (e.contentEvolution ? "，内容已更新" : ""),
    success: true,
    improvement: e.totalImprovement,
    // 后端字段为 changes（引擎事件），从 changes 读取
    changelog: e.changes || [],
  }))

  // 统一 evolver 记录兜底字段：summary / changelog / generation
  const normalizedEvolverEvents = allEvolverEvents.map((e: any) => ({
    ...e,
    source: "evolver",
    summary: e.summary || "进化记录（详情见后端记录）",
    changelog: e.changes || e.changelog || [],
    generation: e.generation ?? null,
  }))

  const allEvents = [...normalizedEvolverEvents, ...allEngineEvents.map((e: any) => ({ ...e, source: "engine" }))]
    .sort((a: any, b: any) => {
      // P2 fix: ISO 字符串相减为 NaN，改用 Date.parse 并兜底 0
      const ta = Date.parse(a.timestamp) || 0
      const tb = Date.parse(b.timestamp) || 0
      return tb - ta
    })
    .filter((e: any) => {
      if (typeFilter !== "all" && e.type !== typeFilter) return false
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        // P1 fix: summary 可能为 undefined，兜底空字符串
        return (e.skillName || "").toLowerCase().includes(q) || (e.summary || "").toLowerCase().includes(q)
      }
      return true
    })

  // P4 fix: 找到最近一条未回滚的 engine 事件（只有这条可回滚）
  const latestRollbackableEngineEvent = allEvents.find(
    (e: any) => e.source === "engine" && !e.rollbackReason
  )

  // P2 fix: 统计栏字段兜底——后端 status 可能无 evolverStats/engineStats 字段
  // 优先从已加载的 history 中本地计算总数/成功/失败
  const bkEvolverStats = evolutionStatus?.evolverStats
  const bkEngineStats = evolutionStatus?.engineStats
  const hasEvolverStats = bkEvolverStats && (bkEvolverStats.totalEvolutions != null || bkEvolverStats.successfulEvolutions != null || bkEvolverStats.failedEvolutions != null)
  const hasEngineStats = bkEngineStats && (bkEngineStats.totalImprovements != null || bkEngineStats.skillCount != null)
  // 从 history 本地计算
  const localEvolverTotal = allEvolverEvents.length
  const localEvolverSuccess = allEvolverEvents.filter((e: any) => e.success !== false).length
  const localEvolverFail = allEvolverEvents.filter((e: any) => e.success === false).length
  const localEngineTotal = allEngineEvents.length
  const statTotal = hasEvolverStats ? (bkEvolverStats!.totalEvolutions ?? localEvolverTotal) : localEvolverTotal
  const statSuccess = hasEvolverStats ? (bkEvolverStats!.successfulEvolutions ?? localEvolverSuccess) : localEvolverSuccess
  const statFail = hasEvolverStats ? (bkEvolverStats!.failedEvolutions ?? localEvolverFail) : localEvolverFail
  const statImprovements = hasEngineStats ? (bkEngineStats!.totalImprovements ?? localEngineTotal) : localEngineTotal
  const statSkillCount = hasEngineStats ? (bkEngineStats!.skillCount ?? "—") : "—"

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-4" style={{ borderBottom: "1px solid var(--border-primary)" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: "var(--accent-muted)" }}>
            <History className="w-4 h-4 theme-accent" />
          </div>
          <div>
            <h2 className="text-lg font-bold theme-text-primary">进化日志</h2>
            <p className="text-xs theme-text-muted">
              {evolutionStatus?.available ? "进化系统已就绪" : "待初始化"}
              {evolutionStatus?.isRunning && " · 运行中"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => loadEvolutionData(true)} disabled={loading}
            className="p-2 rounded-lg theme-bg-tertiary theme-text-secondary hover:theme-bg-hover transition-colors" title="刷新">
            <RefreshCw className={"w-4 h-4" + (loading ? " animate-spin" : "")} />
          </button>
          <button onClick={handleTriggerEvolution} disabled={evolving || !evolutionStatus?.available}
            className="flex items-center gap-2 px-4 py-2 theme-accent-bg text-white rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 text-sm">
            {evolving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {evolving ? "进化中..." : "触发进化"}
          </button>
        </div>
      </div>

      {/* Stats Bar */}
      {evolutionStatus && (
        <div className="p-4" style={{ borderBottom: "1px solid var(--border-primary)" }}>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div className="rounded-lg p-3 theme-bg-tertiary text-center">
              <p className="text-lg font-bold theme-text-primary">{statTotal}</p>
              <p className="text-xs theme-text-muted">进化次数</p>
            </div>
            <div className="rounded-lg p-3 theme-bg-tertiary text-center">
              <p className="text-lg font-bold text-green-500">{statSuccess}</p>
              <p className="text-xs theme-text-muted">成功</p>
            </div>
            <div className="rounded-lg p-3 theme-bg-tertiary text-center">
              <p className="text-lg font-bold text-red-500">{statFail}</p>
              <p className="text-xs theme-text-muted">失败</p>
            </div>
            <div className="rounded-lg p-3 theme-bg-tertiary text-center">
              <p className="text-lg font-bold theme-text-primary">{statImprovements}</p>
              <p className="text-xs theme-text-muted">指标改进</p>
            </div>
            <div className="rounded-lg p-3 theme-bg-tertiary text-center">
              <p className="text-lg font-bold theme-text-primary">{statSkillCount}</p>
              <p className="text-xs theme-text-muted">涉及技能</p>
            </div>
          </div>
          {/* P2: 当后端补齐 evolverStats/engineStats 字段后，优先使用后端数据 */}
          {(!hasEvolverStats || !hasEngineStats) && (
            <p className="text-xs theme-text-muted mt-2">
              {!hasEvolverStats ? "进化统计来自本地计算，待后端补齐 evolverStats 字段 " : ""}
              {!hasEngineStats ? "指标统计来自本地计算，待后端补齐 engineStats 字段" : ""}
            </p>
          )}
        </div>
      )}

      {/* Evolution Graph Summary */}
      {evolutionGraph && (evolutionGraph.nodeCount > 0 || evolutionGraph.maxGeneration > 0) && (
        <div className="p-4" style={{ borderBottom: "1px solid var(--border-primary)" }}>
          <div className="theme-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <GitBranch className="w-4 h-4 theme-accent" />
              <h3 className="text-sm font-medium theme-text-primary">进化图谱</h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg p-3 theme-bg-tertiary">
                <p className="text-xs theme-text-muted">节点数</p>
                <p className="text-lg font-bold theme-text-primary">{evolutionGraph.nodeCount}</p>
              </div>
              <div className="rounded-lg p-3 theme-bg-tertiary">
                <p className="text-xs theme-text-muted">最高世代</p>
                <p className="text-lg font-bold theme-text-primary">Gen {evolutionGraph.maxGeneration}</p>
              </div>
            </div>
            {evolutionGraph.relationCounts && Object.keys(evolutionGraph.relationCounts).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(evolutionGraph.relationCounts).map(([rel, count]) => (
                  <span key={rel} className="text-xs px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400">{rel}: {count as number}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="p-4 flex flex-wrap items-center gap-3" style={{ borderBottom: "1px solid var(--border-primary)" }}>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 theme-text-muted" />
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索技能名称或事件摘要..."
            className="w-full pl-10 pr-4 py-2 rounded-lg theme-bg-input theme-text-primary text-sm border border-transparent focus:border-orange-500/50 outline-none" />
          {searchQuery && <button onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2"><X className="w-3.5 h-3.5 theme-text-muted" /></button>}
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 theme-text-muted" />
          {(["all", "fix", "derived", "captured"] as const).map(t => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={"px-3 py-1.5 rounded-lg text-xs font-medium transition-colors " + (typeFilter === t ? "theme-accent-bg text-white" : "theme-bg-tertiary theme-text-secondary hover:theme-bg-hover")}>
              {t === "all" ? "全部" : TYPE_CONFIG[t].label}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && allEvents.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-8 h-8 animate-spin theme-text-muted" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-20">
            <AlertTriangle className="w-12 h-12 mb-3 theme-text-muted opacity-30" />
            <p className="theme-text-muted">进化数据加载失败</p>
            <p className="text-xs theme-text-muted mt-1">{loadError}</p>
            <button
              onClick={() => loadEvolutionData(true)}
              className="mt-4 px-4 py-2 rounded-lg text-sm theme-btn theme-btn-primary"
            >重试</button>
          </div>
        ) : allEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <History className="w-12 h-12 mb-3 theme-text-muted opacity-30" />
            <p className="theme-text-muted">暂无进化记录</p>
            <p className="text-xs theme-text-muted mt-1">技能在使用过程中会自动积累进化数据</p>
          </div>
        ) : (
          <div className="p-4">
            <div className="relative pl-8">
              {/* Vertical Line */}
              <div className="absolute left-[15px] top-0 bottom-0 w-0.5 bg-[var(--border-primary)]" />

              <div className="space-y-4">
                {allEvents.map((event: any, _idx: number) => {
                  const config = TYPE_CONFIG[event.type] || TYPE_CONFIG.derived
                  const EventIcon = config.icon
                  const isExpanded = expandedEvents.has(event.id)
                  const hasDetails = event.changelog && event.changelog.length > 0
                  // P4: 只有"最近一条未回滚的 engine 事件"才可回滚
                  const isRollbackable = event.source === "engine" && !event.rollbackReason && event.id === latestRollbackableEngineEvent?.id

                  return (
                    <div key={event.id} className="relative">
                      {/* Timeline Dot */}
                      <div className={"absolute left-[-23px] top-1 w-4 h-4 rounded-full border-2 flex items-center justify-center " + config.bgColor + " border-[var(--bg-primary)] z-10"}>
                        <span className={"text-[8px] font-bold " + config.color}>{config.letter}</span>
                      </div>

                      {/* Card */}
                      <div className="theme-card rounded-lg overflow-hidden">
                        <div
                          className={"p-4 flex items-start gap-3 " + (hasDetails ? "cursor-pointer hover:brightness-105 transition-all" : "")}
                          onClick={() => hasDetails && toggleExpand(event.id)}
                        >
                          {/* Icon */}
                          <div className={"w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 " + config.bgColor}>
                            <EventIcon className={"w-4 h-4 " + config.color} />
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium theme-text-primary text-sm">{event.skillName}</span>
                              <span className={"text-xs px-1.5 py-0.5 rounded-full " + config.bgColor + " " + config.color}>
                                {config.label}
                              </span>
                              <span className="text-xs theme-text-muted">
                                {event.success ? "成功" : "失败"}
                              </span>
                              {event.rollbackReason && (
                                <span className="text-xs px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-500">已回滚</span>
                              )}
                              {event.source === "engine" && (
                                <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-400">指标</span>
                              )}
                            </div>
                            <p className="text-sm theme-text-secondary mt-1">{event.summary}</p>
                            <div className="flex items-center gap-3 mt-1.5">
                              <span className="text-xs theme-text-muted flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {event.timestamp ? new Date(event.timestamp).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
                              </span>
                              {event.generation != null && (
                                <span className="text-xs theme-text-muted">Gen {event.generation}</span>
                              )}
                              {event.improvement != null && (
                                <span className="text-xs text-green-500">+{((event.improvement) * 100).toFixed(1)}%</span>
                              )}
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {event.source === "engine" && (
                              isRollbackable ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setShowRollbackConfirm({ id: event.id, skillName: event.skillName }) }}
                                  className="p-1.5 rounded-lg theme-bg-tertiary hover:theme-bg-hover transition-colors"
                                  title="撤销该技能最近一次进化"
                                >
                                  <RotateCcw className="w-4 h-4 theme-text-muted" />
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => e.stopPropagation()}
                                  className="p-1.5 rounded-lg theme-bg-tertiary opacity-30 cursor-not-allowed transition-colors"
                                  title={event.rollbackReason ? "已回滚" : "仅支持回滚最新进化"}
                                  disabled
                                >
                                  <RotateCcw className="w-4 h-4 theme-text-muted" />
                                </button>
                              )
                            )}
                            {hasDetails && (
                              <span className="theme-text-muted">
                                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Changelog Details */}
                        {isExpanded && hasDetails && (
                          <div className="px-4 pb-4 border-t border-[var(--border-primary)]">
                            <div className="mt-3 space-y-2">
                              <h4 className="text-xs font-medium theme-text-muted flex items-center gap-1">
                                <FileText className="w-3 h-3" />变更详情
                              </h4>
                              {event.changelog.map((change: string, ci: number) => (
                                <div key={ci} className="flex items-start gap-2 text-sm">
                                  <ArrowRight className="w-3.5 h-3.5 theme-accent flex-shrink-0 mt-0.5" />
                                  <span className="theme-text-secondary">{change}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Rollback Confirmation Dialog — P4: 文案改为"撤销该技能最近一次进化" */}
      {showRollbackConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.5)" }}>
          <div className="rounded-xl p-6 max-w-sm w-full mx-4" style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-primary)" }}>
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-6 h-6 text-yellow-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-lg font-semibold theme-text-primary">确认回滚</h3>
                <p className="text-sm theme-text-secondary mt-1">
                  确定要撤销该技能最近一次进化吗？此操作将撤销技能 "{showRollbackConfirm.skillName}" 的最新进化变更。
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowRollbackConfirm(null)}
                className="px-4 py-2 rounded-lg theme-bg-tertiary theme-text-secondary hover:theme-bg-hover text-sm">取消</button>
              <button onClick={() => handleRollback(showRollbackConfirm.id, showRollbackConfirm.skillName)}
                className="px-4 py-2 rounded-lg bg-yellow-500 text-black hover:bg-yellow-600 text-sm font-medium">确认回滚</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
