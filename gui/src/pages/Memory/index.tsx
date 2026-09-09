import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Brain,
  Search,
  Plus,
  Trash2,
  Database,
  Moon,
  RefreshCw,
  FileText,
  Sparkles,
  Clock,
  Edit3,
  Tag,
  Users,
  X,
  Check,
  Filter,
  GitBranch,
  Activity,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiDelete, apiPut } from '../../lib/api'
import { MemoryGraph } from '../../components/MemoryGraph'
import { TrustBadge } from '../../components/TrustBadge'
import { MemorySoul } from '../../components/MemorySoul'
import { MemoryEvolution } from '../../components/MemoryEvolution'
import { MemorySnapshot } from '../../components/MemorySnapshot'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { useConfirm } from '../../components/useConfirm'
import { useDebounce, useSearchAbort } from '../../hooks/useMemoryHelpers'
// Interfaces moved to ./types.ts for reuse
import type { MemoryNote, MemoryStats, DreamResult, EntityInfo, GraphNode, GraphEdge, TimelineEntry } from './types'

interface MemoryPanelProps {
  serviceStatus?: { server: boolean; larkBridge: boolean; wecomBridge: boolean }
}

export function MemoryPanel(_props: MemoryPanelProps) {
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [notes, setNotes] = useState<MemoryNote[]>([])
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [dreamResult, setDreamResult] = useState<DreamResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearchQuery = useDebounce(searchQuery, 400)
  const [showAddNote, setShowAddNote] = useState(false)
  const [editingNote, setEditingNote] = useState<MemoryNote | null>(null)
  const [newNote, setNewNote] = useState({ title: '', content: '', tags: '', type: 'note' })
  const [activeTab, setActiveTab] = useState<'overview' | 'notes' | 'search' | 'entities' | 'graph' | 'timeline' | 'evolution' | 'snapshot' | 'soul'>('overview')
  const [hasSearched, setHasSearched] = useState(false)
  // 2026-08-12 (搜索落地 4a): 记忆搜索分页——后端仅支持 limit(默认 10,无 offset),加载更多每次 +20 重拉全量合并去重
  const [searchLimit, setSearchLimit] = useState(10)
  const [debugInfo, setDebugInfo] = useState<string>('')
  const [entities, setEntities] = useState<EntityInfo[]>([])
  const [selectedEntity, setSelectedEntity] = useState<EntityInfo | null>(null)
  const [noteFilter, setNoteFilter] = useState<string>('all')
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([])
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([])
  const [timelineEntries, setTimelineEntries] = useState<TimelineEntry[]>([])
  const [timelineFilter, setTimelineFilter] = useState<string>('all')
  const [evolutionStatus, setEvolutionStatus] = useState<any>(null)
  const [evolutionProfile, setEvolutionProfile] = useState<any>(null)
  const [evolving, setEvolving] = useState(false)
  const [loadingEvolution, setLoadingEvolution] = useState(false)
  // Snapshot 状态
  const [snapshotAgent, setSnapshotAgent] = useState<string[]>([])
  const [snapshotUser, setSnapshotUser] = useState<string[]>([])
  const [snapshotUsage, setSnapshotUsage] = useState<any>(null)
  const [newSnapshotEntry, setNewSnapshotEntry] = useState('')
  // Soul/IDENTITY 状态
  const [identityContent, setIdentityContent] = useState('')
  const [identitySaving, setIdentitySaving] = useState(false)
  // P9 fix: 脏标记 ref，防止加载覆盖用户正在编辑的内容
  const identityDirtyRef = useRef(false)
  const { confirmNode, askConfirm } = useConfirm()
  // P6 fix: 快照删除确认对话框
  const [snapshotDeleteConfirm, setSnapshotDeleteConfirm] = useState<{ type: 'agent' | 'user'; entry: string } | null>(null)
  const mountedRef = useRef(true)
  const abortRef = useRef<AbortController | null>(null)
  // Memory search now properly uses AbortSignal via fetchWithTimeout (see; dependency: A1 fix)
  const searchAbort = useSearchAbort()

  const loadData = useCallback(async (isManualRefresh: boolean = false) => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    if (isManualRefresh) {
      setIsLoading(true)
      setIsRefreshing(true)
    }

    try {
      const [statsResult, notesResult] = await Promise.all([
        apiGet('/api/memory/stats', { signal: controller.signal }),
        apiGet('/api/memory/notes', { signal: controller.signal })
      ])

      if (!mountedRef.current) return

      const statsData = statsResult.success ? statsResult.data : null
      const notesData = notesResult.success ? notesResult.data : null

      if (statsData?.sessions !== undefined) {
        setStats(statsData)
      }

      if (notesData?.notes) {
        setNotes(notesData.notes)
      }

      if (!statsResult.success || !notesResult.success) {
        setDebugInfo('stats: ' + (statsResult.error || 'ok') + ' | notes: ' + (notesResult.error || 'ok'))
      } else {
        setDebugInfo('')
      }
    } catch (e: any) {
      if (!mountedRef.current) return
      if (e.name === 'AbortError') {
        if (isManualRefresh) toast.error('加载超时，请检查服务是否正常运行')
      } else {
        setDebugInfo('加载异常: ' + e.message)
      }
    } finally {
      clearTimeout(timeoutId)
      if (abortRef.current === controller) {
        abortRef.current = null
      }
      if (mountedRef.current) {
        setIsLoading(false)
        setIsRefreshing(false)
      }
    }
  }, [])

  const loadEntities = useCallback(async () => {
    try {
      const result = await apiGet('/api/memory/entities')
      if (result.success && result.data?.entities) {
        setEntities(result.data.entities)
      }
    } catch (e) {
      console.error('记忆数据加载失败:', e)
      toast.error('记忆数据加载失败: ' + ((e as any)?.message || '未知错误'))
    }
  }, [])

  const loadGraph = useCallback(async () => {
    try {
      // P3(GUI 全量修复 P0): apiGet 已把内层 data 剥到 result.data(fetch 分支与
      // Electron proxy 双通道均如此)——旧代码再取 result.data.data 恒 undefined →
      // 记忆图谱永远空白且无任何错误提示(success===true)。改为直接取 result.data。
      const result = await apiGet('/panels/memory-graph?maxNodes=200&maxEdges=500')
      if (result.success && result.data) {
        const inner = result.data as any
        setGraphNodes(inner?.nodes || [])
        setGraphEdges(inner?.edges || [])
      }
    } catch (e) {
      console.error('记忆数据加载失败:', e)
      toast.error('记忆数据加载失败: ' + ((e as any)?.message || '未知错误'))
    }
  }, [])

  const loadTimeline = useCallback(async () => {
    try {
      const result = await apiGet('/api/memory/timeline')
      if (result.success && result.data?.entries) {
        setTimelineEntries(result.data.entries)
      }
    } catch (e) {
      console.error('记忆数据加载失败:', e)
      toast.error('记忆数据加载失败: ' + ((e as any)?.message || '未知错误'))
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    loadData()
    return () => {
      mountedRef.current = false
      if (abortRef.current) {
        abortRef.current.abort()
        abortRef.current = null
      }
    }
  }, [loadData])

  // ── 必须在 useEffect 之前定义，避免 TDZ ──
  const loadSnapshot = useCallback(async () => {
    try {
      const res = await apiGet('/api/memory/snapshot')
      if (res?.success) {
        const data = res.data || res
        // 新版返回 entries[]，旧版返回 rawMarkdown（兼容两种格式）
        const agentEntries = Array.isArray(data.agent) ? data.agent : (data.agent ? data.agent.split('\n').filter((l: string) => l.trim()).map((l: string) => l.replace(/^-\s*/, '')) : [])
        const userEntries = Array.isArray(data.user) ? data.user : (data.user ? data.user.split('\n').filter((l: string) => l.trim()).map((l: string) => l.replace(/^-\s*/, '')) : [])
        setSnapshotAgent(agentEntries)
        setSnapshotUser(userEntries)
        setSnapshotUsage(data.usage || null)
      }
    } catch(e) { console.warn("[Memory]", e instanceof Error ? e.message : String(e)); }
  }, [])

  const loadEvolutionData = async () => {
    setLoadingEvolution(true)
    try {
      const [statusRes, profileRes] = await Promise.allSettled([
        apiGet('/api/memory/evolution/status'),
        apiGet('/api/memory/evolution/profile'),
      ])
      if (statusRes.status === 'fulfilled' && statusRes.value?.success) {
        setEvolutionStatus((statusRes.value as { data?: { status?: unknown }; status?: unknown }).data?.status || (statusRes.value as { data?: { status?: unknown }; status?: unknown }).status)
      }
      if (profileRes.status === 'fulfilled' && profileRes.value?.success) {
        setEvolutionProfile((profileRes.value as { data?: { profile?: unknown }; profile?: unknown }).data?.profile || (profileRes.value as { data?: { profile?: unknown }; profile?: unknown }).profile)
      }
    } catch (e) {
      console.error('加载进化数据失败:', e)
    } finally {
      setLoadingEvolution(false)
    }
  }

  const loadIdentity = useCallback(async () => {
    // P9 fix: 如果用户正在编辑（脏标记），跳过加载覆盖
    if (identityDirtyRef.current) return
    try {
      const res = await apiGet('/api/identity')
      if (res?.success) {
        const data = res.data || res
        setIdentityContent(data.content || '')
      }
    } catch(e) { console.warn("[Memory]", e instanceof Error ? e.message : String(e)); }
  }, [])

  useEffect(() => {
    // P9 fix: 离开 soul tab 时如有未保存编辑，提示用户
    // （通过 tab 切换前的逻辑处理——此处保留现有逻辑）
    // Clear selected entity when switching away from entities tab
    if (activeTab !== 'entities') {
      setSelectedEntity(null)
    }
    if (activeTab === 'entities' && entities.length === 0) {
      loadEntities()
    }
    if (activeTab === 'graph') {
      loadGraph()
    }
    if (activeTab === 'timeline') {
      loadTimeline()
    }
    if (activeTab === 'evolution') {
      loadEvolutionData()
    }
    if (activeTab === 'snapshot') {
      loadSnapshot()
    }
    if (activeTab === 'soul') {
      loadIdentity()
    }
  }, [activeTab, entities.length, loadEntities, loadGraph, loadTimeline, loadSnapshot, loadIdentity])

  const handleTriggerEvolution = async () => {
    setEvolving(true)
    try {
      const result = await apiPost('/api/memory/evolution/trigger', {})
      if (result.success) {
        toast.success('记忆进化触发成功')
        loadEvolutionData()
      } else {
        toast.error(result.error || '进化触发失败')
      }
    } catch (e: any) {
      toast.error('进化触发失败: ' + (e.message || '未知错误'))
    } finally {
      setEvolving(false)
    }
  }

  // ── Snapshot 快照记忆 ──
  const handleAddSnapshotEntry = async (type?: 'agent' | 'user', entry?: string) => {
    const t = type || 'agent'
    const e = (entry || newSnapshotEntry).trim()
    if (!e) return
    // P13 fix: 重复检测——若 entries 已含此条目则提示
    const existingEntries = t === 'agent' ? snapshotAgent : snapshotUser
    const existingLines = existingEntries
    if (existingLines.some((l: string) => l.trim() === e)) {
      toast.error('该记忆条目已存在，请勿重复添加')
      return
    }
    try {
      const res = await apiPost('/api/memory/snapshot/add', { type: t, entry: e })
      if (res.success) {
        toast.success('记忆已添加')
        setNewSnapshotEntry('')
        loadSnapshot()
      } else {
        toast.error(res.error || '添加失败')
      }
    } catch (e) { console.error('[Memory] 快照条目添加失败:', e); toast.error('添加失败') }
  }

  // P6 fix: 删除前弹确认对话框（两阶段：先设 confirm state，确认后才真正调用 API）
  const handleRemoveSnapshotEntryConfirm = async () => {
    if (!snapshotDeleteConfirm) return
    const { type, entry } = snapshotDeleteConfirm
    // P6 fix: 用 "- " 前缀整行精确匹配，避免子串替换误删
    const oldStr = `- ${entry}`
    try {
      const res = await apiPost('/api/memory/snapshot/remove', { type, oldStr })
      if (res.success) {
        toast.success('已删除')
        setSnapshotDeleteConfirm(null)
        loadSnapshot()
      } else {
        toast.error(res.error || '删除失败')
        setSnapshotDeleteConfirm(null)
      }
    } catch (e) { console.error('[Memory] 快照删除失败:', e); toast.error('删除失败'); setSnapshotDeleteConfirm(null) }
  }

  const handleRemoveSnapshotEntry = (type: 'agent' | 'user', entry: string) => {
    // P6 fix: 弹出确认对话框而不是直接删除
    setSnapshotDeleteConfirm({ type, entry })
  }

  // ── Soul/IDENTITY 人格编辑 ──
  const handleIdentityChange = (val: string) => {
    identityDirtyRef.current = true
    setIdentityContent(val)
  }
  const saveIdentity = async () => {
    setIdentitySaving(true)
    try {
      const res = await apiPost('/api/identity', { content: identityContent })
      if (res.success) {
        toast.success('IDENTITY.md 已保存')
        identityDirtyRef.current = false
      } else {
        toast.error(res.error || '保存失败')
      }
    } catch (e) { console.error('[Memory] IDENTITY 保存失败:', e); toast.error('保存失败') }
    finally { setIdentitySaving(false) }
  }

  // 2026-08-12 (搜索落地 4a): 记录上一个已执行的搜索查询——新查询先清空旧结果再合并,防加载更多串味
  const prevSearchQueryRef = useRef('')

  // RRF 结果合并去重:id 为主键(后端无 id 时整条兜底);同一查询增大 limit 重拉全量时合并去重保序
  function mergeSearchResults(prev: any[], incoming: any[]): any[] {
    const seen = new Set<string>()
    const out: any[] = []
    for (const r of [...prev, ...incoming]) {
      const key = r?.id !== undefined && r?.id !== null ? String(r.id) : JSON.stringify(r)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
    return out
  }

  useEffect(() => {
    if (!debouncedSearchQuery.trim()) {
      if (hasSearched) {
        setSearchResults([])
        setHasSearched(false)
      }
      return
    }
    if (activeTab !== 'search') return

    const controller = searchAbort.getController()

    // 新查询(防抖值变化)→ 先清空旧结果并记录,防加载更多合并串入上个查询的结果
    const isNewQuery = prevSearchQueryRef.current !== debouncedSearchQuery
    if (isNewQuery) {
      prevSearchQueryRef.current = debouncedSearchQuery
      setSearchResults([])
    }

    const doSearch = async () => {
      setIsSearching(true)
      try {
        const result = await apiGet(`/api/memory/search?q=${encodeURIComponent(debouncedSearchQuery)}&limit=${searchLimit}`, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (result.success && result.data?.results) {
          // 同一查询加载更多(limit 增大)→ 合并去重;新查询(结果已清空)→ 等价于替换
          setSearchResults(prev => mergeSearchResults(prev, result.data.results))
        }
        setHasSearched(true)
      } catch (e: any) {
        if (e.name === 'AbortError') return
        console.error('记忆搜索失败:', e)
        toast.error('记忆搜索失败: ' + (e?.message || '未知错误'))
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false)
        }
      }
    }
    doSearch()

    return () => {
      controller.abort()
    }
  }, [debouncedSearchQuery, activeTab, searchAbort, searchLimit])

  const handleSearch = () => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }
    // 手动搜索：中止之前的防抖搜索，直接执行
    searchAbort.abort()
    setIsSearching(true)
    const controller = searchAbort.getController()
    apiGet(`/api/memory/search?q=${encodeURIComponent(searchQuery)}&limit=${searchLimit}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return
        if (result.success && result.data?.results) {
          setSearchResults(result.data.results)
        } else if (!result.success) {
          toast.error(result.error || '搜索失败，请稍后重试')
        }
        setHasSearched(true)
      })
      .catch((e: any) => {
        if (e.name === 'AbortError') return
        toast.error('搜索失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsSearching(false)
        }
      })
  }

  const handleAddNote = async () => {
    if (!newNote.content.trim()) {
      toast.error('请输入笔记内容')
      return
    }

    try {
      const res = await apiPost('/api/memory/notes', {
        title: newNote.title || '笔记',
        content: newNote.content,
        tags: newNote.tags.split(',').map(t => t.trim()).filter(Boolean),
        type: newNote.type || 'note'
      })
      // P7(GUI 全量修复): 检查 result.success——业务失败不抛异常, 旧实现假成功
      if (!res.success) { toast.error(res.error || '笔记添加失败'); return }
      toast.success('笔记已添加')
      setShowAddNote(false)
      setNewNote({ title: '', content: '', tags: '', type: 'note' })
      loadData()
    } catch (e) {
      toast.error('添加失败')
    }
  }

  const handleUpdateNote = async () => {
    if (!editingNote || !editingNote.content.trim()) {
      toast.error('请输入笔记内容')
      return
    }

    try {
      const res = await apiPut(`/api/memory/notes/${editingNote.id}`, {
        title: editingNote.title,
        content: editingNote.content,
        tags: editingNote.tags
      })
      if (!res.success) { toast.error(res.error || '笔记更新失败'); return }
      toast.success('笔记已更新')
      setEditingNote(null)
      loadData()
    } catch (e) {
      toast.error('更新失败')
    }
  }

  const handleDeleteNote = async (noteId: string) => {
    // 2026-08-08(审计 P1): window.confirm → askConfirm（Electron 下原生 confirm 恒 false）
    if (!(await askConfirm({ title: '删除笔记', message: '确定要删除这条笔记吗？此操作不可撤销。', danger: true }))) {
      return
    }
    try {
      const res = await apiDelete(`/api/memory/notes/${noteId}`)
      if (!res.success) { toast.error(res.error || '笔记删除失败'); return }
      toast.success('笔记已删除')
      loadData()
    } catch (e) {
      toast.error('删除失败')
    }
  }

  const handleTriggerDream = async () => {
    setIsLoading(true)
    try {
      const data = await apiPost('/api/memory/dream', {})
      // A2 fix: apiPost 统一返回 ApiResult<T>，内部数据在 .data 中
      const dreams = data.data?.dreams
      if (dreams) {
        setDreamResult({
          insights: dreams.insights || [],
          consolidated: dreams.consolidated ?? dreams.stats?.memoriesReviewed ?? 0,
          timestamp: dreams.timestamp || Date.now(),
        })
        if (dreams.message) {
          toast.info(dreams.message)
        } else {
          toast.success('记忆整理完成')
        }
        // 整理完成后刷新统计数据
        loadData()
      } else {
        toast.error('整理失败：服务未返回有效结果')
      }
    } catch (e: any) {
      toast.error('整理失败: ' + (e.message || '未知错误'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleProbeEntity = async (entityName: string) => {
    try {
      const result = await apiGet(`/api/memory/entities/${encodeURIComponent(entityName)}`)
      if (result.success && result.data) {
        setSelectedEntity({
          name: entityName,
          type: result.data.entity?.type || 'unknown',
          factCount: result.data.facts?.length || 0,
          facts: result.data.facts || []
        })
      }
    } catch (e) {
      toast.error('查询实体失败')
    }
  }

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const noteTypes = useMemo(() => {
    const types = new Set<string>()
    notes.forEach(n => { if (n.type) types.add(n.type) })
    return Array.from(types)
  }, [notes])

  const filteredNotes = useMemo(() => {
    if (noteFilter === 'all') return notes
    return notes.filter(n => n.type === noteFilter)
  }, [notes, noteFilter])

  const tabs = [
    { key: 'overview' as const, label: '统计概览', icon: Database },
    { key: 'notes' as const, label: '我的笔记', icon: FileText },
    { key: 'search' as const, label: '搜索记忆', icon: Search },
    { key: 'entities' as const, label: '实体浏览', icon: Users },
    { key: 'graph' as const, label: '记忆图谱', icon: GitBranch },
    { key: 'timeline' as const, label: '时间线', icon: Activity },
    { key: 'evolution' as const, label: '记忆进化', icon: Zap },
    { key: 'snapshot' as const, label: '快照记忆', icon: FileText },
    { key: 'soul' as const, label: '人格编辑', icon: Edit3 },
  ]

  return (
    <div className="flex flex-col p-6" style={{ minHeight: '100%' }}>
      {confirmNode}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold theme-text-primary flex items-center gap-2">
            <Brain className="w-6 h-6 theme-color-info" />
            记忆系统
          </h2>
          <p className="text-sm mt-1 theme-text-muted">查看会话统计、管理笔记、搜索记忆和浏览实体</p>
        </div>
        <button
          onClick={() => loadData(true)}
          disabled={isRefreshing}
          className="p-2 rounded-lg transition-colors theme-bg-tertiary hover:theme-bg-hover"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex overflow-x-auto border-b theme-border" role="tablist" aria-label="记忆管理选项卡">
        {tabs.map(tab => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() => {
              // P9 fix: 离开 soul tab 前若有未保存编辑，提示用户
              if (activeTab === 'soul' && tab.key !== 'soul' && identityDirtyRef.current) {
                // 使用 askConfirm 异步确认（替代 Electron 下不可用的 window.confirm）
                askConfirm({ title: '未保存修改', message: '当前人格文件有未保存的修改，切换将丢失更改。确定离开吗？' }).then(ok => {
                  if (ok) {
                    identityDirtyRef.current = false
                    setActiveTab(tab.key)
                  }
                })
                return
              }
              setActiveTab(tab.key)
            }}
            className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === tab.key
                ? 'theme-accent border-b-2'
                : 'theme-text-secondary hover:theme-text-primary'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6 mt-6">
          {isLoading && isRefreshing && !stats && (
            <div className="flex items-center justify-center py-12 theme-text-muted">
              <RefreshCw className="w-8 h-8 animate-spin mr-3" />
              <div className="flex items-center justify-center gap-2 py-4"><div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" style={{animationDelay:"0ms"}}></div><div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" style={{animationDelay:"150ms"}}></div><div className="w-2 h-2 rounded-full bg-purple-400 animate-bounce" style={{animationDelay:"300ms"}}></div><span className="text-xs theme-text-muted ml-1">加载中</span></div>
              {debugInfo && <span className="ml-2 text-xs theme-color-error">{debugInfo}</span>}
            </div>
          )}
          {!isLoading && !stats && (
            <div className="text-center py-12 theme-text-muted">
              <Brain className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>无法加载记忆数据</p>
              {debugInfo && <p className="mt-2 text-xs theme-color-error">{debugInfo}</p>}
            </div>
          )}
          {stats && (
            <>
              <div className="grid grid-cols-4 gap-4">
                <div className="theme-card p-4">
                  <div className="flex items-center gap-2 theme-text-secondary text-sm mb-2">
                    <Database className="w-4 h-4" />
                    会话总数
                  </div>
                  <div className="text-3xl font-bold theme-text-primary">
                    {stats.sessions?.total || 0}
                  </div>
                </div>
                <div className="theme-card p-4">
                  <div className="flex items-center gap-2 theme-text-secondary text-sm mb-2">
                    <FileText className="w-4 h-4" />
                    消息总数
                  </div>
                  <div className="text-3xl font-bold theme-text-primary">
                    {stats.sessions?.totalMessages || 0}
                  </div>
                </div>
                <div className="theme-card p-4">
                  <div className="flex items-center gap-2 theme-text-secondary text-sm mb-2">
                    <Sparkles className="w-4 h-4" />
                    笔记记忆
                  </div>
                  <div className="text-3xl font-bold theme-text-primary">
                    {stats.notebook?.totalMemories || 0}
                  </div>
                  {(stats.notebook?.noteCount !== undefined || stats.notebook?.sessionHighlightCount !== undefined) && (
                    <div className="text-xs theme-text-muted mt-1">
                      {stats.notebook?.noteCount || 0} 笔记 + {stats.notebook?.sessionHighlightCount || 0} 对话
                    </div>
                  )}
                </div>
                <div className="theme-card p-4">
                  <div className="flex items-center gap-2 theme-text-secondary text-sm mb-2">
                    <Moon className="w-4 h-4" />
                    整理次数
                  </div>
                  <div className="text-3xl font-bold theme-text-primary">
                    {stats.dream?.sessionCount || 0}
                  </div>
                </div>
              </div>

              {/* ═══════ 🧠 记忆智能面板 ═══════ */}
              <div className="mt-4 p-4 rounded-xl" style={{background:'rgba(59,130,246,0.05)',border:'1px solid rgba(59,130,246,0.15)'}}>
                <div className="flex items-center gap-2 mb-3">
                  <Zap className="w-4 h-4 theme-accent" />
                  <span className="text-sm font-semibold theme-accent">记忆智能</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full theme-accent-bg text-white">NEW</span>
                </div>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="p-2 rounded-lg" style={{background:'rgba(255,255,255,0.03)'}}>
                    <div className="theme-text-muted mb-1">自动提取</div>
                    <div className="text-lg font-bold theme-text-primary">LLM 驱动</div>
                    <div className="theme-text-muted mt-0.5">从对话中自动识别偏好、事实、修正</div>
                  </div>
                  <div className="p-2 rounded-lg" style={{background:'rgba(255,255,255,0.03)'}}>
                    <div className="theme-text-muted mb-1">矛盾检测</div>
                    <div className="text-lg font-bold theme-text-primary">实时</div>
                    <div className="theme-text-muted mt-0.5">新记忆入库时自动检查矛盾与更新</div>
                  </div>
                  <div className="p-2 rounded-lg" style={{background:'rgba(255,255,255,0.03)'}}>
                    <div className="theme-text-muted mb-1">主动提醒</div>
                    <div className="text-lg font-bold theme-text-primary">温和</div>
                    <div className="theme-text-muted mt-0.5">检测到矛盾时在对话中温和提醒用户</div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] theme-text-muted flex items-center gap-1">
                  <Activity className="w-3 h-3" />
                  在有 LLM 可用时自动提取；无 LLM 时使用正则回退，不影响对话响应速度
                </div>
              </div>

              {(stats.notebook?.enhancedFactCount != null && stats.notebook.enhancedFactCount > 0) || (stats.notebook?.enhancedEntityCount != null && stats.notebook.enhancedEntityCount > 0) ? (
                <div className="grid grid-cols-2 gap-4">
                  {stats.notebook?.enhancedFactCount != null && stats.notebook.enhancedFactCount > 0 && (
                    <div className="theme-card p-4">
                      <div className="flex items-center gap-2 theme-text-secondary text-sm mb-2">
                        <Brain className="w-4 h-4" />
                        增强记忆 (事实)
                      </div>
                      <div className="text-2xl font-bold theme-text-primary">
                        {stats.notebook.enhancedFactCount}
                      </div>
                    </div>
                  )}
                  {stats.notebook?.enhancedEntityCount != null && stats.notebook.enhancedEntityCount > 0 && (
                    <div className="theme-card p-4">
                      <div className="flex items-center gap-2 theme-text-secondary text-sm mb-2">
                        <Users className="w-4 h-4" />
                        识别实体
                      </div>
                      <div className="text-2xl font-bold theme-text-primary">
                        {stats.notebook.enhancedEntityCount}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {stats.sessionFiles && stats.sessionFiles.length > 0 && (
                <div className="theme-card p-6">
                  <h3 className="font-medium mb-4 theme-text-primary">会话记录</h3>
                  <div className="space-y-2">
                    {stats.sessionFiles.map((session, i) => (
                      <div key={`${session.id}_${i}`} className="flex items-center justify-between p-3 rounded-lg theme-bg-tertiary">
                        <div className="flex items-center gap-3">
                          <span className="font-medium theme-text-primary">{session.id}</span>
                          <span className="text-sm theme-text-muted">
                            {formatDate(session.createdAt)}
                          </span>
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <span className="theme-text-secondary">{session.messageCount} 条消息</span>
                          <span className="theme-text-muted">{Math.round(session.tokenCount / 1000)}k tokens</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {stats.notebook?.byType && (
                <div className="theme-card p-6">
                  <h3 className="font-medium mb-4 theme-text-primary">记忆类型分布</h3>
                  <div className="grid grid-cols-4 gap-3">
                    {Object.entries(stats.notebook.byType).map(([type, count]) => (
                      <div key={type} className="flex items-center justify-between p-3 rounded-lg theme-bg-tertiary">
                        <span className="text-sm theme-text-secondary">{type}</span>
                        <span className="font-medium theme-text-primary">{count as number}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="theme-card p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-medium theme-text-primary flex items-center gap-2">
                    <Moon className="w-5 h-5 theme-color-info" />
                    记忆整理
                  </h3>
                  <button
                    onClick={handleTriggerDream}
                    disabled={isLoading}
                    className="px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-50"
                    style={{ backgroundColor: 'var(--color-info)' }}
                  >
                    触发整理
                  </button>
                </div>
                <p className="theme-text-secondary text-sm mb-4">
                  记忆整理会自动分析和整合记忆，提取关键信息，优化存储结构。
                </p>
                {dreamResult && (
                  <div className="p-4 rounded-lg theme-bg-tertiary">
                    <div className="text-sm theme-text-secondary mb-2">
                      上次整理: {formatDate(dreamResult.timestamp)}
                    </div>
                    <div className="text-sm theme-text-primary">
                      {dreamResult.consolidated > 0
                        ? `整合了 ${dreamResult.consolidated} 条记忆`
                        : '暂无新记忆需要整合'}
                    </div>
                    {dreamResult.insights?.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {dreamResult.insights.slice(0, 3).map((insight, i) => (
                          <div key={i} className="text-sm theme-text-secondary">
                            • {insight.summary || insight.content}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'notes' && (
        <div className="space-y-4 mt-6">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <h3 className="font-medium theme-text-primary">笔记列表</h3>
              {noteTypes.length > 1 && (
                <div className="flex items-center gap-1">
                  <Filter className="w-3 h-3 theme-text-muted" />
                  <select
                    value={noteFilter}
                    onChange={e => setNoteFilter(e.target.value)}
                    className="text-xs px-2 py-1 rounded theme-bg-tertiary theme-text-primary border-none outline-none"
                  >
                    <option value="all">全部</option>
                    {noteTypes.map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <button
              onClick={() => {
                setNewNote({ title: '', content: '', tags: '', type: 'note' })
                setShowAddNote(true)
              }}
              className="theme-btn theme-btn-primary"
            >
              <Plus className="w-4 h-4" />
              添加笔记
            </button>
          </div>

          {showAddNote && (
            <div className="theme-card p-6">
              <h4 className="font-medium mb-4 theme-text-primary">新笔记</h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">标题</label>
                  <input
                    type="text"
                    value={newNote.title}
                    onChange={(e) => setNewNote(prev => ({ ...prev, title: e.target.value }))}
                    className="theme-input"
                    placeholder="笔记标题"
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">类型</label>
                  <select
                    value={newNote.type}
                    onChange={(e) => setNewNote(prev => ({ ...prev, type: e.target.value }))}
                    className="theme-input"
                  >
                    <option value="note">笔记</option>
                    <option value="fact">事实</option>
                    <option value="preference">偏好</option>
                    <option value="procedure">流程</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">内容</label>
                  <textarea
                    value={newNote.content}
                    onChange={(e) => setNewNote(prev => ({ ...prev, content: e.target.value }))}
                    className="theme-input resize-none"
                    rows={4}
                    placeholder="笔记内容..."
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">标签 (逗号分隔)</label>
                  <input
                    type="text"
                    value={newNote.tags}
                    onChange={(e) => setNewNote(prev => ({ ...prev, tags: e.target.value }))}
                    className="theme-input"
                    placeholder="工作, 重要, 项目"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleAddNote}
                    className="theme-btn theme-btn-primary"
                  >
                    <Check className="w-4 h-4" />
                    保存
                  </button>
                  <button
                    onClick={() => setShowAddNote(false)}
                    className="theme-btn theme-btn-secondary"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {editingNote && (
            <div className="theme-card p-6">
              <h4 className="font-medium mb-4 theme-text-primary">编辑笔记</h4>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">标题</label>
                  <input
                    type="text"
                    value={editingNote.title}
                    onChange={(e) => setEditingNote(prev => prev ? { ...prev, title: e.target.value } : prev)}
                    className="theme-input"
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">内容</label>
                  <textarea
                    value={editingNote.content}
                    onChange={(e) => setEditingNote(prev => prev ? { ...prev, content: e.target.value } : prev)}
                    className="theme-input resize-none"
                    rows={4}
                  />
                </div>
                <div>
                  <label className="block text-sm mb-1 theme-text-secondary">标签 (逗号分隔)</label>
                  <input
                    type="text"
                    value={editingNote.tags?.join(', ') || ''}
                    onChange={(e) => setEditingNote(prev => prev ? {
                      ...prev,
                      tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean)
                    } : prev)}
                    className="theme-input"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    onClick={handleUpdateNote}
                    className="theme-btn theme-btn-primary"
                  >
                    <Check className="w-4 h-4" />
                    保存修改
                  </button>
                  <button
                    onClick={() => setEditingNote(null)}
                    className="theme-btn theme-btn-secondary"
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          )}

          {filteredNotes.length === 0 && !showAddNote ? (
            <div className="text-center py-12 theme-text-muted">
              <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>{noteFilter === 'all' ? '暂无笔记' : `暂无类型为 "${noteFilter}" 的笔记`}</p>
              {debugInfo && <p className="mt-2 text-xs theme-color-error">{debugInfo}</p>}
              <p className="text-sm mt-2">点击上方按钮添加第一条笔记</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredNotes.map(note => (
                <div
                  key={note.id}
                  className="theme-card p-4"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h4 className="font-medium theme-text-primary">{note.title}</h4>
                        {note.type && (
                          <span className={`text-xs px-2 py-0.5 rounded ${
                            note.type === 'session' ? 'theme-color-info-bg theme-color-info' :
                            note.type === 'note' ? 'theme-color-warning-bg theme-color-warning' :
                            note.type === 'fact' ? 'theme-color-success-bg theme-color-success' :
                            note.type === 'preference' ? 'theme-color-warning-bg theme-color-warning' :
                            'theme-bg-tertiary theme-text-muted'
                          }`}>
                            {note.type}
                          </span>
                        )}
                        <TrustBadge score={note.trustScore} />
                      </div>
                      <p className="text-sm theme-text-secondary line-clamp-2">{note.content}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs theme-text-muted">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatDate(note.updated)}
                        </span>
                        {Array.isArray(note.tags) && note.tags.length > 0 && (
                          <div className="flex gap-1">
                            {note.tags.map(tag => (
                              <span key={tag} className="px-1.5 py-0.5 rounded theme-bg-tertiary flex items-center gap-0.5">
                                <Tag className="w-2.5 h-2.5" />
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setEditingNote({ ...note })}
                        className="p-2 theme-text-muted theme-color-info-hover rounded-lg transition-colors"
                        title="编辑笔记"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteNote(note.id)}
                        className="p-2 theme-text-muted theme-color-error-hover rounded-lg transition-colors"
                        title="删除笔记"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'search' && (
        <div className="space-y-4 mt-6">
          <div className="flex gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 theme-text-muted" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="搜索记忆... (输入即自动搜索)"
                className="theme-input pl-10"
              />
              {isSearching && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <RefreshCw className="w-4 h-4 animate-spin theme-text-muted" />
                </div>
              )}
            </div>
            <button
              onClick={handleSearch}
              disabled={isSearching || !searchQuery.trim()}
              className="theme-btn theme-btn-primary"
            >
              搜索
            </button>
          </div>

          {hasSearched && searchResults.length === 0 && !isSearching && (
            <div className="text-center py-12 theme-text-muted">
              <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>未找到相关记忆</p>
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="space-y-3">
              <div className="text-sm theme-text-muted">
                找到 {searchResults.length} 条结果
              </div>
              {searchResults.map((result, i) => (
                <div
                  key={result.id || i}
                  className="theme-card p-4"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h4 className="font-medium theme-text-primary">{result.title || result.content?.slice(0, 40) + '...'}</h4>
                        {result.category && (
                          <span className="text-xs px-2 py-0.5 theme-color-info-bg theme-color-info rounded">
                            {result.category}
                          </span>
                        )}
                        {result.type && (
                          <span className="text-xs px-2 py-0.5 theme-color-warning-bg theme-color-warning rounded">
                            {result.type}
                          </span>
                        )}
                        <TrustBadge score={result.trustScore} />
                      </div>
                      <p className="text-sm theme-text-secondary line-clamp-3">{result.content}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs theme-text-muted">
                        {/* P10 fix: RRF 分数非 0-1 概率，改用千分比展示，注释说明 */}
                        {result.score !== undefined && (
                          <span title="RRF 融合排序分（非概率，范围为实数）">
                            匹配度: {(result.score * 1000).toFixed(0)}‰
                          </span>
                        )}
                        {/* P10 fix: hrrSim 为死代码字段（后端未稳定输出），注释保留待后续确认 */}
                        {/* result.hrrSim !== undefined && (
                          <span>语义相似: {(result.hrrSim * 100).toFixed(1)}%</span>
                        ) */}
                        {/* P10 fix: 后端字段为 updatedAt，兼读 updated 兼容 */}
                        {(result.updatedAt || result.updated) && (
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDate(result.updatedAt || result.updated)}
                          </span>
                        )}
                        {result.entities?.length > 0 && (
                          <div className="flex gap-1">
                            {result.entities.map((entity: string) => (
                              <span key={entity} className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                                {entity}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {/* 2026-08-12 (搜索落地 4a): 加载更多——每次 +20 重拉全量合并去重;结果不足当前 limit 视为已加载完,隐藏按钮 */}
              {searchResults.length >= searchLimit && (
                <button
                  type="button"
                  onClick={() => setSearchLimit(l => l + 20)}
                  disabled={isSearching}
                  className="theme-btn theme-btn-secondary w-full"
                >
                  {isSearching ? '加载中...' : '加载更多'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === 'entities' && (
        <div className="space-y-4 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="font-medium theme-text-primary flex items-center gap-2">
              <Users className="w-5 h-5" />
              实体浏览
            </h3>
            <button
              onClick={loadEntities}
              className="theme-btn theme-btn-secondary text-sm"
            >
              <RefreshCw className="w-3 h-3" />
              刷新
            </button>
          </div>

          {selectedEntity && (
            <div className="theme-card p-6">
              <div className="flex items-center justify-between mb-4">
                <h4 className="font-medium theme-text-primary flex items-center gap-2">
                  <Users className="w-4 h-4 text-indigo-400" />
                  {selectedEntity.name}
                  <span className="text-xs px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded">
                    {selectedEntity.type}
                  </span>
                </h4>
                <button
                  onClick={() => setSelectedEntity(null)}
                  className="p-1 theme-text-muted hover:theme-text-primary rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="text-sm theme-text-secondary mb-3">
                关联 {selectedEntity.factCount} 条记忆
              </div>
              {selectedEntity.facts && selectedEntity.facts.length > 0 ? (
                <div className="space-y-2">
                  {selectedEntity.facts.map((fact, i) => (
                    <div key={fact.id || i} className="p-3 rounded-lg theme-bg-tertiary">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm theme-text-primary flex-1">{fact.content}</p>
                        <TrustBadge score={fact.trustScore} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm theme-text-muted">暂无关联记忆</p>
              )}
            </div>
          )}

          {entities.length === 0 && !selectedEntity ? (
            <div className="text-center py-12 theme-text-muted">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>暂无实体数据</p>
              <p className="text-sm mt-2">实体会在对话过程中自动提取和积累</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {entities.map(entity => (
                <div
                  key={entity.name}
                  className="theme-card p-4 cursor-pointer hover:ring-1 hover:ring-purple-400/30 transition-all"
                  onClick={() => handleProbeEntity(entity.name)}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-medium theme-text-primary">{entity.name}</span>
                    <span className="text-xs px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded">
                      {entity.type}
                    </span>
                  </div>
                  <div className="text-sm theme-text-secondary">
                    {entity.factCount} 条关联记忆
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'graph' && (
        <div className="space-y-4 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="font-medium theme-text-primary flex items-center gap-2">
              <GitBranch className="w-5 h-5 theme-color-info" />
              记忆关系图谱
            </h3>
            <button
              onClick={loadGraph}
              className="theme-btn theme-btn-secondary text-sm"
            >
              <RefreshCw className="w-3 h-3" />
              刷新
            </button>
          </div>

          {graphNodes.length === 0 ? (
            <div className="text-center py-12 theme-text-muted">
              <GitBranch className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>暂无图谱数据</p>
              <p className="text-sm mt-2">图谱会在记忆积累后自动生成</p>
            </div>
          ) : (
            <>
              <div className="theme-card p-6">
                <div className="flex items-center gap-4 mb-4 text-sm">
                  <span className="theme-text-secondary">
                    节点: <strong className="theme-text-primary">{graphNodes.length}</strong>
                  </span>
                  <span className="theme-text-secondary">
                    关系: <strong className="theme-text-primary">{graphEdges.length}</strong>
                  </span>
                </div>
                <div className="mt-3">
                  <MemoryGraph
                    nodes={graphNodes.map(n => ({ id: n.id, label: n.label, type: n.type as 'note' | 'tag' | 'entity' | 'session', importance: (n as { trustScore?: number }).trustScore, count: (n as { size?: number }).size }))}
                    edges={graphEdges.map(e => ({
                      source: ((e as { source?: string; from?: string }).source || (e as { source?: string; from?: string }).from) as string,
                      target: ((e as { target?: string; to?: string }).target || (e as { target?: string; to?: string }).to) as string,
                      weight: (e as { weight?: number }).weight || 1,
                    }))}
                  />
                </div>
                {/*
                <div className="relative" style={{ height: '400px', overflow: 'hidden' }}>
                  <svg width="100%" height="100%" viewBox="0 0 800 400">
                    {graphEdges.map((edge, i) => {
                      const sourceNode = graphNodes.find(n => n.id === edge.source)
                      const targetNode = graphNodes.find(n => n.id === edge.target)
                      if (!sourceNode || !targetNode) return null
                      const sx = (graphNodes.indexOf(sourceNode) % 8) * 100 + 50
                      const sy = Math.floor(graphNodes.indexOf(sourceNode) / 8) * 80 + 40
                      const tx = (graphNodes.indexOf(targetNode) % 8) * 100 + 50
                      const ty = Math.floor(graphNodes.indexOf(targetNode) / 8) * 80 + 40
                      return (
                        <line
                          key={`edge-${i}`}
                          x1={sx} y1={sy} x2={tx} y2={ty}
                          stroke="var(--color-info)"
                          strokeWidth={Math.max(1, edge.weight * 3)}
                          opacity={0.3}
                        />
                      )
                    })}
                    {graphNodes.map((node, i) => {
                      const x = (i % 8) * 100 + 50
                      const y = Math.floor(i / 8) * 80 + 40
                      const nodeColors: Record<string, string> = {
                        entity: '#818cf8',
                        fact: '#34d399',
                        memory: '#a78bfa',
                        user: '#f472b6',
                        project: '#fbbf24',
                      }
                      const color = nodeColors[node.type] || '#94a3b8'
                      return (
                        <g key={node.id}>
                          <circle
                            cx={x} cy={y}
                            r={Math.max(8, Math.min(24, node.size * 4))}
                            fill={color}
                            opacity={0.7}
                          />
                          <text
                            x={x} y={y + Math.max(12, node.size * 4) + 12}
                            textAnchor="middle"
                            fill="var(--text-secondary)"
                            fontSize={10}
                          >
                            {node.label.length > 8 ? node.label.slice(0, 8) + '...' : node.label}
                          </text>
                        </g>
                      )
                    })}
                  </svg>
                </div>
              </div>

              <div className="theme-card p-6">
                <h4 className="font-medium mb-3 theme-text-primary">节点详情</h4>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {graphNodes.map(node => (
                    <div key={node.id} className="flex items-center justify-between p-2 rounded theme-bg-tertiary">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm theme-text-primary">{node.label}</span>
                        <span className="text-xs px-2 py-0.5 rounded theme-color-warning-bg theme-color-warning">{node.type}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <TrustBadge score={node.trustScore} />
                        <span className="text-xs theme-text-muted">连接: {graphEdges.filter(e => e.source === node.id || e.target === node.id).length}</span>
                      </div>
                    </div>
                  ))}
                */}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === 'timeline' && (
        <div className="space-y-4 mt-6">
          <div className="flex justify-between items-center">
            <h3 className="font-medium theme-text-primary flex items-center gap-2">
              <Activity className="w-5 h-5 theme-color-info" />
              记忆时间线
            </h3>
            <div className="flex items-center gap-2">
              <select
                value={timelineFilter}
                onChange={e => setTimelineFilter(e.target.value)}
                className="text-xs px-2 py-1 rounded theme-bg-tertiary theme-text-primary border-none outline-none"
              >
                <option value="all">全部类型</option>
                <option value="fact">事实</option>
                <option value="note">笔记</option>
                <option value="preference">偏好</option>
                <option value="project">项目</option>
                <option value="feedback">反馈</option>
              </select>
              <button
                onClick={loadTimeline}
                className="theme-btn theme-btn-secondary text-sm"
              >
                <RefreshCw className="w-3 h-3" />
                刷新
              </button>
            </div>
          </div>

          {timelineEntries.length === 0 ? (
            <div className="text-center py-12 theme-text-muted">
              <Activity className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>暂无时间线数据</p>
              <p className="text-sm mt-2">记忆会在对话过程中自动积累</p>
            </div>
          ) : (
            <div className="relative pl-8">
              <div className="absolute left-3 top-0 bottom-0 w-0.5" style={{ backgroundColor: 'var(--border-secondary)' }} />
              {(timelineFilter === 'all' ? timelineEntries : timelineEntries.filter(e => e.type === timelineFilter))
                .map((entry, i) => {
                  const typeColors: Record<string, { text: string; bg: string }> = {
                    fact: { text: 'text-green-400', bg: 'bg-green-500' },
                    note: { text: 'text-amber-400', bg: 'bg-amber-500' },
                    preference: { text: 'text-amber-400', bg: 'bg-amber-500' },
                    project: { text: 'text-blue-400', bg: 'bg-blue-500' },
                    feedback: { text: 'text-red-400', bg: 'bg-red-500' },
                    general: { text: 'text-gray-400', bg: 'bg-gray-500' },
                  }
                  const dotColor = typeColors[entry.type] || typeColors.general
                  const date = new Date(entry.timestamp)
                  const isToday = new Date().toDateString() === date.toDateString()
                  return (
                    <div key={entry.id || i} className="relative mb-6">
                      <div className={`absolute -left-5 top-1.5 w-3 h-3 rounded-full ${dotColor.bg} ring-2 ring-purple-500/20`} />
                      <div className="theme-card p-4">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs theme-text-muted">
                            {isToday ? '今天' : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} {date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded ${dotColor.bg}/20 text-white`}>
                            {entry.type}
                          </span>
                          {entry.category && (
                            <span className="text-xs px-2 py-0.5 theme-color-info-bg theme-color-info rounded">
                              {entry.category}
                            </span>
                          )}
                          <TrustBadge score={entry.trustScore} />
                        </div>
                        <p className="text-sm theme-text-primary">{entry.content}</p>
                        {entry.entities && entry.entities.length > 0 && (
                          <div className="flex gap-1 mt-2">
                            {entry.entities.map(entity => (
                              <span key={entity} className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300">
                                {entity}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
            </div>
          )}
        </div>
      )}

      {activeTab === 'evolution' && (
        <MemoryEvolution
          evolutionStatus={evolutionStatus}
          evolutionProfile={evolutionProfile}
          loadingEvolution={loadingEvolution}
          evolving={evolving}
          onTriggerEvolution={handleTriggerEvolution}
        />
      )}

      {activeTab === 'snapshot' && (
        <MemorySnapshot
          usage={snapshotUsage}
          agentEntries={snapshotAgent}
          userEntries={snapshotUser}
          onAdd={handleAddSnapshotEntry}
          onRemove={handleRemoveSnapshotEntry}
        />
      )}

      {/* ─── Soul/IDENTITY 人格编辑 ─── */}
      {activeTab === 'soul' && (
        <MemorySoul
          content={identityContent}
          saving={identitySaving}
          onChange={handleIdentityChange}
          onSave={saveIdentity}
        />
      )}

      {/* P6 fix: 快照删除确认对话框（复用 ConfirmDialog） */}
      <ConfirmDialog
        open={snapshotDeleteConfirm !== null}
        title="确认删除快照记忆"
        message={`确定要删除该 ${snapshotDeleteConfirm?.type === 'agent' ? 'Agent' : 'User'} 记忆条目吗？此操作不可撤销。`}
        confirmLabel="确认删除"
        onCancel={() => setSnapshotDeleteConfirm(null)}
        onConfirm={handleRemoveSnapshotEntryConfirm}
      />
    </div>
  )
}
