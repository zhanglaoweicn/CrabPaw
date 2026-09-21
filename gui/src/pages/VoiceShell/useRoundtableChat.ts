/**
 * useRoundtableChat — 圆桌会 × 对话流胶水 hook（2026-09-21 P2-1 第二批从 index.tsx 拆出）
 *
 * 把 useRoundtableMeetings 的六路 SSE 回调绑定到对话流 pushChat：
 * 专家发言=署名气泡、老板插话=用户气泡、简报/文档=系统消息、
 * 收口=结构化决策卡（结论态永久属对话历史）。
 * 纯搬运：回调体与原实现逐字一致。
 */
import { useCallback } from 'react'
import {
  useRoundtableMeetings,
  type RtStatement,
  type RtIntervention,
  type RtConclusion,
  type RtDocument,
} from '../../hooks/useRoundtable'
import type { PushChatFn } from './types'

export function useRoundtableChat(pushChat: PushChatFn, dialogChannel: 'classic' | 'realtime' | undefined) {
  return useRoundtableMeetings({
    initialMuted: dialogChannel === 'realtime',
    onStatement: useCallback((s: RtStatement) => {
      pushChat('ai', s.failed ? '（该岗位本次未能发言）' : s.text, undefined, undefined, undefined, undefined, { name: s.expertName, dept: s.department, round: s.round })
    }, [pushChat]),
    onIntervention: useCallback((it: RtIntervention) => {
      pushChat('user', it.text)
    }, [pushChat]),
    onBrief: useCallback((text: string) => {
      pushChat('ai', `📊 会务组已实算会场数据简报，专家发言将以此为准：\n\n${text}`)
    }, [pushChat]),
    onConclusion: useCallback((c: RtConclusion, host: { name: string; department?: string } | null) => {
      // 2026-09-21 创新-B: 收口升级为结构化决策卡(text 为降级/复制用全文,
      // decision 驱动分栏渲染); 决策卡=结论态永久属对话历史, 文档=产物态独立出卡
      const taskLines = c.tasks.map((t) => `☐ ${t.owner}：${t.task}`).join('\n')
      pushChat(
        'ai',
        `✅ 会议收口\n\n${c.text}${taskLines ? `\n\n—— 任务清单 ——\n${taskLines}` : ''}`,
        undefined, undefined, undefined, undefined,
        { name: host ? `${host.name}（主持）` : '主持', dept: host?.department, round: 3 },
        { text: c.text, tasks: c.tasks },
      )
    }, [pushChat]),
    onDocument: useCallback((doc: RtDocument) => {
      pushChat('ai', `📄 会议纪要已生成：${doc.name}（已出文件卡，可投递企微）`)
    }, [pushChat]),
    onEnded: useCallback((status: string, error?: string | null) => {
      if (status !== 'done') pushChat('ai', `⚠️ 圆桌会异常中断：${error || '未知错误'}`)
    }, [pushChat]),
  })
}
