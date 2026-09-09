import { useState, useEffect, useRef } from 'react'
import { Edit3, Save, RotateCcw, ChevronLeft, MessageCircle, Trash2 } from 'lucide-react'
import type { Expert, ExpertDetail } from './types'
import { fetchExpertDetail, updateExpert, resetExpertPrompt, deleteExpert } from './api'
import { ConfirmDialog } from '../ConfirmDialog'

interface ExpertDetailProps {
  expert: Expert
  onBack: () => void
  onSummon: (e: Expert) => void
  onUpdated: () => void
  /** 2026-08-26 审计 E2: 内置专家名映射——collaborationChain 存 id, 渲染成中文名 */
  expertNameMap?: Record<string, string>
}

export function ExpertDetailView({ expert, onBack, onSummon, onUpdated, expertNameMap }: ExpertDetailProps) {
  const [detail, setDetail] = useState<ExpertDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  // P2-8: 重置提示词前需确认——与删除确认同模式，防误触恢复默认内容
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [saveError, setSaveError] = useState('')

  // "已保存"提示定时器 ref——卸载时清理，防卸载后 setState
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchExpertDetail(expert.id).then(d => {
      if (cancelled) return
      setDetail(d)
      if (d) setPrompt(d.systemPrompt)
    }).catch(e => {
      console.error('[ExpertDetail] 加载详情失败:', e?.message || e)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [expert.id])

  const handleSave = async () => {
    if (!detail || expert.builtin) return
    setSaving(true)
    setSaveError('')
    try {
      const result = await updateExpert(expert.id, { systemPrompt: prompt })
      if (!result) {
        // API 返回 {success:false} 时不抛异常，检查返回值
        setSaved(false)
        setSaveError('保存失败，请重试')
        return
      }
      setSaveError('')
      setEditing(false)
      setSaved(true)
      // 2026-09-05 修复: 同步本地 detail——非编辑态渲染 detail.systemPrompt,
      // 不同步的话保存成功后界面立刻回显旧提示词(重进详情才见新值)
      setDetail(d => (d ? { ...d, systemPrompt: prompt } : d))
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
      savedTimerRef.current = setTimeout(() => setSaved(false), 2000)
      onUpdated()
    } catch (e: any) {
      console.error('[ExpertDetail] save error:', e?.message || e)
      setSaveError('保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setShowResetConfirm(false)
    try {
      const p = await resetExpertPrompt(expert.id)
      if (p) {
        setPrompt(p)
        setEditing(false)
        // 2026-09-05: 同步 detail(同保存路径的回显问题)
        setDetail(d => (d ? { ...d, systemPrompt: p } : d))
      }
    } catch (e: any) {
      console.error('[ExpertDetail] reset error:', e?.message || e)
    }
  }

  const handleSummon = () => {
    // 2026-09-05: recordSession 移除(父级召唤链路+后端 summon 端点已计数, 此处叠加致虚高)
    onSummon(expert)
  }

  const handleDelete = async () => {
    setShowDeleteConfirm(false)
    setDeleting(true)
    setDeleteError('')
    try {
      const ok = await deleteExpert(expert.id)
      if (ok) { onBack(); onUpdated() }
      else { setDeleteError('删除失败，请重试') }
    } catch (e: any) {
      console.error('[ExpertDetail] delete error:', e?.message || e)
      setDeleteError('删除失败，请重试')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 theme-text-muted text-xs">加载中...</div>
    )
  }
  if (!detail) {
    return (
      <div className="flex items-center justify-center py-16 theme-text-muted text-xs">加载失败</div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b theme-border sticky top-0" style={{ background: 'var(--bg-primary)' }}>
        <button onClick={onBack} className="p-1 rounded hover:theme-bg-tertiary">
          <ChevronLeft className="w-4 h-4 theme-text-muted" />
        </button>
        <span className="text-sm font-semibold theme-text-primary flex-1">{detail.name}</span>
        {!detail.builtin && (
          <button onClick={() => setShowDeleteConfirm(true)} disabled={deleting}
            className="p-1.5 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors" title="删除专家">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
        <button onClick={handleSummon}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium"
          style={{ background: 'var(--accent-muted)', color: 'var(--accent-primary)' }}>
          <MessageCircle className="w-3 h-3" />
          召唤
        </button>
      </div>

      <div className="p-4 space-y-5">
        {/* Title + Description */}
        <div>
          <div className="text-xs theme-text-muted mb-1">{detail.title}</div>
          <p className="text-xs theme-text-secondary">{detail.description}</p>
        </div>

        {/* Tags + Capabilities */}
        <div className="flex flex-wrap gap-1.5">
          {detail.tags.map(t => (
            <span key={t} className="px-2 py-0.5 rounded text-[10px]" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>{t}</span>
          ))}
          {detail.capabilities.map(c => (
            <span key={c} className="px-2 py-0.5 rounded text-[10px]" style={{ background: 'rgba(89,168,255,0.1)', color: '#59a8ff' }}>{c}</span>
          ))}
        </div>

        {/* Usage Stats */}
        <div className="flex gap-6 text-xs">
          <div><span className="theme-text-muted">使用次数: </span><span className="theme-text-primary font-medium">{detail.usageCount}</span></div>
          <div><span className="theme-text-muted">上次使用: </span><span className="theme-text-primary font-medium">
            {detail.lastUsedAt ? new Date(detail.lastUsedAt).toLocaleString() : '从未'}
          </span></div>
          <div><span className="theme-text-muted">类型: </span><span className="theme-text-primary font-medium">{detail.builtin ? '内置' : '自定义'}</span></div>
        </div>

        {/* Routing Keywords */}
        {detail.routingKeywords.length > 0 && (
          <div>
            <div className="text-[11px] theme-text-muted mb-1.5 font-medium">路由关键词</div>
            <div className="flex flex-wrap gap-1">
              {detail.routingKeywords.map(k => (
                <span key={k} className="px-1.5 py-0.5 text-[10px] rounded" style={{ background: 'rgba(255,255,255,0.04)', color: '#888' }}>
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Collaboration Chain */}
        {detail.collaborationChain.length > 0 && (
          <div>
            <div className="text-[11px] theme-text-muted mb-1.5 font-medium">推荐协作链</div>
            <div className="flex items-center gap-1 flex-wrap text-xs">
              <span className="px-2 py-0.5 rounded theme-bg-tertiary theme-text-primary">{detail.name}</span>
              {detail.collaborationChain.map((cId, _i) => (
                <span key={cId} className="flex items-center gap-1">
                  <span className="text-muted" style={{ color: '#555' }}>→</span>
                  <span className="px-2 py-0.5 rounded" style={{ background: 'rgba(89,168,255,0.08)', color: '#59a8ff' }}>{expertNameMap?.[cId] || cId}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* System Prompt (editable for custom experts) */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] theme-text-muted font-medium">系统提示词</span>
            <div className="flex gap-1">
              {!detail.builtin && !editing && (
                <button onClick={() => setEditing(true)} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] hover:theme-bg-tertiary theme-text-muted">
                  <Edit3 className="w-2.5 h-2.5" /> 编辑
                </button>
              )}
              {detail.builtin && (
                <button onClick={() => setShowResetConfirm(true)} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] hover:theme-bg-tertiary theme-text-muted">
                  <RotateCcw className="w-2.5 h-2.5" /> 重置
                </button>
              )}
            </div>
          </div>
          {editing ? (
            <div className="space-y-2">
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                className="w-full h-28 text-xs p-2 rounded-lg theme-bg-input theme-text-primary border theme-border resize-none focus:outline-none focus:border-accent-primary/50 font-mono"
              />
              <div className="flex gap-2">
                <button onClick={handleSave} disabled={saving}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium"
                  style={{ background: saved ? '#4caf50' : 'var(--accent-primary)', color: '#fff' }}>
                  <Save className="w-3 h-3" />
                  {saving ? '保存中...' : saved ? '已保存 ✓' : '保存'}
                </button>
                <button onClick={() => { setEditing(false); setPrompt(detail.systemPrompt) }}
                  className="px-3 py-1.5 rounded-lg text-xs theme-text-muted hover:theme-text-primary" style={{ background: 'var(--bg-tertiary)' }}>
                  取消
                </button>
              </div>
              {saveError && <div className="text-xs" style={{ color: '#f44336' }}>{saveError}</div>}
            </div>
          ) : (
            <div className="p-3 rounded-lg text-xs theme-text-secondary leading-relaxed whitespace-pre-wrap" style={{ background: 'var(--bg-tertiary)', fontFamily: 'monospace', fontSize: 10 }}>
              {detail.systemPrompt}
            </div>
          )}
        </div>
      </div>

      {/* 重置确认弹窗（P2-8: 与删除确认同模式） */}
      <ConfirmDialog
        open={showResetConfirm}
        title="确认重置"
        message={`确定要重置专家「${detail.name}」的系统提示词吗？将恢复为默认内容。`}
        confirmLabel="确认重置"
        onCancel={() => setShowResetConfirm(false)}
        onConfirm={handleReset}
      />
      {/* 删除确认弹窗 */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title="确认删除"
        message={`确定要删除专家「${detail.name}」吗？此操作不可撤销。`}
        confirmLabel="确认删除"
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
      />
      {deleteError && <div className="text-xs text-center mt-2" style={{ color: '#f44336' }}>{deleteError}</div>}
    </div>
  )
}
