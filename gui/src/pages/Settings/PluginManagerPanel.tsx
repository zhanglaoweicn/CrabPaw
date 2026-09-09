import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost } from '../../lib/api'
import { Package, RefreshCw, Power, PowerOff, AlertCircle, Layers, ShieldCheck, Database, Boxes } from 'lucide-react'
// 2026-08-27 A6: trust 徽章迁移 CockpitUI StatusBadge
import { StatusBadge } from '../../components/CockpitUI'
import { toast } from 'sonner'

interface PluginInfo {
  name: string
  version: string
  kind: string
  source: string
  description: string
  enabled: boolean
  manuallyDisabled?: boolean
  contributions: string[]
}

interface AssemblyView {
  assembly?: { loaded: number; known: number; disabled: string[]; loadedList: Array<{ name: string; version: string; source: string; trust: string }> }
  tree?: { summary: string | null; ok: boolean | null }
  panels?: Array<{ key: string; surface: string; ui: string; dataSource: string | null }>
  sources?: Array<{ name: string; description?: string }>
  providers?: { llm: Array<{ id: string }>; tts: Array<{ id: string }>; docEngine: Array<{ id: string }> }
}

// 2026-08-27 面板禁用开关（已知限制#1 收口）：清单取 /api/panels/state 全量（含停用面）
interface PanelState { key: string; surface: string; ui: string; dataSource?: string | null; enabled: boolean }

// 2026-08-27 A6: trust 徽章迁移 CockpitUI StatusBadge——语义色如实:
// signed(正式证书/官方发布)=success 已验证; hash(自签 hash-pin, 发布者校验过)=warn 发布者校验;
// unsigned=neutral 未验证署名。tooltip 文案不变。
const TRUST_BADGE: Record<string, { label: string; tone: string }> = {
  signed: { label: '已验证', tone: 'success' },
  hash: { label: '发布者校验', tone: 'warn' },
  unsigned: { label: '未验证署名', tone: 'neutral' },
}

