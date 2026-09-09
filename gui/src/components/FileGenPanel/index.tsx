/**
 * FileGenPanel — 文件生成面板（2026-08-17，spec: file-generation-panel-design）
 *
 * SideSheet 全屏面板（股票面板同款）。数据源双通道：
 *  - scene surface 'file-panel'（useSceneClient）→ 面板开合 + 快照恢复
 *  - SSE /events filegen:start/phase/done/error → 增量推进状态机
 * 预览分派：md→阅读器 / html→开发模式分屏 / code→代码窗 / 其余→文件卡。
 * 关闭：语音"关闭文件面板"（__filePanel.setVisible(false)）或点击 ✕。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { useSse } from '../../hooks/useSSE'
import { useSceneClient } from '../../lib/scene-client'
import { SideSheet } from '../SideSheet'
import { registerCommandHost } from '../../lib/ui-command-registry'
import { apiGet, apiPost } from '../../lib/api'
import { fileUrlFor } from '../../lib/attachment'
import { stripScripts } from '../../lib/sanitize'
// 2026-08-23: 文档卡载体感知视图的内容解析器（PPT 页面轨道 / EXCEL 表格矩阵）
// 2026-09-06: 降级为兜底——优先渲染后端解析结构（filegen:doc-structure / 直出参数回填）
import { parseSlides, parseTables, type SlidePage, type ParsedTable } from '../../lib/doc-content-parser'
import './styles.css'

export interface FileGenTask {
  taskId: string | null
  title: string
  format: string        // md|html|code|docx|xlsx|pptx|pdf|txt
  // 2026-09-06 状态机 v2: + paused（等待补充需求/可继续生成）、cancelled（用户取消）
  phase: 'idle' | 'collect' | 'writing' | 'converting' | 'paused' | 'done' | 'error' | 'cancelled'
  label: string
  file: FileGenFile | null
  files: FileGenFile[]  // R2-4: done 态产物清单（多文件网页 html+css+js 产物）
  error: string | null
  sources?: FileGenSource[] // 2026-08-23: 研究阶段收集的资料（filegen:source 累积）
  autoDocx?: boolean        // 2026-09-06: 步骤表分流（md 是否含"格式转换"步）
  startedAt?: number | null // 2026-09-06: 实时计时
  originalMessage?: string | null // 2026-09-06: error/paused 态"重新生成"复用
  expertName?: string | null // 2026-09-06: 执笔专家署名（激活专家时开卡传入，卡片头徽标）
}

/** 2026-08-23: 一次搜索收集的资料（🔍 关键词 → 来源标题+链接） */
export interface FileGenSource {
  query: string
  sources: { title: string; url: string; snippet: string }[]
  ts: number
}

/** 生成产物文件（SSE filegen:done 的 file 字段） */
export interface FileGenFile {
  path: string
  name: string
  size: number
  format: string
  url: string | null
}

/** 2026-08-28 SP-4: 历史产物条目（GET /api/doc-artifacts 的 artifacts 元素）
 *  2026-09-03 Artifact 深化轮: 补版本/状态/血缘/历史版本字段 */
export interface HistoryArtifact {
  id: string
  path: string
  name: string
  size: number
  format: string
  url: string | null
  taskId: string
  createdAt: number
  version?: number
  status?: 'completed' | 'failed' | string
  runId?: string
  versions?: Array<{ version: number; path: string; size?: number; createdAt?: number; runId?: string }>
}

const PHASE_LABEL: Record<FileGenTask['phase'], string> = {
  idle: '待命', collect: '收集资料', writing: '撰写中', converting: '转换中',
  paused: '已暂停', done: '完成', error: '失败', cancelled: '已取消',
}

// 2026-08-17: 文件生成流程指示器（用户需求：①资料搜集→②大纲编写→③内容撰写→④文档生成，
// 每一步可视化）。②大纲编写 = writing 阶段未出现写入调用前的模型构思期（thinking 流可见）；
// ③内容撰写 = Write/Edit 工具调用出现后。
// 2026-08-23: 双卡片架构——网页版（编码心智）四步 ③编码 ④实时预览；
// 文档版（创作者心智）五步 ③撰写 ④格式转换 ⑤成品。
const WEB_STEPS = [
  { n: 1, label: '资料搜集' },
  { n: 2, label: '大纲' },
  { n: 3, label: '编码' },
  { n: 4, label: '实时预览' },
] as const

const DOC_STEPS = [
  { n: 1, label: '资料搜集' },
  { n: 2, label: '大纲' },
  { n: 3, label: '撰写' },
  { n: 4, label: '格式转换' },
  { n: 5, label: '成品' },
] as const

// 2026-09-06: 纯 md 文章无转换步——autoDocx=false 的 md 任务用四步表，
// 治"done 时第 4 步『格式转换』自动变 ✓"的错位
const DOC_STEPS_NO_CONV = [
  { n: 1, label: '资料搜集' },
  { n: 2, label: '大纲' },
  { n: 3, label: '撰写' },
  { n: 4, label: '成品' },
] as const

/** 2026-09-08: 海报四步（①需求理解 ②文案与底图 ③排版合成 ④成品）——
 *  双层渲染工作流（AI 底图 + HTML 确定性排版），phase→步骤映射见 currentStep */
const POSTER_STEPS = [
  { n: 1, label: '需求理解' },
  { n: 2, label: '文案与底图' },
  { n: 3, label: '排版合成' },
  { n: 4, label: '成品' },
] as const

/** 2026-09-06: 步骤表按任务形态分流（html 四步 / 纯 md 四步 / 转换类五步 / poster 四步） */
function stepsFor(format: string, autoDocx?: boolean) {
  if (format === 'html') return WEB_STEPS
  if (format === 'poster') return POSTER_STEPS
  if (format === 'md' && !autoDocx) return DOC_STEPS_NO_CONV
  return DOC_STEPS
}

/** 写入类工具调用 → 当前步骤推进到 ③撰写/编码 */
const WRITE_TOOLS = new Set(['Write', 'Edit'])
/** 2026-08-31: 直接生成类工具(DocxGenerate 等, 无 Write 流) → step 也推进 ③撰写——
 *  此前 sawWrite 恒 false 停在 ②大纲, 面板表现与真实进程不一致 */
const GENERATE_TOOLS = new Set(['DocxGenerate', 'XlsxGenerate', 'PptxGenerate', 'PdfGenerate',
  'HtmlGenerate', 'MarkdownToWord', 'MarkdownToPPT', 'MarkdownToPDF', 'MarkdownToHTML', 'MarkdownToExcel'])

/** 阶段 → 当前步骤号（0 = 无流程进行）。网页四步 vs 文档五步/纯md四步按 format 分流。
 *  2026-09-06: done 步号按实际步骤表算——纯 md（无 autoDocx）done=4，不再让
 *  不存在的"格式转换"步自动变 ✓ */
function currentStep(format: string, phase: FileGenTask['phase'], sawWrite: boolean, sawGenerate = false, autoDocx?: boolean): number {
  if (format === 'poster') {
    if (phase === 'collect') return 1
    if (phase === 'writing') return 2
    if (phase === 'converting') return 3
    if (phase === 'done') return 4
    return 0
  }
  switch (phase) {
    case 'collect': return 1
    case 'writing': return (sawWrite || sawGenerate) ? 3 : 2
    case 'converting': return 4
    case 'done': return format === 'html' ? 4 : (format === 'md' && !autoDocx ? 4 : 5)
    // 2026-09-06: paused 保持当前流程位置（不归零）——writing 后暂停显示 ③
    case 'paused': return (sawWrite || sawGenerate) ? 3 : 2
    default: return 0
  }
}

// ─── 2026-09-06: 结构映射（后端/直出 → 载体视图模型）───
// 后端 slides 结构（markdown-slides.js parseMarkdownToSlides）→ 前端 SlidePage
function mapBackendSlide(p: any): SlidePage {
  const points: string[] = []
  if (p?.subtitle) points.push(String(p.subtitle))
  if (Array.isArray(p?.bullets)) points.push(...p.bullets.map(String))
  if (p?.type === 'table') {
    if (Array.isArray(p?.headers) && p.headers.length) points.push(p.headers.join(' | '))
    if (Array.isArray(p?.rows)) points.push(...p.rows.map((r: any[]) => (r || []).map(String).join(' | ')))
  }
  if (Array.isArray(p?.points)) points.push(...p.points.map(String))
  if (p?.conclusion) points.push(String(p.conclusion))
  return { title: String(p?.title || '未命名页'), level: p?.type === 'title' ? 1 : 2, points, raw: '' }
}

// 直出 PptxGenerate slide 参数 → SlidePage（bullets/points/items 别名 + 两列/表格/结论合并）
function mapDirectSlide(s: any): SlidePage {
  const points: string[] = []
  if (s?.subtitle) points.push(String(s.subtitle))
  const bullets = s?.bullets || s?.points || s?.items
  if (Array.isArray(bullets)) points.push(...bullets.map(String))
  if (Array.isArray(s?.left)) points.push(...s.left.map(String))
  if (Array.isArray(s?.right)) points.push(...s.right.map(String))
  if (Array.isArray(s?.headers) && s.headers.length) points.push(s.headers.join(' | '))
  if (Array.isArray(s?.rows)) points.push(...s.rows.map((r: any[]) => (r || []).map(String).join(' | ')))
  if (s?.conclusion) points.push(String(s.conclusion))
  return { title: String(s?.title || '未命名页'), level: s?.type === 'title' || s?.layout === 'title' ? 1 : 2, points, raw: '' }
}

// 直出 XlsxGenerate sheet 参数 → ParsedTable（防御式取字段，sheets/data.sheets 双兼容）
function mapDirectSheet(sheet: any): ParsedTable | null {
  const headers = sheet?.headers || sheet?.header
  const rows = sheet?.rows || sheet?.data
  if (!Array.isArray(headers) || !headers.length) return null
  return {
    headers: headers.map(String),
    rows: Array.isArray(rows) ? rows.map((r: any) => Array.isArray(r) ? r.map(String) : [String(r)]) : [],
  }
}

