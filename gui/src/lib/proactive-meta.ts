/**
 * proactive_speak SSE 事件 → ProactiveNotice（纯函数，可测）
 * 面板元数据：intent 决定打扰强度与徽章视觉（对应设计规格 6.1 决策输出）
 */

export type ProactiveIntent = 'confront' | 'inform' | 'ambient' | 'silent'

export interface ProactiveNotice {
  trigger: string
  text: string
  intent: ProactiveIntent
  ts: number
  surface?: { kind?: string; title?: string; data?: { title?: string; body?: string } }
}

export const INTENT_META: Record<ProactiveIntent, { label: string; color: string }> = {
  confront: { label: '重要提醒', color: '#f44336' },
  inform: { label: 'CrabPaw 主动汇报', color: '#f97316' },
  ambient: { label: '背景资讯', color: '#59a8ff' },
  silent: { label: '静默通知', color: '#888' },
}

const VALID_INTENTS: ProactiveIntent[] = ['confront', 'inform', 'ambient', 'silent']

export function toProactiveNotice(data: any): ProactiveNotice | null {
  if (!data || typeof data.text !== 'string' || !data.text.trim()) return null
  const intent = VALID_INTENTS.includes(data.intent) ? (data.intent as ProactiveIntent) : 'inform'
  return {
    trigger: typeof data.trigger === 'string' ? data.trigger : 'agent',
    text: data.text,
    intent,
    ts: typeof data.ts === 'number' ? data.ts : Date.now(),
    surface: data.surface && typeof data.surface === 'object' ? data.surface : undefined,
  }
}
