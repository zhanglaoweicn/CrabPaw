/**
 * SchedulePanel — 日程卡片（2026-08-19）
 *
 * 语音/文本「打开日程/日历」→ 弹出日程卡片,展示近 7 天日程(数据走系统原有
 * /api/calendar 日程服务:handleCalendarList + expandRecurring 展开重复日程)。
 *
 * 2026-08-19 第二版：日程卡片自承担添加/管理（用户要求不再跳转业务面板）——
 * - 「➕ 添加日程」打开内建模态表单（支持自然语言智能解析回填）
 * - 每条日程 hover 出 ✏️ 编辑 / 🗑 删除（删除走 useConfirm 确认）
 * - 增删改成功后端广播 schedule:updated → SSE 自动刷新（面板开着时）
 *
 * 架构:MeetingPanel 宿主骨架(useSceneClient('schedule-panel') + dismissed +
 * registerCommandHost('schedulePanel') + 可见性广播 + close 三件套)。
 * 分组:今天 / 明天 / 其余按日期(MM月DD日 周X);每天按时间升序。
 */
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useSceneClient } from '../../lib/scene-client'
import { SideSheet } from '../SideSheet'
import { registerCommandHost, getCommandHost } from '../../lib/ui-command-registry'
import { apiGet, apiPost, apiPut, apiDelete } from '../../lib/api'
import { useSse } from '../../hooks/useSSE'
import { useConfirm } from '../useConfirm'
import { toast } from 'sonner'
import './styles.css'

export interface ScheduleEvent {
  id: string
  title: string
  /** YYYY-MM-DD */
  date: string
  /** HH:mm */
  time: string
  duration: number
  description: string
  color: string
  source?: 'local' | 'feishu' | 'wecom'
}

export interface ScheduleGroup {
  label: string
  events: ScheduleEvent[]
}

