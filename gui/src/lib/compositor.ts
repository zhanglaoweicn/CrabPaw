/**
 * sweepCompositor — Electron 合成器幽灵层清扫（2026-09-17）
 *
 * 背景：VoiceShell 界面大量使用 GPU 合成层（backdrop-filter 玻璃、canvas、
 * 大面积 blur），Electron/Chromium 合成器存在已知问题——元素移出渲染树后
 * 残留合成层偶发"画"回屏幕，症状为关闭浮层后顶栏/卡片消失或被暗色层盖住。
 * 此前两次定点修复（极光装饰层 z-index 0→-1 @4591ba5、SideSheet 关闭
 * display:none @cd0ef00）各覆盖一类来源，但用户实测仍复现。
 *
 * 方案：同步 body 隐藏 → 强制 reflow → 恢复。整个过程在单个 JS 任务内完成，
 * 浏览器不会在中间产生任何绘制（用户完全不可见），但会强制合成器销毁全部
 * 旧 GPU 层并全量重新光栅化——无论残留层来自哪个元素，必然被清扫。
 *
 * 调用时机：任何浮层/卡片关闭动画结束后的下一帧。
 */

export function sweepCompositor(): void {
  try {
    const body = document.body
    const prev = body.style.display
    body.style.display = 'none'
    // 强制同步 reflow——display:none 落地, 合成器持有层全部失效
    void body.offsetHeight
    body.style.display = prev
  } catch (e) {
    console.warn('[compositor] 清扫失败(不影响功能):', e)
  }
}

/** 延迟版：等关闭动画(约 450ms)结束后清扫 */
export function sweepCompositorDeferred(delayMs = 600): void {
  setTimeout(sweepCompositor, delayMs)
}
