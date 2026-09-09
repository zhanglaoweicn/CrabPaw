/**
 * doc-content-parser.ts — 2026-08-23 文档卡载体感知视图的内容解析器
 *
 * 文档生成面板按目标格式切换「载体视图」（WORD 文档流 / PPT 页面轨道 /
 * EXCEL 表格矩阵 / PDF 预览）——四种格式共享同一份 Write 内容（markdown），
 * 差异只在解析视角。纯函数，可单测。
 */

/** PPT 页面：Write 的 markdown 按 # 标题拆页（一个标题 = 一页） */
export interface SlidePage {
  title: string
  level: number
  points: string[]
  raw: string
}

/**
 * parseSlides — 按 markdown 标题（#~##）拆 PPT 页面。
 * 规则：每个 #/## 标题开新页；页面正文 = 标题后的行（要点提取：- 列表项 / 纯文本行去空）；
 * 无标题时的散内容并入第一页（title='首页'）。
 * 深度研究/报告场景 Write 可能是整篇长文——只拆到 ##（避免每小节一页）。
 */
export function parseSlides(markdown: string): SlidePage[] {
  const text = String(markdown || '')
  if (!text.trim()) return []
  const lines = text.split(/\r?\n/)
  const pages: SlidePage[] = []
  let current: SlidePage | null = null
  const push = (p: SlidePage) => { if (p.title || p.points.length) pages.push(p) }
  for (const raw of lines) {
    const m = raw.match(/^(#{1,2})\s+(.+)$/)
    if (m) {
      if (current) push(current)
      current = { title: m[2].trim(), level: m[1].length, points: [], raw: raw.trim() }
      continue
    }
    if (!current) current = { title: '首页', level: 0, points: [], raw: '' }
    const t = raw.trim()
    if (!t || /^(```|---|\*\*\*|___)/.test(t)) continue
    const bullet = t.replace(/^[-*+]\s+/, '')
    if (bullet.length <= 120) current.points.push(bullet)
  }
  if (current) push(current)
  return pages
}

/** EXCEL 表格：markdown 表格 → 列头 + 行数据（Gfm 表格语法） */
export interface ParsedTable {
  headers: string[]
  rows: string[][]
}

/**
 * parseTables — 提取 markdown 中的 Gfm 表格（| a | b | 分隔 + --- 分隔行）。
 * 返回全部表格（首个为主表）；无表格返回 []。
 */
export function parseTables(markdown: string): ParsedTable[] {
  const text = String(markdown || '')
  const lines = text.split(/\r?\n/)
  const tables: ParsedTable[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const cells = line.match(/^\s*\|(.+)\|\s*$/)
    if (!cells) { i += 1; continue }
    // 收集连续表格行（含分隔行）
    const block: string[] = []
    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i += 1 }
    if (block.length < 2) continue
    // 分隔行（|---|）在第二行 → 合法 Gfm 表格；否则跳过（可能是文本装饰）
    if (!/^\s*\|[\s:|-]+\|\s*$/.test(block[1])) continue
    const parseRow = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    const headers = parseRow(block[0]).filter((c, idx) => c !== '' || idx < 0)
    const rows = block.slice(2).map(parseRow)
    tables.push({ headers, rows })
    // 表格行可能被非空行打断——若下一条非空行仍是表格行则继续（跨行场景已覆盖）
  }
  return tables
}
