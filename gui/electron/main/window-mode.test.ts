import { parseWindowMode } from './window-mode'

describe('parseWindowMode', () => {
  it('no flags → normal mode', () => {
    const m = parseWindowMode(['electron.exe', 'main.js'])
    expect(m).toEqual({ kiosk: false, fullscreen: false })
  })
  it('--kiosk → kiosk on, fullscreen implied', () => {
    const m = parseWindowMode(['electron.exe', 'main.js', '--kiosk'])
    expect(m).toEqual({ kiosk: true, fullscreen: true })
  })
  it('--fullscreen alone → fullscreen only', () => {
    const m = parseWindowMode(['electron.exe', 'main.js', '--fullscreen'])
    expect(m).toEqual({ kiosk: false, fullscreen: true })
  })
  it('flags among other args still detected', () => {
    const m = parseWindowMode(['--dev', '--kiosk', '--remote-debugging-port=9222'])
    expect(m.kiosk).toBe(true)
  })
})
