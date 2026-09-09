/**
 * TaskPanelStore — 任务面板聚合层（前端纯逻辑，不依赖 React）
 *
 * 消费 SSE 事件流（/events），按 roundId / flowId 聚合为任务面板数据。
 * 面板是"业务处理的统一投影"：任何业务（工具链 / 工作流 / 企微文档 / 文件生成）
 * 都聚合成一块面板，由 task-panel kind 渲染。
 */

export type PanelEvent =
  | { type: 'tool_call'; roundId?: string; toolName: string; summary: string; ts: number }
  | { type: 'tool_result'; roundId?: string; toolName: string; status: 'success' | 'error'; summary: string; ts: number }
  | { type: 'thinking'; roundId?: string; summary: string; ts: number }
  | { type: 'workflow_start'; flowId: string; name: string; steps?: string[]; ts: number }
  | { type: 'workflow_step'; flowId: string; stepId: string; name: string; status: 'done' | 'running' | 'error'; ts: number }
  | { type: 'workflow_complete'; flowId: string; ts: number }
  | { type: 'workflow_error'; flowId: string; error?: string; ts: number }
  | { type: 'wecom_doc'; title: string; fileName?: string; ts: number }
  | { type: 'file_generated'; fileName: string; path: string; ts: number }
  | { type: 'panel_cancel'; id: string; ts: number }
  // 2026-08-13 P2-2: run 终态事件(ag-ui RunFinished/RunError 借鉴)——roundId 面板终态
  | { type: 'run_finished'; roundId: string; ts: number }
  | { type: 'run_error'; roundId: string; error?: string; ts: number }
  | { type: 'run_interrupted'; roundId: string; ts: number }

export interface ToolEvent {
  toolName: string
  summary: string
  status: 'running' | 'success' | 'error'
  ts: number
}

export interface TaskPanel {
  id: string
  title: string
  status: 'running' | 'success' | 'error' | 'cancelled' | 'stale'
  progress: number
  currentAction: string
  toolHistory: ToolEvent[]
  result?: { fileName?: string; path?: string }
  createdAt: number
  updatedAt: number
  steps?: Array<{ name: string; status: 'pending' | 'running' | 'done' | 'error' }>
  /** 2026-08-13: 面板对应的最后一条用户消息——error 卡重试时复用原消息重发 */
  lastUserMessage?: string
}

/** 兜底: 运行中面板超过该时长(5 分钟)无事件 → 标记 stale(断线/事件丢失兜底,由上层自动清理关闭) */
const STALE_AFTER_MS = 5 * 60 * 1000
/** 工具历史保留上限: 防止长时间任务的工具列表无限增长 */
const MAX_TOOL_HISTORY = 100

/**
 * 语音显隐判定（voice-interrupt-panels-analysis 问题 #1/#2）：
 * task_panel 统一归 TaskPanelHost 浮层渲染（通道 B），语音命令经 __taskPanel.setVisible 控制。
 * - 打开：有进行中任务卡 → 可开；无卡 → 不可开（VoiceShell 据此播报"当前没有进行中的任务面板"）
 * - 关闭：恒可关
 */
export function resolveTaskPanelCommand(action: 'open' | 'close', panelCount: number): boolean {
  if (action === 'close') return true
  return panelCount > 0
}

export class TaskPanelStore {
  private panels = new Map<string, TaskPanel>()
  private onUpdate: ((panels: TaskPanel[]) => void) | null

  constructor(opts?: { onUpdate?: (panels: TaskPanel[]) => void }) {
    this.onUpdate = opts?.onUpdate || null
  }

  private touch(panel: TaskPanel) {
    panel.updatedAt = Date.now()
    if (this.onUpdate) {
      try { this.onUpdate(this.getPanels()) } catch (e) { console.error('[task-panel] onUpdate 回调异常:', e) }
    }
  }

  private ensurePanel(id: string, title: string): TaskPanel {
    let panel = this.panels.get(id)
    if (!panel) {
      panel = {
        id, title, status: 'running', progress: 0,
        currentAction: '', toolHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
      }
      this.panels.set(id, panel)
    } else if (panel.status === 'stale') {
      // 2026-08-07: stale 面板收到新事件 → 恢复 running(兜底误判可恢复)
      panel.status = 'running'
    }
    return panel
  }

