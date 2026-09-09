/**
 * dev-mode — 开发者模式开关（贾维斯单界面·阶段 B）。
 * 持久化到 localStorage；调试类管理功能仅在开启时显示/响应。
 */

const DEV_MODE_KEY = 'crabpaw_dev_mode'

export function isDevMode(): boolean {
  try {
    return localStorage.getItem(DEV_MODE_KEY) === 'true'
  } catch (e) {
    console.error('[dev-mode] 读取失败:', e)
    return false
  }
}

export function setDevMode(v: boolean): void {
  try {
    localStorage.setItem(DEV_MODE_KEY, v ? 'true' : 'false')
  } catch (e) {
    console.error('[dev-mode] 写入失败:', e)
  }
}
