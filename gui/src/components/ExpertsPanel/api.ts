import { apiGet, apiPost, apiPut, apiDelete } from '../../lib/api'
import type { Expert, ExpertDetail, Category, RouteResult, ChainSuggestion, DepartmentInfo, TeamPreset, SummonResult } from './types'

export async function fetchExperts(category?: string): Promise<Expert[]> {
  const qs = category ? `?category=${encodeURIComponent(category)}` : ''
  const res = await apiGet<Expert[]>(`/api/experts${qs}`)
  if (!res.success) console.error('[fetchExperts] API error:', res.error)
  if (!res.data) console.warn('[fetchExperts] empty data, response:', res)
  return res.data || []
}

export async function fetchExpertDetail(id: string): Promise<ExpertDetail | null> {
  const res = await apiGet<ExpertDetail>(`/api/experts/${encodeURIComponent(id)}`)
  return res.data || null
}

export async function createExpert(data: Partial<ExpertDetail>): Promise<ExpertDetail | null> {
  const res = await apiPost<ExpertDetail>('/api/experts', data)
  return res.data || null
}

export async function updateExpert(id: string, data: Partial<ExpertDetail>): Promise<ExpertDetail | null> {
  const res = await apiPut<ExpertDetail>(`/api/experts/${encodeURIComponent(id)}`, data)
  return res.data || null
}

export async function deleteExpert(id: string): Promise<boolean> {
  const res = await apiDelete(`/api/experts/${encodeURIComponent(id)}`)
  return res.success
}

export async function resetExpertPrompt(id: string): Promise<string | null> {
  const res = await apiPost<{ prompt: string }>(`/api/experts/${encodeURIComponent(id)}/reset`, {})
  return res.data?.prompt || null
}

export async function routeMessage(message: string): Promise<RouteResult[]> {
  const res = await apiPost<RouteResult[]>('/api/experts/route', { message })
  return res.data || []
}

export async function suggestChain(expertId: string): Promise<ChainSuggestion[]> {
  const res = await apiPost<ChainSuggestion[]>('/api/experts/chain', { expertId })
  return res.data || []
}

export async function recordSession(expertId: string): Promise<void> {
  try { await apiPost('/api/experts/session', { expertId }) } catch (e) { console.warn('[recordSession] error:', e) }
}

export async function fetchCategories(): Promise<Category[]> {
  const res = await apiGet<Category[]>('/api/experts/categories')
  return res.data || []
}

export async function startCollab(goal: string, tasks: { expertId: string; prompt: string }[]) {
  const res = await apiPost<{ collabId: string; tasks: any[] }>('/api/experts/collab/start', { goal, tasks })
  if (!res.success) throw new Error(res.error || '启动失败')
  return res.data!
}

export async function getCollabStatus(id: string) {
  const res = await apiGet<any>(`/api/experts/collab/status?id=${encodeURIComponent(id)}`)
  return res.data || null
}

export async function getActivities(limit = 50) {
  const res = await apiGet<any>(`/api/experts/activity?limit=${limit}`)
  return res.data || []
}

export async function postActivity(activity: { expertId: string; expertName: string; expertIcon: string; action: string; message?: string }) {
  const res = await apiPost<any>('/api/experts/activity', activity)
  return res.data || null
}

/** 2026-08-26 E1: 当前激活专家(expert-context) — UI 角标 */
export async function fetchActiveExpert() {
  const res = await apiGet<{ name: string } | null>('/api/experts/active')
  return res?.data || null
}

/** 2026-09-04 部门化 P2: 部门列表（含主管解析与在编计数） */
export async function fetchDepartments(): Promise<DepartmentInfo[]> {
  const res = await apiGet<DepartmentInfo[]>('/api/experts/departments')
  return res.data || []
}

/** 2026-09-04 部门化 P2: 预设班组（一键例会） */
export async function fetchTeamPresets(): Promise<TeamPreset[]> {
  const res = await apiGet<TeamPreset[]>('/api/experts/presets')
  return res.data || []
}

/** 2026-09-04 P3: 按部门查在编岗位（确认环提案名单用） */
export async function fetchExpertsByDepartment(department: string): Promise<Expert[]> {
  const res = await apiGet<Expert[]>(`/api/experts?department=${encodeURIComponent(department)}&status=active`)
  return res.data || []
}

/**
 * 2026-09-04 P2: 显式召唤——query = 专家 id | 岗位别名 | 部门名。
 * expert/department → 后端已精确激活(activated=true); ambiguous → 消歧候选。
 */
export async function summonExpert(query: string): Promise<SummonResult | null> {
  const res = await apiPost<SummonResult>('/api/experts/summon', { query })
  if (!res.success) throw new Error(res.error || '召唤失败')
  return res.data || null
}

/** 2026-09-04 P2: 部门例会——成员并行执行 + 主管汇总（进度见 TaskRun 面板/collab SSE） */
export async function startDepartmentMeeting(params: { department?: string; presetId?: string; goal: string }) {
  const res = await apiPost<{ collabId: string; departmentLabel: string; lead: { id: string; name: string; title?: string; voiceStyle?: string } | null; tasks: any[] }>(
    '/api/experts/collab/department',
    params
  )
  if (!res.success) throw new Error(res.error || '例会启动失败')
  return res.data!
}
