/**
 * TaskLedger — 左栏「事务账本」（2026-09-22 体验层）
 *
 * 左栏此前是「用户消息处理器」：Memory / Knowledge / Decayed 三个内部计数器 +
 * 全量事件时间线 + SSE 帧回放滑杆——那是给工程师看的遥测，却占着老板视野里
 * 最贵的一栏。更麻烦的是它只回答「刚才发生了什么」，不回答「我现在该做什么」；
 * 而真正需要老板拍板的三类事（审批超时 / 长任务失败 / 待授权）分散在五个地方，
 * 最容易漏的那几类还会静默消失。
 *
 * 本组件就是那个问题的答案面：读 lib/notices 的账本，按「要不要你出手」排序，
 * 未处理的排最前，并提供行内动作（直接批准/拒绝、看任务、知道了）。
 *
 * 遥测能力没有丢——它整体移到了左栏的「运行日志」页签（AgentLeftPanel）。
 * 本组件只渲染账本，不订阅任何 SSE：写账本的人在 lib/notices（审批/任务各处）。
 */
import { useSyncExternalStore } from 'react'
import {
  clearNotices,
  countPending,
  getNotices,
  markNoticeHandled,
  sortNotices,
  subscribeNotices,
  type Notice,
  type NoticeLevel,
} from '../../lib/notices'
import { executeCommand, getCommandHost } from '../../lib/ui-command-registry'

/** 分档 → 语义色 token（不写死色值——亮/暗主题与强调色切换都能跟随） */
const LEVEL_COLOR: Record<NoticeLevel, string> = {
  action: 'var(--color-warning)',
  failed: 'var(--color-error)',
  done: 'var(--color-success)',
  info: 'var(--color-info)',
}

/** 审批宿主接口（ApprovalHost 经 ui-command-registry 注册） */
interface ApprovalHostHandle {
  approve?: (id?: string) => boolean
  reject?: (id?: string) => boolean
}

function timeLabel(ts: number): string {
  try {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return '' }
}

const btnStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  cursor: 'pointer',
  background: 'transparent',
  border: '1px solid var(--border-secondary)',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
}

export function TaskLedger({ onSpeakHint, maskDetail = false }: {
  /** 行内动作的即时语音反馈（父级把文案投给共享播报队列）；缺省不发声 */
  onSpeakHint?: (text: string) => void
  /** 2026-09-24 会客厅轮: 客人在场时隐藏明细行——业务明细（客户名/金额）不进公共视野；
   *  标题与"待拍板"件事仍可见（不能因为界面收敛而漏掉要老板出手的事） */
  maskDetail?: boolean
} = {}) {
  const notices = useSyncExternalStore(subscribeNotices, getNotices)
  const sorted = sortNotices(notices)
  const pending = countPending(notices)

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '6px 16px 4px',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-muted)',
          letterSpacing: '0.08em',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>要办的事</span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 500,
            padding: '0 6px',
            borderRadius: 'var(--radius-full)',
            background: pending > 0 ? 'var(--color-warning-bg)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${pending > 0 ? 'var(--color-warning)' : 'var(--border-primary)'}`,
            color: pending > 0 ? 'var(--color-warning)' : 'var(--text-muted)',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: 0,
          }}
          title={pending > 0 ? `${pending} 件事等你拍板` : '没有等你拍板的事'}
        >
          {pending > 0 ? `${pending} 待办` : sorted.length}
        </span>
        {sorted.length > 0 && (
          <button
            type="button"
            onClick={() => clearNotices()}
            title="把这些都标成「知道了」，清空账本"
            style={{ ...btnStyle, marginLeft: 'auto' }}
          >
            全部知道了
          </button>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 12px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {sorted.length === 0 ? (
          <div style={{ padding: '18px 6px', color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.7 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>现在没有要办的事</div>
            需要我做什么，直接说就行。
          </div>
        ) : (
          sorted.map(n => <LedgerRow key={n.id} notice={n} onSpeakHint={onSpeakHint} maskDetail={maskDetail} />)
        )}
      </div>
    </div>
  )
}

function LedgerRow({ notice, onSpeakHint, maskDetail = false }: { notice: Notice; onSpeakHint?: (text: string) => void; maskDetail?: boolean }) {
  const color = LEVEL_COLOR[notice.level]
  const isPendingApproval = notice.kind === 'approval' && notice.level === 'action' && !notice.handled
  const host = isPendingApproval ? getCommandHost<ApprovalHostHandle>('approvalHost') : undefined
  const dim = notice.handled ? 0.5 : 1

  const decide = (decision: 'approve' | 'reject') => {
    const fn = decision === 'approve' ? host?.approve : host?.reject
    if (typeof fn !== 'function' || !notice.ref) return
    const ok = fn.call(host, notice.ref)
    if (ok) onSpeakHint?.(decision === 'approve' ? '好的，批准了' : '好，拒绝了')
  }

  return (
    <div
      style={{
        border: '1px solid var(--border-primary)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 'var(--radius-sm)',
        padding: '6px 8px',
        background: 'rgba(255,255,255,0.02)',
        opacity: dim,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>
          {notice.title}
        </span>
        <span style={{ fontSize: 9.5, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
          {timeLabel(notice.ts)}
        </span>
      </div>

      {notice.detail && !maskDetail && (
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={notice.detail}
        >
          {notice.detail}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
        {isPendingApproval && host && (
          <>
            <button
              type="button"
              style={{ ...btnStyle, color: 'var(--color-success)', borderColor: 'var(--color-success)' }}
              onClick={() => decide('approve')}
            >
              批准
            </button>
            <button
              type="button"
              style={{ ...btnStyle, color: 'var(--color-error)', borderColor: 'var(--color-error)' }}
              onClick={() => decide('reject')}
            >
              拒绝
            </button>
          </>
        )}
        {notice.kind === 'task' && !notice.handled && (
          <button
            type="button"
            style={btnStyle}
            onClick={() => { try { executeCommand('taskPanel', 'open') } catch (e) { console.warn('[ledger] 打开任务面板失败:', e) } }}
          >
            看任务
          </button>
        )}
        {notice.handled ? (
          <span style={{ fontSize: 9.5, color: 'var(--text-muted)', marginLeft: 'auto' }}>已处理</span>
        ) : (
          <button
            type="button"
            style={{ ...btnStyle, marginLeft: 'auto' }}
            onClick={() => markNoticeHandled(notice.id)}
            title="从待办里去掉（不影响实际操作）"
          >
            知道了
          </button>
        )}
      </div>
    </div>
  )
}
