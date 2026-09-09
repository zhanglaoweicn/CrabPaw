// wake-probe-preload.cjs —— 采集窗口的 preload 桥
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wakeProbe', {
  sendPcm: (buffer) => {
    if (!buffer) return
    try { ipcRenderer.send('wake:pcm', buffer) } catch (err) {
      console.error('[wake-probe] PCM 发送失败:', err?.message || err)
    }
  },
  reportStatus: (status, detail) => {
    try { ipcRenderer.send('wake:status', { status, detail }) } catch (err) {
      console.error('[wake-probe] 状态上报失败:', err?.message || err)
    }
  },
  // 2026-08-03: 麦克风占用切换（ASR 会话激活时暂停 KWS 采集，避免并发抢 mic）
  onMicToggle: (callback) => {
    if (typeof callback !== 'function') return
    const handler = (_e, enabled) => callback(enabled)
    ipcRenderer.on('wake:mic-toggle', handler)
    return () => { ipcRenderer.removeListener('wake:mic-toggle', handler) }
  },
  // F7: 采集切换完成回执——主进程等待此信号才 resolve，消除抢麦竞态
  micToggleAck: () => {
    try { ipcRenderer.send('wake:mic-toggle-ack') } catch (err) {
      console.error('[wake-probe] mic-toggle-ack 发送失败:', err?.message || err)
    }
  },
})
