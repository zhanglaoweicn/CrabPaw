import { useState, useCallback, useRef } from 'react'
import { Search, Zap, ArrowRight, Loader2, ArrowLeft } from 'lucide-react'
import type { RouteResult, ChainSuggestion } from './types'
import { routeMessage, suggestChain } from './api'



interface RouterPanelProps {
  onSummon: (expertId: string) => void
  collapsed?: boolean
  onClose?: () => void
}

export function RouterPanel({ onSummon, collapsed, onClose }: RouterPanelProps) {
  const [input, setInput] = useState('')
  const [results, setResults] = useState<RouteResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [chain, setChain] = useState<ChainSuggestion[]>([])
  const [history, setHistory] = useState<string[]>([])
  const chainReqRef = useRef<string | null>(null)  // 跟踪最新发起的协作链请求
  const routeSeqRef = useRef(0)  // 路由请求序号——连续输入时旧响应不覆盖新结果

  const handleRoute = useCallback(async (msg?: string) => {
    const query = (msg || input).trim()
    if (!query) return
    const mySeq = ++routeSeqRef.current
    setLoading(true)
    try {
      const r = await routeMessage(query)
      if (mySeq !== routeSeqRef.current) return  // 过期响应，丢弃
      setResults(r)
      if (!msg) setHistory(prev => [query, ...prev].slice(0, 5))
      if (r.length > 0) {
        setSelected(r[0].expertId)
        const c = await suggestChain(r[0].expertId)
        if (mySeq === routeSeqRef.current) setChain(c)
      } else {
        setSelected(null)
        setChain([])
      }
    } catch (e: any) {
      console.error('[RouterPanel] route error:', e?.message || e)
      // 失败不清空已显示结果（保留上次匹配），仅停止加载态
    }
    if (mySeq === routeSeqRef.current) setLoading(false)
  }, [input])

  if (collapsed) {
    return null
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b theme-border flex-shrink-0">
        <span className="text-xs font-semibold theme-text-primary flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 theme-accent" />
          路由匹配
        </span>
        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] theme-text-muted hover:theme-text-primary transition-colors"
            style={{ background: 'var(--bg-tertiary)' }}
            title="返回专家团"
          >
            <ArrowLeft className="w-3 h-3" />
            返回
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Input */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 theme-text-muted" />
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleRoute()}
            placeholder="输入你的问题，匹配最合适的专家..."
            className="w-full pl-8 pr-3 py-2 text-xs rounded-lg theme-bg-input theme-text-primary border theme-border focus:outline-none focus:border-accent-primary/50"
          />
        </div>

        {/* Match Results */}
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin theme-accent" />
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] theme-text-muted font-medium uppercase tracking-wider">匹配结果</div>
            {results.map((r, i) => {
              const scoreColor = r.score >= 80 ? '#4caf50' : r.score >= 50 ? '#ff9800' : '#888'
              return (
                <div
                  key={r.expertId}
                  className={`p-3 rounded-xl cursor-pointer transition-all ${
                    selected === r.expertId ? 'ring-2' : 'hover:opacity-80'
                  }`}
                  style={{
                    background: selected === r.expertId ? 'rgba(89,168,255,0.08)' : 'var(--bg-card)',
                    border: `1px solid ${selected === r.expertId ? 'rgba(89,168,255,0.3)' : 'var(--border-primary)'}`,
                  }}
                  onClick={() => {
                    setSelected(r.expertId)
                    chainReqRef.current = r.expertId
                    suggestChain(r.expertId)
                      .then(c => { if (chainReqRef.current === r.expertId) setChain(c) })
                      .catch(e => console.error('[RouterPanel] suggestChain error:', e?.message || e))
                  }}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold theme-text-primary">{r.name}</span>
                      {i === 0 && <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(76,175,80,0.15)', color: '#4caf50' }}>最佳</span>}
                    </div>
                    <span className="text-xs font-mono font-bold" style={{ color: scoreColor }}>{r.score}%</span>
                  </div>

                  {/* Score bar */}
                  <div className="h-1 rounded-full mb-1.5" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="h-full rounded-full transition-all" style={{ width: `${r.score}%`, background: scoreColor }} />
                  </div>

                  {r.reason && (
                    <div className="text-[10px] theme-text-muted">{r.reason}</div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {!loading && input && results.length === 0 && (
          <div className="text-center py-8 theme-text-muted text-xs">未匹配到合适专家，试试更换描述</div>
        )}

        {/* Chain Suggestion */}
        {selected && chain.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] theme-text-muted font-medium uppercase tracking-wider">推荐协作链</div>
            <div className="p-3 rounded-xl flex items-center gap-1.5 flex-wrap" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)' }}>
              {chain.map((c, i) => (
                <span key={c.expertId} className="flex items-center gap-1">
                  {i > 0 && <ArrowRight className="w-3 h-3 theme-text-muted" />}
                  <span className="px-2 py-1 rounded text-[10px]" style={{ background: 'rgba(89,168,255,0.08)', color: '#59a8ff' }}>
                    {c.name}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Quick Action */}
        {selected && (
          <button
            onClick={() => onSummon(selected)}
            className="w-full py-2 rounded-lg text-xs font-medium text-white transition-all"
            style={{ background: 'var(--accent-primary)' }}
          >
            召唤 {results.find(r => r.expertId === selected)?.name || selected} ←
          </button>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] theme-text-muted font-medium uppercase tracking-wider pt-2">最近路由</div>
            {history.map((h, i) => (
              <button key={i} onClick={() => { setInput(h); setTimeout(() => handleRoute(h), 100) }}
                className="w-full text-left px-2 py-1.5 text-[10px] theme-text-muted hover:theme-text-primary rounded hover:theme-bg-tertiary transition-colors truncate">
                {h}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
