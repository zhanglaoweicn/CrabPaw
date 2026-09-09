/**
 * KnowledgePanel — 知识库面板（2026-08-20 DeepTutor 精华落地的前端承载）
 *
 * 语音/文本「打开知识库」→ 弹出知识库卡片，三 tab 自服务：
 *   - 检索：输入检索词 → GET /api/kb/search（混合检索 FTS+向量+实体图 RRF 融合，
 *     与 LLM 侧 KbSearch 工具同一 handler，口径一致）；结果带溯源（文档标题/文件路径）。
 *   - 文档：GET /api/kb/list 文档清单（清单≠检索证据——面板只看"有什么"，
 *     内容引用仍由 KbSearch 文本回答）。
 *   - 复习：GET /api/kb/due 到期实体 + POST /api/kb/review（SRS 间隔重复
 *     memory 0/1/3/7/14/30/60 天——答对提升等级、答错降级，连续答对跳级）。
 *
 * 架构：SchedulePanel 宿主骨架（useSceneClient('kb-panel') + dismissed +
 * registerCommandHost('knowledgePanel') → window.__knowledgePanel + 可见性广播
 * + close 三件套）。弹卡守卫：KbSearch 保持纯文本工具，面板仅显式打开。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSceneClient } from '../../lib/scene-client'
import { SideSheet } from '../SideSheet'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { apiGet, apiPost } from '../../lib/api'
import { toast } from 'sonner'
import './styles.css'

export interface KbSearchResult {
  id: string
  kind: string
  title: string
  snippet: string
  score: number
  documentId: string | null
  source: string
  sourcePath: string | null
}

export interface KbDoc {
  id: string
  title: string
  updatedAt: number | null
  source: string
  sourcePath: string | null
  charCount: number
}

export interface KbDueEntity {
  id: string
  name: string
  kind: string
  dueAt: number | null
  interval: number
  streak: number
}

export interface KbFailure {
  path?: string
  error?: string
  at?: number
}

export interface KbStats {
  documents: number
  chunks: number
  entities: number
  memories: number
  failures?: KbFailure[]
  processed?: { path?: string; documentId?: string; at?: number }[]
}

type KbTab = 'search' | 'docs' | 'review'

/** kind 标签（SRS 实体类型 → 人类可读） */
const KIND_LABELS: Record<string, string> = {
  memory: '记忆', concept: '概念', procedure: '流程', design: '设计',
  email: '邮箱', url: '链接', phone: '电话', date: '日期',
  person: '人物', organization: '组织', technical: '技术',
}

