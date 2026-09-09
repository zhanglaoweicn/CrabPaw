/**
 * 管理舱 tab 导航映射单源（2026-08-21 审计 P0-1 收敛）。
 * 原 VoiceShell 内双份内联 map（cockpitTabMap/targetMap）键复数 experts，
 * 与全部发射方（语音/Ctrl+K/ControlUI 工具）的单数 expert 错位，
 * 导致三条入口全部静默落到 settings。此处单源 + 旧键兼容。
 */
import type { CockpitTab } from '../components/ManagementCockpit'

/** crabpaw:open-cockpit 事件路径（__cockpit.open / CommandPalette / UiCommandBridge） */
export const COCKPIT_TAB_MAP: Record<string, CockpitTab> = {
  settings: 'settings',
  cost: 'cost',
  model: 'settings',
  mcp: 'mcp',
  plugin: 'plugin',
  skills: 'skills',
  expert: 'expert',
  experts: 'expert', // 旧复数键兼容（历史发射方）
}

/** 语音命令 management_cockpit 路径（含 debug 直达） */
export const COCKPIT_TARGET_MAP: Record<string, CockpitTab> = {
  ...COCKPIT_TAB_MAP,
  logs: 'debug',
  status: 'debug',
  gateway: 'debug',
  memory: 'debug',
}

export function resolveCockpitTab(target: string, map: Record<string, CockpitTab> = COCKPIT_TAB_MAP): CockpitTab {
  return map[target] || 'settings'
}

// 2026-08-27 全局搜索: 管理舱设置小节静态清单(与 Settings 导航一致, 见 Settings/index.tsx NAV)
export const COCKPIT_SEARCH_SECTIONS: { label: string; tab: CockpitTab; section: string | null }[] = [
  { label: '模型配置', tab: 'settings', section: 'model' },
  { label: '安全配置', tab: 'settings', section: 'security' },
  { label: '消息通道', tab: 'settings', section: 'channel' },
  { label: '语音设置', tab: 'settings', section: 'voice' },
  { label: '外观主题', tab: 'settings', section: 'appearance' },
  { label: '数据备份', tab: 'settings', section: 'backup' },
  { label: '更新设置', tab: 'settings', section: 'update' },
  { label: '搜索配置', tab: 'settings', section: 'search' },
]

/** 管理舱搜索结果项 */
export interface CockpitSearchItem {
  id: string
  label: string
  hint: string
  tab: CockpitTab
  section: string | null
  keyword?: string
}

/** 构建搜索索引: 设置小节 + 技能/专家/插件/MCP 动态项; 单组失败静默跳过 */
export async function buildCockpitSearchIndex(): Promise<CockpitSearchItem[]> {
  const items: CockpitSearchItem[] = COCKPIT_SEARCH_SECTIONS.map(s => ({
    id: `section-${s.section}`, label: s.label, hint: '设置', tab: s.tab, section: s.section,
  }))
  const grab = async (fn: () => Promise<CockpitSearchItem[]>) => {
    try { return await fn() } catch (e) {
      console.warn('[cockpit-search] 索引组拉取失败(静默跳过):', (e as Error)?.message || e)
      return []
    }
  }
  const [skills, experts, plugins, mcp] = await Promise.all([
    grab(async () => {
      const { apiGet } = await import('./api')
      const res = await apiGet<{ skills: { name: string; displayName?: string; description?: string }[] }>('/skills')
      return (res?.data?.skills || []).map(s => ({
        id: `skill-${s.name}`, label: s.displayName || s.name, hint: '技能',
        tab: 'skills' as CockpitTab, section: null, keyword: s.name,
      }))
    }),
    grab(async () => {
      const { apiGet } = await import('./api')
      const res = await apiGet<{ name: string; title?: string }[]>('/api/experts')
      return (res?.data || []).map(e => ({
        id: `expert-${e.name}`, label: e.name, hint: '专家', tab: 'expert' as CockpitTab, section: null, keyword: e.name,
      }))
    }),
    grab(async () => {
      const { apiGet } = await import('./api')
      const res = await apiGet<{ plugins: { name: string; description?: string }[] }>('/api/plugin-manager/list')
      return (res?.data?.plugins || []).map(p => ({
        id: `plugin-${p.name}`, label: p.name, hint: '插件', tab: 'plugin' as CockpitTab, section: null, keyword: p.name,
      }))
    }),
    grab(async () => {
      const { apiGet } = await import('./api')
      const res = await apiGet<{ servers: { name: string }[] }>('/api/mcp/servers')
      return (res?.data?.servers || []).map(s => ({
        id: `mcp-${s.name}`, label: s.name, hint: 'MCP 服务', tab: 'mcp' as CockpitTab, section: null, keyword: s.name,
      }))
    }),
  ])
  return [...items, ...skills, ...experts, ...plugins, ...mcp]
}
