/**
 * ChatInputArea — 对话输入区（2026-09-21 P2-1 第二批从 index.tsx 拆出）
 *
 * 组成：圆桌会进行中横幅（此刻说话=老板插话 + 静音开关）→ 审批接管横幅 +
 * inline ApprovalHost（审批期输入暂停, AG-UI dojo HITL 语义）→ 附件 chips →
 * 输入行（附件上传/IME 守卫输入框/发送-停止合一按钮）→ 语音模式 footer。
 * 纯渲染搬运：JSX 与原实现逐字一致，状态与回调全部由 props 注入。
 */
import { Send, Square } from 'lucide-react'
import { ApprovalHost } from '../../components/ApprovalHost'
import { TodayOutputRail } from '../../components/TodayOutputRail'

export interface PendingAttachment {
  name: string
  path?: string
  pending?: boolean
}

export interface ChatInputAreaProps {
  /** 圆桌会状态（会议横幅显示与静音开关） */
  roundtableRunning: boolean
  roundtableGoal: string
  roundtableMuted: boolean
  onToggleRoundtableMuted: () => void
  /** 圆桌会进度（2026-09-22）：阶段人话标签 + 已发言/到场人数。
   *  数据源是后端一向就在广播、前端此前从未订阅的 roundtable:phase。 */
  roundtablePhaseLabel?: string
  roundtableSpoken?: number
  roundtableTotal?: number
  /** 2026-09-23 中止：请求已发出（按钮转"中止中…"直到会议真正收尾）+ 触发回调 */
  roundtableCancelling?: boolean
  onCancelRoundtable?: () => void
  /** 审批接管：>0 显示横幅并禁用输入 */
  approvalPendingCount: number
  onApprovalActiveChange: (n: number) => void
  /** 附件 */
  attachments: PendingAttachment[]
  uploadPct: number
  uploading: boolean
  onRemoveAttachment: (idx: number) => void
  onPickFiles: () => void
  /** 输入框 */
  textInput: string
  onTextInputChange: (v: string) => void
  inputRef: React.Ref<HTMLInputElement>
  composingRef: React.MutableRefObject<boolean>
  onSubmit: () => void
  /** 语音模式三态（placeholder/footer 文案） */
  muted: boolean
  pttOnly: boolean
  continuousMode: boolean
  /** 发送/停止合一按钮 */
  isGenerating: boolean
  onStopGenerating: () => void
}

