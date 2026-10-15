/**
 * ImageGenCard.tsx — 生图任务卡(2026-10-10)
 *
 * 用户诉求:"单独一个任务卡片用于生成、展示图片生成过程"。
 *
 * 数据源:useVoiceChatFlow.imageGenSlots——每个 ImageGenerate 工具调用一个槽位:
 *   tool_call 建槽(running + 提示词摘要) → tool_result 回填状态与图片路径
 *   → file_generated 兜底。卡片实时展示每次调用的进行状态,完成后原位显示成图
 *   缩略图(点击打开原图),不随轮次淡出(与 ToolCardStream 的 2.5s 淡出不同——
 *   生图产物是用户要的结果本体,不是过程噪音)。
 */
import type { ChatMsgFile } from './types'

export interface ImageGenSlot {
  toolId: string
  prompt: string
  status: 'running' | 'done' | 'error'
  imagePath?: string
}

export function ImageGenCard({ slots, onOpenImage }: {
  slots: ImageGenSlot[]
  onOpenImage: (f: ChatMsgFile) => void
}) {
  if (!slots.length) return null
  const doneCount = slots.filter(s => s.status === 'done' && s.imagePath).length
  const failCount = slots.filter(s => s.status === 'error').length
  const allSettled = doneCount + failCount === slots.length

  return (
    <div className="imagegen-card" data-state={allSettled ? 'settled' : 'running'}>
      <div className="imagegen-card__head">
        <span className="imagegen-card__title">🖼 图片生成</span>
        <span className="imagegen-card__progress">
          {allSettled
            ? (failCount === 0 ? `完成 ${doneCount} 张` : `完成 ${doneCount}/${slots.length}${failCount ? ` · 失败 ${failCount}` : ''}`)
            : `生成中 ${doneCount}/${slots.length}`}
        </span>
      </div>
      <div className="imagegen-card__grid">
        {slots.map(s => {
          // TS 收窄: 守卫在 JSX 条件里无法传导进闭包, 先取局部常量
          const imgPath = s.status === 'done' ? s.imagePath : undefined
          return (
            <div key={s.toolId} className={`imagegen-card__cell imagegen-card__cell--${s.status}`} title={s.prompt}>
              <div className="imagegen-card__canvas">
                {imgPath ? (
                  <img
                    src={`local:///${imgPath.replace(/\\/g, '/')}`}
                    alt={s.prompt || '生成的图片'}
                    className="imagegen-card__img"
                    loading="lazy"
                    onClick={() => onOpenImage({ path: imgPath, name: imgPath.split(/[/\\]/).pop() || imgPath, type: 'image' })}
                  />
                ) : s.status === 'error' ? (
                  <span className="imagegen-card__mark imagegen-card__mark--fail" aria-label="生成失败">✕</span>
                ) : (
                  <span className="imagegen-card__spinner" role="status" aria-label="生成中" />
                )}
              </div>
              {s.prompt && <span className="imagegen-card__prompt" title={s.prompt}>{s.prompt}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
