import { useState, useEffect } from 'react'
import { X, Loader2, CheckCircle2, XCircle, Store } from 'lucide-react'
import { apiGet, apiPost } from '../../lib/api'
import { toast } from 'sonner'

interface ModelPreset {
  id: string
  name: string
  icon: string
  apiUrl: string
  docs: string
  models: { id: string; name: string; context: number }[]
}

interface ModelMarketplaceProps {
  onApply?: (preset: ModelPreset, model: { id: string; name: string }) => void
}

export function ModelMarketplace({ onApply }: ModelMarketplaceProps) {
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<ModelPreset[]>([])
  const [loading, setLoading] = useState(false)
  // 单值 testing 状态在快速连点多个"测活"时互相覆盖（一个请求返回就清空全部）——改为 Set<string> 记录 (providerId-modelId) 组合，各模型独立
  const [testing, setTesting] = useState<Set<string>>(new Set())
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; latency: number; message: string }>>({})

  const load = async () => {
    setLoading(true)
    try {
      const data = await apiGet<{ providers: ModelPreset[] }>('/api/model-ecosystem')
      setProviders((data as { providers?: ModelPreset[] }).providers || [])
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) load()
  }, [open])

  const handleTest = async (p: ModelPreset, m: { id: string; name: string }) => {
    const key = `${p.id}-${m.id}`
    setTesting(prev => new Set(prev).add(key))
    try {
      const result = await apiPost<{ ok: boolean; latency: number; message: string }>('/api/model-ecosystem', {
        apiUrl: p.apiUrl,
        apiKey: '', // 没填就只测端点
        model: m.id,
        providerId: p.id,
      })
      setTestResults((prev) => ({ ...prev, [key]: result.data ?? { ok: false, latency: 0, message: result.error || '' } }))
      if (result.data?.ok) {
        toast.success(`${p.name} · ${m.name} 连通 (${result.data.latency}ms)`)
      } else {
        toast.error(`${p.name} · ${m.name} 失败：${result.data?.message || result.error || '未知'}`)
      }
    } catch (e: any) {
      toast.error(`测试失败: ${e?.message || '未知'}`)
    } finally {
      setTesting(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded theme-btn-secondary"
        title="浏览 11+ 主流 AI 提供商预设"
      >
        <Store className="w-4 h-4" />
        模型市场
      </button>

      {open && (
        <>
          <div className="fixed inset-0 bg-black/40 z-50" onClick={() => setOpen(false)} />
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[760px] max-w-[92vw] max-h-[85vh] z-50 theme-card rounded-xl shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-primary)' }}>
              <div className="flex items-center gap-2">
                <Store className="w-4 h-4 theme-accent" />
                <h2 className="text-base font-semibold theme-text-primary">模型市场</h2>
                <span className="text-xs theme-text-muted">{providers.length} 个提供商</span>
              </div>
              <button onClick={() => setOpen(false)} className="p-1 rounded theme-btn-ghost">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {loading ? (
                <div className="flex items-center justify-center py-10 theme-text-muted">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  加载提供商列表...
                </div>
              ) : (
                <div className="space-y-3">
                  {providers.map((p) => (
                    <div
                      key={p.id}
                      className="border rounded-lg p-3 theme-bg-tertiary"
                      style={{ borderColor: 'var(--border-secondary)' }}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">{p.icon}</span>
                          <span className="font-medium theme-text-primary">{p.name}</span>
                          <span className="text-xs theme-text-muted font-mono">{p.id}</span>
                        </div>
                        <a
                          href={p.docs}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs theme-text-muted hover:theme-text-secondary"
                        >
                          获取 API Key ↗
                        </a>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                        {p.models.map((m) => {
                          const key = `${p.id}-${m.id}`
                          const r = testResults[key]
                          return (
                            <div
                              key={m.id}
                              className="flex items-center justify-between p-2 rounded border theme-bg-secondary"
                              style={{ borderColor: 'var(--border-secondary)' }}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="text-sm theme-text-primary truncate">{m.name}</div>
                                <div className="text-[10px] theme-text-muted">{(m.context / 1000).toFixed(0)}K context</div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {r && (r.ok
                                  ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                                  : <XCircle className="w-3.5 h-3.5 text-red-500" />)}
                                <button
                                  onClick={() => handleTest(p, m)}
                                  disabled={testing.has(key)}
                                  className="text-xs px-2 py-0.5 rounded theme-btn-ghost disabled:opacity-50"
                                  title="测活（不消耗额度）"
                                >
                                  {testing.has(key) ? <Loader2 className="w-3 h-3 animate-spin" /> : '测活'}
                                </button>
                                <button
                                  onClick={() => onApply?.(p, m)}
                                  className="text-xs px-2 py-0.5 rounded theme-btn-primary"
                                  title="使用此配置"
                                >
                                  使用
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )
}
