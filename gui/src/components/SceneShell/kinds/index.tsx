export { MeetingRecordingCard } from './meeting'
export type { MeetingRecordingData } from './meeting'
export { ChartCard } from './chart'
export type { ChartData } from './chart'
export { TimelineCard } from './timeline'
export type { TimelineData } from './timeline'
export { FocusThreadCard } from './focus-thread'
export type { FocusThreadData } from './focus-thread'
export { FormCard } from './form'
export type { FormData } from './form'
export { KanbanCard as KanbanRendererCard } from './kanban'
export type { KanbanData } from './kanban'
export { WeatherCard } from './weather'
export type { WeatherData } from './weather'
export { MetricCard } from './metric'
export type { MetricData } from './metric'
export { ChoiceCard } from './choice'
export type { ChoiceData } from './choice'
export { ImageCard } from './image'
export type { ImageData } from './image'
export { AwakeningCard } from './awakening'
export type { AwakeningData } from './awakening'
export { SelfCheckCard } from './selfcheck'
export type { SelfCheckData } from './selfcheck'
export { TaskPanelCard } from './task-panel'
export type { TaskPanelData } from './task-panel'
export { NewsCard } from './news'
export type { NewsData } from './news'
export { ExpertReviewCard } from './expert-review'
export type { ExpertReviewData } from './expert-review'
export { DocumentCard } from './document'
export type { DocumentData } from './document'
export type { ContractData } from './contract'
export { ProgressCard } from './progress'
export type { ProgressData } from './progress'
export { WebPreviewCard } from './web-preview'
export type { WebPreviewData } from './web-preview'
export { BriefingCard } from './briefing'
export type { BriefingCardData } from './briefing'
export { default as TravelCard } from './travel'
export type { TravelCardData } from './travel'
export { default as StocksCard } from './stocks'
export type { StocksCardData } from './stocks'
export { default as TyphoonCard } from './typhoon'
export type { TyphoonCardData } from './typhoon'

import React, { useEffect } from 'react'
import { PersonCard } from '../../PersonCard'
import { MediaStage } from '../../MediaStage'
import { WeatherCard } from './weather'
import { MetricCard } from './metric'
import { ChoiceCard } from './choice'
import { ImageCard } from './image'
import { AwakeningCard } from './awakening'
import { SelfCheckCard } from './selfcheck'
import { MeetingRecordingCard } from './meeting'
import { ChartCard } from './chart'
import { TimelineCard } from './timeline'
import { FocusThreadCard } from './focus-thread'
import { FormCard } from './form'
import { KanbanCard as KanbanRendererCard } from './kanban'
import { NewsCard } from './news'
import { ExpertReviewCard } from './expert-review'
import { ProgressCard } from './progress'
import { WebPreviewCard } from './web-preview'
import { BriefingCard } from './briefing'
import { ReceivableCard } from './receivable'
import { ContractExpiryCard } from './contract-expiry'
import { BusinessBriefingCard } from './business-briefing'
import { ApprovalsCard } from './approvals'
import { StockAlertCard } from './stock-alert'
import { CustomerCard } from './customer'
import { SupplierCard } from './supplier'
import TravelCard from './travel'
import StocksCard from './stocks'
import TyphoonCard from './typhoon'
import EnterpriseCard from './enterprise'
// 2026-08-27 B1-3: 面板宿主组件——[panel] 条目(下方 KIND_REGISTRY)的 component 引用。
// 各面板由 App/VoiceShell 常驻宿主承载(SideSheet), SceneShell 侧注册 render:'skip'
// 仅作门禁接线声明, 行为与原「kind 未注册→null」一致(例外: businessReport 按全屏面板直挂)。
import { FloatingMusicPlayer } from '../../FloatingMusicPlayer'
import { FileGenPanel } from '../../FileGenPanel'
import { SchedulePanel } from '../../SchedulePanel'
import { KnowledgePanel } from '../../KnowledgePanel'
import CommodityPanel from '../../CommodityPanel'
import { StockPanel } from '../../StockPanel'
import BusinessReportPanel from '../../BusinessReportPanel'

const rankColors = ['#ffd700', '#c0c0c0', '#cd7f32', '#888', '#888']

export const TextRenderer: React.FC<{ data?: { text?: string; content?: string; body?: string; title?: string } }> = ({ data }) => (
  <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.06)' }}>
    {data?.title ? <div style={{ fontSize: '14px', color: '#dbe0ff', marginBottom: 4, fontWeight: 600 }}>{data.title}</div> : null}
    <div style={{ fontSize: '14px', color: 'var(--text-secondary, #ccc)', lineHeight: 1.5 }}>
      {data?.text || data?.content || data?.body || ''}
    </div>
  </div>
)

