/**
 * ChatMessages — 对话流单条消息渲染（2026-09-21 从 index.tsx 拆出）
 *
 * 第一批拆分：conversation.map 的单条消息体（头像/署名/正文/附件/决策卡/
 * 工具链回看/动作行）抽为 ChatMessageItem。容器（滚动 ref/空态/流式气泡）
 * 仍留在 index.tsx——它们与 shell 布局耦合更深，后续批次再拆。
 *
 * 纯渲染搬运：JSX 与原实现逐字一致，原闭包依赖（setTextInput/chatInputRef/
 * feedbackMap 等）全部改为 props 回调。行为不变由 tsc + vitest + 闸门保证。
 */
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { rtDeptColor } from '../../hooks/useRoundtable'
import { isImageAttachment, fileUrlFor, formatFileSize } from '../../lib/attachment'
import { SUGGESTED_PROMPTS } from '../../lib/voice-panel-commands'
import type { ChatMsg, ChatMsgFile, FlowToolEvent } from './types'

// Markdown 链接组件: 新窗口打开(react-markdown 默认 <a> 在同一窗口覆盖会话)
export function chatMarkdownLink(props: { href?: string; children?: React.ReactNode }) {
  return (
    <a href={props.href} target="_blank" rel="noopener noreferrer">
      {props.children}
    </a>
  )
}

export interface ChatMessageItemProps {
  m: ChatMsg
  /** 2026-08-19 三栏联动轮: 该消息轮次是否为当前联动选中轮 */
  linked: boolean
  agentDisplayName: string
  agentDisplayIcon: string
  feedback: 'up' | 'down' | undefined
  onLinkRound: (round: number) => void
  onOpenAttachment: (f: ChatMsgFile) => void
  /** 决策卡"追问这场会议"——父级闭包: 预填输入框并聚焦 */
  onFollowUp: () => void
  getToolBatch: (round: number) => FlowToolEvent[] | null
  toolchainOpen: boolean
  onToggleToolchain: (ts: number) => void
  onCopy: (m: ChatMsg) => void
  onRegenerate: (m: ChatMsg) => void
  onFeedback: (m: ChatMsg, rating: 'up' | 'down') => void
}

