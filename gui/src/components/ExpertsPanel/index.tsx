/**
 * ExpertsPanel — 专家面板
 *
 * 参考实现风格 + 2025-2026 行业设计模式:
 * - 专家目录（分页/搜索/分类过滤）
 * - 专家详情（提示词可编辑、使用统计）
 * - 创建自定义专家
 * - 隐式路由标签（输入框中出现 @专家 提示）
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Users, Search, Plus, Zap, Loader2, Activity, Building2, Play,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Expert, Category, ExpertDetail, DepartmentInfo, TeamPreset } from './types'
import {
  fetchExperts, fetchCategories, routeMessage, fetchExpertDetail, fetchActiveExpert,
  fetchDepartments, fetchTeamPresets, summonExpert, startDepartmentMeeting,
} from './api'
import { ExpertCard } from './ExpertCard'
import { ExpertDetailView } from './ExpertDetail'
import { CreateExpert } from './CreateExpert'
// 2026-08-26 审计 E1: RouterPanel 原本无挂载(孤儿)——接回"路由诊断"入口
import { RouterPanel } from './RouterPanel'
// 2026-09-04 P3: CollabWizard 同为孤儿组件(发起/轮询/汇总渲染齐全但全仓无挂载)——接回入口
import CollabWizard from './CollabWizard'
// 2026-08-27 活动流开关: ActivityFeed 组件/端点早已在, 但挂载被 8-21 审计隐藏成
// 无入口死代码——恢复为头部「活动流」开关(默认关); addActivity 调用保留继续沉淀。
import { ActivityFeed, addActivity } from './ActivityFeed'
import { renderExpertIcon } from './icons'
// 2026-08-27 A6: 激活角标迁移到 CockpitUI StatusBadge(tone=success 实心语义)
import { StatusBadge } from '../CockpitUI'
import { CATEGORY_LABELS } from './category-labels'

type ViewMode = 'grid' | 'list'

// ─── 专家图标渲染（共享实现见 ./icons）───

export function ExpertsPanel({ onSummon, onNavigateChat, initialKeyword = '' }: {
  onSummon?: (expert: ExpertDetail) => void
  onNavigateChat?: () => void
  /** 2026-08-27 全局搜索: 挂载时初始化搜索输入(仅初值) */
  initialKeyword?: string
}) {
  const [experts, setExperts] = useState<Expert[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  // P2-6: 加载失败不再静默——置错误态,渲染可读文案 + 重试按钮
  // （此前接口挂掉时只 console.error,面板显示空态,用户误以为没有专家）
  const [loadError, setLoadError] = useState<string | null>(null)
  // 2026-08-27 全局搜索: 挂载时以 initialKeyword 初始化搜索输入(仅初值, 后续用户自改)
  const [search, setSearch] = useState(initialKeyword)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [summoned, setSummoned] = useState<string | null>(null)
  const summonedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 2026-08-26 E1: 当前激活专家轮询角标——expert-context 激活后 UI 可见"谁在作答"
  const [activeExpert, setActiveExpert] = useState<{ name: string } | null>(null)
  useEffect(() => {
    let stop = false
    const poll = async () => {
      try {
        const active = await fetchActiveExpert()
        if (!stop) setActiveExpert(active?.name ? { name: active.name } : null)
      } catch (e) { console.warn('[experts] active 轮询失败:', e) }
    }
    poll()
    const t = setInterval(poll, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [])

  // 子视图状态
  const [selectedExpert, setSelectedExpert] = useState<Expert | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  // 2026-08-26 审计 E1: RouterPanel(路由诊断)原本是孤儿组件(全库无挂载, 后端 API 实测可用)——接回入口
  const [showRouter, setShowRouter] = useState(false)
  // 2026-09-04 P3: CollabWizard(协作编排)孤儿组件接回——手动选岗发起多专家协作+汇总查看
  const [showCollab, setShowCollab] = useState(false)
  // 2026-08-27 活动流开关: ActivityFeed 挂载恢复为可控开关(默认关, 不抢占专家目录视图)
  const [showActivity, setShowActivity] = useState(false)
  // 2026-09-04 部门化 P2: 部门视图 + 预设班组 + 例会草稿
  const [departments, setDepartments] = useState<DepartmentInfo[]>([])
  const [presets, setPresets] = useState<TeamPreset[]>([])
  const [departmentFilter, setDepartmentFilter] = useState('')
  const [meetingDraft, setMeetingDraft] = useState<{ kind: 'department' | 'preset'; id: string; label: string } | null>(null)
  const [meetingGoal, setMeetingGoal] = useState('')
  const [launchingMeeting, setLaunchingMeeting] = useState(false)

  // 2026-09-05: 全量专家名单(不受分类/部门过滤)——详情协作链人名映射 + 创建重名校验
  const [allExperts, setAllExperts] = useState<Expert[]>([])
  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [expertList, catList, deptList, presetList, fullList] = await Promise.all([
        fetchExperts(categoryFilter || undefined),
        fetchCategories(),
        fetchDepartments(),
        fetchTeamPresets(),
        // 2026-09-05: 全量名单——协作链人名映射/创建重名校验不能建立在过滤子集上
        fetchExperts(),
      ])
      console.log('[Experts] loaded:', expertList?.length, 'experts,', catList?.length, 'cats,', deptList?.length, 'depts')
      setExperts(expertList || [])
      setCategories(catList || [])
      setDepartments(deptList || [])
      setPresets(presetList || [])
      setAllExperts(fullList || [])
    } catch (e) {
      console.error('[Experts] load error:', e)
      setLoadError(e instanceof Error ? e.message : String(e))
    }
    setLoading(false)
  }, [categoryFilter])

  useEffect(() => { loadData() }, [loadData])

  // 清理 summoned 超时定时器
  useEffect(() => {
    return () => {
      if (summonedTimerRef.current) clearTimeout(summonedTimerRef.current)
    }
  }, [])

  // 搜索过滤（字段防御：undefined/null 兜底）; 2026-09-04 P2 增加部门维度
  const deptFiltered = departmentFilter ? experts.filter(e => e.department === departmentFilter) : experts
  const filtered = search
    ? deptFiltered.filter(e =>
        (e.name || '').includes(search) ||
        (e.title || '').includes(search) ||
        (e.tags || []).some(t => t.includes(search)) ||
        (e.description || '').includes(search)
      )
    : deptFiltered

  // 召唤专家
  const handleSummon = useCallback(async (expert: Expert) => {
    try {
      const detail = await fetchExpertDetail(expert.id)
      if (detail) {
        // 2026-09-04 P2: 召唤走后端精确激活(POST /api/experts/summon)——此前仅插话术,
        // 靠发送后关键词路由兜底; 现在人设激活与话术插入双保险。
        summonExpert(expert.id).catch(err => console.warn('[ExpertsPanel] summon API 失败(不阻塞):', err))
        onSummon?.(detail)
        // 2026-09-05: recordSession 移除——后端 summon 端点内已记使用计数,
        // 此处再记一次导致卡片「使用 N 次」双倍(详情页召唤路径曾是三倍)
        addActivity(expert.id, expert.name, expert.icon, 'summoned', detail.systemPrompt.slice(0, 60))
        onNavigateChat?.()
      } else {
        console.warn('[ExpertsPanel] summon failed: expert detail not loaded for', expert.id)
        // P2-7: alert 阻塞弹窗 → toast 内联提示（Electron 下 alert 样式突兀且阻塞主线程）
        toast.error('专家详情加载失败，请重试')
      }
    } catch (e: any) {
      console.warn("[ExpertsPanel] summon error:", e?.message || e)
      toast.error(`专家召唤失败：${e?.message || '未知错误'}`)
    }
    if (summonedTimerRef.current) clearTimeout(summonedTimerRef.current)
    summonedTimerRef.current = setTimeout(() => {
      setSummoned(null)
      summonedTimerRef.current = null
    }, 2000)
  }, [onSummon, onNavigateChat])

  const handleSummonById = useCallback(async (expertId: string) => {
    if (!expertId) { toast.error('该记录没有关联专家'); return }
    // P3(GUI 全量修复 P0): 分类过滤下 experts 是被 categoryFilter 过滤的子集——
    // 隐式路由推荐命中的内置专家可能不在其中, 旧实现 find 落空后
    // 静默无反应(按钮点了没反馈)。兜底: 直接按 id 查全量专家详情再召唤。
    const expert = experts.find(e => e.id === expertId)
    if (expert) {
      handleSummon(expert)
      return
    }
    try {
      const detail = await fetchExpertDetail(expertId)
      if (detail && detail.name) {
        handleSummon(detail as any)
        return
      }
    } catch (e: any) {
      console.warn('[ExpertsPanel] 分类外专家详情获取失败:', e?.message || e)
    }
    toast.error('未找到该专家，召唤失败')
  }, [experts, handleSummon])

  // 2026-09-04 P2: 部门例会发车——成员并行→主管汇总, 进度见任务面板(TaskRun lane)与活动流
  const launchMeeting = useCallback(async () => {
    if (!meetingDraft) return
    const goal = meetingGoal.trim()
    if (!goal) { toast.error('请输入例会目标'); return }
    setLaunchingMeeting(true)
    try {
      const params = meetingDraft.kind === 'department'
        ? { department: meetingDraft.id, goal }
        : { presetId: meetingDraft.id, goal }
      const h = await startDepartmentMeeting(params)
      addActivity(h.lead?.id || '', meetingDraft.label, 'Users', 'summoned', `例会已召开: ${goal.slice(0, 40)}`)
      toast.success(`${meetingDraft.label}已召开，${h.tasks.length} 位成员执行中（进度见任务面板）`)
      setMeetingDraft(null)
      setMeetingGoal('')
      onNavigateChat?.()
    } catch (e: any) {
      console.warn('[ExpertsPanel] meeting error:', e?.message || e)
      toast.error(`例会启动失败：${e?.message || '未知错误'}`)
    }
    setLaunchingMeeting(false)
  }, [meetingDraft, meetingGoal, onNavigateChat])

  // 路由匹配 + 隐式路由检测
  const [implicitTag, setImplicitTag] = useState<{ id: string; name: string } | null>(null)
  const routeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const implicitSeqRef = useRef(0)

  // 路由防抖定时器卸载清理——面板关闭/切换视图后不再触发 setState
  useEffect(() => {
    return () => {
      if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current)
    }
  }, [])

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value)

    if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current)
    routeDebounceRef.current = setTimeout(async () => {
      const mySeq = ++implicitSeqRef.current
      const query = value.trim()
      if (query.length < 4) { setImplicitTag(null); return }
      try {
        const results = await routeMessage(query)
        if (mySeq !== implicitSeqRef.current) return
        if (results.length > 0 && results[0].score >= 50) {
          setImplicitTag({ id: results[0].expertId, name: results[0].name })
        } else {
          setImplicitTag(null)
        }
      } catch (e: any) {
        console.warn("[ExpertsPanel] route error:", e?.message || e)
        if (mySeq === implicitSeqRef.current) setImplicitTag(null)
      }
    }, 500)
  }, [])

  // 副标题显示专家数量
  const categoryName = categoryFilter ? (CATEGORY_LABELS[categoryFilter] || categoryFilter) : '全部'

  /* ===== 子视图路由 ===== */
  if (selectedExpert) {
    return (
      <div className="flex-1 min-h-0 overflow-hidden tab-content-enter" style={{ background: 'var(--bg-primary)' }}>
        <ExpertDetailView
          expert={selectedExpert}
          onBack={() => setSelectedExpert(null)}
          onSummon={(e) => { handleSummon(e); setSelectedExpert(null) }}
          onUpdated={loadData}
          expertNameMap={Object.fromEntries(allExperts.map(e => [e.id, e.name]))}
        />
      </div>
    )
  }

  if (showCreate) {
    return (
      <div className="flex-1 min-h-0 overflow-hidden tab-content-enter" style={{ background: 'var(--bg-primary)' }}>
        <CreateExpert onBack={() => setShowCreate(false)} onCreated={loadData} existingNames={allExperts.map(e => e.name)} />
      </div>
    )
  }

  // 2026-08-26 审计 E1: 路由诊断面板(孤儿组件接线)
  if (showRouter) {
    return (
      <div className="flex-1 min-h-0 overflow-hidden tab-content-enter" style={{ background: 'var(--bg-primary)' }}>
        <RouterPanel
          onSummon={(expertId) => { setShowRouter(false); handleSummonById(expertId) }}
          collapsed={false}
          onClose={() => setShowRouter(false)}
        />
      </div>
    )
  }

  // 2026-09-04 P3: 协作编排面板(孤儿组件接线)——手动选岗发起协作, 轮询任务卡与汇总
  if (showCollab) {
    return (
      <div className="flex-1 min-h-0 overflow-hidden tab-content-enter" style={{ background: 'var(--bg-primary)' }}>
        <CollabWizard onClose={() => setShowCollab(false)} />
      </div>
    )
  }

  // 2026-08-27 活动流: 开关打开时优先渲染 ActivityFeed(与 RouterPanel 分支同款容器);
  // onSummon 回专家 → 关闭活动流并复用 handleSummonById(分类过滤外专家按 id 兜底查详情)
  if (showActivity) {
    return (
      <div className="flex-1 min-h-0 overflow-hidden tab-content-enter" style={{ background: 'var(--bg-primary)' }}>
        <ActivityFeed onBack={() => setShowActivity(false)} onSummon={(expertId) => { setShowActivity(false); handleSummonById(expertId) }} />
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden tab-content-enter flex" style={{ background: 'var(--bg-primary)' }}>
      {/* ── Left: Expert Directory ── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b theme-border">
          <div>
            <h2 className="text-lg font-bold theme-text-primary flex items-center gap-2">
              <Users className="w-5 h-5" />
              专家团
            </h2>
            <p className="text-[11px] theme-text-muted mt-0.5">
              {departmentFilter
                ? (departments.find(d => d.id === departmentFilter)?.label || departmentFilter)
                : categoryName} · {filtered.length} 位专家
              {activeExpert && (
                <span className="ml-2"><StatusBadge tone="success" label={`● ${activeExpert.name} 正在作答`} /></span>
              )}
              {!categoryFilter && implicitTag && (
                <span className="ml-2 px-1.5 py-0.5 rounded text-[10px]"
                  style={{ background: 'rgba(89,168,255,0.1)', color: '#59a8ff' }}>
                  @{implicitTag.name}
                </span>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* View toggle */}
            <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--border-primary)' }}>
              <button
                onClick={() => setViewMode('grid')}
                className="px-2 py-1.5 text-[10px] transition-colors"
                style={{
                  background: viewMode === 'grid' ? 'var(--bg-tertiary)' : 'transparent',
                  color: 'var(--text-muted)',
                }}
              >▦</button>
              <button
                onClick={() => setViewMode('list')}
                className="px-2 py-1.5 text-[10px] transition-colors"
                style={{
                  background: viewMode === 'list' ? 'var(--bg-tertiary)' : 'transparent',
                  color: 'var(--text-muted)',
                }}
              >☰</button>
            </div>

            {/* Create button */}
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-all"
              style={{ background: 'var(--accent-primary)' }}
            >
              <Plus className="w-3.5 h-3.5" />
              创建
            </button>

            {/* 2026-08-26 审计 E1: 路由诊断入口（RouterPanel 孤儿组件接线） */}
            <button
              onClick={() => setShowRouter(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              <Zap className="w-3.5 h-3.5" />
              路由诊断
            </button>

            {/* 2026-09-04 P3: 协作编排入口（CollabWizard 孤儿组件接线） */}
            <button
              onClick={() => setShowCollab(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
            >
              <Users className="w-3.5 h-3.5" />
              协作编排
            </button>

            {/* 2026-08-27 活动流开关: 组件/端点早已在, 但挂载被 8-21 审计隐藏成无入口死代码——恢复为可控开关(默认关) */}
            <button
              onClick={() => setShowActivity(s => !s)}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${showActivity ? 'theme-accent-bg text-white' : ''}`}
              style={{ background: showActivity ? undefined : 'var(--bg-tertiary)', color: showActivity ? undefined : 'var(--text-secondary)' }}
            >
              <Activity className="w-3.5 h-3.5" />
              活动流
            </button>
          </div>
        </div>

        {/* Search + Category filter */}
        <div className="flex items-center gap-2 px-6 py-2.5 border-b theme-border">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 theme-text-muted" />
            <input
              type="text"
              value={search}
              onChange={e => handleSearchChange(e.target.value)}
              placeholder="搜索专家或描述你的问题..."
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none focus:border-accent-primary/50"
            />
            {/* 隐式路由提示 */}
            {implicitTag && !categoryFilter && (
              <div className="absolute left-9 -bottom-5 flex items-center gap-1 text-[9px]"
                style={{ color: '#59a8ff' }}>
                <Zap className="w-2.5 h-2.5" />
                推荐专家: {implicitTag.name}
                <button onClick={() => handleSummonById(implicitTag.id)}
                  className="ml-1 px-1 py-0.5 rounded text-[8px]" style={{ background: 'rgba(89,168,255,0.15)' }}>
                  召唤
                </button>
                <button onClick={() => setImplicitTag(null)} className="ml-0.5 opacity-50">✕</button>
              </div>
            )}
          </div>

          {/* Category filter */}
          <select
            value={categoryFilter}
            onChange={e => { setCategoryFilter(e.target.value); setSearch('') }}
            className="px-2.5 py-1.5 text-[11px] rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none"
          >
            <option value="">全部分类</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>

        {/* 2026-09-04 P2: 部门抽屉 chips + 预设班组(一键例会) */}
        <div className="flex items-center gap-1.5 px-6 py-2 border-b theme-border overflow-x-auto">
          <Building2 className="w-3.5 h-3.5 theme-text-muted flex-shrink-0" />
          <button
            onClick={() => setDepartmentFilter('')}
            className="px-2 py-1 rounded-full text-[10px] whitespace-nowrap transition-colors"
            style={departmentFilter === ''
              ? { background: 'var(--accent-primary)', color: '#fff' }
              : { background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
          >全部</button>
          {departments.map(d => (
            <span key={d.id} className="inline-flex items-center flex-shrink-0 rounded-full overflow-hidden"
              style={{ border: '1px solid var(--border-primary)' }}>
              <button
                onClick={() => setDepartmentFilter(departmentFilter === d.id ? '' : d.id)}
                className="px-2 py-1 text-[10px] whitespace-nowrap transition-colors"
                style={departmentFilter === d.id
                  ? { background: 'var(--accent-primary)', color: '#fff' }
                  : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                title={d.description}
              >{d.label}·{d.memberCount}</button>
              {departmentFilter === d.id && (
                <button
                  onClick={() => { setMeetingDraft({ kind: 'department', id: d.id, label: `${d.label}例会` }); setMeetingGoal('') }}
                  className="px-1.5 py-1 text-[9px] font-medium"
                  style={{ background: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
                  title={`召开${d.label}例会（成员并行→主管汇总）`}
                >例会</button>
              )}
            </span>
          ))}
          <span className="w-px h-4 mx-1 flex-shrink-0" style={{ background: 'var(--border-primary)' }} />
          {presets.map(p => (
            <button
              key={p.id}
              onClick={() => { setMeetingDraft({ kind: 'preset', id: p.id, label: p.label }); setMeetingGoal(p.defaultGoal || '') }}
              className="flex items-center gap-1 px-2 py-1 rounded-full text-[10px] whitespace-nowrap flex-shrink-0"
              style={{ background: 'var(--accent-muted)', color: 'var(--accent-primary)' }}
              title={`${p.description}（一键按默认目标发车，可修改）`}
            >
              <Play className="w-2.5 h-2.5" />
              {p.label}
            </button>
          ))}
        </div>

        {/* 2026-09-04 P2: 例会目标输入（发车后成员并行执行, 主管汇总; 进度见任务面板） */}
        {meetingDraft && (
          <div className="flex items-center gap-2 px-6 py-2 border-b theme-border" style={{ background: 'var(--bg-tertiary)' }}>
            <span className="text-[11px] theme-text-primary font-medium flex-shrink-0">{meetingDraft.label} · 目标：</span>
            <input
              autoFocus
              value={meetingGoal}
              onChange={e => setMeetingGoal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') launchMeeting() }}
              placeholder="本次例会要解决什么问题…"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none"
            />
            <button
              onClick={launchMeeting}
              disabled={launchingMeeting || !meetingGoal.trim()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50 flex-shrink-0"
              style={{ background: 'var(--accent-primary)' }}
            >
              {launchingMeeting ? '发车中…' : '发车'}
            </button>
            <button onClick={() => { setMeetingDraft(null); setMeetingGoal('') }} className="text-[11px] theme-text-muted flex-shrink-0">取消</button>
          </div>
        )}

        {/* Expert Grid / List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin theme-accent" />
            </div>
          ) : loadError ? (
            /* P2-6: 加载失败错误态——与空态区分,可重试（参考 FileBrowser 错误态样式） */
            <div className="flex flex-col items-center justify-center py-16">
              <p className="text-xs theme-text-muted mb-2">加载失败：{loadError}</p>
              <button
                type="button"
                onClick={() => { void loadData() }}
                className="px-4 py-1.5 text-xs rounded-lg text-white transition-colors"
                style={{ background: 'var(--accent-primary)' }}
                title="重新加载专家列表"
              >
                重试
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Users className="w-12 h-12 mb-3 theme-text-muted opacity-30" />
              <p className="text-sm theme-text-muted mb-2">
                {search || categoryFilter ? '未找到匹配的专家' : '暂无可用专家'}
              </p>
              <p className="text-[11px] theme-text-muted opacity-60 mb-4">
                {search || categoryFilter ? '试试其他关键词或分类' : '点击「创建」按钮自定义专家'}
              </p>
              {!search && !categoryFilter && (
                <button onClick={() => setShowCreate(true)}
                  className="flex items-center gap-1 px-4 py-2 rounded-lg text-xs font-medium text-white"
                  style={{ background: 'var(--accent-primary)' }}>
                  <Plus className="w-3.5 h-3.5" />
                  创建自定义专家
                </button>
              )}
            </div>
          ) : viewMode === 'grid' ? (
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {filtered.map(expert => (
                <ExpertCard
                  key={expert.id}
                  expert={expert}
                  summoned={summoned}
                  onSummon={handleSummon}
                  onSelect={setSelectedExpert}
                />
              ))}
            </div>
          ) : (
            /* List view */
            <div className="p-4 space-y-1">
              {filtered.map(expert => (
                <div key={expert.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:theme-bg-tertiary cursor-pointer transition-colors"
                  onClick={() => setSelectedExpert(expert)}
                >
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'var(--accent-muted)' }}>
                    {renderExpertIcon(expert.icon, 'w-4 h-4 theme-accent')}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs theme-text-primary font-medium">{expert.name}</div>
                    <div className="text-[10px] theme-text-muted truncate">{expert.title} · {expert.description}</div>
                  </div>
                  <div className="flex gap-1">
                    {(expert.tags || []).slice(0, 2).map(t => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-[9px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleSummon(expert) }}
                    className="px-2.5 py-1 rounded-lg text-[10px] font-medium transition-all"
                    style={{
                      background: summoned === expert.id ? 'var(--accent-primary)' : 'var(--accent-muted)',
                      color: summoned === expert.id ? '#fff' : 'var(--accent-primary)',
                    }}
                  >
                    {summoned === expert.id ? '已召唤' : '召唤'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  )
}