export const HotspotRenderer: React.FC<{ data?: { items?: any[]; platforms?: { items?: any[] }[]; platform?: string } }> = ({ data }) => {
  const items: any[] = data?.items || data?.platforms?.[0]?.items || []
  const platform = data?.platform || '综合'
  return (
    <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.06)', minWidth: 200 }}>
      <div style={{ fontSize: '14px', color: '#f97316', marginBottom: 6, fontWeight: 600 }}>🔥 {platform}热议 · 实时</div>
      {items.slice(0, 5).map((item: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 14, color: '#ccc', borderBottom: i < Math.min(4, items.length - 1) ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
          <span style={{ minWidth: 16, textAlign: 'center', fontWeight: 700, color: rankColors[i] || '#666', fontSize: 10 }}>{i + 1}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title || item.text || ''}</span>
          {item.heat && <span style={{ color: '#888', fontSize: 9 }}>{item.heat}</span>}
        </div>
      ))}
      <div style={{ fontSize: 9, color: '#666', marginTop: 6, textAlign: 'right' }}>点击侧栏「热点」查看完整榜单</div>
    </div>
  )
}

export const DocRenderer: React.FC<{ data?: { topicId?: string; topic?: string; sections?: Array<{ title?: string } | string> } }> = ({ data }) => {
  const topic = data?.topicId || data?.topic || '配置说明'
  const sections = data?.sections || []
  return (
    <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.06)', minWidth: 180 }}>
      <div style={{ fontSize: '14px', color: '#59a8ff', marginBottom: 6, fontWeight: 600 }}>📖 {topic}</div>
      {sections.slice(0, 3).map((s: any, i: number) => (
        <div key={i} style={{ padding: '2px 0', fontSize: 14, color: '#aaa' }}>· {s.title || s}</div>
      ))}
      <div style={{ fontSize: 9, color: '#666', marginTop: 6, textAlign: 'right' }}>点击侧栏「文档」查看完整说明</div>
    </div>
  )
}

// P6(GUI 全量修复 P1): 字段对齐后端 panels-v2 pushFocusBanner 实际推送
// {level, icon, color, title, message, actions, ttlMs}——旧实现读 task/text/status
// 后端从不推送 → 卡片恒空正文恒蓝色
export const FocusBannerRenderer: React.FC<{ data?: { title?: string; message?: string; level?: string; icon?: string; actions?: any[] } }> = ({ data }) => {
  const title = data?.title || '专注提醒'
  const message = data?.message || ''
  const level = data?.level || 'info'
  const colorMap: Record<string, string> = { info: '#59a8ff', warn: '#ff9800', error: '#f44336', success: '#4caf50', alert: '#f44336' }
  const borderColor = colorMap[level] || '#59a8ff'
  return (
    <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)', border: `1px solid ${borderColor}44`, borderLeft: `3px solid ${borderColor}` }}>
      <div style={{ fontSize: '14px', color: borderColor, marginBottom: 4, fontWeight: 600 }}>{data?.icon || '🎯'} {title}</div>
      {message && <div style={{ fontSize: 14, color: '#eee', lineHeight: 1.4 }}>{message}</div>}
    </div>
  )
}

export const TerminalRenderer: React.FC<{ data?: { lines?: string[]; logs?: string[] } }> = ({ data }) => {
  const lines: string[] = data?.lines || data?.logs || []
  return (
    <div style={{ padding: '10px 12px', borderRadius: '12px', background: 'rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.06)', fontFamily: 'monospace', maxHeight: 120, overflow: 'hidden' }}>
      <div style={{ fontSize: 9, color: '#59a8ff', marginBottom: 4 }}>$ 终端输出</div>
      {lines.slice(-5).map((line: string, i: number) => {
        const text = String(line ?? '')
        return (
          <div key={i} style={{ fontSize: 14, color: text.startsWith('!') ? '#f44336' : text.startsWith('>') ? '#4caf50' : '#aaa', whiteSpace: 'pre-wrap', lineHeight: 1.3 }}>{text}</div>
        )
      })}
    </div>
  )
}

