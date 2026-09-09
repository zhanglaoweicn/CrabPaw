/**
 * 低性能模式检测与切换模块
 *
 * 优先级：用户手动设置（localStorage crabpaw_perf_mode）> 自动检测
 *
 * 自动检测规则：
 *   - hardwareConcurrency < 4：低核数 CPU（Atom/赛扬/旧笔记本），判定 low
 *   - devicePixelRatio > 1.5 且 hardwareConcurrency < 6：高分屏 + 中低核数，
 *     canvas 2D 粒子/全息动画在高 DPI 下像素填充压力大，判定 low
 *   - 其余情况：high
 *
 * 消费方：
 *   - HoloDissolve：粒子数 400 → 120
 *   - progress kind：关闭激光扫描线动画
 *   - music kind：频谱柱静态低幅，不启动 rAF 循环
 */

export const STORAGE_KEY = 'crabpaw_perf_mode'

/** 自动检测设备性能模式（无 localStorage 覆盖时使用） */
function autoDetect(): 'low' | 'high' {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'high'

  const cores = navigator.hardwareConcurrency || 4
  const dpr = window.devicePixelRatio || 1

  // 规则 1: 低核 CPU（< 4 核）→ low
  if (cores < 4) return 'low'

  // 规则 2: 高分屏（dpr > 1.5）+ 中低核数（< 6）→ low
  // 高 DPI 时 canvas 2D 粒子/全息动画像素填充量翻倍，GPU 负载显著增加
  if (dpr > 1.5 && cores < 6) return 'low'

  return 'high'
}

/** 获取当前性能模式 */
export function getPerformanceMode(): 'low' | 'high' {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'low' || stored === 'high') return stored
  } catch (e) {
    console.error('[perf] 读取性能模式失败:', e)
  }
  return autoDetect()
}

/** 设置性能模式（写入 localStorage，持久化） */
export function setPerformanceMode(mode: 'low' | 'high'): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch (e) {
    console.error('[perf] 保存性能模式失败:', e)
  }
}
