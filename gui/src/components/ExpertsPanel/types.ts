/** ExpertsPanel 类型定义 */

export interface Expert {
  id: string
  name: string
  title: string
  description: string
  icon: string
  category: string
  tags: string[]
  capabilities: string[]
  builtin: boolean
  voiceStyle?: string
  lastUsedAt: number | null
  usageCount: number
  /** 2026-08-27 B1-5: 清单校验(validateExpertManifest)结果——false 时卡片显示「清单异常」徽章 */
  manifestValid?: boolean
  manifestIssues?: string[]
  /** 2026-09-04 部门化 P1: 组织字段——部门 id/显示名/编制状态/岗位别名 */
  department?: string | null
  departmentLabel?: string | null
  status?: 'active' | 'parked'
  aliases?: string[]
}

/** 2026-09-04 部门化 P2: 部门注册表条目(GET /api/experts/departments) */
export interface DepartmentInfo {
  id: string
  label: string
  icon: string
  description: string
  voiceAliases: string[]
  lead: string | null
  memberCount: number
}

/** 2026-09-04 部门化 P2: 预设班组(GET /api/experts/presets) */
export interface TeamPreset {
  id: string
  label: string
  description: string
  defaultGoal?: string
  expertIds: string[]
  memberCount: number
}

/** 2026-09-04 P2: 召唤解析结果(POST /api/experts/summon) */
export interface SummonResult {
  activated: boolean
  type: 'expert' | 'department' | 'ambiguous'
  expert?: { id: string; name: string; title: string; departmentLabel: string | null; status: string; voiceStyle?: string }
  department?: { id: string; label: string; lead: string | null; memberCount: number }
  members?: { id: string; name: string; voiceStyle?: string }[]
  candidates?: { id: string; name: string; departmentLabel: string | null }[]
  state?: { ok: boolean; name?: string } | null
}

export interface ExpertDetail extends Expert {
  systemPrompt: string
  promptTemplate: string | null
  routingKeywords: string[]
  collaborationChain: string[]
}

export interface Category {
  id: string
  label: string
}

export interface RouteResult {
  expertId: string
  name: string
  score: number
  matchedKeywords: string[]
  reason: string
}

export interface ChainSuggestion {
  expertId: string
  name: string
  title: string
  icon: string
}