/**
 * VoiceRetireRenderer — 语音会话退休反馈卡（P2-2）
 *
 * 消费 ShowVoiceRetire 工具 scene 格式数据：
 * { title, duration(ms), turns, asrChars, ttsChars, reconnects, tips, farewell }。
 * 极简反馈卡：6 秒后经 onClose（closeSurface 双通道）自动消失。
 */
export const VoiceRetireRenderer: React.FC<{
  data?: { title?: string; duration?: number; turns?: number; asrChars?: number; ttsChars?: number; reconnects?: number; tips?: string[]; farewell?: string }
  onClose?: () => void
}> = ({ data, onClose }) => {
  // 反馈卡语义：短暂展示后自动收走（closeSurface → __sceneShell 本地 dismiss，无卡时 no-op）
  useEffect(() => {
    if (!onClose) return
    const t = setTimeout(() => {
      try { onClose() } catch (e) { console.error('[voice_retire] 自动关闭失败:', e) }
    }, 6000)
    return () => clearTimeout(t)
  }, [onClose])
  const dur = data?.duration ? `${(data.duration / 1000).toFixed(1)}s` : ''
  return (
    <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.06)', minWidth: 200, position: 'relative' }}>
      {onClose && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          style={{
            position: 'absolute', top: 4, right: 4, width: 22, height: 22, borderRadius: 6,
            border: 'none', cursor: 'pointer', background: 'rgba(255,255,255,0.06)',
            color: 'var(--text-muted, #999)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, zIndex: 2,
          }}
          title="关闭"
        >✕</button>
      )}
      <div style={{ fontSize: 14, color: '#c084fc', marginBottom: 6, fontWeight: 600 }}>💤 语音会话已退下</div>
      {(dur || data?.turns !== undefined) && (
        <div style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5 }}>
          {dur && `时长 ${dur}`}{dur && data?.turns !== undefined ? ' · ' : ''}{data?.turns !== undefined ? `${data.turns} 回合` : ''}
          {data?.asrChars !== undefined ? ` · ASR ${data.asrChars} 字` : ''}
          {data?.ttsChars !== undefined ? ` · TTS ${data.ttsChars} 字` : ''}
        </div>
      )}
      {data?.farewell && <div style={{ fontSize: 13, color: '#ccc', marginTop: 4 }}>{data.farewell}</div>}
    </div>
  )
}

