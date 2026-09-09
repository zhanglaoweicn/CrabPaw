/**
 * top-overlay — 全局"置顶覆盖层"注册表（2026-08-12）
 *
 * 背景：信息类全屏浮层（天气 WeatherPopup z-61/62、热点 HotspotPanel z-100）弹出时，
 * 遮罩盖住 VoiceShell 的语音球/文本输入框/对话卡片，导致语音识别不灵敏时
 * 无法用文本输入"关闭天气"等指令。
 *
 * 机制：把打开中的浮层 key 写入 <html data-top-overlay>（模块级 Set 计数），
 * VoiceShell/styles.css 依据该属性解除 .voice-shell 的 stacking context 并把
 * 语音球/输入框/对话卡提升到遮罩之上；全部浮层关闭后属性被删除，界面还原。
 *
 * 取值：'weather' / 'hotspot' / 'multiple'（多个同时打开，全关才清除）。
 * 操作类浮层（管理舱 z-80、历史抽屉 z-200）不注册，避免输入框盖住设置表单。
 */

/** 当前打开中的浮层 key 集合 */
const overlayKeys = new Set<string>()

/** 把集合状态同步到 <html data-top-overlay> */
function syncDataset(): void {
  try {
    const value =
      overlayKeys.size === 0
        ? undefined
        : overlayKeys.size === 1
          ? [...overlayKeys][0]
          : 'multiple'
    if (value === undefined) {
      delete document.documentElement.dataset.topOverlay
    } else {
      document.documentElement.dataset.topOverlay = value
    }
  } catch (err) {
    console.error('[top-overlay] 同步 data-top-overlay 失败:', err)
  }
}

/** 浮层打开时注册（幂等，重复调用无害） */
export function setTopOverlay(key: string): void {
  try {
    overlayKeys.add(key)
    syncDataset()
  } catch (err) {
    console.error(`[top-overlay] setTopOverlay('${key}') 失败:`, err)
  }
}

/** 浮层关闭时注销；多个浮层同时打开时仅当最后一个关闭才清除属性 */
export function clearTopOverlay(key: string): void {
  try {
    overlayKeys.delete(key)
    syncDataset()
  } catch (err) {
    console.error(`[top-overlay] clearTopOverlay('${key}') 失败:`, err)
  }
}
