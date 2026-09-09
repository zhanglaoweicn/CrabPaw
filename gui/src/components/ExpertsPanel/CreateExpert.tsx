import { useState, useRef, useEffect } from 'react'
import { Save, ChevronLeft, Brain, Cpu, BarChart3, FileText, Wrench, Globe, Sparkles, Monitor } from 'lucide-react'
import { createExpert } from './api'
import { CATEGORY_LABELS } from './category-labels'

const ICON_OPTIONS = [
  { key: 'Brain', icon: Brain, label: '大脑' },
  { key: 'Cpu', icon: Cpu, label: '芯片' },
  { key: 'BarChart3', icon: BarChart3, label: '图表' },
  { key: 'FileText', icon: FileText, label: '文档' },
  { key: 'Wrench', icon: Wrench, label: '工具' },
  { key: 'Globe', icon: Globe, label: '地球' },
  { key: 'Sparkles', icon: Sparkles, label: '火花' },
  { key: 'Monitor', icon: Monitor, label: '屏幕' },
]

const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS).map(([key, label]) => ({ key, label }))

interface CreateExpertProps {
  onBack: () => void
  onCreated: () => void
  existingNames?: string[]  // 已有专家名称，用于前端查重
}

export function CreateExpert({ onBack, onCreated, existingNames = [] }: CreateExpertProps) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('Brain')
  const [category, setCategory] = useState('custom')
  const [tags, setTags] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [routingKeywords, setRoutingKeywords] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  // "创建成功"跳转定时器 ref——卸载时清理，防卸载后触发 onBack
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
    }
  }, [])

  const handleSubmit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) { setError('请输入专家名称'); return }
    if (existingNames.some(n => n === trimmedName)) { setError('专家名称已存在，请更换'); return }
    setError('')
    setSaving(true)
    try {
      const result = await createExpert({
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        icon,
        category,
        tags: tags.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
        systemPrompt: systemPrompt.trim(),
        routingKeywords: routingKeywords.split(/[,，、]/).map(s => s.trim()).filter(Boolean),
      })
      if (!result) { setError('创建失败，请重试'); return }
      setDone(true)
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
      doneTimerRef.current = setTimeout(() => { onCreated(); onBack() }, 1200)
    } catch (e: any) {
      console.error('[CreateExpert] 创建失败:', e?.message || e)
      setError(e.message || '创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center gap-2 px-4 py-3 border-b theme-border sticky top-0" style={{ background: 'var(--bg-primary)' }}>
        <button onClick={onBack} className="p-1 rounded hover:theme-bg-tertiary">
          <ChevronLeft className="w-4 h-4 theme-text-muted" />
        </button>
        <span className="text-sm font-semibold theme-text-primary">创建自定义专家</span>
      </div>

      <div className="p-4 space-y-4">
        {/* Name */}
        <div>
          <label className="text-[11px] theme-text-muted font-medium block mb-1">名称 *</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="w-full px-3 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none focus:border-accent-primary/50"
            placeholder="例如：运维专家" />
        </div>

        {/* Title */}
        <div>
          <label className="text-[11px] theme-text-muted font-medium block mb-1">头衔</label>
          <input value={title} onChange={e => setTitle(e.target.value)}
            className="w-full px-3 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none focus:border-accent-primary/50"
            placeholder="例如：SRE 工程师" />
        </div>

        {/* Description */}
        <div>
          <label className="text-[11px] theme-text-muted font-medium block mb-1">描述</label>
          <input value={description} onChange={e => setDescription(e.target.value)}
            className="w-full px-3 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none focus:border-accent-primary/50"
            placeholder="简要描述专家擅长的领域" />
        </div>

        {/* Icon + Category (side by side) */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-[11px] theme-text-muted font-medium block mb-1">图标</label>
            <div className="flex gap-1 flex-wrap">
              {ICON_OPTIONS.map(opt => {
                const Icon = opt.icon
                return (
                  <button key={opt.key} onClick={() => setIcon(opt.key)}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                      icon === opt.key ? 'ring-2' : ''
                    }`}
                    style={{
                      background: icon === opt.key ? 'rgba(89,168,255,0.15)' : 'var(--bg-tertiary)',
                    }}>
                    <Icon className={`w-4 h-4 ${icon === opt.key ? 'theme-accent' : 'theme-text-muted'}`} />
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex-1">
            <label className="text-[11px] theme-text-muted font-medium block mb-1">分类</label>
            <select value={category} onChange={e => setCategory(e.target.value)}
              className="w-full px-3 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none">
              {CATEGORY_OPTIONS.map(c => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Tags */}
        <div>
          <label className="text-[11px] theme-text-muted font-medium block mb-1">标签（逗号分隔）</label>
          <input value={tags} onChange={e => setTags(e.target.value)}
            className="w-full px-3 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none"
            placeholder="例如：运维、监控、部署" />
        </div>

        {/* Routing Keywords */}
        <div>
          <label className="text-[11px] theme-text-muted font-medium block mb-1">路由关键词（逗号分隔）</label>
          <input value={routingKeywords} onChange={e => setRoutingKeywords(e.target.value)}
            className="w-full px-3 py-1.5 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none"
            placeholder="输入触发此专家的关键词" />
        </div>

        {/* System Prompt */}
        <div>
          <label className="text-[11px] theme-text-muted font-medium block mb-1">系统提示词</label>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            className="w-full h-36 text-xs p-3 rounded-lg theme-bg-input theme-text-primary border theme-border resize-none focus:outline-none focus:border-accent-primary/50 font-mono leading-relaxed"
            placeholder="输入 AI 以该专家身份回答时应遵循的提示词..."
          />
        </div>

        {error && <div className="text-xs" style={{ color: '#f44336' }}>{error}</div>}
        {done && <div className="text-xs" style={{ color: '#4caf50' }}>创建成功 ✓</div>}

        <button
          onClick={handleSubmit}
          disabled={saving || done}
          className="w-full py-2.5 rounded-lg text-xs font-medium text-white transition-all disabled:opacity-50"
          style={{ background: 'var(--accent-primary)' }}
        >
          <Save className="w-3.5 h-3.5 inline mr-1.5" />
          {saving ? '创建中...' : done ? '已创建 ✓' : '创建专家'}
        </button>
        {/* 2026-09-05: 泊车语义提示——自建专家默认不参与自动路由/协作编排, 只能显式召唤 */}
        <p className="text-[10px] theme-text-muted mt-2 leading-relaxed">
          提示：新创建的专家默认「泊车」状态——不出现在自动路由与协作编排中，可通过搜索名单或"以XX身份"显式召唤。
        </p>
      </div>
    </div>
  )
}