/** Calendar 页同款 EVENT_COLORS（数据侧颜色契约） */
const EVENT_COLORS: Record<string, string> = {
  blue: 'var(--color-info)',
  green: 'var(--color-success)',
  orange: 'var(--accent-primary)',
  red: 'var(--color-error)',
  purple: '#a855f7',
  teal: '#14b8a6',
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']
const DURATION_OPTIONS = [30, 60, 90, 120, 180, 240]

function toLocalDateISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseTime(time: string): { hour: number; minute: number } | null {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return null
  return { hour: h, minute: m }
}

/** 事件时间展示:14:00-15:30(有时长);无时间 → 全天 */
function timeRange(time: string, duration: number): string {
  const t = parseTime(time)
  if (!t) return '全天'
  const endMin = t.hour * 60 + t.minute + (duration || 0)
  const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
  return duration > 0 ? `${time} - ${end}` : time
}

/** 分组:今天 / 明天 / 其余按日期(MM月DD日 周X);组内时间升序 */
export function groupSchedule(events: ScheduleEvent[]): ScheduleGroup[] {
  const now = new Date()
  const todayStr = toLocalDateISO(now)
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  const tomorrowStr = toLocalDateISO(tomorrow)

  const byDate = new Map<string, ScheduleEvent[]>()
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, [])
    byDate.get(e.date)!.push(e)
  }

  const labelFor = (dateStr: string): string => {
    if (dateStr === todayStr) return '今天'
    if (dateStr === tomorrowStr) return '明天'
    const d = new Date(`${dateStr}T00:00:00`)
    return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY_LABELS[d.getDay()]}`
  }

  const sortedDates = [...byDate.keys()].sort()
  const groups: ScheduleGroup[] = []
  // 今天/明天置顶(若在窗口内),其余按日期
  const ordered = [...sortedDates].sort((a, b) => (a === todayStr ? -1 : b === todayStr ? 1 : a === tomorrowStr ? -1 : b === tomorrowStr ? 1 : a.localeCompare(b)))
  for (const dateStr of ordered) {
    groups.push({
      label: labelFor(dateStr),
      events: byDate.get(dateStr)!
        .slice()
        .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99')),
    })
  }
  return groups
}

/** 已结束(日期早于今天,或今天但时间已过)→ 置灰 */
export function isPastEvent(e: ScheduleEvent): boolean {
  const now = new Date()
  const todayStr = toLocalDateISO(now)
  if (e.date < todayStr) return true
  if (e.date > todayStr) return false
  const t = parseTime(e.time)
  if (!t) return false
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const endMin = t.hour * 60 + t.minute + (e.duration || 0)
  return endMin <= nowMin
}

/** S3.1: 已开始未结束（进行中）→ 灰化 */
export function isOngoingEvent(e: ScheduleEvent): boolean {
  const now = new Date()
  if (e.date !== toLocalDateISO(now)) return false
  const t = parseTime(e.time)
  if (!t) return false
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const startMin = t.hour * 60 + t.minute
  const endMin = startMin + (e.duration || 0)
  return nowMin >= startMin && nowMin < endMin
}

/** S3.2: 当天事件两两 [start,end) 重叠检测 → id → 冲突对象标题数组（卡片内直接算，不新增后端） */
export function findConflicts(events: ScheduleEvent[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const parsed: { e: ScheduleEvent; start: number; end: number }[] = []
  for (const e of events) {
    const t = parseTime(e.time)
    if (!t) continue
    const start = t.hour * 60 + t.minute
    parsed.push({ e, start, end: start + (e.duration || 0) })
  }
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const a = parsed[i]
      const b = parsed[j]
      if (a.start < b.end && b.start < a.end) {
        if (!map.has(a.e.id)) map.set(a.e.id, [])
        if (!map.has(b.e.id)) map.set(b.e.id, [])
        map.get(a.e.id)!.push(b.e.title)
        map.get(b.e.id)!.push(a.e.title)
      }
    }
  }
  return map
}

// ────────────────────────────────────────────────────────────
// 添加/编辑共用表单模态（2026-08-19：日程卡片内建增删管，不再跳业务面板）
// ────────────────────────────────────────────────────────────

export interface ScheduleFormValue {
  title: string
  date: string
  time: string
  duration: number
  description: string
  color: string
}

export function emptyFormValue(): ScheduleFormValue {
  return {
    title: '',
    date: toLocalDateISO(new Date()),
    time: '09:00',
    duration: 60,
    description: '',
    color: 'blue',
  }
}

export function ScheduleEventFormModal({
  open,
  initial,
  prefill,
  onClose,
  onSaved,
}: {
  open: boolean
  /** 非空 = 编辑模式（PUT）；null = 新建（POST） */
  initial: ScheduleEvent | null
  /** S2.1: 语音歧义预填——非空时新建模态按此预填(仍走 POST 新建) */
  prefill?: Partial<ScheduleEvent> | null
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<ScheduleFormValue>(emptyFormValue())
  const [nlText, setNlText] = useState('')
  const [nlParsing, setNlParsing] = useState(false)
  const [saving, setSaving] = useState(false)

  // 打开时初始化表单（编辑预填 / 新建空表单），关闭清空自然语言输入
  useEffect(() => {
    if (!open) return
    setForm(
      initial
        ? {
            title: initial.title || '',
            date: initial.date || toLocalDateISO(new Date()),
            time: initial.time || '09:00',
            duration: initial.duration || 60,
            description: initial.description || '',
            color: initial.color || 'blue',
          }
        : prefill
          ? {
              title: prefill.title || '',
              date: prefill.date || toLocalDateISO(new Date()),
              time: prefill.time || '09:00',
              duration: prefill.duration || 60,
              description: prefill.description || '',
              color: prefill.color || 'blue',
            }
          : emptyFormValue(),
    )
    setNlText('')
    setSaving(false)
    setNlParsing(false)
  }, [open, initial, prefill])

  const setField = (field: keyof ScheduleFormValue, value: string | number) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  /** 自然语言智能解析：明天下午3点开周会 → {title,date,time,duration} 回填 */
  const handleNlParse = async () => {
    if (!nlText.trim()) {
      toast.error('请输入日程描述')
      return
    }
    setNlParsing(true)
    try {
      const result = await apiPost<{ success: boolean; event: ScheduleFormValue; error?: string }>(
        '/api/calendar/parse',
        { text: nlText },
      )
      if (result.success && result.data?.event?.title) {
        const ev = result.data.event
        // R5: title 为门槛——无 title 视为解析失败，不触碰已填表单（不半填）
        setForm(prev => ({
          ...prev,
          title: ev.title,
          date: ev.date || toLocalDateISO(new Date()),
          time: ev.time || '09:00',
          duration: ev.duration || 60,
          description: ev.description || prev.description || nlText,
        }))
        toast.success('已识别日程，请确认后保存')
      } else {
        toast.error('未能识别出日程内容，请手动填写或换个说法')
      }
    } catch (e: any) {
      toast.error('解析失败: ' + (e?.message || e))
    } finally {
      setNlParsing(false)
    }
  }

  const handleSave = async () => {
    if (!form.title.trim() || !form.date) {
      toast.error('标题和日期不能为空')
      return
    }
    setSaving(true)
    try {
      if (initial) {
        const up = await apiPut<{ success: boolean; error?: string }>('/api/calendar', { id: initial.id, ...form })
        if (!up.success) { toast.error(up.error || '日程更新失败'); setSaving(false); return }
        toast.success('日程已更新')
      } else {
        const cr = await apiPost<{ success: boolean; error?: string }>('/api/calendar', form)
        if (!cr.success) { toast.error(cr.error || '日程创建失败'); setSaving(false); return }
        toast.success('日程已创建')
      }
      onClose()
      onSaved()
    } catch (e: any) {
      toast.error((initial ? '更新' : '创建') + '失败: ' + (e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="schedule-modal" role="dialog" aria-modal="true" aria-label={initial ? '编辑日程' : '添加日程'}>
      <div className="schedule-modal-box">
        <div className="schedule-modal-title">{initial ? '✏️ 编辑日程' : '➕ 添加日程'}</div>

        {/* 自然语言快捷输入 */}
        <div className="schedule-form-nl">
          <input
            className="schedule-input"
            type="text"
            placeholder="自然语言输入，如「明天下午 3 点开周会」"
            value={nlText}
            onChange={e => setNlText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleNlParse() }}
            aria-label="自然语言日程描述"
          />
          <button type="button" className="schedule-btn" onClick={() => void handleNlParse()} disabled={nlParsing}>
            {nlParsing ? '解析中…' : '🔍 智能解析'}
          </button>
        </div>

        <div className="schedule-form-row">
          <label className="schedule-form-label">标题 *</label>
          <input
            className="schedule-input"
            type="text"
            placeholder="日程标题"
            value={form.title}
            onChange={e => setField('title', e.target.value)}
            aria-label="日程标题"
          />
        </div>
        <div className="schedule-form-row schedule-form-row--split">
          <div className="schedule-form-field">
            <label className="schedule-form-label">日期 *</label>
            <input
              className="schedule-input"
              type="date"
              value={form.date}
              onChange={e => setField('date', e.target.value)}
              aria-label="日程日期"
            />
          </div>
          <div className="schedule-form-field">
            <label className="schedule-form-label">时间</label>
            <input
              className="schedule-input"
              type="time"
              value={form.time}
              onChange={e => setField('time', e.target.value)}
              aria-label="日程时间"
            />
          </div>
          <div className="schedule-form-field">
            <label className="schedule-form-label">时长</label>
            <select
              className="schedule-input"
              value={form.duration}
              onChange={e => setField('duration', Number(e.target.value))}
              aria-label="日程时长"
            >
              {DURATION_OPTIONS.map(m => (
                <option key={m} value={m}>{m} 分钟</option>
              ))}
            </select>
          </div>
        </div>
        <div className="schedule-form-row">
          <label className="schedule-form-label">颜色</label>
          <div className="color-picker">
            {Object.keys(EVENT_COLORS).map(c => (
              <button
                key={c}
                type="button"
                aria-label={`颜色 ${c}`}
                className={`color-dot color-dot--${c}${(form.color || 'blue') === c ? ' color-dot--active' : ''}`}
                onClick={() => setField('color', c)}
              />
            ))}
          </div>
        </div>
        <div className="schedule-form-row">
          <label className="schedule-form-label">描述</label>
          <textarea
            className="schedule-input schedule-input--textarea"
            placeholder="备注（可选）"
            value={form.description}
            onChange={e => setField('description', e.target.value)}
            rows={2}
            aria-label="日程描述"
          />
        </div>

        <div className="schedule-form-actions">
          <button type="button" className="schedule-btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="button" className="schedule-btn schedule-btn--primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────
// 日程卡片
// ────────────────────────────────────────────────────────────

export function SchedulePanel() {
  const surface = useSceneClient('schedule-panel')
  const [dismissed, setDismissed] = useState(false)
  const dismissedRef = useRef(false)
  dismissedRef.current = dismissed
  const [voiceVisible, setVoiceVisible] = useState(false)
  const [events, setEvents] = useState<ScheduleEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 增删管状态：false=关闭；editing=null 新建 / 非空 编辑
  const [formOpen, setFormOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState<ScheduleEvent | null>(null)
  const [formPrefill, setFormPrefill] = useState<Partial<ScheduleEvent> | null>(null)
  // S3.1: 60s 心跳——now-line 位置/进行中灰化随时间自动刷新
  const [nowTick, setNowTick] = useState(0)
  // S3.3: scheduleId → 已完成纪要 {id,title}（chip 直达会议详情）
  const [meetingMap, setMeetingMap] = useState<Map<string, { id: string; title: string }>>(new Map())
  const { confirmNode, askConfirm } = useConfirm()

  const visible = (voiceVisible || !!surface) && !dismissed

  // 组合布局联动(同 MeetingPanel/FileGenPanel 模式)
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('crabpaw:hotspot-panel-visibility', { detail: { visible, name: 'schedule' } }))
    } catch (e) { console.warn('[schedule-panel] 广播可见性事件失败:', e) }
  }, [visible])

  // S3.1: 面板打开期间每 60s 触发重渲染(now-line/灰化随钟表走)
  useEffect(() => {
    if (!visible) return
    const t = setInterval(() => setNowTick(x => x + 1), 60_000)
    return () => clearInterval(t)
  }, [visible])

  /** 拉取近 7 天日程(含今天) */
  const loadEvents = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const start = toLocalDateISO(new Date())
      const end = new Date()
      end.setDate(end.getDate() + 6)
      const res = await apiGet<{ events: ScheduleEvent[] }>(
        `/api/calendar?start=${start}&end=${toLocalDateISO(end)}`,
      )
      if (res.success && Array.isArray(res.data?.events)) {
        setEvents(res.data.events)
      } else {
        setError(res.error || '日程加载失败')
      }
      // S3.3: 拉会议列表建 scheduleId → 纪要 映射（失败静默降级, chip 不显示）
      try {
        const mres = await apiGet<{ success: boolean; data?: { id: string; title: string; scheduleId?: string | null; hasSummary?: boolean; status?: string }[] }>('/api/meetings')
        const map = new Map<string, { id: string; title: string }>()
        for (const mtg of (mres.success && Array.isArray(mres.data)) ? mres.data : []) {
          if (mtg.scheduleId && (mtg.hasSummary || mtg.status === 'done') && !map.has(mtg.scheduleId)) {
            map.set(mtg.scheduleId, { id: mtg.id, title: mtg.title })
          }
        }
        setMeetingMap(map)
      } catch (e: any) {
        console.warn('[schedule-panel] 会议列表加载失败(纪要 chip 降级):', e?.message || e)
      }
    } catch (e: any) {
      console.error('[schedule-panel] 日程加载失败:', e?.message || e)
      setError('日程加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  /** 打开(语音「打开日程」/ surface 到达):复位 + 拉数据(保证新鲜) */
  const open = useCallback(() => {
    setDismissed(false)
    setVoiceVisible(true)
    void loadEvents()
  }, [loadEvents])

  // 后端日历增删改广播(schedule:updated)→ 面板开着时自动刷新(创建日程后立即可见)
  useSse({
    handlers: {
      'schedule:updated': () => {
        if (visible) void loadEvents()
      },
      // S2.1: 工具歧义分流——服务端已推 surface show 打开面板，这里打开预填表单
      'schedule:form': (payload: any) => {
        const p = payload?.prefill || {}
        setEditingEvent(null)
        setFormPrefill({ title: p.title, date: p.date, time: p.time, duration: p.duration, description: p.description })
        setFormOpen(true)
      },
    },
  })

  /** close 三件套:dismissed + 移除 surface + panel-state closed(同 MeetingPanel) */
  const handleClose = useCallback(() => {
    setDismissed(true)
    setVoiceVisible(false)
    setFormOpen(false)
    try {
      apiPost('/api/scene/remove', { id: 'schedule-panel' }).catch((e: any) => console.warn('[schedule-panel] 场景移除失败:', e?.message))
      apiPost('/api/scene/panel-state', { panel: 'schedule', state: 'closed' }).catch((e: any) => console.warn('[schedule-panel] 面板状态写入失败:', e?.message))
    } catch (e) { console.error('[schedule-panel] 关闭链路异常:', e) }
  }, [])

  /** 打开新建表单 */
  const openCreate = useCallback(() => {
    setEditingEvent(null)
    setFormPrefill(null)
    setFormOpen(true)
  }, [])

  /** 打开编辑表单 */
  const openEdit = useCallback((ev: ScheduleEvent) => {
    setEditingEvent(ev)
    setFormOpen(true)
  }, [])

  /** S3.3: 为日程开录会议纪要（命令宿主 meetingPanel.startRecordingForSchedule） */
  const startRecordingForEvent = useCallback((ev: ScheduleEvent) => {
    const host = getCommandHost('meetingPanel') as { startRecordingForSchedule?: (id: string, title: string) => void } | null
    if (host?.startRecordingForSchedule) {
      host.startRecordingForSchedule(ev.id, ev.title)
      toast.success('已开始为该日程记录会议')
    } else {
      toast.error('会议面板未就绪，请稍后重试')
    }
  }, [])

  /** S3.3: 打开该日程的会议纪要详情 */
  const openMinutes = useCallback((mtg: { id: string }) => {
    const host = getCommandHost('meetingPanel') as { openMeetingDetail?: (id: string) => void } | null
    if (host?.openMeetingDetail) host.openMeetingDetail(mtg.id)
    else toast.error('会议面板未就绪，请稍后重试')
  }, [])

  /** 删除(useConfirm 确认 → DELETE → SSE 自动刷新) */
  const handleDelete = useCallback(async (ev: ScheduleEvent) => {
    if (!(await askConfirm({ title: '删除日程', message: `确定要删除「${ev.title}」吗？此操作不可撤销。`, danger: true }))) return
    try {
      const res = await apiDelete<{ success: boolean; error?: string }>(`/api/calendar?id=${ev.id}`)
      if (!res.success) { toast.error(res.error || '日程删除失败'); return }
      toast.success('日程已删除')
      void loadEvents()
    } catch (e: any) {
      toast.error('删除失败: ' + (e?.message || e))
    }
  }, [askConfirm, loadEvents])

  /** 表单保存成功回调(SSE 也会自动刷新,双保险) */
  const handleFormSaved = useCallback(() => {
    void loadEvents()
  }, [loadEvents])

  // 语音/全局接口(恒注册)
  useEffect(() => {
    return registerCommandHost('schedulePanel', {
      open: () => open(),
      close: handleClose,
      isOpen: () => visible,
    })
  }, [open, handleClose, visible])

  // 首次挂载预拉一次(打开时开箱即快)
  useEffect(() => {
    void loadEvents()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const groups = groupSchedule(events)

  return (
    <SideSheet
      open={visible}
      onClose={handleClose}
      name="schedule"
      width="min(75vw, 1920px)"
    >
      <div className="schedule-panel">
        {/* 标题栏(视频卡片同构) */}
        <div className="schedule-header">
          <span className="schedule-title-icon">📅</span>
          <span className="schedule-title">日程</span>
          <button
            type="button"
            className="schedule-close-btn"
            data-close-btn
            onClick={handleClose}
            aria-label="关闭日程面板"
            title="关闭"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="schedule-error">
            {error}
            <button type="button" className="schedule-error-retry" onClick={() => void loadEvents()}>
              重试
            </button>
          </div>
        )}

        {/* 内容区(flex-1 滚动) */}
        <div className="schedule-body">
          {loading && events.length > 0 && <div className="schedule-refresh-bar" />}
          {loading && events.length === 0 ? (
            <div className="schedule-empty">
              <div className="schedule-empty-text">正在加载日程…</div>
            </div>
          ) : groups.length === 0 ? (
            <div className="schedule-empty">
              <div className="schedule-empty-icon">🗓️</div>
              <div className="schedule-empty-text">近 7 天暂无日程</div>
              <div className="schedule-empty-tip">点下方「添加日程」或说「明天下午 3 点开会」让我帮你安排</div>
            </div>
          ) : (
            groups.map(g => {
              // S3.1/S3.2: 今天组 now-line 定位 + 冲突检测(每渲染/每 60s tick 重算)
              void nowTick
              const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
              const firstFutureId = g.label === '今天'
                ? g.events.find(e => {
                    const t = parseTime(e.time)
                    return t && t.hour * 60 + t.minute > nowMin
                  })?.id
                : undefined
              const conflicts = findConflicts(g.events)
              return (
              <div key={g.label} className="schedule-group">
                <div className={`schedule-group-title${g.label === '今天' ? ' schedule-group-title--today' : ''}`}>{g.label}</div>
                {g.events.map(e => {
                  const conflictTitles = conflicts.get(e.id)
                  return (
                  <Fragment key={e.id}>
                    {firstFutureId === e.id && (
                      <div className="schedule-now-line"><span className="schedule-now-label">现在</span></div>
                    )}
                  <div
                    className={[
                      'schedule-item',
                      isPastEvent(e) ? 'schedule-item--past' : '',
                      isOngoingEvent(e) ? 'schedule-item--ongoing' : '',
                      conflictTitles?.length ? 'schedule-item--conflict' : '',
                    ].filter(Boolean).join(' ')}
                    style={{ borderLeftColor: EVENT_COLORS[e.color] || EVENT_COLORS.blue }}
                  >
                    <div className="schedule-item-time">{timeRange(e.time, e.duration)}</div>
                    <div className="schedule-item-main">
                      <div className="schedule-item-title">
                        <span className="schedule-item-title-text">{e.title}</span>
                        {e.source === 'feishu' && <span className="schedule-item-src">☁️ 飞书</span>}
                        {e.source === 'wecom' && <span className="schedule-item-src">💬 企微</span>}
                        {meetingMap.get(e.id) && (
                          <button
                            type="button"
                            className="schedule-item-minutes"
                            aria-label={`纪要 ${e.title}`}
                            title="查看该日程的会议纪要"
                            onClick={() => openMinutes(meetingMap.get(e.id)!)}
                          >
                            📋 纪要
                          </button>
                        )}
                      </div>
                      {e.description && <div className="schedule-item-desc">{e.description}</div>}
                      {conflictTitles?.length ? (
                        <div className="schedule-item-conflict">⚠ 与「{conflictTitles.join('」「')}」时间冲突</div>
                      ) : null}
                    </div>
                    {/* 2026-08-19: 内建管理——编辑/删除(hover 显示) */}
                    <div className="schedule-item-actions">
                      {!isPastEvent(e) && (
                        <button
                          type="button"
                          className="schedule-action-btn"
                          aria-label={`记录 ${e.title}`}
                          title="为该日程开录会议纪要"
                          onClick={() => startRecordingForEvent(e)}
                        >
                          🎙️
                        </button>
                      )}
                      <button
                        type="button"
                        className="schedule-action-btn"
                        aria-label={`编辑 ${e.title}`}
                        title="编辑"
                        onClick={() => openEdit(e)}
                      >
                        ✏️
                      </button>
                      <button
                        type="button"
                        className="schedule-action-btn schedule-action-btn--danger"
                        aria-label={`删除 ${e.title}`}
                        title="删除"
                        onClick={() => void handleDelete(e)}
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                  </Fragment>
                  )
                })}
              </div>
              )
            })
          )}
        </div>

        {/* 底部操作行(2026-08-19: 管理日程不再跳业务面板,内建增删管) */}
        <div className="schedule-footer">
          <button type="button" className="schedule-btn" onClick={() => void loadEvents()}>
            🔄 刷新
          </button>
          <button type="button" className="schedule-btn schedule-btn--primary" onClick={openCreate}>
            ➕ 添加日程
          </button>
        </div>
      </div>

      {/* 添加/编辑模态 */}
      <ScheduleEventFormModal
        open={formOpen}
        initial={editingEvent}
        prefill={formPrefill}
        onClose={() => setFormOpen(false)}
        onSaved={handleFormSaved}
      />
      {confirmNode}
    </SideSheet>
  )
}

export default SchedulePanel
