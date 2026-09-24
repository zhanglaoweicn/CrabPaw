/**
 * kiosk-mode — 一体机 / 会客厅模式（2026-09-24 会客厅轮 S1+S3）
 *
 * 两种来源，语义不同：
 *   ① 设备形态：主进程 `--kiosk` 随 URL 注入 `?kiosk=1`（见 gui/electron/main/index.ts）。
 *      这台机器就是一体机——**不可在界面里退出**。
 *   ② 预览/演示：用户在顶栏一键开关，落 localStorage。用于开发验收、工位演示、
 *      会客前临时切"体面形态"。
 *
 * 为什么用 URL 参数做设备标志而不是 IPC：同步可读——首帧就是会客厅态，不会先闪一下
 * 工位版；dev（loadURL）与打包（loadFile query）两条路径都成立。
 */

const OVERRIDE_KEY = 'voice-shell.kiosk-mode'

/** 设备形态（`--kiosk`）：真的挂在墙上，界面内不可退出 */
export function isKioskDevice(): boolean {
  try {
    const q = new URLSearchParams(window.location.search)
    return q.has('kiosk') && q.get('kiosk') !== '0'
  } catch (e) {
    console.warn('[kiosk] 解析 URL 失败，按工位态处理:', (e as Error)?.message || e)
    return false
  }
}

/** 预览开关（顶栏一键切换）——设备形态下不可用（一体机不该被退出） */
export function getKioskOverride(): boolean {
  try { return localStorage.getItem(OVERRIDE_KEY) === '1' } catch { return false }
}

export function setKioskOverride(on: boolean): void {
  try {
    if (on) localStorage.setItem(OVERRIDE_KEY, '1')
    else localStorage.removeItem(OVERRIDE_KEY)
  } catch (e) {
    console.warn('[kiosk] 写入预览开关失败:', (e as Error)?.message || e)
  }
}

/** 最终判定：设备形态优先，其次预览开关 */
export function resolveKiosk(): boolean {
  return isKioskDevice() || getKioskOverride()
}
