/**
 * TodayOutputRail — 今日产出轴（2026-09-21 创新-C）
 *
 * 解决老板"我要找上午那份东西"的高频诉求：对话流右侧折叠徽标
 * 「📦 今日产出 N」，展开列出今天登记的文档产物（doc-artifacts 注册表），
 * 点击条目用系统默认程序打开（electronAPI.shell.openPath）。
 *
 * 数据源：GET /api/doc-artifacts（filegen 产物注册表，登记即有；前端按
 * 本地日键过滤今天——口径与 usage-stats localDayKey 修复一致）。
 * 无今日产物整条不渲染（诚实降级）。
 */
import { useEffect, useMemo, useState } from 'react'
import { apiGet } from '../../lib/api'
import { formatFileSize } from '../../lib/attachment'

interface ArtifactEntry {
  id?: string
  path: string
  name?: string
  title?: string
  format?: string
  size?: number
  updatedAt?: number
  createdAt?: number
  version?: number
}

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isToday(entry: ArtifactEntry): boolean {
  const t = entry.updatedAt || entry.createdAt
  if (!t) return false
  const d = new Date(t)
  const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return k === todayKey()
}

function openFile(p: string) {
  try {
    const shell = (window as any).electronAPI?.shell
    if (shell?.openPath) {
      shell.openPath(p).catch((e: Error) => console.warn('[output-rail] 打开失败:', e?.message || e))
      return
    }
    window.open(`/files/workspace/${encodeURIComponent(p.split(/[\\/]/).pop() || '')}`, '_blank', 'noopener,noreferrer')
  } catch (e) {
    console.warn('[output-rail] 打开失败:', e)
  }
}

export function TodayOutputRail() {
  const [items, setItems] = useState<ArtifactEntry[] | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await apiGet<{ artifacts: ArtifactEntry[] }>('/api/doc-artifacts?limit=100')
        if (alive && r?.success && Array.isArray(r.data?.artifacts)) {
          setItems(r.data.artifacts.filter(isToday))
        }
      } catch {
        // 后端未就绪/无注册表：保持隐藏
      }
    }
    load()
    const timer = setInterval(load, 60 * 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  const count = items?.length ?? 0

  const railStyle = useMemo<React.CSSProperties>(() => ({
    position: 'fixed', right: 16, bottom: 96, zIndex: 60,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
    pointerEvents: 'none',
  }), [])

  if (count === 0) return null

  const listStyle: React.CSSProperties = {
    pointerEvents: 'auto',
    maxHeight: 320, overflowY: 'auto', minWidth: 240, maxWidth: 320,
    borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(18,20,28,0.92)', backdropFilter: 'blur(10px)',
    padding: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
  }
  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '6px 8px', borderRadius: 8, border: 'none', textAlign: 'left',
    background: 'transparent', color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: 12,
  }

  return (
    <div style={railStyle} data-testid="today-output-rail">
      {expanded && (
        <div style={listStyle}>
          {items!.map((a, i) => (
            <button
              key={a.id || `${a.path}-${i}`}
              type="button" style={rowStyle}
              onClick={() => openFile(a.path)}
              title={a.path}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.07)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <span style={{ flexShrink: 0 }}>📄</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {a.title || a.name || a.path.split(/[\\/]/).pop()}
              </span>
              <span style={{ opacity: 0.45, flexShrink: 0 }}>
                {new Date(a.updatedAt || a.createdAt!).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}
              </span>
              {a.size ? <span style={{ opacity: 0.45, flexShrink: 0 }}>{formatFileSize(a.size)}</span> : null}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        style={{
          pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 12px', borderRadius: 16, fontSize: 12, cursor: 'pointer',
          border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.85)',
          background: 'rgba(18,20,28,0.9)', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}
        title="今天生成的文档产物"
      >
        📦 今日产出 <span style={{ fontWeight: 700 }}>{count}</span>
        <span style={{ opacity: 0.6 }}>{expanded ? '▾' : '▸'}</span>
      </button>
    </div>
  )
}
