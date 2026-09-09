import { useEffect, useRef, useState } from 'react'

/**
 * ToolCardStream — 中栏聊天流内嵌工具**结果**卡片（DingDong CardStream 对齐, 纯结果语义）
 *
 * 2026-08-14 用户反馈修正: 对话窗口不应出现"工具内容"(工具名/参数/状态徽标——
 * 右栏过程卡负责)。本组件只渲染工具**产出**:
 * - running 完全不渲染(进行中状态看右栏)
 * - done/error 出现结果卡 → 2.5s 后缩小淡出(不阻塞对话流)
 *
 * 数据流: flow.toolEvents(status/args/result) → 过滤 running → 结果卡。
 * 与三栏职责严格区分: 中栏=对话+结果卡, 右栏=工具执行过程, 左栏=事件时间线。
 */
export interface ToolCardRun {
  toolId: string
  toolName: string
  status: 'running' | 'done' | 'error'
  summary?: string
  args?: string
  result?: string
}

interface CardState {
  toolId: string
  status: 'done' | 'error'
  result?: string
  phase: 'active' | 'closing'
}

/** 结果卡停留时长（DingDong ttl 2.5s 对齐） */
const DONE_TTL_MS = 2500
/** closing 动画时长（须与下方 card-out 动画一致） */
const CLOSING_MS = 600

// 2026-08-15 用户反馈: 音乐类工具(MusicSearch/PlayMusic/MusicControl/Music)的结果
// 不再出工具结果卡——音乐交互统一由 FloatingMusicPlayer 承载(后端 upsert
// music-player surface 自动打开播放器)。此前"播放歌曲"同时出现"音乐搜索卡"
// (本组件的工具结果卡)与"音乐播放器"两个 UI, 二合一语义落在这里。
const MUSIC_TOOLS = new Set(['MusicSearch', 'PlayMusic', 'MusicControl', 'Music'])

// 2026-08-25 用户反馈(与 MUSIC_TOOLS 同款二合一): 文档生成类工具结果卡——
// 此前"生成文档"同时出现本组件的临时结果小卡 与 FileGenPanel 完整文档卡片,
// 用户明确"生成文档只有文档卡片, 不再使用这类临时小卡片"(左侧栏与对话窗口
// 中间的文档内容卡)。文档产出统一由 FileGenPanel(单栏文档流/载体视图)承载。
const FILEGEN_TOOLS = new Set([
  'DocxGenerate', 'XlsxGenerate', 'PptxGenerate', 'PdfGenerate', 'HtmlGenerate',
  'MarkdownToWord', 'MarkdownToPPT', 'MarkdownToPDF', 'Write',
])

/**
 * JSON 启发式解析工具结果 → 展示行列表。
 * 数组 → 前 5 项(取 name/title/path 友好字段, 否则 JSON 截断);
 * 对象 → 前 4 个 label: value; 非 JSON → 空列表(调用方按纯文本渲染)。
 */
function parseResultLines(result: string): string[] {
  const text = result.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return []
  try {
    const obj = JSON.parse(text)
    if (Array.isArray(obj)) {
      return obj.slice(0, 5).map(v => {
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>
          const friendly = o.name ?? o.title ?? o.path ?? o.filename ?? o.fileName
          if (typeof friendly === 'string' && friendly) return friendly
          return JSON.stringify(v).slice(0, 60)
        }
        return String(v)
      })
    }
    if (obj && typeof obj === 'object') {
      return Object.entries(obj as Record<string, unknown>).slice(0, 4).map(([k, v]) => {
        const val = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v)
        return `${k}: ${val}`
      })
    }
  } catch {
    return []
  }
  return []
}

const CARD_CSS = `
@keyframes tool-card-out {
  0% { opacity: 1; transform: scale(1); }
  100% { opacity: 0; transform: scale(0.92) translateY(-4px); }
}
`

