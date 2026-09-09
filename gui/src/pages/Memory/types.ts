// 记忆系统类型定义 — 供 Memory/index.tsx 复用

export interface MemoryStats {
  sessions?: {
    total?: number
    totalMessages?: number
  }
  notebook?: {
    totalMemories?: number
    noteCount?: number
    sessionHighlightCount?: number
    byType?: Record<string, number>
    enhancedFactCount?: number
    enhancedEntityCount?: number
  }
  dream?: {
    sessionCount?: number
  }
  sessionFiles?: Array<{
    id: string
    createdAt: number
    messageCount: number
    tokenCount: number
  }>
}

export interface MemoryNote {
  id: string
  title: string
  content: string
  type?: string
  tags?: string[]
  trustScore?: number
  updated: number
}

export interface DreamResult {
  insights: Array<{ summary?: string; content?: string }>
  consolidated: number
  timestamp: number
}

export interface EntityInfo {
  name: string
  type: string
  factCount: number
  facts?: Array<{ id?: string; content: string; trustScore?: number }>
}

export interface GraphNode {
  id: string
  label: string
  type: string
  size?: number
  trustScore?: number
}

export interface GraphEdge {
  source: string
  target: string
  weight?: number
  label?: string
}

export interface TimelineEntry {
  id: string
  type: string
  timestamp: number
  content: string
  category?: string
  trustScore?: number
  entities?: string[]
}