export default function PluginManagerPanel({ initialKeyword = '' }: { initialKeyword?: string }) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [stats, setStats] = useState({ total: 0, active: 0 })
  const [assembly, setAssembly] = useState<AssemblyView | null>(null)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 2026-08-27 全局搜索: 挂载时以 initialKeyword 初始化列表过滤(仅初值, 后续用户自改)
  const [filterKeyword, setFilterKeyword] = useState(initialKeyword)
  // 2026-08-27 面板禁用开关: 面板清单独立 state（并行拉取, 与装配视图互不影响）
  const [panelStates, setPanelStates] = useState<PanelState[]>([])
  // 2026-08-27 P2 审查: 清单拉取失败错误态（与装配 error 同风格）+ 面板开关 toggling 守卫（对齐 togglePlugin）
  const [panelError, setPanelError] = useState('')
  const [panelToggling, setPanelToggling] = useState<string | null>(null)

  const loadPlugins = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await apiGet('/api/plugin-manager/list')
      if (res?.success && res.data) {
        const list = Array.isArray(res.data.plugins) ? res.data.plugins : []
        setPlugins(list)
        setStats({ total: list.length, active: list.filter((p: any) => p.enabled !== false).length })
      } else {
        setError('API 返回异常: ' + JSON.stringify(res).slice(0, 100))
      }
    } catch (e: any) {
      const msg = e?.message || ''
      if (msg.includes('fetch') || msg.includes('NetworkError') || msg.includes('ECONNREFUSED')) {
        setError('无法连接后端服务，请先在首页启动服务')
      } else {
        setError('加载失败: ' + msg)
      }
    }
    finally { setLoading(false) }
  }, [])

  const loadAssembly = useCallback(async () => {
    try {
      const res = await apiGet('/api/plugins/assembly')
      if (res?.success) setAssembly(res as any)
    } catch { /* 装配视图可选——失败不影响插件列表 */ }
  }, [])

  const loadPanelStates = useCallback(async () => {
    try {
      const res = await apiGet('/api/panels/state')
      if (res?.success && res.data) {
        const list = Array.isArray(res.data.panels) ? res.data.panels : []
        setPanelStates(list)
        setPanelError('')
      } else {
        setPanelError('面板清单加载失败')
      }
    } catch (e: any) {
      console.warn('[panels] 状态加载失败（面板清单可选）:', e?.message || e)
      setPanelError('面板清单加载失败')
    }
  }, [])

  useEffect(() => { loadPlugins(); loadAssembly(); loadPanelStates() }, [loadPlugins, loadAssembly, loadPanelStates])

  const togglePlugin = useCallback(async (name: string, currentlyEnabled: boolean) => {
    const action = currentlyEnabled ? 'disable' : 'enable'
    setToggling(name)
    setPlugins(prev => prev.map(p => p.name === name ? { ...p, enabled: !currentlyEnabled } : p))
    try {
      const res = await apiPost(`/api/plugin-manager/${name}/${action}`, {})
      if (res.success) {
        setStats(prev => ({
          ...prev,
          active: prev.active + (currentlyEnabled ? -1 : 1),
        }))
      } else {
        // 2026-08-28 CK5: 失败反馈对齐面板启停(toast)——此前静默回滚, 用户无感知
        setPlugins(prev => prev.map(p => p.name === name ? { ...p, enabled: currentlyEnabled } : p))
        toast.error(`插件「${name}」${currentlyEnabled ? '停用' : '启用'}失败: ${res?.error || '未知错误'}`)
      }
    } catch (e: any) {
      setPlugins(prev => prev.map(p => p.name === name ? { ...p, enabled: currentlyEnabled } : p))
      console.warn('toggle failed:', e?.message || e)
      toast.error(`插件「${name}」${currentlyEnabled ? '停用' : '启用'}失败`) // CK5: 与面板启停同款反馈
    }
    finally { setToggling(null) }
  }, [])

  // 2026-08-27 面板禁用开关: 乐观更新+失败回滚+toast（与插件启停同模式）
  // 2026-08-27 P2 审查: toggling 守卫对齐 togglePlugin 模式——set/clear + 按钮 disabled（无闭包陈旧问题）
  const togglePanelState = useCallback(async (key: string, enabled: boolean) => {
    setPanelToggling(key)
    setPanelStates(prev => prev.map(p => p.key === key ? { ...p, enabled } : p))
    try {
      const res = await apiPost('/api/panels/state', { key, enabled })
      if (!res?.success) {
        setPanelStates(prev => prev.map(p => p.key === key ? { ...p, enabled: !enabled } : p))
        toast.error(`面板「${key}」${enabled ? '启用' : '停用'}失败: ${res?.error || '未知错误'}`)
      } else {
        toast.success(`面板「${key}」已${enabled ? '启用' : '停用'}`)
      }
    } catch (e: any) {
      setPanelStates(prev => prev.map(p => p.key === key ? { ...p, enabled: !enabled } : p))
      console.warn('panel toggle failed:', e?.message || e)
      toast.error(`面板「${key}」${enabled ? '启用' : '停用'}失败`)
    }
    finally { setPanelToggling(null) }
  }, [])

  const getKindLabel = (kind: string) => {
    const map: Record<string, string> = { plugin: '代码插件', skill: '提示词插件', combined: '混合插件' }
    return map[kind] || kind
  }

  const getSourceLabel = (source: string) => {
    const map: Record<string, string> = { 'plugin:bundled': '系统内置', 'plugin:builtin': '内置', 'plugin:user': '用户' }
    return map[source] || source.replace('plugin:', '')
  }

  const loadedList = assembly?.assembly?.loadedList || []
  const disabledList = assembly?.assembly?.disabled || []
  const q = filterKeyword.trim().toLowerCase()
  const visiblePlugins = q
    ? plugins.filter(p =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      )
    : plugins

  return (
    <div className="theme-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium flex items-center gap-2 theme-text-primary">
          <Package className="w-5 h-5 theme-accent" />插件
        </h3>
        <button onClick={() => { loadPlugins(); loadAssembly(); loadPanelStates() }} disabled={loading}
          className="text-xs px-3 py-1 rounded theme-btn theme-btn-secondary disabled:opacity-50 flex items-center gap-1">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />刷新
        </button>
      </div>
      <p className="text-sm theme-text-muted">管理智能体的能力模块：查看已加载/启用的插件，控制其开关，并了解插件需要的数据源与模型。未验证署名的插件仍可加载，但高风险权限（命令执行/网络）会被限制。</p>

      {/* 2026-08-27 全局搜索: 插件名/描述过滤（initialKeyword 挂载初值） */}
      <input
        type='text'
        value={filterKeyword}
        onChange={e => setFilterKeyword(e.target.value)}
        placeholder='搜索插件名或描述…'
        className='w-full pl-4 pr-4 py-2 rounded-lg theme-input text-sm'
      />

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-start gap-2" style={{ color: 'var(--color-error)' }}>
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="text-sm">{error}</div>
        </div>
      )}

      {/* 装配概览（2026-08-26 P1 通俗化：开发者术语→用户语言） */}
      <div className="p-3 rounded-lg theme-bg-active">
        <div className="flex items-center gap-2 mb-2 text-sm">
          <Layers className="w-4 h-4 theme-accent" />
          <span className="font-medium theme-text-primary">加载状态</span>
          <span className="text-xs theme-text-muted">
            {assembly?.assembly
              ? `${assembly.assembly.loaded} 个插件已加载 / 共 ${assembly.assembly.known} 个${disabledList.length ? ` · 已禁用 ${disabledList.length}（${disabledList.join('，')}）` : ''}`
              : '加载中…'}
          </span>
        </div>
        {assembly?.tree?.summary && (
          <div className="text-xs theme-text-muted leading-relaxed">
            {String(assembly.tree.summary).replace('🌳 Harness 树审计', '系统模块审计')}
          </div>
        )}
      </div>

      {/* 2026-08-27 面板禁用开关：界面卡片从统计卡升级为清单行（启用开关对齐插件启停交互） */}
      <div className="p-3 rounded-lg theme-bg-active">
        <div className="flex items-center gap-2 mb-2 text-sm">
          <Boxes className="w-4 h-4 theme-accent" />
          <span className="font-medium theme-text-primary">界面面板</span>
          <span className="text-xs theme-text-muted">
            {panelError && panelStates.length === 0
              ? '加载失败'
              : panelStates.length > 0 ? `${panelStates.filter(p => p.enabled).length} 启用 / ${panelStates.length} 已知` : '加载中…'}
          </span>
        </div>
        {panelError && panelStates.length === 0 ? (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-start gap-2" style={{ color: 'var(--color-error)' }}>
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="text-sm flex-1">{panelError}</div>
            <button onClick={loadPanelStates} className="text-xs px-2 py-1 rounded theme-btn theme-btn-secondary">重试</button>
          </div>
        ) : panelStates.length === 0 ? (
          <div className="text-xs theme-text-muted">面板清单加载中…</div>
        ) : (
          <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
            {panelStates.map(p => (
              <div key={p.key} className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <span className="theme-text-primary font-medium">{p.key}</span>
                  <span className="ml-2 text-[10px] theme-text-muted">{p.surface}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0" title={p.enabled ? '面板已启用（数据源不受影响）' : '面板已停用——卡片不再弹出'}>
                  <StatusBadge tone={p.enabled ? 'success' : 'neutral'} label={p.enabled ? '启用' : '停用'} />
                  <button role="switch" aria-checked={p.enabled} aria-label={`切换面板 ${p.key}`}
                    onClick={() => togglePanelState(p.key, !p.enabled)} disabled={panelToggling === p.key}
                    className={`relative w-8 h-5 rounded-full transition-colors disabled:opacity-40 ${p.enabled ? 'bg-green-500/70' : 'bg-zinc-600/70'}`}>
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${p.enabled ? 'translate-x-3' : ''}`} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 生态注册表一览（2026-08-26 P1 通俗化——数据源/供应商统计卡保留, 界面卡片已升级为上方清单） */}
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-lg theme-bg-active">
          <div className="flex items-center gap-1.5 mb-1"><Database className="w-3.5 h-3.5 theme-accent" /><span className="text-xs theme-text-muted">数据源</span></div>
          <div className="text-lg font-bold theme-text-primary">{assembly?.sources?.length ?? '—'}</div>
          <div className="text-[10px] theme-text-muted truncate">
            {(assembly?.sources || []).map(s => s.name).join(' · ') || '加载中…'}
          </div>
        </div>
        <div className="p-3 rounded-lg theme-bg-active">
          <div className="flex items-center gap-1.5 mb-1"><ShieldCheck className="w-3.5 h-3.5 theme-accent" /><span className="text-xs theme-text-muted">模型供应商</span></div>
          <div className="text-lg font-bold theme-text-primary">
            {(assembly?.providers?.llm?.length ?? 0) + (assembly?.providers?.tts?.length ?? 0) + (assembly?.providers?.docEngine?.length ?? 0) || '—'}
          </div>
          <div className="text-[10px] theme-text-muted truncate">
            LLM {(assembly?.providers?.llm?.length ?? '—')} · TTS {(assembly?.providers?.tts?.length ?? '—')} · 文档引擎 {(assembly?.providers?.docEngine?.length ?? '—')}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="p-3 rounded-lg theme-bg-active"><div className="text-lg font-bold theme-accent">{stats.total}</div><div className="text-xs theme-text-muted">总计</div></div>
        <div className="p-3 rounded-lg theme-bg-active"><div className="text-lg font-bold text-green-500">{stats.active}</div><div className="text-xs theme-text-muted">运行中</div></div>
        <div className="p-3 rounded-lg theme-bg-active"><div className="text-lg font-bold theme-text-muted">{stats.total - stats.active}</div><div className="text-xs theme-text-muted">未启用</div></div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 gap-2"><div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{animationDelay:"0ms"}}></div><div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{animationDelay:"150ms"}}></div><div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{animationDelay:"300ms"}}></div><span className="text-xs theme-text-muted ml-1">加载中</span></div>
      ) : plugins.length === 0 && !error ? (
        <div className="text-center py-8"><Package className="w-10 h-10 mx-auto mb-2 opacity-30 theme-text-muted" /><p className="text-sm theme-text-muted">没有发现插件</p><p className="text-xs theme-text-muted mt-1">插件将自动从 plugins/ 和 data/.crabpaw/plugins/ 目录加载</p></div>
      ) : plugins.length === 0 ? null : (
        <div className="space-y-2">
          {visiblePlugins.length === 0 ? (
            <div className="text-center py-8"><p className="text-sm theme-text-muted">没有匹配「{filterKeyword.trim()}」的插件</p></div>
          ) : null}
          {visiblePlugins.map(p => {
            const trustMeta = TRUST_BADGE[(loadedList.find(x => x.name === p.name)?.trust) || 'unsigned'] || TRUST_BADGE.unsigned
            return (
              <div key={p.name} className="flex items-center justify-between p-3 rounded-lg border transition-all theme-bg-tertiary hover:border-[var(--color-accent)]/30 hover:shadow-sm hover:brightness-105">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium theme-text-primary truncate">{p.name}</span>
                      <span className="text-[11px] theme-text-muted tabular-nums">v{p.version}</span>
                      <StatusBadge tone={trustMeta.tone} label={trustMeta.label} title="信任状态：签名=官方发布；哈希=发布者校验过；未签名=未验证署名，高风险权限受限" />
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full theme-bg-active theme-text-muted">{getKindLabel(p.kind)}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full theme-bg-active theme-text-muted">{getSourceLabel(p.source)}</span>
                    </div>
                    <p className="text-xs theme-text-muted truncate mt-0.5">{p.description}</p>
                    {(p.contributions || []).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(p.contributions || []).map(c => (
                          <span key={c} className="text-[10px] px-1.5 py-0.5 rounded theme-bg-active theme-text-muted" title="该插件提供的贡献">贡献:{c}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <button onClick={() => togglePlugin(p.name, p.enabled)} disabled={toggling === p.name}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${p.enabled ? 'text-green-600 hover:bg-red-50 hover:text-red-600' : 'theme-text-muted hover:theme-bg-active'}`}>
                  {toggling === p.name ? <RefreshCw className="w-4 h-4 animate-spin" /> : p.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
                  {p.enabled ? '已启用' : '已禁用'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