export function FileGenPanel() {
  const surface = useSceneClient('file-panel')
  const [dismissed, setDismissed] = useState(false)
  const dismissedRef = useRef(false)
  dismissedRef.current = dismissed
  const [voiceVisible, setVoiceVisible] = useState(false)
  // 快照（scene surface 优先，SSE 增量覆盖）
  const [task, setTask] = useState<FileGenTask>({
    taskId: null, title: '', format: '', phase: 'idle', label: '', file: null, files: [], error: null, sources: [],
  })
  // 2026-08-23: 资料区折叠开关（研究阶段🔍资料展示；可收起避免挤压文档流）
  const [sourcesOpen, setSourcesOpen] = useState(true)
  const taskRef = useRef(task)
  taskRef.current = task
  // 2026-08-28 SP-4: 历史产物（doc-artifacts 注册表最近 5 条）——挂载时拉取;
  // filegen:done 后延迟再拉（后端注册发生在广播之后, 稍等避开落盘竞态）
  const [artifacts, setArtifacts] = useState<HistoryArtifact[]>([])
  const refreshArtifacts = useCallback(() => {
    // 2026-09-06: limit 5→50——历史区新增搜索过滤，拉全量后客户端过滤
    apiGet('/api/doc-artifacts?limit=50').then((res: any) => {
      const list = res?.data?.artifacts
      if (Array.isArray(list)) setArtifacts(list)
    }).catch((e: any) => console.warn('[filegen-panel] 历史产物拉取失败:', e?.message))
  }, [])
  useEffect(() => { refreshArtifacts() }, [refreshArtifacts])
  // 2026-09-07: 发送到企微——文件卡操作条按钮状态（requestSendToWecom 结果回显）
  const [wecomSend, setWecomSend] = useState<{ path: string; state: 'sending' | 'ok' | 'error'; msg: string } | null>(null)
  const sendFileToWecom = useCallback(async (p: string) => {
    setWecomSend({ path: p, state: 'sending', msg: '正在发送到企业微信…' })
    const r = await requestSendToWecom(p)
    setWecomSend({ path: p, state: r.ok ? 'ok' : 'error', msg: r.msg })
  }, [])
  // 2026-08-17 R2-4: 代码流按文件分组（多文件网页产物 html+css+js 分 tab 展示）；
  // 2026-08-23 降噪: 仅 Write/Edit 的真实代码行进 codeGroups（组顺序 = 首次出现顺序）——
  // 工具调用标题行/搜索帧/thinking 帧改走操作日志 logLines（折叠条），网页版主区
  // 呈现「编码过程」而非「工具调用过程」（用户 2026-08-23 双卡片反馈第 2 点）。
  const [codeGroups, setCodeGroups] = useState<{ name: string; lines: string[] }[]>([])
  const [activeTab, setActiveTab] = useState('')
  // 2026-08-23: 操作日志（thinking/工具调用标题/搜索帧）——折叠条，网页版默认收起
  const [logLines, setLogLines] = useState<string[]>([])
  const appendLog = useCallback((line: string) => {
    setLogLines(prev => [...prev.slice(-59), line])
  }, [])
  // 2026-08-17: 是否已出现写入类工具调用——四步指示器 ②大纲编写→③内容撰写 的细分信号
  const [sawWrite, setSawWrite] = useState(false)
  const [sawGenerate, setSawGenerate] = useState(false)
  const startTsRef = useRef<number | null>(null)
  // R2-2: Write 工具调用计数——iframe 刷新信号（每次 Write 工具调用刷新预览）
  const [writeTick, setWriteTick] = useState(0)
  // R2-2: 最近写出的主 html 文件路径（生成中 iframe 预览目标；done 后切 file.url）
  const [mainHtmlPath, setMainHtmlPath] = useState('')
  // 2026-08-22 UI 迭代（方案 A）: 文章单栏文档流——Write 写出的完整内容（md/docx 场景）。
  // 与 codeGroups（代码行滚入）并存：html 走代码流双栏，md/docx 走文档流单栏。
  // Write 是覆盖语义（模型一次 Write 写完整篇），Edit 增量第一版不支持（保持显示）。
  const [docText, setDocText] = useState('')
  // 2026-09-06 状态机 v2: 载体视图结构化数据——后端 doc-structure 广播 / 直出工具
  // 参数回填优先，本地 parseSlides/parseTables 降级兜底（预览=产物单一事实源）
  const [slideData, setSlideData] = useState<SlidePage[] | null>(null)
  const [tableData, setTableData] = useState<ParsedTable[] | null>(null)
  // 2026-09-06: HtmlGenerate 直出内容 blob 预览（无文件落盘前 iframe 即可预览）
  const [htmlBlobUrl, setHtmlBlobUrl] = useState<string | null>(null)
  const htmlBlobUrlRef = useRef<string | null>(null)
  // 2026-09-06: 卡住兜底——最近一次 phase 变化时刻（filegen:start/phase 刷新），
  // 进行中超 120s 无变化 → 状态条提示"可能卡住" + 取消按钮高可用
  const lastPhaseChangeRef = useRef<number>(Date.now())
  const [stuck, setStuck] = useState(false)
  // 2026-09-06: 实时计时（活跃 phase 每秒重渲染状态条）
  const [nowTick, setNowTick] = useState(Date.now())
  // 2026-09-06: 历史产物搜索过滤（客户端）
  const [historyQuery, setHistoryQuery] = useState('')
  // 2026-09-06: 引用-正文联动——资料条目点击 → 文档流定位高亮
  const [highlightTarget, setHighlightTarget] = useState<{ seq: number; terms: string[] } | null>(null)
  // 2026-09-06: 历史产物搜索过滤（客户端，名称包含匹配）
  const filteredArtifacts = useMemo(() => {
    const q = historyQuery.trim().toLowerCase()
    if (!q) return artifacts
    return artifacts.filter(a => (a.name || '').toLowerCase().includes(q))
  }, [artifacts, historyQuery])
  // done toast 的"查看"动作需要最新 setVisible（SSE handler 闭包捕获问题）
  const setVisibleRef = useRef<(open: boolean) => void>(() => {})
  // 2026-08-18 实机反馈修复 G2: 多行批量追加——Write/Edit 的 content/new_string 按行
  // 滚入文件组（单次 setState 批量提交, 逐行渲染 + 行索引错峰动画呈现"逐行写代码"过程）
  const appendLinesToGroup = useCallback((name: string, newLines: string[]) => {
    if (!newLines.length) return
    setCodeGroups(prev => {
      const idx = prev.findIndex(g => g.name === name)
      const append = (lines: string[]) => [...lines, ...newLines].slice(-199)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { name, lines: append(next[idx].lines) }
        return next
      }
      const procIdx = prev.findIndex(g => g.name === '过程')
      const group = { name, lines: newLines }
      const next = [...prev]
      if (procIdx >= 0) next.splice(procIdx, 0, group)
      else next.push(group)
      return next
    })
  }, [])
  // SSE 驱动（增量覆盖快照；旧任务事件忽略——任务覆盖语义）
  useSse({
    path: '/events',
    // 2026-08-20: SSE 断连重连后对账——done/error 事件可能在断开期间丢失,
    // 面板永久卡在"撰写中"。连接(含重连)建立时拉 /api/filegen/status 快照,
    // 终态(done/error)恢复; 进行中任务快照幂等覆盖, 无副作用。
    onStatus: (status) => {
      if (status !== 'open') return
      apiGet('/api/filegen/status').then((res: any) => {
        const st = res?.data
        if (st && st.taskId && taskRef.current.taskId && taskRef.current.taskId === st.taskId) {
          setTask(prev => ({ ...prev, ...st }))
        }
      }).catch((e: any) => console.warn('[filegen-panel] 状态对账失败:', e?.message))
    },
    handlers: {
      // Artifact 深化轮: 产物注册/版本升级实时刷新历史清单（注册点在后端 filegen:done
      // 广播之后, artifact:updated 是"登记完成"的可靠信号）
      'artifact:updated': () => { refreshArtifacts() },
      'filegen:start': (d: any) => {
        if (d?.taskId) {
          // 2026-08-17 实机回归: 不再 setDismissed(false)——用户主动关闭(dismissed=true)
          // 后, 新任务 start 不得复活面板(此前"关闭文档卡片"后下次写文档又自动弹出)。
          // 面板显示由 surface 存在性驱动(首次任务 start 时后端已 upsert surface → 自动
          // 打开, 过程可视化不受影响); 用户想再看进度, 语音"打开文件面板"即恢复。
          setCodeGroups([]) // 新任务清空旧代码流分组
          setActiveTab('') // 2026-08-23 降噪: 默认 tab 交给首个文件组（不再有 '过程' 组）
          setLogLines([]) // 2026-08-23: 新任务清空操作日志
          setSawWrite(false) // 新任务回到 ①资料搜集
          setSawGenerate(false)
          startTsRef.current = Date.now()
          setMainHtmlPath('') // R2-2: 清空上一任务主 html 路径（防止新任务预览旧文件）
          setDocText('') // 2026-08-22 UI 迭代: 新任务清空文档流内容
          setSourcesOpen(true) // 2026-08-23: 新任务资料区默认展开
          setWriteTick(0) // 2026-09-06: iframe 破缓存计数一并归零
          setSlideData(null) // 2026-09-06: 清空后端结构/直出回填数据
          setTableData(null)
          if (htmlBlobUrlRef.current) { try { URL.revokeObjectURL(htmlBlobUrlRef.current) } catch { /* noop */ } }
          htmlBlobUrlRef.current = null
          setHtmlBlobUrl(null)
          lastPhaseChangeRef.current = Date.now() // 2026-09-06: 卡住判定锚点重置
          setStuck(false)
          setTask({ taskId: d.taskId, title: d.title || '', format: d.format || '', phase: 'collect', label: '正在收集资料…', file: null, files: [], error: null, sources: [], expertName: d.expertName || null })
        }
      },
      'filegen:phase': (d: any) => {
        if (d?.taskId && taskRef.current.taskId === d.taskId) {
          lastPhaseChangeRef.current = Date.now()
          setStuck(false)
          setTask(prev => ({ ...prev, phase: d.phase, label: d.label || '' }))
        }
      },
      'filegen:done': (d: any) => {
        if (d?.taskId && taskRef.current.taskId === d.taskId) {
          // 2026-08-21: 任务完成——过程流清掉进行时瞬态行(「正在…/⏳ 正在执行…」)。
          // 此前它们随 thinking 帧滚入左侧代码流后一直滞留, 与顶部步骤全✓、右侧成品
          // 三处状态互相矛盾(用户反馈「逻辑混乱」)。tool_call 记录行(⟪…⟫)保留。
          setCodeGroups(prev => prev.map(g => ({ ...g, lines: g.lines.filter(l => !/^(正在|⏳)/.test(l.trim())) })))
          setTask(prev => {
            // R2-4: done 态产物清单——done 事件已携带 files（后端去重累积），缺省退化单文件
            const files: FileGenFile[] = (Array.isArray(d.files) && d.files.length > 0)
              ? d.files
              : (d.file ? [d.file] : [])
            // final-review P2 修复: 多文件网页最后写 css/js 时, done 不得被最后产物
            // format 翻转成 'code' 丢页面预览——产物含 html 文件则保持 html,
            // 且主文件取 html 文件（页面预览/操作条指向主产物而非 css 子文件）
            const htmlFile = files.find((f: any) => /\.html?$/i.test(f?.path || f?.name || '')) || null
            const format = htmlFile ? 'html' : (d?.file?.format ?? prev.format)
            const file = htmlFile || d.file || prev.file
            return { ...prev, phase: 'done', file, files, format }
          })
          // R2-3 修订（2026-09-06 通知分层）: done 不再强制滑入面板——对"我正在干
          // 别的事"的用户是打断式通知。改为右下角 toast（点击查看再滑入）+ 语音
          // 一句话播报。面板开着时 toast 不发（用户正看着结果）。
          if (dismissedRef.current) {
            try {
              toast.success(`文档已生成：${d.file?.name || '文件'}`, {
                description: taskRef.current.title || undefined,
                action: { label: '查看', onClick: () => setVisibleRef.current(true) },
                duration: 8000,
              })
            } catch (e) { console.warn('[filegen-panel] toast 展示失败:', e) }
            try {
              window.dispatchEvent(new CustomEvent('crabpaw:speak', {
                detail: { id: `filegen_done_${d.taskId}`, text: `文档已生成：${d.file?.name || '文件'}` },
              }))
            } catch (e) { console.warn('[filegen-panel] 播报请求失败:', e) }
          }
          // 2026-08-28 SP-4: done 后刷新历史产物区（注册在广播后异步落盘——延迟拉取）
          setTimeout(() => refreshArtifacts(), 800)
        }
      },
      'filegen:error': (d: any) => {
        if (d?.taskId && taskRef.current.taskId === d.taskId) {
          lastPhaseChangeRef.current = Date.now()
          setTask(prev => ({ ...prev, phase: 'error', error: d.message || '生成失败' }))
        }
      },
      // 2026-09-06 状态机 v2: 用户取消 / 卡住兜底取消 → 终态 cancelled
      'filegen:cancelled': (d: any) => {
        if (d?.taskId && taskRef.current.taskId === d.taskId) {
          setTask(prev => ({ ...prev, phase: 'cancelled', label: '已取消' }))
        }
      },
      // 2026-09-06 状态机 v2: 产物登记事件（Write/Edit 不再触发 done）——
      // 产物清单实时累积 + html 主产物即时可预览
      'filegen:artifact': (d: any) => {
        if (d?.taskId && taskRef.current.taskId === d.taskId && d.file?.path) {
          setTask(prev => {
            const files = (prev.files || []).some(f => f.path === d.file.path)
              ? prev.files
              : [...(prev.files || []), d.file]
            // html 产物 → 任务格式定格 html（多文件网页中途到达的 css/js 不降级）
            const isHtml = /\.html?$/i.test(d.file.path || '')
            return {
              ...prev,
              files,
              file: isHtml ? d.file : (prev.file && /\.html?$/i.test(prev.file.path || '') ? prev.file : (prev.file || d.file)),
              format: isHtml && prev.format !== 'html' ? 'html' : prev.format,
            }
          })
          if (/\.html?$/i.test(d.file.path || '')) setMainHtmlPath(d.file.path)
        }
      },
      // 2026-09-06 预览单一事实源: 后端解析结构（Write md 源 + pptx/xlsx 任务时广播）——
      // 前端载体视图优先渲染，本地解析降级兜底
      'filegen:doc-structure': (d: any) => {
        if (d?.taskId && taskRef.current.taskId === d.taskId) {
          if (d.kind === 'slides' && Array.isArray(d.pages)) {
            setSlideData(d.pages.map(mapBackendSlide))
          } else if (d.kind === 'tables' && Array.isArray(d.tables)) {
            setTableData(d.tables.map((t: any) => ({ headers: t.headers || [], rows: t.rows || [] })))
          }
        }
      },
      // 2026-08-23: 研究阶段资料来源（WebSearch 插桩广播）——🔍 关键词 → 来源列表
      'filegen:source': (d: any) => {
        if (d?.taskId && taskRef.current.taskId === d.taskId && Array.isArray(d.sources) && d.sources.length) {
          const entry: FileGenSource = {
            query: String(d.query || '').slice(0, 100),
            sources: d.sources.map((s: any) => ({
              title: String(s?.title || '').slice(0, 120),
              url: String(s?.url || '').slice(0, 300),
              snippet: String(s?.snippet || '').slice(0, 200),
            })),
            ts: Date.now(),
          }
          setTask(prev => ({ ...prev, sources: [...(prev.sources || []), entry] }))
        }
      },
      // 2026-08-23 降噪: thinking 帧 → 操作日志（此前滚入 '过程' 组混在代码流里，
      // 网页版主区被工具调用/思考行占据，「编码过程」不可见）
      'thinking': (d: any) => {
        // 2026-08-21: 任务已终态(done/error)后迟到的瞬态帧不再记录——
        // 防 SSE 乱序把「正在…」行追加进已完成任务的日志
        if (taskRef.current.phase === 'done' || taskRef.current.phase === 'error') return
        const text = d?.content ?? d?.text ?? d?.thinking ?? ''
        if (text) appendLog(String(text))
      },
      'tool_call': (d: any) => {
        if (taskRef.current.phase === 'done' || taskRef.current.phase === 'error') return
        try {
          // 实机对齐（src/core/ai.js onChunk）：tool_call 帧字段为
          // toolName/toolId/toolArgs/cardState（旧 name/args 兜底兼容）
          const name = d?.toolName || d?.name || d?.tool || d?.call?.name || ''
          const args = d?.toolArgs ?? d?.args ?? d?.call?.args ?? null
          let parsed: any = args
          if (typeof args === 'string') {
            try { parsed = JSON.parse(args) } catch (e) { console.warn('[filegen] toolArgs 非 JSON，按无参数处理:', e); parsed = null }
          }
          // R2-4: 解析文件路径归组（Write/Edit 工具才有 path/file_path）
          const p = (parsed && (parsed.path ?? parsed.file_path)) || ''
          const groupName = (typeof p === 'string' && p)
            ? String(p).replace(/\\/g, '/').split('/').pop() || '过程'
            : '过程'
          // 2026-08-18 实机反馈修复 G2: 标题行只带路径——此前整个 toolArgs 参数 JSON
          // （含 Write content 全量）被拼成一条巨长行, 代码流没有"写代码"过程感
          // 2026-08-23 降噪: 标题行改走操作日志——codeGroups 只保留真实代码行
          appendLog(`⟪${name}⟫${p ? ` ${p}` : ''}`)
          // 2026-08-23: 搜索帧——WebSearch/WebFetch 把关键词/URL 记入操作日志
          // （🔍 搜索: xxx），配合资料区让「搜集资料」阶段可见（后端插桩可能滞后于帧）
          if (name === 'WebSearch' && parsed && typeof parsed.query === 'string') {
            appendLog(`🔍 搜索: ${parsed.query.slice(0, 100)}`)
          } else if (name === 'WebFetch' && parsed && typeof parsed.url === 'string') {
            appendLog(`🔍 抓取: ${parsed.url.slice(0, 100)}`)
          }
          // 编码过程可视化: Write 的 content / Edit 的 new_string 按行滚入文件组
          // （与 iframe 预览同源的原始代码, 行级 reveal 动画呈现逐行写出）
          if (parsed && typeof parsed === 'object' && WRITE_TOOLS.has(name)) {
            const codeText = name === 'Write' ? parsed.content : parsed.new_string
            if (typeof codeText === 'string' && codeText.length > 0) {
              const codeLines = codeText.split(/\r?\n/)
              const MAX_CODE_LINES = 400
              appendLinesToGroup(groupName, codeLines.length > MAX_CODE_LINES
                ? [...codeLines.slice(0, MAX_CODE_LINES), `…（代码过长，省略 ${codeLines.length - MAX_CODE_LINES} 行）`]
                : codeLines)
            }
          }
          // R2-2: 最近写出的主 html 文件路径（生成中 iframe 预览目标；done 后切 file.url）
          if (p && typeof p === 'string' && /\.html?$/i.test(p)) setMainHtmlPath(p)
          // 2026-08-22 UI 迭代（方案 A）: 文章单栏文档流——Write 全量内容覆盖 docText
          // （模型一次 Write 写完整篇；Edit 增量修改第一版不支持，保持当前显示）
          if (name === 'Write' && parsed && typeof parsed.content === 'string') {
            setDocText(parsed.content)
          }
          // 流程指示器：写入类工具调用 → 步骤推进到 ③撰写/编码
          if (WRITE_TOOLS.has(name)) { setSawWrite(true); setWriteTick(t => t + 1) }
          if (GENERATE_TOOLS.has(name)) { setSawGenerate(true); setWriteTick(t => t + 1) }
          // 2026-09-06 直出参数回填: 直出工具的 tool_call 帧带完整结构化参数——
          // 解析进载体视图，让 PptxGenerate/XlsxGenerate/HtmlGenerate/DocxGenerate
          // 直出路径与 Write 路径共享同一套"逐页/逐表/逐段生长"预览（此前只有一行 label）
          if (parsed && typeof parsed === 'object') {
            if (name === 'PptxGenerate' && Array.isArray(parsed.slides)) {
              setSlideData(parsed.slides.map(mapDirectSlide))
            } else if (name === 'XlsxGenerate') {
              const sheets = Array.isArray(parsed.sheets)
                ? parsed.sheets
                : (parsed.data && Array.isArray(parsed.data.sheets) ? parsed.data.sheets : null)
              if (sheets) setTableData(sheets.map(mapDirectSheet).filter((t: ParsedTable | null): t is ParsedTable => !!t))
            } else if (name === 'HtmlGenerate' && typeof parsed.content === 'string' && parsed.content.length > 0) {
              // 直出 html：blob 预览即时可用（不等文件落盘 done）+ 代码流同步滚入
              try {
                if (htmlBlobUrlRef.current) { try { URL.revokeObjectURL(htmlBlobUrlRef.current) } catch { /* noop */ } }
                const url = URL.createObjectURL(new Blob([parsed.content], { type: 'text/html' }))
                htmlBlobUrlRef.current = url
                setHtmlBlobUrl(url)
              } catch { /* blob 失败降级为等待 done 文件预览 */ }
              appendLinesToGroup(groupName || 'index.html', parsed.content.split(/\r?\n/))
            } else if (name === 'DocxGenerate' && typeof parsed.content === 'string' && parsed.content.length > 0) {
              setDocText(parsed.content)
            }
          }
        } catch (e) { console.warn('[filegen] 代码流解析失败:', e) }
      },
    },
  })

  // 2026-08-25 兜底对账: SSE 事件可能因 sse-hub 退避窗口丢失(done 广播已发但前端
  // 未收), 此前仅"重连时"对账一次——生成中(collect/writing/converting)每 10s 拉
  // /api/filegen/status 快照, 终态(done/error)即收敛停止; 快照幂等覆盖无副作用。
  // 2026-09-06: ①同 phase 也全量合并（含 sources——治 SSE 丢 source 事件资料区缺失）；
  // ②卡住兜底——进行中超 120s 无 phase 变化 → 提示"可能卡住"+取消按钮；③终态
  // (含 paused/cancelled)停止轮询与计时。
  useEffect(() => {
    const t = setInterval(() => {
      const phase = taskRef.current.phase
      const active = phase === 'collect' || phase === 'writing' || phase === 'converting'
      if (!active) { setStuck(false); return }
      const stalled = Date.now() - lastPhaseChangeRef.current > 120000
      setStuck(stalled)
      apiGet('/api/filegen/status').then((res: any) => {
        const st = res?.data
        if (st && st.taskId && taskRef.current.taskId && taskRef.current.taskId === st.taskId) {
          setTask(prev => {
            // 终态到达（轮询捕获 SSE 丢失的 done/error）→ 全量采纳
            if (st.phase !== prev.phase) return { ...prev, ...st }
            // 同 phase：幂等合并（sources/files/label 心跳均同步）
            const same = st.label === prev.label
              && (st.sources?.length ?? 0) === (prev.sources?.length ?? 0)
              && (st.files?.length ?? 0) === (prev.files?.length ?? 0)
            return same ? prev : { ...prev, ...st }
          })
        }
      }).catch(() => { /* 状态端点不可用时静默, SSE 主通道兜底 */ })
    }, 10000)
    return () => clearInterval(t)
  }, [])

  // 2026-09-06: 实时计时心跳——活跃任务每秒重渲染状态条（"已进行 N 秒"）
  useEffect(() => {
    const phase = task.phase
    if (phase !== 'collect' && phase !== 'writing' && phase !== 'converting') return
    const t = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [task.phase])

  // surface 快照恢复（面板重开时 scene store 已有最新状态）
  useEffect(() => {
    const d = surface?.data
    if (d && typeof d === 'object' && d.taskId) {
      // 新任务快照（不同 taskId）→ 四步指示器回到 ①资料搜集
      if (taskRef.current.taskId !== d.taskId) setSawWrite(false)
      setTask(prev => ({ ...prev, ...d } as FileGenTask))
    }
  }, [surface])

  const visible = (voiceVisible || !!surface) && !dismissed
  // 流程指示器当前步（网页四步：资料搜集→大纲→编码→实时预览 / 文档五步：…→撰写→格式转换→成品
  // / 纯 md 四步：无"格式转换"——2026-09-06）
  const step = currentStep(task.format, task.phase, sawWrite, sawGenerate, task.autoDocx)
  // 2026-09-06: 步骤表按任务形态分流（html / 纯 md / 转换类）
  const steps = stepsFor(task.format, task.autoDocx)
  // 2026-09-06: 实时耗时文本（活跃任务每秒跳动；startedAt 后端下发，startTsRef 兜底）
  const elapsedText = useMemo(() => {
    const base = task.startedAt || startTsRef.current
    if (!base) return ''
    const sec = Math.max(1, Math.round((nowTick - base) / 1000))
    if (sec < 60) return `${sec} 秒`
    return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
  }, [task.startedAt, nowTick])

  // 2026-09-06: 取消任务（collect/writing/converting/paused 均可）
  const cancelTask = useCallback(() => {
    const tid = taskRef.current.taskId
    if (!tid) return
    apiPost('/api/filegen/cancel', { taskId: tid }).catch((e: any) => console.warn('[filegen-panel] 取消失败:', e?.message))
  }, [])

  // 2026-09-06: 重新生成——经 VoiceShell 消息桥重发原始请求（error/paused 态）
  const resendTask = useCallback(() => {
    const msg = taskRef.current.originalMessage || taskRef.current.title
    if (!msg) return
    try { window.dispatchEvent(new CustomEvent('crabpaw:send-message', { detail: { text: msg } })) } catch (e) { console.warn('[filegen-panel] 消息桥派发失败:', e) }
  }, [])

  // 2026-09-06 恢复链路: "继续生成"≠"重新生成"——发继续类短消息走后端恢复通道
  //（复活暂停任务/保留已收集资料与产物，卡片从暂停处续跑）；"重新生成"重发原始
  // 请求会开新任务、清空旧产物。
  const continueTask = useCallback(() => {
    try { window.dispatchEvent(new CustomEvent('crabpaw:send-message', { detail: { text: '继续' } })) } catch (e) { console.warn('[filegen-panel] 继续消息派发失败:', e) }
  }, [])

  // 2026-09-06: 引用-正文联动——资料条目点击 → 文档流定位高亮相关段落
  const locateSourceInDoc = useCallback((query: string) => {
    const terms = String(query || '')
      .split(/[\s,，、;；/|]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 2)
      .slice(0, 4)
    if (!terms.length) return
    setHighlightTarget({ seq: Date.now(), terms })
  }, [])

  // 组合布局联动（同 StockPanel 模式）
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible, name: 'filegen' } }))
    } catch (e) { console.warn('[filegen-panel] 广播可见性事件失败:', e) }
  }, [visible])

  const handleClose = useCallback(() => {
    setDismissed(true)
    setVoiceVisible(false)
    try {
      apiPost('/api/scene/remove', { id: 'file-panel' }).catch((e: any) => console.warn('[filegen-panel] 场景移除失败:', e?.message))
      apiPost('/api/scene/panel-state', { panel: 'filegen', state: 'closed' }).catch((e: any) => console.warn('[filegen-panel] 面板状态写入失败:', e?.message))
    } catch (e) { console.error('[filegen-panel] 关闭链路异常:', e) }
  }, [])

  const setVisible = useCallback((open: boolean) => {
    if (open) {
      setDismissed(false)
      setVoiceVisible(true)
      // 面板重开：拉取当前任务快照（生成中状态恢复）
      apiGet('/api/filegen/status').then((res: any) => {
        const st = res?.data
        if (st && st.taskId) setTask({ ...taskRef.current, ...st } as FileGenTask)
      }).catch((e: any) => console.warn('[filegen-panel] 状态恢复失败:', e?.message))
    } else {
      // 对齐 StockPanel：false → handleClose()，surface 存在时也真关闭（不再被 surface 复活）
      handleClose()
    }
  }, [handleClose])
  setVisibleRef.current = setVisible

  // 语音/全局接口
  useEffect(() => {
    return registerCommandHost('filePanel', {
      close: handleClose,
      setVisible,
      isOpen: () => visible,
      getTask: () => taskRef.current,
    })
  }, [handleClose, setVisible, visible])

  return (
    <SideSheet open={visible} onClose={handleClose} name="filegen" width="clamp(520px, 70vw, 1080px)">
      <div className="filegen-panel">
        {/* 标题栏（语音开关随 SideSheet 统一渲染——全面板语音开关，2026-08-15 轮已实现） */}
        <div className="filegen-header">
          <span className="filegen-title-icon">📄</span>
          <span className="filegen-title">{task.title || '文件生成'}</span>
          {task.expertName && (
            <span className="filegen-expert-badge" title={`本文档由「${task.expertName}」专家视角撰写（人设/语气随专家人设注入写作过程）`}>
              ✍️ {task.expertName} 执笔
            </span>
          )}
          <span className={`filegen-phase-badge filegen-phase-badge--${task.phase}`}>{PHASE_LABEL[task.phase]}</span>
          <button
            type="button"
            className="filegen-close-btn"
            data-close-btn
            onClick={handleClose}
            aria-label="关闭文件面板"
            title="关闭"
          >
            ✕
          </button>
        </div>
        {/* 流程指示器（网页四步 / 文档五步 / 纯md四步，逐步可视化——2026-08-23 双卡片架构） */}
        {step > 0 && (
          <div className="filegen-steps">
            {steps.map((s) => {
              const done = task.phase === 'done' || step > s.n
              const active = !done && step === s.n
              return (
                <div key={s.n} className={`filegen-step${done ? ' filegen-step--done' : ''}${active ? ' filegen-step--active' : ''}`}>
                  <span className="filegen-step-dot">{done ? '✓' : s.n}</span>
                  <span className="filegen-step-label">{s.label}</span>
                </div>
              )
            })}
          </div>
        )}
        {/* 状态条（2026-09-06: 活跃态实时计时 + 卡住提示 + 取消；paused 态重试/放弃） */}
        <div className="filegen-statusbar">
          {(task.phase === 'writing' || task.phase === 'converting' || task.phase === 'collect') && (
            <>
              <span className="filegen-statusbar-main">
                ⏳ {task.label || PHASE_LABEL[task.phase]}…{elapsedText ? ` · 已进行 ${elapsedText}` : ''}
                {stuck && <span className="filegen-stuck-hint"> ⚠️ 可能卡住（超 2 分钟无进展）</span>}
              </span>
              <button type="button" className="filegen-cancel-btn" onClick={cancelTask}>取消</button>
            </>
          )}
          {task.phase === 'paused' && (
            <>
              <span className="filegen-statusbar-main">⏸ {task.label || '已暂停 · 等待补充需求信息'}</span>
              <button type="button" className="filegen-action-btn" onClick={continueTask}>继续生成</button>
              {task.originalMessage && (
                <button type="button" className="filegen-action-btn" onClick={resendTask}>重新生成</button>
              )}
              <button type="button" className="filegen-cancel-btn" onClick={cancelTask}>放弃任务</button>
            </>
          )}
          {task.phase === 'cancelled' && (
            <span className="filegen-statusbar-main">🚫 {task.label || '已取消'}</span>
          )}
          {task.phase === 'done' && (
            <span className="filegen-statusbar-main">✅ 已生成: {task.file?.name || ''}{startTsRef.current ? ` · 耗时 ${Math.max(1, Math.round((Date.now() - startTsRef.current) / 1000))} 秒` : ''}</span>
          )}
          {task.phase === 'error' && (
            <span className="filegen-statusbar-main">{task.label || '生成失败'}</span>
          )}
          {task.phase === 'idle' && (
            <span className="filegen-statusbar-main">{task.label || '等待文件生成任务…'}</span>
          )}
        </div>
        {/* 2026-08-23: 资料区——研究阶段 WebSearch 插桩收集的来源（🔍 关键词 → 标题+链接）。
            折叠开关：深度研究来源多，可收起避免挤压文档流；无资料时不渲染 */}
        {task.sources && task.sources.length > 0 && (
          <div className="filegen-sources" data-testid="filegen-sources">
            <button
              type="button"
              className="filegen-sources-head"
              onClick={() => setSourcesOpen(o => !o)}
              aria-expanded={sourcesOpen}
            >
              <span>🔍 收集资料</span>
              <span className="filegen-sources-count">
                {task.sources.reduce((n, e) => n + e.sources.length, 0)} 条来源 · {task.sources.length} 次搜索
              </span>
              <span className={`filegen-sources-caret${sourcesOpen ? ' filegen-sources-caret--open' : ''}`}>▾</span>
            </button>
            {sourcesOpen && (
              <div className="filegen-sources-body">
                {task.sources.map((entry, i) => (
                  <div className="filegen-source-entry" key={`${entry.query}-${i}`}>
                    {/* 2026-09-06 引用-正文联动: 点击关键词 → 文档流定位高亮相关段落 */}
                    <button
                      type="button"
                      className="filegen-source-query filegen-source-query--link"
                      title="点击在正文中定位相关段落"
                      onClick={() => locateSourceInDoc(entry.query)}
                    >
                      <span className="filegen-source-query-icon">🔍</span>
                      {entry.query || `搜索 ${i + 1}`}
                    </button>
                    <ul className="filegen-source-list">
                      {entry.sources.map((s, j) => (
                        <li className="filegen-source-item" key={j}>
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            title={s.url}
                            onClick={(e) => { e.stopPropagation() }}
                          >
                            {s.title}
                          </a>
                          {s.snippet && <span className="filegen-source-snippet">{s.snippet}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* 主工作区（预览分派）——2026-08-22: 通用双栏（左过程流/代码流 + 右预览区），
            与网页生成同构：文章/docx 生成中左栏流式滚入、右栏等待或实时渲染 */}
        <div className="filegen-body">
          {task.phase === 'error' && (
            <div className="filegen-error">
              <div>❌ 生成失败</div>
              <pre>{task.error}</pre>
              <div className="filegen-error-actions">
                <button onClick={() => { navigator.clipboard?.writeText(task.error || '').catch((e: any) => console.warn('[filegen-panel] 复制错误信息失败:', e?.message)) }}>
                  复制错误
                </button>
                {task.originalMessage && (
                  <button className="filegen-error-retry" onClick={resendTask}>重新生成</button>
                )}
              </div>
            </div>
          )}
          {task.phase !== 'idle' && task.phase !== 'error' && (
            <SplitPreview
              format={task.format}
              phase={task.phase}
              task={task}
              codeGroups={codeGroups}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              writeTick={writeTick}
              mainHtmlPath={mainHtmlPath}
              docText={docText}
              logLines={logLines}
              slideData={slideData}
              tableData={tableData}
              htmlBlobUrl={htmlBlobUrl}
              highlightTarget={highlightTarget}
            />
          )}
          {/* R2-4: done 态产物清单（多文件）——主区预览保留, 清单为补充（icon+名+大小+点击打开+主文件高亮） */}
          {task.phase === 'done' && task.files.length > 1 && (
            <FileArtifactList files={task.files} mainPath={task.file?.path ?? null} />
          )}
          {task.phase === 'idle' && (
            <div className="filegen-empty">说点什么，我来生成文件——文章、网页、表格、演示或代码</div>
          )}
        </div>
        {/* 操作条 */}
        {task.phase === 'done' && task.file && (
          <div className="filegen-actions">
            <ActionButton label="打开文件" onClick={() => openFile(task.file!.path)} />
            <ActionButton label="打开文件夹" onClick={() => openFolder(task.file!.path)} />
            <ActionButton label="复制路径" onClick={() => copyPath(task.file!.path)} />
            {task.format === 'html' && <ActionButton label="用浏览器打开" onClick={() => openBrowser(task.file!.path, task.file!.url)} />}
            <ActionButton
              label={wecomSend && wecomSend.path === task.file!.path && wecomSend.state === 'sending' ? '发送中…' : '发送到企微'}
              onClick={() => { void sendFileToWecom(task.file!.path) }}
            />
          </div>
        )}
        {/* 2026-09-07: 发送到企微结果回显 */}
        {wecomSend && task.file && wecomSend.path === task.file.path && (
          <div
            data-testid="wecom-send-status"
            className={`text-xs mt-1 ${wecomSend.state === 'ok' ? 'theme-text-secondary' : wecomSend.state === 'error' ? 'text-red-500' : 'theme-text-muted'}`}
          >
            {wecomSend.state === 'ok' ? '✅ ' : wecomSend.state === 'error' ? '⚠️ ' : ''}{wecomSend.msg}
          </div>
        )}
        {/* 2026-08-28 SP-4: 历史产物——注册表(doc-artifacts)最近记录。
            2026-09-06: 新增名称搜索过滤（客户端）；md/html 条目可直接预览；
            任务区下方, details 折叠（与资料区/操作日志同折叠风格）; 点击复用既有
            openFile 打开机制（electronAPI.file.open IPC 兜底 + local:// 窗口） */}
        <details className="text-xs mt-2" data-testid="filegen-history">
          <summary className="cursor-pointer theme-text-muted hover:theme-text-primary">历史产物（{artifacts.length} 条{historyQuery ? ` · 匹配 ${filteredArtifacts.length}` : ''}）</summary>
          <input
            type="text"
            className="filegen-history-search"
            placeholder="搜索产物名称…"
            value={historyQuery}
            onChange={(e) => setHistoryQuery(e.target.value)}
          />
          <div className="mt-1.5 space-y-0.5 max-h-40 overflow-y-auto">
            {filteredArtifacts.map(a => (
              <div key={a.id} className="filegen-history-row">
                <button onClick={() => openArtifact(a)} className="w-full text-left flex items-center justify-between gap-2 px-2 py-1 rounded theme-bg-tertiary hover:theme-bg-hover">
                  <span className="truncate theme-text-secondary">
                    {a.status === 'failed' && <span className="text-[10px] text-red-400 mr-1" title="生成失败">✗</span>}
                    {a.name}
                    {/* Artifact 深化轮: 版本徽章 + 历史版本数（title 悬停列出各版本时间） */}
                    {(a.version ?? 1) > 1 && (
                      <span
                        className="ml-1.5 text-[10px] px-1 rounded theme-bg-primary text-[color:var(--theme-text-primary,#7dd3fc)]"
                        title={(a.versions || []).map(v => `v${v.version} · ${v.createdAt ? new Date(v.createdAt).toLocaleString() : ''}`).join('\n')}
                      >
                        v{a.version}
                        {(a.versions?.length ?? 0) > 0 ? ` ·${(a.versions?.length ?? 0) + 1}版` : ''}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] theme-text-muted flex-shrink-0">{fmtTime(a.createdAt)}</span>
                </button>
                {(a.format === 'md' || a.format === 'html') && (
                  <button
                    type="button"
                    className="filegen-history-preview"
                    title="在窗口内预览"
                    onClick={() => {
                      try {
                        const src = previewSrc(a.url || ('local:///' + a.path.replace(/\\/g, '/')))
                        if (src) window.open(src, '_blank')
                      } catch (e) { console.error('[filegen-panel] 预览失败:', e) }
                    }}
                  >
                    预览
                  </button>
                )}
              </div>
            ))}
            {filteredArtifacts.length === 0 && <p className="px-2 py-1 theme-text-muted">{historyQuery ? '无匹配产物' : '暂无记录——生成后自动登记'}</p>}
          </div>
        </details>
      </div>
    </SideSheet>
  )
}

function ActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="filegen-action-btn" onClick={() => { try { onClick() } catch (e) { console.error('[filegen-panel] 操作失败:', e) } }}>
      {label}
    </button>
  )
}

// ─── 2026-08-23 双卡片架构（用户反馈第 1 点: 生成文档 / 生成网页是两个卡片）───
// 单组件双视图: 按 format 路由到 WebPanelView（网页: 编码心智——代码流主区 + iframe
// 实时预览 + 操作日志折叠条）或 DocPanelView（文档: 创作者心智——按载体切换视图:
// WORD 单栏文档流 / PPT 页面轨道 / EXCEL 表格矩阵 / PDF 转换进度）。两种视图共享
// 同一份 Write 内容（markdown）+ 操作日志（logLines），差异只在解析视角与布局。
function SplitPreview({ format, phase, task, codeGroups, activeTab, onTabChange, writeTick, mainHtmlPath, docText, logLines, slideData, tableData, htmlBlobUrl, highlightTarget }: {
  format: string
  phase: FileGenTask['phase']
  task: FileGenTask
  codeGroups: { name: string; lines: string[] }[]
  activeTab: string
  onTabChange: (t: string) => void
  writeTick: number
  mainHtmlPath: string
  docText: string
  logLines: string[]
  slideData: SlidePage[] | null
  tableData: ParsedTable[] | null
  htmlBlobUrl: string | null
  highlightTarget: { seq: number; terms: string[] } | null
}) {
  // 2026-09-08: 海报——writing/converting 显示排版状态；done 显示成品图（local:// 预览）
  if (format === 'poster') {
    const posterPath = task.file?.path || ''
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, width: '100%' }}>
        {phase === 'done' && posterPath ? (
          <img
            src={fileUrlFor(posterPath)}
            alt="海报成品"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8, boxShadow: '0 6px 24px rgba(0,0,0,.25)' }}
          />
        ) : (
          <div className="theme-text-secondary" style={{ fontSize: 14 }}>
            🖼️ {phase === 'converting' ? '排版合成中（HTML 渲染截图）…' : phase === 'writing' ? '生成 AI 底图与文案…' : '准备中…'}
          </div>
        )}
      </div>
    )
  }
  const live = phase !== 'done'
  if (format === 'html') {
    const file = live
      ? { path: mainHtmlPath || '', url: mainHtmlPath ? `local:///${mainHtmlPath.replace(/\\/g, '/').replace(/^\/+/, '')}` : null }
      : { path: task.file?.path || '', url: task.file?.url || null }
    return <WebPanelView file={file} codeGroups={codeGroups} activeTab={activeTab} onTabChange={onTabChange} live={live} writeTick={writeTick} logLines={logLines} htmlBlobUrl={htmlBlobUrl} />
  }
  return <DocPanelView format={format} phase={phase} task={task} docText={docText} logLines={logLines} slideData={slideData} tableData={tableData} highlightTarget={highlightTarget} />
}

// ─── 2026-08-22 UI 迭代（方案 A）: 文章单栏文档流 ───
// 用户反馈: 文章生成卡片被拆左右双栏「不好看」、代码流对文章语义错位。
// 迭代: md/docx 场景单栏文档流——Write 内容渲染为富文本段落（非代码行），
// 新段落 reveal 淡入 + 自动跟随滚动（打字机式生长）；大纲区实时提取 markdown
// 标题（②大纲编写从状态文字变成可见内容）。html 网页场景仍走双栏（代码+预览）。
function DocumentStreamView({ task, docText, processLines, highlightTarget }: { task: FileGenTask; docText: string; processLines: string[]; highlightTarget?: { seq: number; terms: string[] } | null }) {
  // 2026-08-23 降噪: processLines 由调用方从 logLines 传入（此前的 '过程' 组已删除）
  const bodyRef = useRef<HTMLDivElement>(null)
  // 2026-09-06: 自动跟随滚动加用户意图检测——用户向上滚动（距底 >40px）即暂停
  // 跟随，回到底部自动恢复。治"想回看已写段落被不断拽回底部"。
  const followRef = useRef(true)
  const handleBodyScroll = useCallback(() => {
    const el = bodyRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    followRef.current = atBottom
  }, [])
  useEffect(() => {
    const el = bodyRef.current
    if (el && followRef.current) el.scrollTop = el.scrollHeight
  }, [docText])

  // 2026-09-06: 引用-正文联动——资料条目点击后，定位第一个包含关键词的段落
  const [highlightIdx, setHighlightIdx] = useState<number | null>(null)

  // 大纲: 从已写出内容提取 markdown 标题（#~####，按层级缩进显示）
  const outline = useMemo(() => {
    const items: { level: number; text: string }[] = []
    for (const line of docText.split(/\r?\n/)) {
      const m = line.match(/^(#{1,4})\s+(.+)$/)
      if (m) items.push({ level: m[1].length, text: m[2].trim() })
    }
    return items
  }, [docText])

  // 段落块: 空行切分 + 代码块围栏保护（``` 未闭合的段落与后续合并，防拆坏代码块）。
  // 每块独立 reveal 动画（animation-delay 错峰，同代码行 reveal 模式）
  const blocks = useMemo(() => {
    const raw = docText.split(/\n\s*\n/).filter(p => p.trim())
    const out: string[] = []
    let buf = ''
    let inFence = false
    for (const p of raw) {
      buf = buf ? `${buf}\n\n${p}` : p
      const fences = (p.match(/^```/gm) || []).length
      if (fences % 2 === 1) inFence = !inFence
      if (!inFence) { out.push(buf); buf = '' }
    }
    if (buf.trim()) out.push(buf)
    return out
  }, [docText])

  // 2026-09-06: 引用-正文联动定位——滚动到第一个含关键词的段落并高亮 2.4s
  useEffect(() => {
    if (!highlightTarget?.terms?.length) return
    const lower = blocks.map(b => stripScripts(b).toLowerCase())
    let found = -1
    for (const term of highlightTarget.terms) {
      const t = term.toLowerCase()
      found = lower.findIndex(b => b.includes(t))
      if (found >= 0) break
    }
    if (found < 0) return
    setHighlightIdx(found)
    const el = bodyRef.current?.querySelector(`[data-block-idx="${found}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const timer = setTimeout(() => setHighlightIdx(null), 2400)
    return () => clearTimeout(timer)
  }, [highlightTarget, blocks])

  return (
    <div className="filegen-docstream" data-testid="filegen-docstream">
      {/* 过程提示条（thinking/tool_call 帧——搜集资料/构思过程可见，最多 3 行） */}
      {processLines.length > 0 && (
        <div className="filegen-docstream-process" data-testid="filegen-docstream-process">
          {processLines.slice(-3).map((l, i) => (
            <div key={`${i}-${l.slice(0, 24)}`} className="filegen-docstream-process-line">{l}</div>
          ))}
        </div>
      )}
      {/* 大纲区（内容写出后可见；②大纲编写步骤的真实内容） */}
      {outline.length > 0 && (
        <div className="filegen-docstream-outline" data-testid="filegen-docstream-outline">
          <div className="filegen-docstream-outline-title">📋 大纲</div>
          {outline.map((o, i) => (
            <div key={`${i}-${o.text}`} className={`filegen-docstream-outline-item filegen-docstream-outline-item--h${o.level}`}>
              {o.text}
            </div>
          ))}
        </div>
      )}
      {/* 文档流主区（打字机式滚入；onScroll 检测用户向上阅读意图暂停跟随） */}
      <div className="filegen-docstream-body" ref={bodyRef} onScroll={handleBodyScroll} data-testid="filegen-docstream-body">
        {blocks.length ? blocks.map((b, i) => (
          <div
            key={`${i}-${b.slice(0, 24)}`}
            data-block-idx={i}
            className={`filegen-docstream-para${i === highlightIdx ? ' filegen-docstream-para--highlight' : ''}`}
            style={{ animationDelay: `${Math.min(i * 14, 560)}ms` }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripScripts(b)}</ReactMarkdown>
          </div>
        )) : (
          <div className="filegen-docstream-empty" data-testid="filegen-docstream-empty">
            {/* 2026-08-23: label 优先——后端「正在组织内容…」等推进文案直达 UI */}
            {task.label || (task.phase === 'collect' ? '正在搜集资料…' : '等待内容写出…')}
          </div>
        )}
      </div>
    </div>
  )
}

// 2026-08-23: 2026-08-22 的右栏预览分派（renderRightPane/WaitPane/MdPreview）已删除——
// 双卡片架构后 md/docx/pptx/xlsx/pdf 全部走 DocPanelView 载体视图，无右栏分派。
// 2026-08-18: local: 协议 html 门控参数——electron main 对 .html 仅带 ?html=1 的请求
// 返回 text/html（T1.19 默认 octet-stream 防脚本执行导致 iframe 空白; iframe sandbox
// 无 allow-same-origin, 本地 HTML 脚本在 opaque origin 运行, 安全由 sandbox 兜底）。
// 2026-08-18 追加: local 注册 standard scheme 后 Chromium 把 local:///D:/ 折叠成
// host=D(吞盘符)→ 显式 host localhost 保住盘符（pathname 保留 /D:/...）。
function previewSrc(url: string | null): string | null {
  if (!url) return null
  const fixed = url.startsWith('local:///') ? 'local://localhost/' + url.slice('local:///'.length) : url
  const sep = fixed.includes('?') ? '&' : '?'
  return `${fixed}${sep}html=1`
}

// ─── 2026-08-23 WebPanelView: 网页生成视图（用户反馈第 2 点: 默认显示编码过程,
// 而非工具调用过程）───
// 主区 = 代码流（Write/Edit 真实代码行, 逐行滚入）+ iframe 实时预览（live 指向
// mainHtmlPath, done 切 file.url）；工具调用标题/搜索/思考帧 → 底部操作日志折叠条
// （默认收起——编码过程占据主视觉, 需要时展开看模型操作轨迹）。
function WebPanelView({ file, codeGroups, activeTab, onTabChange, live, writeTick, logLines, htmlBlobUrl }: {
  file: { path: string; url: string | null }
  codeGroups: { name: string; lines: string[] }[]
  activeTab: string
  onTabChange: (t: string) => void
  live?: boolean
  writeTick: number
  logLines: string[]
  htmlBlobUrl?: string | null
}) {
  const [src, setSrc] = useState<string | null>(previewSrc(file.url))
  // R2-2: 每次 Write 工具调用 → iframe 刷新（?t= 破缓存，local:// 文件协议重读全部资源；
  // ?t 用 writeTick 而非 Date.now()——毫秒时间戳在连续 Write 时会撞值导致不刷新，
  // writeTick 单调递增保证每次 Write 必换 src）
  // 2026-09-06: HtmlGenerate 直出路径——htmlBlobUrl 存在时优先 blob 预览
  //（内容在 tool_call 帧里、文件尚未落盘也可预览）
  useEffect(() => {
    if (live && htmlBlobUrl) { setSrc(htmlBlobUrl); return }
    // R2-2 审查修复: url 置空（新任务 collect 期主 html 未写出）→ 清 src——
    // 此前两个 effect 均跳过, src 残留旧任务文件, iframe 显示旧产物
    if (!file.url) { setSrc(null); return }
    // 2026-08-18: html=1 门控——electron local: 协议对 .html 默认 octet-stream(T1.19
    // 防脚本执行)导致 iframe 空白; 仅带 ?html=1 的请求受控放行 text/html(+CSP)
    setSrc(live ? `${previewSrc(file.url)}&t=${writeTick}` : previewSrc(file.url))
  }, [writeTick, file.url, live, htmlBlobUrl])
  useEffect(() => { if (!live) setSrc(previewSrc(file.url)) }, [file.url, live])
  return (
    <div className="filegen-websurface">
      <div className={live ? 'filegen-html-split filegen-html-split--live' : 'filegen-html-split'}>
        <CodeStreamPane codeGroups={codeGroups} activeTab={activeTab} onTabChange={onTabChange} live={live} />
        {src ? (
          /* 预览窗：local:// 由 electron main protocol 放行 DATA_DIR；禁 allow-same-origin。
             key={src} 强制重挂载 iframe（src 变化时彻底重载），比仅改 src 更可靠 */
          <iframe
            key={src}
            className="filegen-html-iframe"
            src={src}
            sandbox="allow-scripts"
            title="html-preview"
          />
        ) : (
          <div className="filegen-file-loading">{live ? '等待主文件写出…' : '加载文档内容…'}</div>
        )}
      </div>
      <OperationLog lines={logLines} />
    </div>
  )
}

// ─── 操作日志折叠条（2026-08-23 降噪——工具调用标题/搜索帧/思考帧收纳于此,
// 网页版默认收起; 文档版在文档流下方, 同样可折叠）───
function OperationLog({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false)
  if (!lines.length) return null
  return (
    <div className="filegen-oplog" data-testid="filegen-oplog">
      <button type="button" className="filegen-oplog-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>⚙️ 操作日志</span>
        <span className="filegen-oplog-count">{lines.length} 条</span>
        <span className={`filegen-sources-caret${open ? ' filegen-sources-caret--open' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="filegen-oplog-body" data-testid="filegen-oplog-body">
          {lines.slice(-30).map((l, i) => (
            <div key={`${i}-${l.slice(0, 24)}`} className="filegen-oplog-line">{l}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 2026-08-23 DocPanelView: 文档生成视图（用户反馈第 3 点——WORD/PDF/PPT/EXCEL
// 四种载体如何在一个卡片里展示）───
// 创新方案「载体感知视图」: 四格式共享同一份 Write 内容（markdown）, 差异只在解析
// 视角——docx/md → 单栏文档流（打字机式生长）; pptx → 页面轨道（# 标题拆页,
// 缩略卡轨道 + 当前页大图）; xlsx → 表格矩阵（Gfm 表格提取）; pdf → 转换进度 +
// 成品文件卡。操作日志折叠条统一置于内容区下方。
function DocPanelView({ format, phase, task, docText, logLines, slideData, tableData, highlightTarget }: {
  format: string
  phase: FileGenTask['phase']
  task: FileGenTask
  docText: string
  logLines: string[]
  slideData: SlidePage[] | null
  tableData: ParsedTable[] | null
  highlightTarget?: { seq: number; terms: string[] } | null
}) {
  let content: ReactNode
  if (format === 'pptx') {
    // PPT 页面轨道——后端结构/直出参数优先，本地解析兜底（2026-09-06）
    content = <SlideTrackView docText={docText} phase={phase} label={task.label} file={task.file} slideData={slideData} />
  } else if (format === 'xlsx') {
    // EXCEL 表格矩阵——后端结构/直出参数优先，本地解析兜底（2026-09-06）
    content = <TableMatrixView docText={docText} phase={phase} label={task.label} file={task.file} tableData={tableData} />
  } else if (format === 'pdf') {
    // PDF 转换进度 + 成品文件卡
    content = <PdfPreviewView phase={phase} task={task} />
  } else {
    // WORD/文章（md/docx/txt/code）: 单栏文档流（打字机式生长 + 大纲区 + 引用联动定位）
    content = (
      <DocumentStreamView
        task={task}
        docText={docText}
        processLines={logLines}
        highlightTarget={highlightTarget}
      />
    )
  }
  return (
    <div className="filegen-docsurface">
      <div className="filegen-docmain">{content}</div>
      <OperationLog lines={logLines} />
    </div>
  )
}

// ─── PPT 页面轨道（2026-08-23 载体感知视图之一）───
// Write 的 markdown 按 #~## 标题拆页（parseSlides）: 上方缩略卡轨道（页号+标题+
// 要点数, 点击选中）+ 下方当前页大图（标题 + 全部要点）。生成中随 Write 内容实时生长,
// done 后即为成品预览骨架。
function SlideTrackView({ docText, phase, label, file, slideData }: { docText: string; phase: FileGenTask['phase']; label?: string; file: FileGenFile | null; slideData?: SlidePage[] | null }) {
  const [sel, setSel] = useState(0)
  // 2026-09-06: 后端解析结构/直出参数优先，本地 parseSlides 降级兜底
  //（预览与真实 pptx 同一解析器，页数/要点不再漂移）
  const pages = useMemo(
    () => (slideData && slideData.length ? slideData : parseSlides(docText)),
    [slideData, docText],
  )
  // 选中页越界修正（Write 覆盖内容后页数可能收缩）
  useEffect(() => {
    if (sel >= pages.length) setSel(Math.max(0, pages.length - 1))
  }, [pages.length, sel])
  if (!pages.length) {
    // 2026-08-23 实机修复: PptxGenerate 直出场景无 Write 内容（docText 恒空）——
    // done 后仍显示「等待演示文稿内容写出…」（用户实锤「实际已生成, 卡片一直显示等待」）。
    // done 态切换成品文件卡; 生成中显示后端推进文案（label 优先）
    if (phase === 'done') {
      return file ? <FileInfoCard file={file} /> : <div className="filegen-file-loading">等待产物…</div>
    }
    return (
      <div className="filegen-docstream-empty" data-testid="filegen-docstream-empty">
        {label || (phase === 'collect' ? '正在搜集资料…' : '正在生成…')}
      </div>
    )
  }
  const cur = pages[Math.min(sel, pages.length - 1)]
  return (
    <div className="filegen-slides" data-testid="filegen-slides">
      <div className="filegen-slides-track">
        {pages.map((p, i) => (
          <button
            key={`${i}-${p.title}`}
            type="button"
            data-testid={`slide-thumb-${i}`}
            className={`filegen-slide-thumb${i === sel ? ' filegen-slide-thumb--active' : ''}`}
            onClick={() => setSel(i)}
          >
            <span className="filegen-slide-thumb-num">{i + 1}</span>
            <span className="filegen-slide-thumb-title">{p.title}</span>
            <span className="filegen-slide-thumb-count">{p.points.length} 要点</span>
          </button>
        ))}
      </div>
      <div className="filegen-slide-stage" data-testid="filegen-slide-stage">
        <div className="filegen-slide-stage-num">{sel + 1} / {pages.length}</div>
        <div className="filegen-slide-stage-title">{cur.title}</div>
        <ul className="filegen-slide-stage-points">
          {cur.points.map((pt, j) => <li key={j}>{pt}</li>)}
        </ul>
      </div>
    </div>
  )
}

// ─── EXCEL 表格矩阵（2026-08-23 载体感知视图之一）───
// parseTables 提取 Write 内容中的全部 Gfm 表格——每个表格一块: 标题（主表/第 N 表 +
// 行计数）+ 表格矩阵（表头粗体）。生成中随内容实时生长。
function TableMatrixView({ docText, phase, label, file, tableData }: { docText: string; phase: FileGenTask['phase']; label?: string; file: FileGenFile | null; tableData?: ParsedTable[] | null }) {
  // 2026-09-06: 后端解析结构/直出参数优先，本地 parseTables 降级兜底
  const tables = useMemo(
    () => (tableData && tableData.length ? tableData : parseTables(docText)),
    [tableData, docText],
  )
  if (!tables.length) {
    // 2026-08-23: 同 SlideTrackView——XlsxGenerate 直出场景 docText 恒空,
    // done 后不得永显「等待表格内容写出…」, 切换成品文件卡
    if (phase === 'done') {
      return file ? <FileInfoCard file={file} /> : <div className="filegen-file-loading">等待产物…</div>
    }
    return (
      <div className="filegen-docstream-empty" data-testid="filegen-docstream-empty">
        {label || (phase === 'collect' ? '正在搜集资料…' : '正在生成…')}
      </div>
    )
  }
  return (
    <div className="filegen-tables" data-testid="filegen-tables">
      {tables.map((t, i) => (
        <div key={i} className="filegen-table-block" data-testid={`table-block-${i}`}>
          <div className="filegen-table-title">{i === 0 ? '主表' : `表格 ${i + 1}`} · {t.rows.length} 行 × {t.headers.length} 列</div>
          <table className="filegen-table">
            <thead>
              <tr>{t.headers.map((h, j) => <th key={j}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {t.rows.map((r, j) => (
                <tr key={j}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

// ─── PDF 预览（2026-08-23 载体感知视图之一）───
// PDF 由 Write 的 md 经 converting 转换而来——生成中显示转换进度（indeterminate
// 进度条 + 当前阶段文案）, done 后渲染成品文件卡。pdf 无生成中预览（二进制产物
// 在转换完成前不存在）。
function PdfPreviewView({ phase, task }: { phase: FileGenTask['phase']; task: FileGenTask }) {
  if (phase !== 'done') {
    return (
      <div className="filegen-pdfview" data-testid="filegen-pdfview">
        <div className="filegen-pdfview-progress">
          <div className="filegen-pdfview-bar" />
        </div>
        <div className="filegen-pdfview-text">📕 {phase === 'converting' ? '正在转换 PDF…' : (task.label || '正在生成…')}</div>
        <div className="filegen-wait-hint">PDF 为二进制产物，转换完成后此处显示文件卡</div>
      </div>
    )
  }
  return (
    <div className="filegen-pdfview" data-testid="filegen-pdfview">
      {task.file ? <FileInfoCard file={task.file} /> : <div className="filegen-file-loading">等待产物…</div>}
    </div>
  )
}

function CodeStreamPane({ codeGroups, activeTab, onTabChange, live }: {
  codeGroups: { name: string; lines: string[] }[]
  activeTab: string
  onTabChange: (t: string) => void
  live?: boolean
}) {
  // 2026-08-23 降噪: 已无 '过程' 组——有效 tab = activeTab 存在则用之, 否则末组
  // （首个 Write 前 activeTab='' → 高亮/显示末组, 等待态兜底）
  const effTab = activeTab && codeGroups.some(g => g.name === activeTab)
    ? activeTab
    : (codeGroups[codeGroups.length - 1]?.name || '')
  const lines = codeGroups.find(g => g.name === effTab)?.lines || []
  return (
    <div className="filegen-code-pane">
      {/* 2026-08-21: 完成态(非 live)文案去掉「实时滚入」进行时措辞——任务已结束，
          左侧显示的是写入代码的记录而非实时过程 */}
      <div className="filegen-code-header">{live ? '编码中（Write 实时滚入）' : '代码流（写入记录）'}</div>
      {codeGroups.length > 0 && (
        <div className="filegen-flow-tabs">
          {codeGroups.map(g => (
            <button key={g.name} type="button" data-testid={`flow-tab-${g.name}`}
              className={`filegen-flow-tab${effTab === g.name ? ' filegen-flow-tab--active' : ''}`}
              onClick={() => onTabChange(g.name)}>
              {g.name}
            </button>
          ))}
        </div>
      )}
      <pre className="filegen-code-body">
        {lines.length ? (
          // 2026-08-18 G2: 逐行渲染——key=行索引+内容前缀（既有行复用 DOM 不重播动画,
          // 新追加行挂载时触发 reveal）；animation-delay 按行索引错峰 → "逐行写出"效果
          lines.slice(-40).map((line, i) => (
            <div
              key={`${i}-${line.slice(0, 24)}`}
              className="filegen-code-line"
              style={{ animationDelay: `${Math.min(i * 14, 560)}ms` }}
              dangerouslySetInnerHTML={{ __html: highlightLine(line) || '&nbsp;' }}
            />
          ))
        ) : ('（等待工具调用…）')}
      </pre>
    </div>
  )
}

// ─── 2026-08-17 R2-2: 轻量语法高亮（不引库，四类 token：注释/字符串/关键字/HTML 标签）───
// 2026-08-17 审查修复: 原分步 replace 级联会重扫上一步插入的 <span> 标记——字符串正则
// 命中 "tok-…" 属性值、关键字正则命中 class，属性被拆碎泄漏为可见文本（⟪Write⟫ JSON
// 行全损）。改为单次交替正则: 引擎从左到右扫描、同位置按 注释→字符串→关键字→HTML 标签
// 分支顺序匹配，一次 pass 完成全部标记，插入的 span 不再被重扫。
const HIGHLIGHT_TOKEN_RE = /(\/\/.*)$|(^#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(const|let|var|function|return|import|export|from|class|if|else|for|while|async|await|new|require|module|document|window|console|this)\b|(&lt;\/?)([a-zA-Z][\w-]*)/gm

export function highlightLine(line: string): string {
  // 1. HTML 转义（防 XSS/破渲染）
  const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // 2. 单次交替正则四分支（同位置匹配优先级：注释→字符串→关键字→标签）
  return escaped.replace(HIGHLIGHT_TOKEN_RE, (_m, comment, hashComment, str, keyword, lt, tagName) => {
    if (comment !== undefined) return `<span class="tok-comment">${comment}</span>`
    if (hashComment !== undefined) return `<span class="tok-comment">${hashComment}</span>`
    if (str !== undefined) return `<span class="tok-str">${str}</span>`
    if (keyword !== undefined) return `<span class="tok-key">${keyword}</span>`
    return `${lt}<span class="tok-tag">${tagName}</span>`
  })
}

// ─── 文件信息卡（docx/xlsx/pptx/pdf/txt）───
function FileInfoCard({ file }: { file: { name: string; size: number; path: string } }) {
  return (
    <div className="filegen-file-card">
      <div className="filegen-file-icon">📄</div>
      <div className="filegen-file-meta">
        <div className="filegen-file-name">{file.name}</div>
        <div className="filegen-file-size">{(file.size / 1024).toFixed(1)} KB</div>
        <div className="filegen-file-path">{file.path}</div>
      </div>
    </div>
  )
}

// ─── 2026-08-17 R2-4: done 态产物清单（多文件网页产物，spec: icon+名+大小+点击打开+主文件高亮）───
/** 人类可读文件大小（B/KB/MB） */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 产物图标：按 format/扩展名分派 */
function artifactIcon(f: FileGenFile): string {
  const fmt = (f.format || '').toLowerCase()
  if (fmt === 'poster') return '🖼️'
  if (fmt === 'html') return '🌐'
  if (fmt === 'md') return '📝'
  if (fmt === 'docx') return '📘'
  if (fmt === 'xlsx') return '📊'
  if (fmt === 'pptx') return '📽️'
  if (fmt === 'pdf') return '📕'
  if (fmt === 'code') {
    const name = (f.name || '').toLowerCase()
    if (name.endsWith('.css')) return '🎨'
    return '⌨️'
  }
  return '📄'
}

function FileArtifactList({ files, mainPath }: { files: FileGenFile[]; mainPath: string | null }) {
  return (
    <div className="filegen-artifacts">
      <div className="filegen-artifacts-title">产物清单</div>
      {files.map((f) => (
        <button
          key={f.path || f.name}
          type="button"
          data-testid={`artifact-${f.name}`}
          className={`filegen-artifact${mainPath && f.path === mainPath ? ' filegen-artifact--main' : ''}`}
          onClick={() => { try { openFile(f.path) } catch (e) { console.error('[filegen-panel] 产物打开失败:', e) } }}
        >
          <span className="filegen-artifact-icon">{artifactIcon(f)}</span>
          <span className="filegen-artifact-name">{f.name}</span>
          <span className="filegen-artifact-size">{formatFileSize(f.size)}</span>
        </button>
      ))}
    </div>
  )
}

// ─── 2026-08-28 SP-4: 历史产物时间（同 FileBrowser.formatTime 格式: 今天 HH:mm / 昨天 / 月日 HH:mm）───
function fmtTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 2026-08-28 SP-4: 历史产物打开——复用既有 openFile（不新建协议/IPC 通道） */
function openArtifact(a: HistoryArtifact) {
  try { openFile(a.path) } catch (e) { console.error('[filegen-panel] 历史产物打开失败:', e) }
}

// ─── 打开/复制操作（复用既有 electron 通道，勿造新协议）───
// electronAPI.file.open → ipcMain 'file:open' → shell.openPath（allowedDirs 守卫，preload:145）
function openFile(path: string) {
  const open = (window as any).electronAPI?.file?.open
  if (typeof open === 'function') {
    open(path).then((r: any) => { if (r && r.success === false) console.warn('[filegen] 打开失败:', r.error) })
      .catch((e: any) => console.warn('[filegen] 打开异常:', e?.message))
  } else {
    window.open('local:///' + path.replace(/\\/g, '/'), '_blank')
  }
}
function openFolder(path: string) { openFile(path.replace(/[/\\][^/\\]+$/, '')) }
// 用浏览器打开 html：shell.openPath 交给系统默认浏览器（.html 默认浏览器打开）
function openBrowser(path: string, url: string | null) {
  const open = (window as any).electronAPI?.file?.open
  if (typeof open === 'function') {
    open(path).catch((e: any) => console.warn('[filegen] 浏览器打开失败:', e?.message))
  } else if (url) {
    window.open(url, '_blank')
  }
}
function copyPath(path: string) {
  navigator.clipboard?.writeText(path).then(() => {}).catch((e: any) => console.warn('[filegen] 复制失败:', e?.message))
}

// ─── 2026-09-07: 发送到企微——文件卡操作条按钮 ───
// 走既有 /wecom/send-file 代理（接收人=设置→用户信息 的企微用户 ID，S-2b 白名单
// 已扩展到 data/workspace 产物目录）；结果经组件内 wecomSend 状态展示。
async function requestSendToWecom(path: string): Promise<{ ok: boolean; msg: string }> {
  try {
    const res: any = await apiPost('/wecom/send-file', { file_path: path })
    if (res?.success) return { ok: true, msg: res?.data?.message || '已发送到企业微信' }
    return { ok: false, msg: res?.error || '发送失败' }
  } catch (e: any) {
    return { ok: false, msg: e?.message || '发送失败' }
  }
}
