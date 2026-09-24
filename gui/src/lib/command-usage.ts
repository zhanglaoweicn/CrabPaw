/**
 * command-usage — 命令使用频次（2026-09-22 体验层）
 *
 * 背景：界面里的入口数量早就过了"靠人力排序"的规模——同一功能有多条路径，
 * 命令面板一份清单(COMMAND_DEFS)、语音一份规则(voice-panel-commands)、
 * agent 一份 case(UiCommandBridge)。清单顺序是人工 curated 的，对每个老板
 * 都一样，于是"你最常用的那条"永远躺在中段。
 *
 * 本模块只做一件事：记住谁用过什么，把高频的浮到前面。不做推荐、不做隐藏——
 * 低频项仍全量可达（只是排在后面），避免"东西不见了"这类不可解释的行为。
 *
 * 排序规则（rankCommandIds）：
 *   ① 有使用记录的，按次数降序；
 *   ② 次数相同 / 都无记录的，保持原清单顺序（稳定排序）——
 *      新用户看到的仍是人工 curated 的顺序，体验不退化。
 */

const STORAGE_KEY = 'crabpaw.commandUsage.v1'
/** 只留最近的若干条——存档是为了排序，不是统计报表 */
const MAX_ENTRIES = 80

export interface UsageEntry {
  count: number
  lastUsedAt: number
}

export type UsageMap = Record<string, UsageEntry>

function load(): UsageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: UsageMap = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<UsageEntry>
      if (!e || typeof e.count !== 'number' || e.count <= 0) continue
      out[id] = { count: e.count, lastUsedAt: typeof e.lastUsedAt === 'number' ? e.lastUsedAt : 0 }
    }
    return out
  } catch (e) {
    console.warn('[command-usage] 读取使用记录失败(忽略):', e)
    return {}
  }
}

function persist(map: UsageMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch (e) {
    // 配额满/隐私模式——排序是尽力而为的体验优化，落盘失败不影响功能
    console.warn('[command-usage] 使用记录落盘失败(忽略):', e)
  }
}

/** 记一次使用。id 用 CommandDef.id（命令面板与语音别名同一 id 空间） */
export function recordCommandUse(id: string, now: number = Date.now()): void {
  if (!id) return
  const map = load()
  const prev = map[id]
  map[id] = { count: (prev?.count ?? 0) + 1, lastUsedAt: now }
  const ids = Object.keys(map)
  if (ids.length > MAX_ENTRIES) {
    // 超界丢弃最久未用的
    const keep = ids
      .sort((a, b) => (map[b].lastUsedAt || 0) - (map[a].lastUsedAt || 0))
      .slice(0, MAX_ENTRIES)
    const trimmed: UsageMap = {}
    for (const k of keep) trimmed[k] = map[k]
    persist(trimmed)
    return
  }
  persist(map)
}

/** 当前使用记录快照 */
export function getCommandUsage(): UsageMap {
  return load()
}

/** 清空使用记录（设置页/排障用） */
export function clearCommandUsage(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch (e) { console.warn('[command-usage] 清空失败:', e) }
}

/**
 * 按使用频次重排 id 列表。纯函数（记录由调用方传入，便于单测）。
 * 无记录 / 次数相同 → 保持原顺序（显式用序号兜底，不依赖 sort 的稳定性实现）。
 */
export function rankCommandIds(ids: string[], usage: UsageMap = getCommandUsage()): string[] {
  return ids
    .map((id, idx) => ({ id, idx, count: usage[id]?.count ?? 0 }))
    .sort((a, b) => (b.count - a.count) || (a.idx - b.idx))
    .map(x => x.id)
}

/** 仅供测试：重置模块存储 */
export function __resetUsageForTest(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* 忽略 */ }
}
