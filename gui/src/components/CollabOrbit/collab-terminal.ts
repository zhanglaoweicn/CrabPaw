/** collab:progress 的 status 终态集合——timeout 曾落入"执行中"分支致卡片永不收口 */
const TERMINAL = new Set(['done', 'error', 'timeout', 'cancelled'])
export function isTerminalCollabStatus(s: string | undefined | null): boolean {
  return !!s && TERMINAL.has(s)
}