/** 更新时间格式化：YYYY-MM-DD（今日显示 HH:mm） */
export function formatUpdatedAt(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  if (y === now.getFullYear() && m === String(now.getMonth() + 1).padStart(2, '0') && day === String(now.getDate()).padStart(2, '0')) {
    return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${y}-${m}-${day}`
}

/** 到期时间展示：今天/明天/日期（SRS 复习用） */
export function formatDueAt(ts: number | null): string {
  if (!ts) return '随时'
  const d = new Date(ts)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dayDiff = Math.round((startDay - startToday) / 86_400_000)
  if (dayDiff === 0) return '今天'
  if (dayDiff === 1) return '明天'
  if (dayDiff === -1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function KnowledgePanel() {
  const surface = useSceneClient('kb-panel')
  const [dismissed, setDismissed] = useState(false)
  const dismissedRef = useRef(false)
  dismissedRef.current = dismissed
  const [voiceVisible, setVoiceVisible] = useState(false)

  const [tab, setTab] = useState<KbTab>('search')

  // ── 检索状态 ──
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<KbSearchResult[]>([])
  const [searchMessage, setSearchMessage] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)

  // ── 文档清单状态 ──
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [docsLoading, setDocsLoading] = useState(false)

  // ── 复习状态 ──
  const [due, setDue] = useState<KbDueEntity[]>([])
  const [dueLoading, setDueLoading] = useState(false)

  // ── 存量快照 ──
  const [stats, setStats] = useState<KbStats | null>(null)

  const visible = (voiceVisible || !!surface) && !dismissed

  // 组合布局联动（同 SchedulePanel/MeetingPanel 模式）
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible, name: 'knowledge' } }))
    } catch (e) { console.warn('[knowledge-panel] 广播可见性事件失败:', e) }
  }, [visible])

  /** 存量快照（documents/chunks/entities + 记账失败数） */
  const loadStats = useCallback(async () => {
    try {
      const res = await apiGet<KbStats>('/api/kb/stats')
      if (res.success && res.data) setStats(res.data)
    } catch (e: any) {
      console.error('[knowledge-panel] 存量快照加载失败:', e?.message || e)
    }
  }, [])

  /** 执行检索（与 LLM 侧 KbSearch 同一后端 handler） */
  const runSearch = useCallback(async (q: string) => {
    const qtrim = q.trim()
    if (!qtrim) return
    setSearching(true)
    setSearchError(null)
    setSearchMessage(null)
    try {
      const res = await apiGet<{ query: string; total: number; results: KbSearchResult[]; message?: string }>(
        `/api/kb/search?q=${encodeURIComponent(qtrim)}&limit=10`,
      )
      if (res.success && res.data) {
        setResults(res.data.results || [])
        setSearchMessage(res.data.total === 0 ? (res.data.message || '知识库中未找到相关内容') : null)
      } else {
        setSearchError(res.error || '检索失败')
      }
    } catch (e: any) {
      console.error('[knowledge-panel] 检索失败:', e?.message || e)
      setSearchError('检索失败')
    } finally {
      setSearching(false)
    }
  }, [])

  /** 文档清单 */
  const loadDocs = useCallback(async () => {
    setDocsLoading(true)
    try {
      const res = await apiGet<{ total: number; documents: KbDoc[] }>('/api/kb/list?limit=100')
      if (res.success && res.data) {
        setDocs(Array.isArray(res.data.documents) ? res.data.documents : [])
      }
    } catch (e: any) {
      console.error('[knowledge-panel] 文档清单加载失败:', e?.message || e)
    } finally {
      setDocsLoading(false)
    }
  }, [])

  /** SRS 到期复习清单 */
  const loadDue = useCallback(async () => {
    setDueLoading(true)
    try {
      const res = await apiGet<{ total: number; entities: KbDueEntity[] }>('/api/kb/due?limit=50')
      if (res.success && res.data) {
        setDue(Array.isArray(res.data.entities) ? res.data.entities : [])
      }
    } catch (e: any) {
      console.error('[knowledge-panel] 复习清单加载失败:', e?.message || e)
    } finally {
      setDueLoading(false)
    }
  }, [])

  /** 记录复习结果（答对/答错 → SRS 等级转移，与 /api/kb/review 契约） */
  const submitReview = useCallback(async (entityId: string, correct: boolean) => {
    try {
      const res = await apiPost<{ entityId: string; index: number; streak: number; dueAt: number }>(
        '/api/kb/review',
        { entityId, correct },
      )
      if (res.success) {
        toast.success(correct ? '已记住 ✓ 下次间隔更长' : '已标记遗忘，稍后再复习')
        setDue(prev => prev.filter(e => e.id !== entityId))
      } else {
        toast.error(res.error || '复习记录失败')
      }
    } catch (e: any) {
      toast.error('复习记录失败: ' + (e?.message || e))
    }
  }, [])

  /** 打开（语音「打开知识库」/ surface 到达）：复位 + 拉三区数据 */
  const open = useCallback(() => {
    setDismissed(false)
    setVoiceVisible(true)
    void loadStats()
    void loadDocs()
    void loadDue()
  }, [loadStats, loadDocs, loadDue])

  /** 打开并直接检索（宿主 search API——语音「知识库里查 XX」预留） */
  const openAndSearch = useCallback((q: string) => {
    setDismissed(false)
    setVoiceVisible(true)
    setTab('search')
    if (q && q.trim()) {
      setQuery(q)
      void runSearch(q)
    }
  }, [runSearch])

  /** close 三件套：dismissed + 移除 surface + panel-state closed（同 SchedulePanel） */
  const handleClose = useCallback(() => {
    setDismissed(true)
    setVoiceVisible(false)
    try {
      apiPost('/api/scene/remove', { id: 'kb-panel' }).catch((e: any) => console.warn('[knowledge-panel] 场景移除失败:', e?.message))
      apiPost('/api/scene/panel-state', { panel: 'knowledge', state: 'closed' }).catch((e: any) => console.warn('[knowledge-panel] 面板状态写入失败:', e?.message))
    } catch (e) { console.error('[knowledge-panel] 关闭链路异常:', e) }
  }, [])

  /** tab 切换：首次进入对应区拉数据（开箱即快） */
  const switchTab = useCallback((t: KbTab) => {
    setTab(t)
    if (t === 'docs') void loadDocs()
    if (t === 'review') void loadDue()
  }, [loadDocs, loadDue])

  // 语音/全局接口（恒注册）
  useEffect(() => {
    return registerCommandHost('knowledgePanel', {
      open: () => open(),
      close: handleClose,
      isOpen: () => visible,
      search: (q?: string) => { if (q) openAndSearch(q); else open() },
    })
  }, [open, handleClose, visible, openAndSearch])

  // 首次挂载预拉三区数据（打开时开箱即快，同 SchedulePanel 挂载预拉模式）
  useEffect(() => {
    void loadStats()
    void loadDocs()
    void loadDue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const failureCount = Array.isArray(stats?.failures) ? stats.failures.length : 0

  return (
    <SideSheet
      open={visible}
      onClose={handleClose}
      name="knowledge"
      width="min(75vw, 1280px)"
    >
      <div className="knowledge-panel">
        {/* 标题栏（视频卡片同构） */}
        <div className="knowledge-header">
          <span className="knowledge-title-icon">📚</span>
          <span className="knowledge-title">知识库</span>
          <button
            type="button"
            className="knowledge-close-btn"
            data-close-btn
            onClick={handleClose}
            aria-label="关闭知识库面板"
            title="关闭"
          >
            ✕
          </button>
        </div>

        {/* tab 栏 */}
        <div className="knowledge-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'search'}
            className={`knowledge-tab${tab === 'search' ? ' knowledge-tab--active' : ''}`}
            onClick={() => switchTab('search')}
          >
            🔍 检索
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'docs'}
            className={`knowledge-tab${tab === 'docs' ? ' knowledge-tab--active' : ''}`}
            onClick={() => switchTab('docs')}
          >
            📄 文档清单
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'review'}
            className={`knowledge-tab${tab === 'review' ? ' knowledge-tab--active' : ''}`}
            onClick={() => switchTab('review')}
          >
            🧠 复习{due.length > 0 ? ` · ${due.length}` : ''}
          </button>
        </div>

        {/* 内容区（flex-1 滚动） */}
        <div className="knowledge-body">
          {tab === 'search' && (
            <div className="knowledge-search">
              <div className="knowledge-search-row">
                <input
                  className="knowledge-input"
                  type="text"
                  placeholder="检索知识库，如「合同金额」「项目风险」"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void runSearch(query) }}
                  aria-label="知识库检索词"
                />
                <button
                  type="button"
                  className="knowledge-btn knowledge-btn--primary"
                  onClick={() => void runSearch(query)}
                  disabled={searching || !query.trim()}
                >
                  {searching ? '检索中…' : '🔍 搜索'}
                </button>
              </div>

              {searchError && (
                <div className="knowledge-error">
                  {searchError}
                  <button type="button" className="knowledge-error-retry" onClick={() => void runSearch(query)}>重试</button>
                </div>
              )}

              {!searching && !searchError && searchMessage && (
                <div className="knowledge-empty">
                  <div className="knowledge-empty-icon">🗂️</div>
                  <div className="knowledge-empty-text">{searchMessage}</div>
                  <div className="knowledge-empty-tip">提示：对 AI 说「分析这个文档」可先把文档录入知识库</div>
                </div>
              )}

              {searching ? (
                <div className="knowledge-empty">
                  <div className="knowledge-empty-text">正在检索…</div>
                </div>
              ) : (
                results.map(r => (
                  <div key={r.id} className="knowledge-result">
                    <div className="knowledge-result-head">
                      <span className="knowledge-result-title">{r.title || '（无标题片段）'}</span>
                      {r.kind !== 'chunk' && <span className="knowledge-result-kind">{r.kind}</span>}
                      <span className="knowledge-result-score">{(r.score * 100).toFixed(1)}%</span>
                    </div>
                    <div className="knowledge-result-snippet">{r.snippet || '（空片段）'}</div>
                    <div className="knowledge-result-meta">
                      {r.source && <span className="knowledge-result-src">{r.source}</span>}
                      {r.sourcePath && <span className="knowledge-result-path" title={r.sourcePath}>{r.sourcePath}</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'docs' && (
            <div className="knowledge-docs">
              {docsLoading && docs.length === 0 ? (
                <div className="knowledge-empty">
                  <div className="knowledge-empty-text">正在加载文档清单…</div>
                </div>
              ) : docs.length === 0 ? (
                <div className="knowledge-empty">
                  <div className="knowledge-empty-icon">🗂️</div>
                  <div className="knowledge-empty-text">暂无分析文档</div>
                  <div className="knowledge-empty-tip">对 AI 说「分析这个文档」（PDF/Word/Excel/网页）即可录入知识库</div>
                </div>
              ) : (
                docs.map(d => (
                  <div key={d.id} className="knowledge-doc">
                    <div className="knowledge-doc-title">
                      {d.title || '（无标题）'}
                      {d.source && <span className="knowledge-doc-src">{d.source}</span>}
                    </div>
                    <div className="knowledge-doc-meta">
                      {formatUpdatedAt(d.updatedAt)}
                      {d.charCount > 0 && ` · ${Math.round(d.charCount / 1000)}k 字符`}
                      {d.sourcePath && <span className="knowledge-doc-path" title={d.sourcePath}>{d.sourcePath}</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {tab === 'review' && (
            <div className="knowledge-review">
              {dueLoading && due.length === 0 ? (
                <div className="knowledge-empty">
                  <div className="knowledge-empty-text">正在加载复习清单…</div>
                </div>
              ) : due.length === 0 ? (
                <div className="knowledge-empty">
                  <div className="knowledge-empty-icon">🧠</div>
                  <div className="knowledge-empty-text">暂无到期复习项</div>
                  <div className="knowledge-empty-tip">知识库实体按间隔重复自动到期：记忆 0/1/3/7/14/30/60 天，概念 3/7/14/30 天</div>
                </div>
              ) : (
                due.map(e => (
                  <div key={e.id} className="knowledge-review-item">
                    <div className="knowledge-review-main">
                      <div className="knowledge-review-name">
                        {e.name}
                        <span className="knowledge-review-kind">{KIND_LABELS[e.kind] || e.kind}</span>
                      </div>
                      <div className="knowledge-review-meta">
                        {formatDueAt(e.dueAt)}到期 · 等级 {e.interval + 1} · 连续答对 {e.streak}
                      </div>
                    </div>
                    <div className="knowledge-review-actions">
                      <button
                        type="button"
                        className="knowledge-btn knowledge-btn--ok"
                        aria-label={`记住 ${e.name}`}
                        title="答对：提升复习间隔"
                        onClick={() => void submitReview(e.id, true)}
                      >
                        ✓ 记住了
                      </button>
                      <button
                        type="button"
                        className="knowledge-btn knowledge-btn--miss"
                        aria-label={`没记住 ${e.name}`}
                        title="答错：缩短复习间隔"
                        onClick={() => void submitReview(e.id, false)}
                      >
                        ✗ 没记住
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* 底部存量快照（诚实呈现知识库覆盖范围） */}
        <div className="knowledge-footer">
          <span>📄 {stats?.documents ?? '–'} 文档</span>
          <span>🧩 {stats?.chunks ?? '–'} 片段</span>
          <span>🧬 {stats?.entities ?? '–'} 实体</span>
          {failureCount > 0 && (
            <span className="knowledge-footer-fail" title="最近分析失败记录">
              ⚠️ {failureCount} 条失败
            </span>
          )}
          <button type="button" className="knowledge-btn" onClick={() => { void loadStats(); void loadDocs(); void loadDue() }}>
            🔄 刷新
          </button>
        </div>
      </div>
    </SideSheet>
  )
}

export default KnowledgePanel