export function ChatMessageItem({
  m,
  linked,
  agentDisplayName,
  agentDisplayIcon,
  feedback,
  onLinkRound,
  onOpenAttachment,
  onFollowUp,
  getToolBatch,
  toolchainOpen,
  onToggleToolchain,
  onCopy,
  onRegenerate,
  onFeedback,
}: ChatMessageItemProps) {
  return (
    <div
      className={`chatcard-msg chatcard-msg--${m.role}${linked ? ' chatcard-msg--linked' : ''}`}
      data-round={m.round ?? undefined}
      /* 2026-08-19 三栏联动轮: 点击消息 → 左栏时间线高亮同轮组 + 右栏定位 */
      onClick={m.round != null ? () => onLinkRound(m.round as number) : undefined}
      title={m.role === 'user' ? '点击定位到时间线事件组' : undefined}
    >
      {m.role === 'ai' && m.speaker ? (
        /* 2026-09-20 圆桌会专家署名头像——部门七色圆徽, 悬停看姓名 */
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
            background: rtDeptColor(m.speaker.dept), color: '#fff', fontSize: 13, fontWeight: 600,
          }}
          title={m.speaker.name}
        >
          {(m.speaker.name || '?').charAt(0)}
        </span>
      ) : m.role === 'ai' ? (
        <div className="chatcard-msg-avatar chatcard-msg-avatar--ai">
          <span className="chatcard-msg-avatar-letter">
            {/^(https?:|local:\/\/|\/)/.test(agentDisplayIcon)
              ? <img src={agentDisplayIcon} alt="AI" className="chatcard-msg-avatar-img" />
              : agentDisplayIcon}
          </span>
        </div>
      ) : m.role === 'tool' ? (
        <span className="chatcard-msg-label chatcard-msg-label--tool">🔧</span>
      ) : (
        <span className="chatcard-msg-username chatcard-msg-username--user">{m.channel === 'wecom' ? '企微' : 'YOU'}</span>
      )}
      <div className="chatcard-msg-col">
        {m.role === 'ai' && (
          <div className="chatcard-msg-name chatcard-msg-name--ai">
            {m.speaker
              ? `${m.speaker.name}${m.speaker.round === 1 ? ' · 开场立场' : m.speaker.round === 2 ? ' · 交锋对齐' : ''}`
              : `${agentDisplayName}${m.channel === 'wecom' ? '（企微）' : ''}`}
          </div>
        )}
        <div className={`chatcard-msg-bubble${m.role === 'tool' ? ' chatcard-msg-bubble--tool' : m.role === 'ai' && !m.speaker ? ' chatcard-msg-bubble--md' : ''}`}>
          {/* 2026-08-21: 用户消息附件——图片缩略图 + 文件 chip，文本之前 */}
          {m.role === 'user' && m.files && m.files.length > 0 && (
            <div className="chatcard-attachments">
              {m.files.map((f, i) => (
                isImageAttachment(f.name) ? (
                  <img
                    key={`${f.path}-${i}`}
                    src={fileUrlFor(f.path)}
                    alt={f.name}
                    className="chatcard-attachment-img"
                    title={`${f.name}（点击打开原图）`}
                    onClick={() => onOpenAttachment(f)}
                    loading="lazy"
                  />
                ) : (
                  <button
                    key={`${f.path}-${i}`}
                    type="button"
                    className="chatcard-attachment-file"
                    title={f.path}
                    onClick={() => onOpenAttachment(f)}
                  >
                    📎 {f.name}
                    {formatFileSize(f.size) ? <span className="chatcard-attachment-size"> {formatFileSize(f.size)}</span> : null}
                  </button>
                )
              ))}
            </div>
          )}
          {m.role === 'ai' && m.decision ? (
            /* 2026-09-21 创新-B: 结构化决策卡——结论/任务清单/行动按钮
               三段分栏(定稿方案 head/结论/任务映射); 按钮只做有真实
               执行方的动作(追问预填/复制), 不造无后端的静态分派 */
            <div className="chatcard-decision">
              <div className="chatcard-decision-head">💡 决策卡</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.decision.text}</div>
              {m.decision.tasks.length > 0 && (
                <div className="chatcard-decision-tasks">
                  <div className="chatcard-decision-tasks-title">任务清单 · {m.decision.tasks.length} 项</div>
                  {m.decision.tasks.map((t, i) => (
                    <div key={i} className="chatcard-decision-task">
                      <span className="chatcard-decision-task-owner">{t.owner}</span>
                      <span className="chatcard-decision-task-body">{t.task}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="chatcard-decision-actions">
                <button
                  type="button"
                  className="chatcard-decision-action"
                  onClick={onFollowUp}
                >追问这场会议</button>
                <button
                  type="button"
                  className="chatcard-decision-action"
                  onClick={() => {
                    const copy = `${m.decision!.text}\n${m.decision!.tasks.map(t => `【${t.owner}】${t.task}`).join('\n')}`
                    navigator.clipboard.writeText(copy)
                      .then(() => toast.success('结论已复制'))
                      .catch(() => toast.error('复制失败'))
                  }}
                >复制结论</button>
              </div>
            </div>
          ) : m.role === 'ai'
            ? (m.speaker
              ? <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
              : <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: chatMarkdownLink }}>{m.text}</ReactMarkdown>)
            : m.text}
        </div>
        {/* 2026-08-14 ag-ui 二次分析: 消息时间戳(完成后才渲染) */}
        <div className="chatcard-msg-time">
          {new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}
        </div>
        {m.role === 'ai' && (() => {
          /* 2026-08-19 三栏联动轮: 该轮工具批(历史/当前)——非空才显示 ⛓ 按钮 */
          const batch = m.round != null ? getToolBatch(m.round) : null
          const chainOpen = toolchainOpen
          return (
          <>
          {/* 2026-08-25 界面对齐(小白龙步骤卡): 本轮工具 mini 徽标——
              成功✓/失败✕/进行中⏳, 展开 ⛓ 看详情 */}
          {batch && batch.length > 0 && (
            <div className="chatcard-msg-runsum">
              <span className="chatcard-msg-runsum-label">⟫ 本轮工具</span>
              {batch.slice(0, 4).map((t) => (
                <span key={t.toolId} className={`chatcard-msg-runsum-item chatcard-msg-runsum-item--${t.status}`}>
                  {t.status === 'error' ? '✕' : t.status === 'running' ? '⏳' : '✓'} {t.toolName}
                </span>
              ))}
              {batch.length > 4 && <span className="chatcard-msg-runsum-more">+{batch.length - 4}</span>}
            </div>
          )}
          <div className="chatcard-msg-actions">
            {/* ag-ui 二次分析: hover 动作行扩展——复制/重新生成(copilot-regenerate-button) */}
            <button
              type="button"
              className="chatcard-msg-action"
              onClick={() => onCopy(m)}
              title="复制回复"
              aria-label="复制回复"
            >📋</button>
            <button
              type="button"
              className="chatcard-msg-action"
              onClick={() => onRegenerate(m)}
              title="重新生成"
              aria-label="重新生成"
            >↻</button>
            {batch && batch.length > 0 && (
              <button
                type="button"
                className={`chatcard-msg-action${chainOpen ? ' is-active' : ''}`}
                onClick={() => onToggleToolchain(m.ts)}
                title={`查看本轮工具链(${batch.length} 个工具)`}
                aria-label={`工具链 ${batch.length} 个工具`}
              >⛓ {batch.length}</button>
            )}
            <button
              type="button"
              className={`chatcard-msg-action ${feedback === 'up' ? 'is-active' : ''}`}
              onClick={() => onFeedback(m, 'up')}
              title="有帮助"
              aria-label="有帮助"
            >👍</button>
            <button
              type="button"
              className={`chatcard-msg-action ${feedback === 'down' ? 'is-active' : ''}`}
              onClick={() => onFeedback(m, 'down')}
              title="不准确"
              aria-label="不准确"
            >👎</button>
          </div>
          {/* 2026-08-19 三栏联动轮: 工具链回看面板——该轮全部工具
              调用/结果(名称/状态/参数/摘要), 消息旁内联展开 */}
          {chainOpen && batch && batch.length > 0 && (
            <div className="chatcard-toolchain">
              {batch.map(t => (
                <div key={t.toolId} className="chatcard-toolchain-item" data-status={t.status}>
                  <div className="chatcard-toolchain-head">
                    <span className={`chatcard-toolchain-dot chatcard-toolchain-dot--${t.status}`} />
                    <span className="chatcard-toolchain-name">{t.toolName}</span>
                    <span className="chatcard-toolchain-status">
                      {t.status === 'running' ? '进行中' : t.status === 'error' ? '失败' : '完成'}
                    </span>
                  </div>
                  {t.args && (
                    <div className="chatcard-toolchain-args" title="工具参数">
                      {t.args.length > 140 ? `${t.args.slice(0, 140)}…` : t.args}
                    </div>
                  )}
                  {t.summary && (
                    <div className="chatcard-toolchain-summary" title="结果摘要">{t.summary}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          </>
          )
        })()}
      </div>
    </div>
  )
}

// ── 2026-09-21 P2-1 第二批: 空态/流式气泡/圆桌"正在输入"从 index.tsx 迁入 ──

/** 对话区空态: 模式化提示 + 快捷建议 chip（点击经 handleCommandChip 直发） */
export function ChatEmptyState({
  pttOnly,
  continuousMode,
  onAsk,
}: {
  pttOnly: boolean
  continuousMode: boolean
  onAsk: (text: string) => void
}) {
  return (
    <div className="voice-shell-chat-empty">
      <div className="voice-shell-chat-empty-hint">
        {/* P3(GUI 全量修复 P0): 提示按语音模式三态渲染——旧实现只分
            pttOnly/其他两态, live(实时)模式唤醒词已禁用却仍提示"说小螃蟹",
            用户照提示操作必然无反应 */}
        {pttOnly
          ? '专注模式 · 按住空格键开始说话'
          : continuousMode
            ? '实时监听中 · 直接说话即可'
            : '说「小螃蟹」或直接输入文字开始对话'}
      </div>
      {!pttOnly && (
        <div className="voice-shell-suggest">
          {SUGGESTED_PROMPTS.map((s) => (
            <button
              key={s}
              type="button"
              className="voice-shell-suggest-chip"
              onClick={() => onAsk(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 2026-08-14 C-1: 流式回复气泡——增量实时显示 + ▌ 光标, 定稿落卡后自动消失 */
export function StreamingBubble({ agentDisplayName, text }: { agentDisplayName: string; text: string }) {
  return (
    <div className="chatcard-msg chatcard-msg--ai chatcard-msg--streaming">
      <div className="chatcard-msg-avatar chatcard-msg-avatar--ai">
        <span className="chatcard-msg-avatar-letter">{agentDisplayName.charAt(0)}</span>
      </div>
      <div className="chatcard-msg-col">
        <div className="chatcard-msg-name chatcard-msg-name--ai">{agentDisplayName}</div>
        <div className="chatcard-msg-bubble chatcard-msg-bubble--md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: chatMarkdownLink }}>{text}</ReactMarkdown>
          <span className="chatcard-stream-cursor" aria-hidden="true">▌</span>
        </div>
      </div>
    </div>
  )
}

export interface RtTypingState {
  running: boolean
  typing: { name: string; dept?: string } | null
}

/** 2026-09-20 圆桌会"正在输入"——顺序调度确定性: 排到谁发言即显示,
    生成完毕气泡弹出、语音接上。会议内容本体走 pushChat 署名气泡, 不再有独立卡片 */
export function RtTypingIndicator({ running, typing }: RtTypingState) {
  return (
    <>
      <style>{'@keyframes rtDot { 0%, 60%, 100% { opacity: .2 } 30% { opacity: 1 } }'}</style>
      {running && typing && (
        <div className="chatcard-msg chatcard-msg--ai">
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
              background: rtDeptColor(typing.dept), color: '#fff', fontSize: 13, fontWeight: 600, opacity: 0.75,
            }}
          >
            {(typing.name || '?').charAt(0)}
          </span>
          <div className="chatcard-msg-col">
            <div className="chatcard-msg-name chatcard-msg-name--ai">{typing.name}</div>
            <div className="chatcard-msg-bubble" style={{ opacity: 0.7 }}>
              正在输入
              <span style={{ animation: 'rtDot 1.2s infinite' }}>·</span>
              <span style={{ animation: 'rtDot 1.2s infinite 0.2s' }}>·</span>
              <span style={{ animation: 'rtDot 1.2s infinite 0.4s' }}>·</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