/** WorldCupRenderer — 体育赛事卡（P2-2）。消费 ShowWorldCup 工具 scene 数据：{ title, events, standings }。 */
export const WorldCupRenderer: React.FC<{
  data?: {
    title?: string
    events?: Array<{ home?: string; away?: string; score?: string; status?: string; time?: string; league?: string }>
    standings?: Array<{ rank?: number; team?: string; points?: number }>
  }
}> = ({ data }) => {
  const events = data?.events || []
  const standings = data?.standings || []
  return (
    <div style={{ padding: '12px 16px', borderRadius: '12px', background: 'rgba(24,24,36,0.88)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.06)', minWidth: 230 }}>
      <div style={{ fontSize: 14, color: '#f97316', marginBottom: 6, fontWeight: 600 }}>{data?.title || '⚽ 体育赛事'}</div>
      {events.length === 0 && <div style={{ fontSize: 13, color: '#888' }}>暂无赛事数据</div>}
      {events.map((e, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 13, borderBottom: i < Math.min(5, events.length) - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
          <span style={{ color: '#ccc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {[e.league, e.home, 'vs', e.away].filter(Boolean).join(' ')}
          </span>
          <span style={{ color: e.status === 'live' ? '#f87171' : '#888', flexShrink: 0 }}>
            {e.score || e.status || ''}{e.time ? ` ${e.time}` : ''}
          </span>
        </div>
      ))}
      {standings.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 3 }}>积分榜 Top {Math.min(3, standings.length)}</div>
          {standings.slice(0, 3).map((s, i) => (
            <div key={i} style={{ fontSize: 13, color: '#aaa' }}>{s.rank}. {s.team} · {s.points} 分</div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 2026-08-14 审计 M2: 渲染上下文——mapProps 定制 props 时使用 */
export interface KindRenderContext {
  surface: { id: string; kind: string; data?: any }
  sendIntent: (id: string, name: string, data: any) => void
  close: () => void
}

export interface KindRenderer {
  component: React.ComponentType<any>
  displayName?: string
  persistOnSwitch?: boolean
  wrapper?: 'card' | 'none' | 'fullscreen'
  /**
   * 2026-08-14 审计 M2: 渲染模式下沉——'skip' 表示 SceneShell 不渲染
   * (由其它宿主渲染,如 music → FloatingMusicPlayer)。
   */
  render?: 'component' | 'skip'
  /**
   * 2026-08-14 审计 M2: 自定义 props 映射(缺省 { data, onClose })——
   * 替代 SceneShell 渲染核心里的 per-kind switch 特判。
   */
  mapProps?: (ctx: KindRenderContext) => Record<string, any>
  /** M2: 组件外层框架样式(如 media 圆角裁切容器),缺省不包裹 */
  frameStyle?: React.CSSProperties
}

// 2026-08-27 B1-3: 面板 registry 单一事实源(后端 panel-registry → gen:ui-registry 生成)。
// KIND_REGISTRY 只保留场景卡 kind; 面板 kind(音乐/热点/天气/股票/文件/会议/日程/知识库/企业/经营日报)
// 从 PANEL_REGISTRY 派生, 新增面板漏绑组件由门禁测试揭发, 不再 silent miss。
import { PANEL_REGISTRY } from './ui-panels.generated'

export function getPanelKeyBySurface(surface: string): string | null {
  for (const [key, e] of Object.entries(PANEL_REGISTRY)) {
    if (e.surface === surface) return key
  }
  return null
}

export const KIND_REGISTRY: Record<string, KindRenderer> = {
  person_card: { component: PersonCard, wrapper: 'card', mapProps: ({ surface }) => ({ person: surface.data }) },
  // 2026-08-15: 媒体面板常驻宿主化(MediaStageHost 根层 SideSheet 渲染)——
  // 场景卡注册改 skip, 避免双渲染
  media: { component: MediaStage, wrapper: 'card', render: 'skip' },
  media_stage: { component: MediaStage, wrapper: 'card', render: 'skip' },

  // weather: WeatherPopup 独立渲染 id='weather-panel'（右上角 overlay）；
  // SceneWeather 工具 / chat-handler 预投影发的 weather-<city> 等 surface 走卡片墙
  // （id 与 weather-panel 不冲突，双通道并存不互踩）。
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  weather: { component: WeatherCard, wrapper: 'card' },
  metric: { component: MetricCard, wrapper: 'card' },
  choice: { component: ChoiceCard, wrapper: 'none', mapProps: ({ surface, sendIntent }) => ({ data: surface.data, surfaceId: surface.id, sendIntent }) },
  text: { component: TextRenderer, wrapper: 'none' },
  info: { component: TextRenderer, wrapper: 'none' },
  image: { component: ImageCard, wrapper: 'card' },
  awakening: { component: AwakeningCard, wrapper: 'card' },
  selfcheck: { component: SelfCheckCard, wrapper: 'card' },
  // 2026-08-15: music/music_player 注册表条目移除——旧条目挂死代码组件
  // MusicPlayerCard(render:'skip' 从不渲染)。kind 未注册时 SceneShell 返回 null
  // 不渲染,音乐 surface 统一由 FloatingMusicPlayer(SideSheet)承载,不经过 SceneShell。
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  // 2026-08-27 B1-3: 依门禁测试回加 skip 声明(挂真实宿主 FloatingMusicPlayer,不渲染)——
  // 与 2026-08-15 移除前行为一致, 只作面板键接线标记, 不再挂死代码组件。
  music: { component: FloatingMusicPlayer, wrapper: 'card', render: 'skip' },
  meeting_recording: { component: MeetingRecordingCard, wrapper: 'card' },
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  meeting: { component: MeetingRecordingCard, wrapper: 'card' },
  chart: { component: ChartCard, wrapper: 'card' },
  timeline: { component: TimelineCard, wrapper: 'card' },
  focus_thread: { component: FocusThreadCard, wrapper: 'card' },
  form: { component: FormCard, wrapper: 'none', mapProps: ({ surface, sendIntent }) => ({ data: surface.data, surfaceId: surface.id, sendIntent }) },
  kanban: { component: KanbanRendererCard, wrapper: 'card' },
  // task_panel 已移除：统一由 TaskPanelHost 浮层渲染（通道 B），消除双通道双卡
  news: { component: NewsCard, wrapper: 'card' },
  expert_review: { component: ExpertReviewCard, wrapper: 'none' },
  // P6(GUI 全量修复 P1): 注册 hotspot——ShowHotspot(format=scene) 推 id
  // hotspot_<platform> 的卡片(旧实现注册表无此 kind → 语音"看看热搜"无任何渲染,
  // 且 VoiceShell 按 kind 过滤把 hotspot-panel 全屏面板也滤掉的双重死通道)
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  hotspot: { component: HotspotRenderer, wrapper: 'card' },
  doc: { component: DocRenderer, wrapper: 'card' },
  documentation: { component: DocRenderer, wrapper: 'card' },
  focus_banner: { component: FocusBannerRenderer, wrapper: 'card' },
  terminal_stream: { component: TerminalRenderer, wrapper: 'card' },
  terminal: { component: TerminalRenderer, wrapper: 'card' },
  // 2026-08-25 用户指令(硬删除): document 场景卡渲染注册移除——文档任务只走 FileGenPanel
  // 2026-08-25 用户指令: contract 场景卡彻底停用(文档任务走 FileGenPanel)
  progress: { component: ProgressCard, wrapper: 'card' },
  'web-preview': { component: WebPreviewCard, wrapper: 'card' },
  web_preview: { component: WebPreviewCard, wrapper: 'card' },
  briefing: { component: BriefingCard, wrapper: 'card' },
  travel: { component: TravelCard, wrapper: 'card' },
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  // stock = 全屏股票面板(StockPanel 常驻 App 宿主, surface id 'stock-panel'), 与下方
  // stocks 持仓场景卡(StockQuery 小卡)是两回事——skip 声明防面板 surface 漏进卡片墙双渲染。
  stock: { component: StockPanel, wrapper: 'card', render: 'skip' },
  stocks: { component: StocksCard, wrapper: 'card' },
  typhoon: { component: TyphoonCard, wrapper: 'card' },
  // 2026-08-14: 企业查询卡（EnterpriseQuery 发射 surface 'enterprise-card'）
  enterprise: { component: EnterpriseCard, wrapper: 'card' },
  voice_retire: { component: VoiceRetireRenderer, wrapper: 'card' },
  worldcup: { component: WorldCupRenderer, wrapper: 'card' },
  // ── 2026-08-27 B1-3: 面板键接线声明——PANEL_REGISTRY(gen:ui-registry)为面板键唯一事实源,
  //    门禁测试要求每个面板键在 KIND_REGISTRY 有渲染配置(新增面板漏绑在测试层爆炸)。
  //    以下各键面板均由常驻宿主承载(App/VoiceShell 直接挂载), SceneShell 侧 skip 不渲染;
  //    businessReport 例外: business-panel surface 已在 VoiceShell 按 id 过滤, 全屏直挂兜底。
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  filegen: { component: FileGenPanel, wrapper: 'card', render: 'skip' },
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  schedule: { component: SchedulePanel, wrapper: 'card', render: 'skip' },
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  knowledge: { component: KnowledgePanel, wrapper: 'card', render: 'skip' },
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  commodity: { component: CommodityPanel, wrapper: 'card', render: 'skip' },
  // [panel] 键来自 PANEL_REGISTRY（gen:ui-registry）——新增面板勿手写键, 先 registerPanel 再 gen
  businessReport: { component: BusinessReportPanel, wrapper: 'fullscreen' },
  // 2026-09-05 业务卡 P0 三张: ShowXxxPanel 发射 surface 数据, SceneShell 卡片墙渲染
  // （数据随 surface 走, 无需独立 API 端点; surface id 不进 VoiceShell PANEL_SURFACE_IDS）
  receivable: { component: ReceivableCard, wrapper: 'card' },
  contractExpiry: { component: ContractExpiryCard, wrapper: 'card' },
  businessBriefing: { component: BusinessBriefingCard, wrapper: 'card' },
  // 2026-09-05 业务卡 P1 三张: 审批卡带 sendIntent(批准/驳回→下轮意图→ResolveApproval)
  approvals: { component: ApprovalsCard, wrapper: 'card', mapProps: ({ surface, sendIntent }) => ({ data: surface.data, surfaceId: surface.id, sendIntent }) },
  stockAlert: { component: StockAlertCard, wrapper: 'card' },
  customerView: { component: CustomerCard, wrapper: 'card' },
  // 2026-09-05 业务卡 P2: 供应商档案卡（采购汇总+可选工商+可选 Bitable 联系人）
  supplierProfile: { component: SupplierCard, wrapper: 'card' },
}

/** 面板键装配清单以 PANEL_REGISTRY 为准——KIND_REGISTRY 中 [panel] 条目不作为事实源 */
export function getKindRenderer(kind: string): KindRenderer | undefined {
  return KIND_REGISTRY[kind]
}