  /** 2026-08-13: 记录面板对应的最后一条用户消息(重试复用)。仅对 running 面板生效 */
  setLastUserMessage(id: string, text: string): void {
    const panel = this.panels.get(id)
    if (!panel || panel.status !== 'running') return
    panel.lastUserMessage = text
    this.touch(panel)
  }

  /** 工具历史入栈并截断上限(防无限增长) */
  private pushTool(panel: TaskPanel, evt: ToolEvent): void {
    panel.toolHistory.push(evt)
    if (panel.toolHistory.length > MAX_TOOL_HISTORY) {
      panel.toolHistory.splice(0, panel.toolHistory.length - MAX_TOOL_HISTORY)
    }
  }

  /** 2026-08-07: 兜底——运行中面板超过 STALE_AFTER_MS 无事件 → 标记 stale(断线/事件丢失),由上层自动清理关闭 */
  private sweepStale(): void {
    const now = Date.now()
    let changed = false
    for (const panel of this.panels.values()) {
      if (panel.status !== 'running') continue
      // updatedAt 即最近一次事件接收时间(每次 ingest 的 touch 都会刷新)
      if (now - panel.updatedAt > STALE_AFTER_MS) {
        panel.status = 'stale'
        panel.currentAction = '面板长时间无事件更新，可能已断线，将自动关闭'
        changed = true
      }
    }
    if (changed && this.onUpdate) {
      try { this.onUpdate(this.getPanels()) } catch (e) { console.error('[task-panel] onUpdate 回调异常:', e) }
    }
  }

