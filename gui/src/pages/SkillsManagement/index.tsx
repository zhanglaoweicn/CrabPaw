import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, Package, Bot, Download, Globe, Star, ToggleLeft, ToggleRight,
  RefreshCw, X, ExternalLink, GitBranch,
  Upload, AlertTriangle, Clock, CheckCircle, XCircle,
  Filter,
} from 'lucide-react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiDelete, apiUpload } from '../../lib/api'

interface SkillLifecycle {
  usageCount: number
  successCount: number
  qualityScore: number
  lastUsedAt: number | null
  status: 'active' | 'archived'
}

interface SkillDependencies {
  hasDependencies: boolean
  pipDeps: string[]
  npmDeps: string[]
  binDeps: string[]
  pipInstalled: boolean
  pipMissing: string[]
  portableDir: string
  installable: boolean
}

interface SkillFile {
  path: string
  size: number
  type: string
}

interface Skill {
  id: string
  name: string
  description: string
  version: string
  enabled: boolean
  available?: boolean
  missingDeps?: string[]
  source: 'builtin' | 'auto_generated' | 'imported' | 'global' | 'flow'
  /** 2026-08-26 S1: 有执行器(LLM 可调 SkillExecute 真正产出) vs 纯知识型(LLM 按 SKILL.md 直接产出) */
  hasExecutor?: boolean
  author?: string
  displayName?: string
  category?: string
  priority?: number
  lifecycle?: SkillLifecycle | null
  dependencies?: SkillDependencies
  files?: SkillFile[]
  deprecated?: boolean
  deprecatedMessage?: string
  tags?: string[]
}

interface LifecycleStats {
  total: number
  active: number
  archived: number
  bySource: { builtin: number; auto_generated: number; imported: number }
}

interface MarketSkill {
  name: string
  slug: string
  category?: string
  description?: string
  author?: string
  downloads?: number
  rating?: number
  tags?: string[]
  source?: string
  installed?: boolean
  /** 2026-08-26 审计 S3: GitHub 项带 repo 名——无 slug 时引导"复制仓库名"走高级导入 */
  repo?: string
  url?: string
}

const SOURCE_LABELS: Record<string, { label: string; icon: any; color: string }> = {
  builtin: { label: '内置', icon: Package, color: 'text-blue-500' },
  auto_generated: { label: '自生成', icon: Bot, color: 'text-purple-500' },
  imported: { label: '导入', icon: Download, color: 'text-green-500' },
  global: { label: '全局', icon: Globe, color: 'text-cyan-500' },
  flow: { label: '工作流', icon: GitBranch, color: 'text-orange-500' },
}

const STATUS_LABELS: Record<string, { label: string; icon: any; color: string }> = {
  active: { label: '活跃', icon: CheckCircle, color: 'text-green-500' },
  stale: { label: '陈旧', icon: Clock, color: 'text-yellow-500' },
  archived: { label: '已归档', icon: XCircle, color: 'text-gray-500' },
}