export function ToolCardStream({ runs }: { runs: ToolCardRun[] }) {
  const [cards, setCards] = useState<CardState[]>([])
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // flow.toolEvents 变化 → 同步本地结果卡列表（只取 done/error, running 不渲染）
  useEffect(() => {
    setCards(prev => {
      const next: CardState[] = []
      // 保留本地已有的（工具已完成的卡片继续生命周期）
      for (const p of prev) {
        const fresh = runs.find(r => r.toolId === p.toolId)
        if (!fresh) continue // 整轮清空/列表裁剪 → 丢弃
        if (fresh.status === 'running') continue // 状态回退(不应发生)或仍 running
        next.push({ ...p, result: fresh.result ?? p.result })
      }
      // 新增结果卡（新完成的工具；音乐类跳过——归 FloatingMusicPlayer；
      // 文件生成类跳过——归 FileGenPanel 完整文档卡片，不再出临时小卡）
      const known = new Set(next.map(p => p.toolId))
      for (const r of runs) {
        if (r.status !== 'running' && !known.has(r.toolId)
          && !MUSIC_TOOLS.has(r.toolName) && !FILEGEN_TOOLS.has(r.toolName)) {
          next.push({ toolId: r.toolId, status: r.status, result: r.result, phase: 'active' })
        }
      }
      return next
    })
  }, [runs])

  // 结果卡 → 定时 closing → 移除；卸载清理所有定时器
  useEffect(() => {
    for (const card of cards) {
      if (card.phase !== 'active') continue
      const t = setTimeout(() => {
        setCards(prev => {
          const idx = prev.findIndex(c => c.toolId === card.toolId)
          if (idx < 0) return prev
          if (prev[idx].phase === 'closing') return prev
          const next = [...prev]
          next[idx] = { ...next[idx], phase: 'closing' }
          return next
        })
        timersRef.current.delete(t)
      }, DONE_TTL_MS)
      timersRef.current.add(t)
      const t2 = setTimeout(() => {
        setCards(prev => prev.filter(c => c.toolId !== card.toolId))
        timersRef.current.delete(t2)
      }, DONE_TTL_MS + CLOSING_MS)
      timersRef.current.add(t2)
    }
  }, [cards])

  useEffect(() => {
    const timers = timersRef.current
    return () => { for (const t of timers) clearTimeout(t) }
  }, [])

  if (cards.length === 0) return null

  return (
    <>
      <style>{CARD_CSS}</style>
      <div className="tool-card-stream" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        {cards.map(card => <ResultCard key={card.toolId} card={card} />)}
      </div>
    </>
  )
}

/** 纯结果卡: 无工具名/无参数/无状态徽标——只渲染工具产出(用户反馈修正) */
function ResultCard({ card }: { card: CardState }) {
  const failed = card.status === 'error'
  const lines = failed ? [] : parseResultLines(card.result || '')

  return (
    <div
      className={`tool-card tool-card--${card.status}${card.phase === 'closing' ? ' tool-card--closing' : ''}`}
      style={{
        maxWidth: 420,
        borderRadius: 8,
        border: `1px solid ${failed ? 'rgba(248, 113, 113, 0.35)' : 'rgba(56, 189, 248, 0.28)'}`,
        background: failed ? 'rgba(248, 113, 113, 0.05)' : 'rgba(56, 189, 248, 0.05)',
        padding: '6px 10px',
        fontSize: 11,
        lineHeight: 1.5,
        animation: card.phase === 'closing' ? 'tool-card-out 0.6s ease-in forwards' : undefined,
      }}
    >
      {failed ? (
        <div style={{
          fontSize: 10,
          color: 'rgba(248, 113, 113, 0.9)',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}>
          {card.result || '操作失败'}
        </div>
      ) : lines.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {lines.map((line, i) => (
            <div key={i} style={{ fontSize: 10, color: 'rgba(191, 236, 255, 0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {line}
            </div>
          ))}
        </div>
      ) : card.result ? (
        <div style={{
          fontSize: 10,
          color: 'rgba(148, 163, 184, 0.75)',
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
        }}>
          {card.result}
        </div>
      ) : null}
    </div>
  )
}
