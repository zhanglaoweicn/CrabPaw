/**
 * 窗口模式解析（P5 一体机）— --kiosk / --fullscreen 启动参数 → BrowserWindow 模式。
 * 纯函数，可 jest。kiosk 隐含全屏（规格 §9：全屏无边框）。
 */
export interface WindowMode { kiosk: boolean; fullscreen: boolean }

export function parseWindowMode(argv: string[]): WindowMode {
  const kiosk = argv.includes('--kiosk')
  const fullscreen = kiosk || argv.includes('--fullscreen')
  return { kiosk, fullscreen }
}

export function applyWindowMode(win: { setKiosk: (v: boolean) => void; setFullScreen: (v: boolean) => void }, mode: WindowMode): void {
  if (mode.kiosk) win.setKiosk(true)
  else if (mode.fullscreen) win.setFullScreen(true)
}