export function SkillsManagement({ initialKeyword = '' }: { initialKeyword?: string }) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [lifecycleStats, setLifecycleStats] = useState<LifecycleStats | null>(null)
  // 2026-08-26 审计 S2: 加载失败态——"暂无技能"只留给真空数据
  const [loadError, setLoadError] = useState('')
  // 2026-08-27 全局搜索: 挂载时以 initialKeyword 初始化过滤输入(仅初值, 后续用户自改)
  const [searchQuery, setSearchQuery] = useState(initialKeyword)
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(true) // 2026-08-26 A4: 初始 loading, 防「暂无技能」一闪
  const [isImporting, setIsImporting] = useState(false)
  const [importMode, setImportMode] = useState<'gh' | 'zip'>('gh')
  const [ghRepo, setGhRepo] = useState('')
  // 2026-08-26: 能力商店——搜索市场技能(后端 /skills/market/search 已就绪, 前端仅缺 UI)
  const [marketQuery, setMarketQuery] = useState('')
  const [marketResults, setMarketResults] = useState<MarketSkill[] | null>(null)
  const [marketSearching, setMarketSearching] = useState(false)
  const [marketInstalling, setMarketInstalling] = useState<string | null>(null)
  const [marketError, setMarketError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [installingDeps, setInstallingDeps] = useState<string | null>(null)
  const [showConfirmDelete, setShowConfirmDelete] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)

  const loadSkills = useCallback(async (isManual = false) => {
    if (isManual) setIsRefreshing(true)
    try {
      const result = await apiGet('/skills')
      if (!mountedRef.current) return
      // 2026-08-26 审计 S2: 接口失败不得伪装成"暂无技能"——apiGet 对 500/404 返回
      // {success:false} 不抛异常, 此前静默进入空态误导用户。加失败分支+重试。
      if (result.success && result.data) {
        setLoadError('')
        const skillsList = (result.data.skills || []).map((s: any) => ({
          ...s,
          version: s.version || '1.0.0',
          source: s.source || 'global',
          lifecycle: s.lifecycle || null,
        }))
        const seen = new Set<string>()
        setSkills(skillsList.filter((s: Skill) => {
          if (seen.has(s.id)) return false
          seen.add(s.id)
          return true
        }))
        if (result.data.lifecycleStats) {
          setLifecycleStats(result.data.lifecycleStats)
        }
        // 2026-08-27 实机反馈: 后端 manifestValid/manifestProblems 校验字段保留(审计/开发者面),
        // 但前端不再渲染「技能清单异常」横幅——技能目录动态增长 vs manifest 声明必然漂移, 属内部噪音。
      } else if (!result.success) {
        setLoadError((result.error || '加载失败').slice(0, 120))
      }
    } catch (e: any) {
      setLoadError('加载失败: ' + (e?.message || '网络错误'))
      if (isManual) toast.error('加载失败: ' + (e.message || '未知错误'))
    } finally {
      if (mountedRef.current) setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    loadSkills()
    return () => { mountedRef.current = false }
  }, [loadSkills])

  const handleToggleSkill = async (id: string) => {
    const skill = skills.find(s => s.id === id)
    if (!skill) return
    // 2026-08-26 审计 S1: 内置技能禁用是假动作——后端对 source==='builtin' 恒返回
    // enabled:true(禁用写入 disabled-skills.json 但列表硬编码忽略)。改用与删除同款
    // 守卫: 内置锁定位, 明确提示而非"点了成功刷新回退"的假反馈。
    if (skill.source === 'builtin') {
      toast.info('内置技能随系统发布，无需禁用（导入的技能可启停）')
      return
    }
    try {
      await apiPost('/skills/' + id, { enabled: !skill.enabled }, 'PATCH')
      setSkills(prev => prev.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s))
      toast.success(skill.enabled ? '已禁用' : '已启用')
    } catch (e: any) {
      toast.error('操作失败: ' + (e.message || '未知错误'))
    }
  }

  const handleDeleteSkill = async (id: string) => {
    const skill = skills.find(s => s.id === id)
    if (!skill) return
    if (skill.source === 'builtin') { toast.error('内置技能无法删除'); return }
    try {
      const res = await apiDelete('/skills/' + id)
      // P7(GUI 全量修复): 查 result.success
      if (!res.success) { toast.error(res.error || '卸载失败'); return }
      setSkills(prev => prev.filter(s => s.id !== id))
      setSelectedSkill(null); setShowConfirmDelete(null)
      toast.success('技能已卸载')
    } catch (e: any) {
      toast.error('卸载失败: ' + (e.message || '未知错误'))
    }
  }

  const handleInstallDeps = async (id: string) => {
    setInstallingDeps(id)
    try {
      const result = await apiPost('/skills/install-deps', { skillId: id })
      if (result.success) { toast.success(result.data?.message || '依赖安装成功'); loadSkills(true) }
      else { toast.error(result.error || '依赖安装失败') }
    } catch (e: any) { toast.error('安装依赖失败: ' + (e.message || '未知错误')) }
    finally { setInstallingDeps(null) }
  }

  const handleGitHubImport = async () => {
    if (!ghRepo.trim()) { toast.error('请输入 GitHub 仓库地址'); return }
    // 2026-08-14 审计 M7: 移除每 400ms 合成 +15% 的假进度(后端 install 为阻塞请求,
    // 无真实进度信号)——改为确定性"运行中"状态,不伪造百分比。
    setIsImporting(true)
    try {
      const result = await apiPost('/skills/market/install', { source: 'github', repo: ghRepo.trim() })
      if (result.success) { toast.success('导入成功'); setGhRepo(''); loadSkills(true) }
      else { toast.error(result.error || '导入失败') }
    } catch (e: any) { toast.error('导入失败: ' + (e.message || '未知错误')) }
    finally { setIsImporting(false) }
  }

  // 2026-08-26: 能力商店——搜索市场技能
  const handleMarketSearch = useCallback(async () => {
    const q = marketQuery.trim()
    if (!q) { setMarketResults(null); return }
    setMarketSearching(true)
    setMarketError('')
    try {
      const res = await apiGet<{ skills?: MarketSkill[]; total?: number }>(`/skills/market/search?q=${encodeURIComponent(q)}&limit=20`)
      if (res?.success && res.data) {
        setMarketResults(res.data.skills || [])
      } else {
        setMarketResults([])
        setMarketError('搜索失败，请稍后再试')
      }
    } catch (e: any) {
      setMarketResults([])
      setMarketError('搜索失败: ' + (e?.message || '网络错误'))
    } finally { setMarketSearching(false) }
  }, [marketQuery])

  const handleMarketInstall = async (item: MarketSkill) => {
    if (item.installed || item.source === 'local') {
      toast.info('该技能已安装')
      return
    }
    // 2026-08-26: 远端条目 slug 可能缺失(GitHub topics 名称含空格/连字符)——用 name 兜底
    if (!item.slug) {
      toast.error('该技能暂不支持一键安装（缺少标识），可用下方高级导入')
      return
    }
    setMarketInstalling(item.slug)
    try {
      // 2026-08-26 审计 S3: 按来源分流——GitHub 项走 github 安装(owner/repo),
      // ClawHub/registry 项走 remote(需 CRABPAW_SKILL_REGISTRY 配置)
      const payload = item.source === 'github'
        ? { source: 'github', repo: item.slug }
        : { source: 'remote', skillSlug: item.slug }
      const res = await apiPost<{ success?: boolean }>('/skills/market/install', payload)
      if (res?.success) {
        toast.success(item.slug + ' 安装成功')
        setMarketResults(prev => prev ? prev.map(s => s.slug === item.slug ? { ...s, installed: true } : s) : prev)
        loadSkills(true)
      } else {
        toast.error(res?.error || '安装失败——若提示未配置注册表，请用下方 ZIP/Tab 方式导入技能包')
      }
    } catch (e: any) {
      toast.error('安装失败: ' + (e?.message || '未知错误'))
    } finally { setMarketInstalling(null) }
  }

  const handleZipUpload = async (file: File) => {
    toast.info('正在导入 ' + file.name + '...')
    try {
      const formData = new FormData(); formData.append('file', file)
      const result = await apiUpload('/skills/install/zip', formData)
      if (result.success) { toast.success('已导入 ' + file.name); loadSkills(true) }
      else { toast.error(result.error || '导入失败') }
    } catch (e: any) { toast.error('导入失败: ' + (e.message || '未知错误')) }
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const files = e.dataTransfer.files
    if (files.length > 0 && files[0].name.endsWith('.zip')) { handleZipUpload(files[0]) }
    else { toast.error('仅支持 .zip 文件') }
  }, [])

  const getStatus = (skill: Skill): string => {
    if (skill.lifecycle?.status === 'archived') return 'archived'
    if (!skill.enabled) return 'stale'
    return skill.lifecycle?.usageCount && skill.lifecycle.usageCount > 0 ? 'active' : 'stale'
  }

  const renderStars = (score: number) =>
    Array.from({ length: 5 }, (_, i) => (
      <Star key={i} className={'w-3.5 h-3.5 ' + (i < Math.round((score || 0) * 5) ? 'text-yellow-500 fill-yellow-500' : 'text-gray-600')} />
    ))

  const filteredSkills = skills.filter(s => {
    if (sourceFilter !== 'all' && s.source !== sourceFilter) return false
    if (statusFilter !== 'all' && getStatus(s) !== statusFilter) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) ||
        (s.displayName && s.displayName.toLowerCase().includes(q)) ||
        (s.tags && s.tags.some(t => t.toLowerCase().includes(q)))
    }
    return true
  })



  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between p-4' style={{ borderBottom: '1px solid var(--border-primary)' }}>
        <div className='flex items-center gap-3'>
          <div className='w-8 h-8 rounded-lg flex items-center justify-center' style={{ backgroundColor: 'var(--accent-muted)' }}>
            <Package className='w-4 h-4 theme-accent' />
          </div>
          <div>
            <h2 className='text-lg font-bold theme-text-primary'>技能管理</h2>
            <p className='text-xs theme-text-muted'>{lifecycleStats ? (lifecycleStats.active + ' 活跃 / ' + lifecycleStats.total + ' 总计') : '加载中...'}</p>
            <p className='text-xs theme-text-secondary mt-0.5'>技能是智能体按需调用的能力：带「可执行」标记的会直接产出结果（图表/文档/表格），其余按 SKILL.md 知识作答。你说的话命中技能描述里的触发场景时，它就会自动生效。</p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          {lifecycleStats && (
            <div className='hidden sm:flex items-center gap-1 px-2 py-1 rounded text-xs theme-bg-tertiary theme-text-muted'>
              <span>内置 {lifecycleStats.bySource?.builtin || 0}</span>
              <span className='mx-1'>·</span>
              <span>自生成 {lifecycleStats.bySource?.auto_generated || 0}</span>
              <span className='mx-1'>·</span>
              <span>导入 {lifecycleStats.bySource?.imported || 0}</span>
            </div>
          )}
          <button onClick={() => loadSkills(true)} disabled={isRefreshing}
            className='p-2 rounded-lg theme-bg-tertiary theme-text-secondary hover:theme-bg-hover transition-colors' title='刷新' aria-label='刷新技能列表'>
            <RefreshCw className={'w-4 h-4' + (isRefreshing ? ' animate-spin' : '')} />
          </button>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className='px-4 py-3 flex items-center gap-3 flex-wrap' style={{ borderBottom: '1px solid var(--border-primary)' }}>
        <div className='flex-1 min-w-[160px] relative'>
          <Search className='absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 theme-text-muted' aria-hidden='true' />
          <input
            type='text' value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
            placeholder='搜索技能名称、描述或标签...'
            className='w-full pl-10 pr-4 py-2 rounded-lg theme-input text-sm'
            aria-label='搜索技能'
          />
        </div>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          className='px-3 py-2 rounded-lg theme-input text-sm' aria-label='按来源筛选'>
          <option value='all'>全部来源</option>
          <option value='builtin'>内置</option>
          <option value='auto_generated'>自生成</option>
          <option value='imported'>导入</option>
          <option value='global'>全局</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          className='px-3 py-2 rounded-lg theme-input text-sm' aria-label='按状态筛选'>
          <option value='all'>全部状态</option>
          <option value='active'>活跃</option>
          <option value='stale'>已禁用</option>
          <option value='archived'>已归档</option>
        </select>
      </div>

      {/* Skill List */}
      <div className='flex-1 min-h-0 overflow-y-auto p-4'>
        {loadError ? (
          <div className='text-center py-16'>
            <AlertTriangle className='w-10 h-10 mx-auto mb-3 opacity-40 theme-text-muted' />
            <p className='text-sm theme-text-secondary'>加载失败</p>
            <p className='text-xs mt-1 theme-text-muted'>{loadError}</p>
            <button onClick={() => loadSkills(true)} className='mt-3 text-xs theme-accent hover:underline'>重试</button>
          </div>
        ) : skills.length === 0 && !isRefreshing ? (
          <div className='text-center py-16 theme-text-muted'>
            <Package className='w-12 h-12 mx-auto mb-3 opacity-30' />
            <p>暂无技能</p>
            <p className='text-xs mt-1'>使用下方导入功能安装技能</p>
          </div>
        ) : (
          <div className='space-y-2'>
            {filteredSkills.length === 0 && skills.length > 0 ? (
              <div className='text-center py-12 theme-text-muted'>
                <Filter className='w-10 h-10 mx-auto mb-2 opacity-30' />
                <p>没有匹配的技能</p>
                <button onClick={() => { setSearchQuery(''); setSourceFilter('all'); setStatusFilter('all') }}
                  className='text-xs mt-1 theme-accent hover:underline'>清除筛选</button>
              </div>
            ) : (
              filteredSkills.map(skill => {
                const sourceInfo = SOURCE_LABELS[skill.source] || SOURCE_LABELS.global
                const SourceIcon = sourceInfo.icon
                const status = getStatus(skill)
                const statusInfo = STATUS_LABELS[status] || STATUS_LABELS.stale
                const StatusIcon = statusInfo.icon
                const isSelected = selectedSkill?.id === skill.id

                return (
                  <div key={skill.id}
                    role='listitem'
                    tabIndex={0}
                    aria-label={`${skill.name}, ${skill.description || ''}, ${statusInfo.label}`}
                    onKeyDown={e => { if (e.key === 'Enter') setSelectedSkill(isSelected ? null : skill) }}
                    onClick={() => setSelectedSkill(isSelected ? null : skill)}
                    className={`theme-card p-3 cursor-pointer transition-all hover:shadow-sm hover:brightness-105 flex items-start gap-3 ${isSelected ? 'ring-1 ring-orange-500/50 border-orange-500/30' : 'hover:theme-border'}`}>
                    {/* Icon */}
                    <div className='flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center theme-bg-tertiary'>
                      <SourceIcon className={`w-4 h-4 ${sourceInfo.color}`} />
                    </div>
                    {/* Content */}
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center gap-2 flex-wrap'>
                        <span className='text-sm font-medium theme-text-primary truncate'>{skill.displayName || skill.name}</span>
                        {skill.version && <span className='text-[10px] theme-text-muted'>v{skill.version}</span>}
                        <span className={`px-1.5 py-0.5 text-[10px] rounded ${sourceInfo.color.replace('text', 'text').replace('500', '500/20')} bg-${sourceInfo.color.replace('text-', '')}/10`}
                          style={{ backgroundColor: sourceInfo.color === 'text-blue-500' ? 'rgba(59,130,246,0.15)' : sourceInfo.color === 'text-purple-500' ? 'rgba(168,85,247,0.15)' : sourceInfo.color === 'text-green-500' ? 'rgba(34,197,94,0.15)' : sourceInfo.color === 'text-cyan-500' ? 'rgba(6,182,212,0.15)' : 'rgba(249,115,22,0.15)' }}>
                          {sourceInfo.label}
                        </span>
                        {skill.hasExecutor && <span className='px-1.5 py-0.5 text-[10px] rounded bg-sky-500/15 text-sky-400' title='有执行器：需要产出时可直接调用执行'>可执行</span>}
                        {skill.deprecated && <span className='px-1.5 py-0.5 text-[10px] rounded bg-red-500/15 text-red-400'>已弃用</span>}
                        {skill.missingDeps && skill.missingDeps.length > 0 && (
                          <span className='px-1.5 py-0.5 text-[10px] rounded bg-yellow-500/15 text-yellow-400 flex items-center gap-1'>
                            <AlertTriangle className='w-3 h-3' /> 缺依赖
                          </span>
                        )}
                      </div>
                      {skill.description && <p className='text-xs theme-text-muted mt-0.5 line-clamp-1'>{skill.description}</p>}
                      {skill.tags && skill.tags.length > 0 && (
                        <div className='flex flex-wrap gap-1 mt-1'>
                          {skill.tags.slice(0, 4).map(tag => (
                            <span key={tag} className='px-1 py-0.5 text-[10px] rounded theme-bg-tertiary theme-text-muted'>{tag}</span>
                          ))}
                          {skill.tags.length > 4 && <span className='text-[10px] theme-text-muted'>+{skill.tags.length - 4}</span>}
                        </div>
                      )}
                      <div className='flex items-center gap-3 mt-1.5 text-[10px] theme-text-muted'>
                        <span className='flex items-center gap-1'><StatusIcon className={`w-3 h-3 ${statusInfo.color}`} />{statusInfo.label}</span>
                        {skill.lifecycle && (skill.lifecycle.usageCount || 0) > 0
                          ? <span>使用 {skill.lifecycle.usageCount} 次</span>
                          : <span>从未使用</span>}
                        {skill.lifecycle?.qualityScore != null && (
                          <span className='flex items-center gap-0.5'>{renderStars(skill.lifecycle.qualityScore)}</span>
                        )}
                      </div>
                    </div>
                    {/* Action Buttons */}
                    <div className='flex items-center gap-1 flex-shrink-0' onClick={e => e.stopPropagation()}>
                      {skill.missingDeps && skill.missingDeps.length > 0 && (
                        <button onClick={() => handleInstallDeps(skill.id)} disabled={installingDeps === skill.id}
                          className='p-1.5 rounded-lg hover:theme-bg-hover text-yellow-500 transition-colors' title='安装依赖' aria-label={`安装 ${skill.name} 的依赖`}>
                          {installingDeps === skill.id ? <RefreshCw className='w-3.5 h-3.5 animate-spin' /> : <Download className='w-3.5 h-3.5' />}
                        </button>
                      )}
                      <button onClick={() => handleToggleSkill(skill.id)}
                        className='p-1.5 rounded-lg hover:theme-bg-hover transition-colors'
                        title={skill.enabled ? '禁用' : '启用'} aria-label={skill.enabled ? `禁用 ${skill.name}` : `启用 ${skill.name}`}>
                        {skill.enabled ? <ToggleRight className='w-3.5 h-3.5 theme-color-success' /> : <ToggleLeft className='w-3.5 h-3.5 theme-text-muted' />}
                      </button>
                      {skill.source !== 'builtin' && (
                        <button onClick={() => setShowConfirmDelete(skill.id)}
                          className='p-1.5 rounded-lg hover:theme-bg-hover text-red-400 transition-colors'
                          title='删除' aria-label={`删除 ${skill.name}`}>
                          <X className='w-3.5 h-3.5' />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Detail Panel (selected skill) */}
      {selectedSkill && (
        <div className='p-4' style={{ borderTop: '1px solid var(--border-primary)' }}>
          <div className='theme-card p-4'>
            <div className='flex items-center justify-between mb-3'>
              <h3 className='text-sm font-bold theme-text-primary'>{selectedSkill.displayName || selectedSkill.name}</h3>
              <button onClick={() => setSelectedSkill(null)} className='p-1 rounded-lg hover:theme-bg-hover' aria-label='关闭详情'>
                <X className='w-4 h-4 theme-text-muted' />
              </button>
            </div>
            {selectedSkill.description && <p className='text-xs theme-text-secondary mb-2'>{selectedSkill.description}</p>}
            <div className='grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs'>
              <div className='p-2 rounded theme-bg-tertiary'><span className='theme-text-muted'>版本</span><p className='theme-text-primary'>{selectedSkill.version || '1.0.0'}</p></div>
              <div className='p-2 rounded theme-bg-tertiary'><span className='theme-text-muted'>来源</span><p className='theme-text-primary'>{(SOURCE_LABELS[selectedSkill.source] || {}).label || selectedSkill.source}</p></div>
              <div className='p-2 rounded theme-bg-tertiary'><span className='theme-text-muted'>状态</span><p className='theme-text-primary'>{selectedSkill.enabled ? '已启用' : '已禁用'}</p></div>
              <div className='p-2 rounded theme-bg-tertiary'><span className='theme-text-muted'>质量</span><p className='theme-text-primary'>{(selectedSkill.lifecycle?.qualityScore || 0).toFixed(1)}</p></div>
            </div>
            {selectedSkill.lifecycle && (
              <div className='mt-2 grid grid-cols-3 gap-2 text-xs'>
                <div className='p-2 rounded theme-bg-tertiary'><span className='theme-text-muted'>使用次数</span><p className='theme-text-primary'>{selectedSkill.lifecycle.usageCount || 0}</p></div>
                <div className='p-2 rounded theme-bg-tertiary'><span className='theme-text-muted'>成功率</span><p className='theme-text-primary'>{((selectedSkill.lifecycle.successCount / Math.max(1, selectedSkill.lifecycle.usageCount || 1)) * 100).toFixed(0)}%</p></div>
                <div className='p-2 rounded theme-bg-tertiary'><span className='theme-text-muted'>最后使用</span><p className='theme-text-primary'>{selectedSkill.lifecycle.lastUsedAt ? new Date(selectedSkill.lifecycle.lastUsedAt).toLocaleDateString('zh-CN') : '从未'}</p></div>
              </div>
            )}
            {selectedSkill.dependencies?.hasDependencies && (
              <div className='mt-2 p-2 rounded theme-bg-tertiary text-xs'>
                <p className='theme-text-secondary mb-1 font-medium'>依赖</p>
                {selectedSkill.dependencies.pipDeps.length > 0 && <p className='theme-text-muted'>pip: {selectedSkill.dependencies.pipDeps.join(', ')}</p>}
                {selectedSkill.dependencies.npmDeps.length > 0 && <p className='theme-text-muted'>npm: {selectedSkill.dependencies.npmDeps.join(', ')}</p>}
              </div>
            )}
            {selectedSkill.deprecated && selectedSkill.deprecatedMessage && (
              <div className='mt-2 flex items-center gap-2 p-2 rounded bg-red-500/10 text-xs text-red-400'>
                <AlertTriangle className='w-3.5 h-3.5' />{selectedSkill.deprecatedMessage}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 能力商店——搜索市场(主入口) + 高级导入(GitHub/ZIP)；2026-08-27 实机反馈: 常驻占高挤压列表, 改默认收起(列表优先) */}
      <details className='text-xs' style={{ borderTop: '1px solid var(--border-primary)' }}>
        <summary className='p-4 cursor-pointer theme-text-secondary hover:theme-text-primary select-none'>能力商店（搜索/安装技能）</summary>
        <div className='px-4 pb-4'>
          <div className='theme-card p-4'>
            <div className='flex items-center gap-2 mb-3'>
            <Upload className='w-4 h-4 theme-accent' />
            <h3 className='text-sm font-medium theme-text-primary'>能力商店</h3>
            <span className='text-xs theme-text-muted'>搜索并安装更多技能：对话中命中描述即会自动调用</span>
          </div>
          <div className='flex gap-2 mb-3'>
            <input
              type='text' value={marketQuery} onChange={(e) => setMarketQuery(e.target.value)}
              placeholder='搜索技能。例如：ppt / excel / 报告 / 图表'
              className='flex-1 px-3 py-2 rounded-lg theme-bg-input theme-text-primary text-sm border border-transparent focus:border-orange-500/50 outline-none'
              onKeyDown={(e) => e.key === 'Enter' && handleMarketSearch()}
            />
            <button onClick={handleMarketSearch} disabled={marketSearching || !marketQuery.trim()}
              className='px-4 py-2 theme-accent-bg text-white rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 text-sm flex items-center gap-2'>
              {marketSearching ? <RefreshCw className='w-4 h-4 animate-spin' /> : <Search className='w-4 h-4' />}
              搜索
            </button>
          </div>
          {marketError && <p className='text-xs text-red-400 mb-2'>{marketError}</p>}
          {marketResults && marketResults.length === 0 && !marketSearching && (
            <p className='text-xs theme-text-muted mb-2'>未找到匹配技能，试试换个关键词，或用下方高级导入</p>
          )}
          {marketResults && marketResults.length > 0 && (
            <div className='space-y-1.5 mb-3 max-h-48 overflow-y-auto'>
              {marketResults.map((item) => (
                <div key={item.slug} className='flex items-center justify-between gap-2 p-2 rounded-lg theme-bg-tertiary'>
                  <div className='min-w-0'>
                    <div className='flex items-center gap-2'>
                      <span className='text-xs font-medium theme-text-primary truncate'>{item.name}</span>
                      <span className='text-[10px] theme-text-muted'>{item.category || ''}</span>
                      <span className='text-[10px] theme-text-muted'>{item.author ? '· ' + item.author : ''}</span>
                    </div>
                    {item.description && <p className='text-[11px] theme-text-muted truncate'>{item.description}</p>}
                  </div>
                  <button
                    onClick={() => handleMarketInstall(item)}
                    disabled={item.installed || marketInstalling === item.slug}
                    className={'px-2 py-1 rounded text-[11px] flex-shrink-0 ' + (item.installed ? 'theme-bg-active theme-text-muted' : 'theme-bg-tertiary hover:theme-bg-hover theme-text-primary')}>
                    {item.installed ? '已安装' : marketInstalling === item.slug ? '安装中…' : '安装'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* 高级导入（开发者/外平台技能包） */}
          <details className='text-xs'>
            <summary className='cursor-pointer theme-text-muted hover:theme-text-primary'>高级导入（ GitHub / ZIP技能包）</summary>
            <div className='mt-2 space-y-2'>
              <div className='flex gap-2'>
                <button onClick={() => setImportMode('gh')}
                  className={'px-3 py-1.5 rounded-lg text-[11px] transition-colors ' + (importMode === 'gh' ? 'theme-accent-bg text-white' : 'theme-bg-tertiary theme-text-secondary')}>
                  GitHub
                </button>
                <button onClick={() => setImportMode('zip')}
                  className={'px-3 py-1.5 rounded-lg text-[11px] transition-colors ' + (importMode === 'zip' ? 'theme-accent-bg text-white' : 'theme-bg-tertiary theme-text-secondary')}>
                  ZIP 文件
                </button>
              </div>
              {importMode === 'gh' ? (
                <div className='flex gap-2'>
                  <input type='text' value={ghRepo} onChange={(e) => setGhRepo(e.target.value)}
                    placeholder='owner/repo 格式的 GitHub 仓库'
                    className='flex-1 px-3 py-2 rounded-lg theme-bg-input theme-text-primary text-xs border border-transparent focus:border-orange-500/50 outline-none'
                    onKeyDown={(e) => e.key === 'Enter' && handleGitHubImport()} />
                  <button onClick={handleGitHubImport} disabled={isImporting || !ghRepo.trim()}
                    className='px-3 py-2 theme-accent-bg text-white rounded-lg hover:opacity-90 transition-colors disabled:opacity-50 text-xs flex items-center gap-1'>
                    {isImporting ? <RefreshCw className='w-3 h-3 animate-spin' /> : <ExternalLink className='w-3 h-3' />}
                    导入
                  </button>
                </div>
              ) : (
                <div onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop} onClick={() => fileInputRef.current?.click()}
                  className={'border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ' + (dragOver ? 'border-orange-500 bg-orange-500/5' : 'border-gray-600 hover:border-gray-500')}>
                  <Upload className='w-6 h-6 mx-auto mb-1 theme-text-muted' />
                  <p className='text-xs theme-text-secondary'>拖放 .zip 文件到此，或点击选择</p>
                  <input ref={fileInputRef} type='file' accept='.zip' className='hidden'
                    onChange={(e) => { const file = e.target.files?.[0]; if (file) handleZipUpload(file); }} />
                </div>
              )}
            </div>
          </details>
          {isImporting && (
            <div className='mt-3 flex items-center gap-2'>
              <RefreshCw className='w-4 h-4 animate-spin theme-text-secondary' />
              <p className='text-xs theme-text-muted'>正在导入 GitHub 仓库，请稍候…</p>
            </div>
          )}
          </div>
        </div>
      </details>

      {/* Delete Confirmation Modal */}
      {showConfirmDelete && (
        <div className='fixed inset-0 bg-black/50 flex items-center justify-center z-50' role='dialog' aria-modal='true'
          onClick={e => { if (e.target === e.currentTarget) setShowConfirmDelete(null) }}>
          <div className='theme-card w-full max-w-sm p-6'>
            <div className='flex items-center gap-3 mb-4'>
              <div className='w-10 h-10 rounded-full bg-red-500/15 flex items-center justify-center'>
                <AlertTriangle className='w-5 h-5 text-red-500' />
              </div>
              <h3 className='font-bold theme-text-primary'>确认删除</h3>
            </div>
            <p className='text-sm theme-text-secondary mb-2'>确定要卸载此技能吗？此操作不可撤销。</p>
            {(() => {
              const sk = skills.find(s => s.id === showConfirmDelete)
              return sk ? <div className='p-2 rounded theme-bg-tertiary mb-4'><p className='text-sm theme-text-primary'>{sk.name}</p></div> : null
            })()}
            <div className='flex justify-end gap-3'>
              <button onClick={() => setShowConfirmDelete(null)}
                className='px-4 py-2 theme-text-secondary hover:theme-text-primary transition-colors rounded-lg'>取消</button>
              <button onClick={() => handleDeleteSkill(showConfirmDelete)}
                className='px-6 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors'>确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