  /** 事件入口：将一条 SSE 事件聚合成面板状态变更 */
  ingest(evt: PanelEvent): void {
    try {
      // 兜底: 每收到一条事件,先扫描长时间无更新的运行中面板 → stale
      this.sweepStale()
      switch (evt.type) {
        case 'tool_call': {
          const id = evt.roundId || 'default'
          const panel = this.ensurePanel(id, '任务处理中')
          panel.currentAction = evt.summary || evt.toolName
          // 2026-08-29 Task 8: activity 的 tool_preparing/tool_executing 归一为 tool_call 后,
          // 同一工具会连发两条 running 事件(准备→执行)——末条 running 且同名时原地更新,
          // 防止工具链出现永不落定的重复 ◌ 行(已 done 的同名历史不合并,支持同工具多次调用)。
          const last = panel.toolHistory[panel.toolHistory.length - 1]
          if (last && last.status === 'running' && last.toolName === evt.toolName) {
            last.summary = evt.summary
            last.ts = evt.ts
          } else {
            this.pushTool(panel, { toolName: evt.toolName, summary: evt.summary, status: 'running', ts: evt.ts })
          }
          this.touch(panel)
          break
        }
        case 'tool_result': {
          const id = evt.roundId || 'default'
          const panel = this.ensurePanel(id, '任务处理中')
          this.pushTool(panel, { toolName: evt.toolName, summary: evt.summary, status: evt.status, ts: evt.ts })
          if (evt.status === 'error') panel.status = 'error'
          // 2026-08-07: 工具 error 后允许后续成功事件恢复 running(前端兜底:
          // 部分工具链 error 后会继续执行,面板不应卡死在 error 态直到收尾事件)
          else if (panel.status === 'error') panel.status = 'running'
          // R12: 工具链任务也推进进度——多数语音任务走 LLM 工具调用(无 workflow 步骤),
          // 旧实现 progress 仅 workflow_step 更新 → 工具任务进度恒 0%。
          // 用"已完成工具数/前 5 个"估算: 每完成一个工具调用前进,到 5 个视为接近完成(90%)。
          // 不设 100%——最终 100% 仍由 workflow_complete 或 tool_result 全成功后的收尾设置。
          const doneCount = panel.toolHistory.filter(t => t.status !== 'running').length
          panel.progress = Math.min(90, Math.round((doneCount / 5) * 100))
          this.touch(panel)
          break
        }
        case 'thinking': {
          const id = evt.roundId || 'default'
          const panel = this.ensurePanel(id, '任务处理中')
          panel.currentAction = evt.summary
          this.touch(panel)
          break
        }
        case 'workflow_start': {
          const panel = this.ensurePanel(`flow:${evt.flowId}`, evt.name)
          panel.steps = (evt.steps || []).map((s, i) => ({ name: s, status: i === 0 ? 'running' : 'pending' }))
          panel.currentAction = (evt.steps || [])[0] || '启动中'
          this.touch(panel)
          break
        }
        case 'workflow_step': {
          const panel = this.panels.get(`flow:${evt.flowId}`)
          if (!panel || !panel.steps) break
          // 2026-08-07: stale 面板收到步骤推进 → 恢复 running
          if (panel.status === 'stale') panel.status = 'running'
          const idx = panel.steps.findIndex(s => s.name === evt.name)
          if (idx >= 0) {
            panel.steps[idx] = { ...panel.steps[idx], status: evt.status }
            if (evt.status === 'running') panel.currentAction = evt.name
          }
          const done = panel.steps.filter(s => s.status === 'done').length
          panel.progress = panel.steps.length ? Math.round((done / panel.steps.length) * 100) : 0
          const next = panel.steps.find(s => s.status === 'pending')
          if (next) next.status = 'running'
          if (next) panel.currentAction = next.name
          this.touch(panel)
          break
        }
        case 'workflow_complete': {
          const panel = this.panels.get(`flow:${evt.flowId}`)
          if (panel) { panel.status = 'success'; panel.progress = 100; this.touch(panel) }
          break
        }
        case 'workflow_error': {
          const panel = this.panels.get(`flow:${evt.flowId}`)
          if (panel) { panel.status = 'error'; panel.currentAction = evt.error || '出错'; this.touch(panel) }
          break
        }
        case 'wecom_doc': {
          const panel = this.ensurePanel(`doc:${evt.ts}`, '文档分析中')
          panel.currentAction = evt.fileName ? `正在分析: ${evt.fileName}` : evt.title
          this.touch(panel)
          break
        }
        case 'file_generated': {
          const id = `file:${evt.ts}`
          const panel = this.ensurePanel(id, '文件已生成')
          panel.status = 'success'
          panel.progress = 100
          panel.currentAction = evt.fileName
          panel.result = { fileName: evt.fileName, path: evt.path }
          this.touch(panel)
          break
        }
        case 'panel_cancel': {
          const panel = this.panels.get(evt.id)
          if (panel) { panel.status = 'cancelled'; this.touch(panel) }
          break
        }
        // 2026-08-13 P2-2: run 终态——roundId 面板置终态(无工具调用的轮次无面板,跳过)
        case 'run_finished': {
          const panel = this.panels.get(evt.roundId)
          if (panel && panel.status === 'running') {
            panel.status = 'success'
            panel.progress = 100
            panel.currentAction = '完成'
            this.touch(panel)
          }
          break
        }
        case 'run_error': {
          const panel = this.panels.get(evt.roundId)
          if (panel && panel.status === 'running') {
            panel.status = 'error'
            panel.currentAction = evt.error || '回复生成失败'
            this.touch(panel)
          }
          break
        }
        case 'run_interrupted': {
          const panel = this.panels.get(evt.roundId)
          if (panel && panel.status === 'running') {
            panel.status = 'cancelled'
            panel.currentAction = '已中断'
            this.touch(panel)
          }
          break
        }
      }
    } catch (err) {
      console.error('[task-panel] ingest 失败:', err instanceof Error ? err.message : String(err))
    }
  }

  getPanels(): TaskPanel[] {
    return Array.from(this.panels.values()).sort((a, b) => a.createdAt - b.createdAt)
  }

  clear(id: string): void {
    this.panels.delete(id)
    if (this.onUpdate) {
      try { this.onUpdate(this.getPanels()) } catch (e) { console.error('[task-panel] onUpdate 回调异常:', e) }
    }
  }

  reset(): void {
    this.panels.clear()
    if (this.onUpdate) {
      try { this.onUpdate(this.getPanels()) } catch (e) { console.error('[task-panel] onUpdate 回调异常:', e) }
    }
  }
}
