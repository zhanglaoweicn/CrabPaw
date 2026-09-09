/**
 * 专家图标共享映射 + 渲染函数
 *
 * 此前 ExpertsPanel / ExpertCard / ActivityFeed 三处各自维护一份 ICON_MAP，
 * 新增图标时容易漏改——统一收敛到此文件导出，三处引用。
 */
import {
  Cpu, BarChart3, FileText, Wrench, Brain, Globe, Sparkles, Monitor,
  // 2026-09-05: 内置 10 岗实际使用的图标名——此前 Wallet/Calculator 等不在表内,
  // renderExpertIcon 兜底把图标名当文本渲染在卡片上
  Calculator, Gauge, Gem, Map, Megaphone, PieChart, Scale, TrendingUp, Users2, Wallet,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'

export const EXPERT_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Cpu, BarChart3, FileText, Wrench, Brain, Globe, Sparkles, Monitor,
  Calculator, Gauge, Gem, Map, Megaphone, PieChart, Scale, TrendingUp, Users2, Wallet,
}

/** 是否为 emoji 图标（ActivityFeed 支持自定义 emoji 头像） */
export function isEmoji(s: string): boolean {
  return /^[\u{1F000}-\u{1FFFF}]/u.test(s)
}

/** 渲染专家图标：按名称取 lucide 图标；emoji 原样渲染；未知名称兜底显示文本 */
export function renderExpertIcon(name: string, className: string): ReactNode {
  if (!name) return <Brain className={className} />
  if (isEmoji(name)) return <span className={className.replace('w-3 h-3', 'text-sm')}>{name}</span>
  const Icon = EXPERT_ICONS[name]
  if (Icon) return <Icon className={className} />
  return <span className="text-lg">{name || '🧠'}</span>
}
