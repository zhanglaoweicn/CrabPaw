/**
 * TodayOutputRail — 今日产出胶囊（2026-09-21 创新-C；同日按用户反馈移位）
 *
 * 解决老板"我要找上午那份东西"的高频诉求：列出今天登记的文档产物
 * （doc-artifacts 注册表），点击条目用系统默认程序打开。
 *
 * 位置（v2，用户反馈"右下角浮层遮挡消息阅读"）：从 fixed 右下浮层改为
 * 嵌入输入区 footer 右侧的紧凑胶囊——不遮任何内容；展开列表从输入区
 * 上方弹出（absolute 定位，用户主动展开的临时遮挡可接受）。
 *
 * 数据源：GET /api/doc-artifacts（filegen 产物注册表，登记即有；前端按
 * 本地日键过滤今天——口径与 usage-stats localDayKey 修复一致）。
 * 无今日产物整条不渲染（诚实降级）。
 */
import { useEffect, useState } from 'react'
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
  if (count === 0) return null

  // footer 右侧锚点：relative 容器承载上弹列表
  const anchorStyle: React.CSSProperties = {
    position: 'relative', marginLeft: 'auto', display: 'inline-flex', flexShrink: 0,
  }
  const listStyle: React.CSSProperties = {
    position: 'absolute', bottom: 'calc(100% + 10px)', right: 0, zIndex: 60,
    maxHeight: 300, overflowY: 'auto', minWidth: 240, maxWidth: 320,
    borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(18,20,28,0.94)', backdropFilter: 'blur(10px)',
    padding: 6, boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
    display: 'flex', flexDirection: 'column', gap: 2,
  }
  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
    padding: '6px 8px', borderRadius: 8, border: 'none', textAlign: 'left',
    background: 'transparent', color: 'rgba(255,255,255,0.85)', cursor: 'pointer', fontSize: 12,
  }
  const chipStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '2px 9px', borderRadius: 10, fontSize: 11, cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.10)', color: 'rgba(255,255,255,0.55)',
    background: 'transparent',
  }

  return (
    <span style={anchorStyle} data-testid="today-output-rail">
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
          ...chipStyle,
          ...(expanded ? { color: 'rgba(255,255,255,0.85)', borderColor: 'rgba(255,255,255,0.22)' } : {}),
        }}
        title="今天生成的文档产物"
      >
        📦 今日产出 <span style={{ fontWeight: 700 }}>{count}</span>
        <span style={{ opacity: 0.6 }}>{expanded ? '▾' : '▸'}</span>
      </button>
    </span>
  )
}
