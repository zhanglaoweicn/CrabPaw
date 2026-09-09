/**
 * wake-words — 唤醒词配置加载（2026-09-01, spec §3.2）。
 *
 * 单一真值来源优先级: config.agent.name（管理舱→用户与智能体→智能体配置 写入,
 * 存 data/.crabpaw/config.json）→ config.wakeWord（Electron wake:set-keyword 写入,
 * 数组）→ BUILTIN_WAKE_WORDS 内置兼容兜底。
 * 读取口径与 useMeetingTranscription 的 asrCfg 一致: IPC 优先、HTTP 兜底、模块级缓存;
 * 'config-updated' 窗口事件时由消费方调用 invalidateWakeWords() 失效重载。
 */

export const BUILTIN_WAKE_WORDS: string[] = ['小螃蟹', '小龙女', 'crabpaw']

let cache: string[] | null = null

export function invalidateWakeWords(): void {
  cache = null
}

export async function loadWakeWords(): Promise<string[]> {
  if (cache) return cache
  let cfg: any = null
  try {
    if (typeof window !== 'undefined' && (window as any).electronAPI?.config?.get) {
      cfg = await (window as any).electronAPI.config.get()
    }
  } catch (e) { console.warn('[wake-words] IPC 读取配置失败,降级 HTTP:', e) }
  if (!cfg) {
    try {
      const { apiGet } = await import('./api')
      const res = await apiGet<{ agent?: { name?: string }; wakeWord?: string | string[] }>('/config')
      if (res?.success && res?.data) cfg = res.data
    } catch (e) { console.warn('[wake-words] HTTP 读取配置失败,用内置词兜底:', e) }
  }
  const fromConfig: string[] = []
  const agentName = cfg?.agent?.name
  if (typeof agentName === 'string' && agentName.trim()) fromConfig.push(agentName.trim())
  const ww = cfg?.wakeWord
  if (typeof ww === 'string' && ww.trim()) fromConfig.push(ww.trim())
  if (Array.isArray(ww)) {
    for (const w of ww) if (typeof w === 'string' && w.trim()) fromConfig.push(w.trim())
  }
  cache = [...new Set([...fromConfig, ...BUILTIN_WAKE_WORDS])].filter(w => w.length >= 2)
  return cache
}
