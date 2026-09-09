/**
 * geometry — SideSheet 几何计算（纯函数，可单测）
 *
 * 面板锚点为视口 (16, 16)（见 styles.css .side-sheet left/top）。
 * 居中 = 面板中心对齐视口中心 → 偏移 = (视口 - 面板)/2 - 16。
 * clamp 与拖动逻辑同语义（SideSheet onPointerMove）：面板至少留 8px 可触及（clamp 界与拖动一致），
 * 防止超小视口把面板完全拖出屏幕。
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

/** 把面板（w×h）居中于视口（vw×vh），返回相对锚点 (16,16) 的偏移 */
export function computeCenterOffset(
  vw: number,
  vh: number,
  w: number,
  h: number,
): { x: number; y: number } {
  return {
    x: clamp((vw - w) / 2 - 16, 8 - w, vw - 40),
    y: clamp((vh - h) / 2 - 16, 8 - h, vh - 40),
  }
}