export function ChatInputArea({
  roundtableRunning,
  roundtableGoal,
  roundtableMuted,
  onToggleRoundtableMuted,
  roundtablePhaseLabel,
  roundtableSpoken,
  roundtableTotal,
  roundtableCancelling,
  onCancelRoundtable,
  approvalPendingCount,
  onApprovalActiveChange,
  attachments,
  uploadPct,
  uploading,
  onRemoveAttachment,
  onPickFiles,
  textInput,
  onTextInputChange,
  inputRef,
  composingRef,
  onSubmit,
  muted,
  pttOnly,
  continuousMode,
  isGenerating,
  onStopGenerating,
}: ChatInputAreaProps) {
  return (
    <div className="voice-shell-chat-input-area voice-shell-chat-input-area--primary">
      {/* 2026-09-20 圆桌会进行中横幅——此刻说话(打字/语音)=老板插话, 后端转交会场;
          静音开关挂这里(会议内容已在对话流, 无独立卡片可放) */}
      {roundtableRunning && (
        <div className="voice-shell-approval-banner" style={{ background: 'rgba(92,107,192,0.2)' }}>
          <span className="voice-shell-approval-banner-dot" />
          <span className="voice-shell-approval-banner-text" style={{ flex: 1 }}>
            🪑 圆桌会进行中 · 此刻说话=老板插话，全场会听取{roundtableGoal ? `（议题：${roundtableGoal}）` : ''}
          </span>
          {/* 2026-09-22 进度可见：此前只有"进行中"一句，老板不知道到第几轮、
              几位专家发过言。阶段与人数都来自后端既有 roundtable:phase / statement。 */}
          {roundtablePhaseLabel ? (
            <span className="voice-shell-approval-banner-chip" title="当前会议阶段">
              {roundtablePhaseLabel}
            </span>
          ) : null}
          {roundtableTotal ? (
            <span
              className="voice-shell-approval-banner-chip"
              title="已发言专家 / 到场专家（同一专家多轮只计一位）"
            >
              {roundtableSpoken ?? 0}/{roundtableTotal} 位已发言
            </span>
          ) : null}
          {onCancelRoundtable && (
            <button
              type="button"
              onClick={onCancelRoundtable}
              disabled={roundtableCancelling}
              title={
                roundtableCancelling
                  ? '已请求中止，正在等当前发言结束'
                  : '中止本场会议（已产生的发言会保留；正在发言的专家会说完这句）'
              }
              style={{
                background: 'none',
                border: '1px solid rgba(248,113,113,0.45)',
                borderRadius: 'var(--radius-full)',
                cursor: roundtableCancelling ? 'default' : 'pointer',
                color: roundtableCancelling ? 'var(--text-muted)' : 'var(--color-error)',
                fontSize: 11,
                flexShrink: 0,
                padding: '1px 8px',
              }}
            >
              {roundtableCancelling ? '中止中…' : '中止'}
            </button>
          )}
          <button
            type="button"
            onClick={onToggleRoundtableMuted}
            title={roundtableMuted ? '开启语音播报' : '静音只看文字'}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12, flexShrink: 0, padding: '0 4px' }}
          >
            {roundtableMuted ? '🔇 已静音' : '🔊 播报中'}
          </button>
        </div>
      )}
      {approvalPendingCount > 0 && (
        <div className="voice-shell-approval-banner">
          <span className="voice-shell-approval-banner-dot" />
          <span className="voice-shell-approval-banner-text">
            工具需要授权 · {approvalPendingCount} 个请求待处理(输入已暂停)
          </span>
        </div>
      )}
      <ApprovalHost variant="inline" onActiveChange={onApprovalActiveChange} />
      {attachments.length > 0 && (
        <div className="vs-attachments">
          {attachments.map((a, i) => (
            <span key={`${a.name}-${i}`} className="vs-attachment-chip" title={a.path || a.name}>
              📎 {a.name}{a.pending && uploadPct > 0 ? <span className="vs-upload-pct"> {uploadPct}%</span> : null}
              <button type="button" className="vs-attachment-remove" onClick={() => onRemoveAttachment(i)}>✕</button>
            </span>
          ))}
        </div>
      )}
      <div className="voice-shell-chat-input-row">
        <button
          type="button"
          className="vs-attach-btn vs-attach-btn--round"
          onClick={onPickFiles}
          disabled={uploading}
          title="上传附件"
          aria-label="上传附件"
        >
          {/* 2026-08-20: emoji 📎 换内联 SVG 回形针——emoji 在小按钮内跨平台
              渲染粗糙(彩色/位图), SVG stroke 随 currentColor, 与深色主题一致;
              上传中同图标旋转(不再用 ⏳) */}
          <svg className={`vs-attach-icon${uploading ? ' vs-attach-icon--busy' : ''}`} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          className="voice-shell-chat-input-field"
          ref={inputRef}
          value={textInput}
          onChange={(e) => onTextInputChange(e.target.value)}
          /* 2026-08-14 ag-ui 二次分析: IME 组合守卫——拼音候选词确认回车不误发送
             (isComposing 为真时 Enter 属于输入法选词, 不触发提交)
             2026-08-19 修复: 改自跟踪 composingRef——原生 isComposing 在组合中途
             失焦后卡死为 true,回车永远被吞;ref + blur 取消后失焦即恢复可用 */
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onBlur={() => { composingRef.current = false }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !composingRef.current) onSubmit() }}
          /* 2026-08-25 界面对齐: placeholder 随语音模式给出常驻操作提示 */
          /* 2026-09-23 排版轮: 静音态不再重复"语音已关闭"（底部状态条已说一次，且
             "点击左侧语音球"在极简布局是错的——球是居中/可拖动的浮动卡，左栏此时
             根本不显示；方位词一律去掉，状态词统一由底部条承担） */
          placeholder={approvalPendingCount > 0
            ? '审批处理中…'
            : attachments.length > 0 ? '补充说明（可选）…'
            : muted ? '输入文字回车发送'
            : pttOnly ? '按住空格键开始说话 · 或输入文字回车发送'
            : continuousMode ? '实时监听中 · 直接说话 · 或输入文字回车发送'
            : '输入文字回车发送 · 空格说话或说唤醒词'}
          disabled={uploading || approvalPendingCount > 0}
        />
        {/* 2026-08-14 ag-ui 二次分析: 生成中按钮合一为 ⏹ 停止(发送/停止切换,
            停止后保留已收部分回复——useChatStream.abort 静默返回语义) */}
        <button
          type="button"
          className={`voice-shell-chat-send-btn${isGenerating ? ' voice-shell-chat-send-btn--stop' : ''}`}
          onClick={isGenerating ? onStopGenerating : onSubmit}
          disabled={uploading || approvalPendingCount > 0}
        >
          {isGenerating ? <Square size={12} fill="currentColor" /> : <Send size={16} />}
        </button>
      </div>
      <div className="voice-shell-chat-input-footer">
        <span className="voice-shell-chat-input-footer-dot" />
        {muted
          ? '语音已关闭 · 点一下语音球开启'
          : pttOnly
            ? '按住空格键开始说话'
            : continuousMode
              ? '实时监听中 · 直接说话即可'
              : '按住空格键开始说话'}
        <TodayOutputRail />
      </div>
    </div>
  )
}
