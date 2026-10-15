/**
 * motion-tier.test.ts — 动效保真阶梯（2026-09-30）
 *
 * 背景：UI 有 98 处 backdrop-filter / 340 个 keyframes，此前无降级机制也不响应
 * prefers-reduced-motion，而本产品跑在 U 盘插的老机器上（项目还发生过"大面积 blur
 * 与视频合成层死锁→黑屏"）。本用例锁住三件事：
 *   1. 判定规则本身（纯函数 decideTier）——弱机必须降档、达标才允许全效；
 *   2. 档位必须能落到 <html data-motion> 并持久化（设置页要能读）；
 *   3. **系统无障碍偏好最高优先**：reduce 时必须 L0，且手动锁定不被系统改回。
 */
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  decideTier,
  applyTier,
  currentTier,
  readMotionMode,
  saveMotionMode,
  resolveAndApplyMotionTier,
} from '../lib/motion-tier'

describe('decideTier（纯判定规则）', () => {
  test('帧率明显不足 → L0 精简', () => {
    expect(decideTier(30, 8)).toBe('L0')
    expect(decideTier(44, 16)).toBe('L0')
  })

  test('帧率达标且核数够 → L2 全效', () => {
    expect(decideTier(60, 8)).toBe('L2')
    expect(decideTier(58, 4)).toBe('L2')
  })

  test('帧率居中或核数偏少 → L1 标准', () => {
    expect(decideTier(50, 8)).toBe('L1')
    expect(decideTier(60, 2)).toBe('L1')   // 高分屏双核：不冒险给全效
  })

  test('采不到帧率 → L1 保守但不残废（不是 L0）', () => {
    expect(decideTier(null, 8)).toBe('L1')
    expect(decideTier(null, undefined)).toBe('L1')
  })
})

describe('档位应用与持久化', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-motion')
    try { localStorage.clear() } catch { /* ignore */ }
  })

  test('applyTier 落到 <html data-motion> 且 currentTier 可读回', () => {
    applyTier('L0')
    expect(document.documentElement.getAttribute('data-motion')).toBe('L0')
    expect(currentTier()).toBe('L0')
    applyTier('L2')
    expect(currentTier()).toBe('L2')
  })

  test('currentTier 在未设置时回落 L1（不返回 undefined）', () => {
    expect(currentTier()).toBe('L1')
  })

  test('手动模式可保存与读回；auto 会清掉存储', () => {
    expect(readMotionMode()).toBe('auto')
    saveMotionMode('L0')
    expect(readMotionMode()).toBe('L0')
    saveMotionMode('auto')
    expect(readMotionMode()).toBe('auto')
  })
})

describe('CSS 令牌契约（JS 写属性 / CSS 定视觉，两侧必须对齐）', () => {
  // 与 offline-fonts.test.ts 同款：本套件在 Electron 渲染器测试环境里跑，
  // ESM `import fs from 'node:fs'` 会命中浏览器 shim（require is not defined），
  // 而 CommonJS 形式的 require('fs') 可用。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsMod = require('fs') as typeof import('fs')
  const pathMod = require('path') as typeof import('path')
  const css = fsMod.readFileSync(pathMod.resolve(__dirname, '..', 'index.css'), 'utf8')

  test('三档令牌块都存在（否则 applyTier 写了属性也没有视觉效果）', () => {
    // 注意压缩器会把 [data-motion="L0"] 压成 [data-motion=L0]，断言不要依赖引号
    for (const tier of ['L0', 'L1', 'L2']) {
      expect(css).toMatch(new RegExp(`\\[data-motion=["']?${tier}["']?\\]`))
    }
  })

  test(':root 基值对齐默认档 L1（否则首帧先全模糊再降档，出现可见闪动）', () => {
    // 取 :root 到第一个 [data-motion 段之间的内容（不能拿 '/* ══' 当边界：
    // 文件头部注释里也有 ══，会出现负长度切片而静默通过）
    const start = css.indexOf(':root {')
    const end = css.indexOf('[data-motion=')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const rootBlock = css.slice(start, end)
    expect(rootBlock).toMatch(/--glass-blur:\s*9px/)
    // 基值不应是 L2 的 20px —— 那会让首帧先全模糊再降档
    expect(rootBlock).not.toMatch(/--glass-blur:\s*20px/)
  })

  test('L0 强制清零全部模糊（含未走令牌的 98 处字面量）', () => {
    // 断言在 L0 段与无障碍段之间存在 backdrop-filter:none !important
    const l0Index = css.search(/\[data-motion=["']?L0["']?\]/)
    expect(l0Index).toBeGreaterThan(-1)
    const reducedIndex = css.indexOf('@media (prefers-reduced-motion: reduce)')
    expect(reducedIndex).toBeGreaterThan(l0Index)
    const l0Section = css.slice(l0Index, reducedIndex)
    expect(l0Section).toMatch(/backdrop-filter:\s*none\s*!important/)
  })

  test('无障碍偏好有 CSS 兜底（JS 未执行的首帧就已精简）', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    const m = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(m).toMatch(/backdrop-filter:\s*none\s*!important/)
    // 时长写法压缩后可能是 .001s / 1ms，两种都接受（断言"接近零"而非精确字面量）
    expect(m).toMatch(/animation-duration:\s*(0?\.0*1s|1ms)\s*!important/)
  })

  test('关闭确认动画走动效令牌（L0 下必须自动变近乎瞬变）', () => {
    // 关掉卡片的收拢动画时长必须来自 --motion-enter 令牌；
    // 若写成固定 ms，L0（无障碍/弱机）用户会被强制看完动画，违背降级承诺。
    const voiceCss = require('fs').readFileSync(
      require('path').resolve(__dirname, '..', 'pages', 'VoiceShell', 'styles.css'), 'utf8')
    const rule = voiceCss.slice(voiceCss.indexOf('.holo-stage-item.is-closing'))
    expect(rule).toMatch(/animation:\s*holo-card-close\s+var\(--motion-enter/)
    expect(voiceCss).toMatch(/@keyframes holo-card-close/)
  })
})

describe('系统无障碍偏好优先（prefers-reduced-motion）', () => {
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    try { localStorage.clear() } catch { /* ignore */ }
    document.documentElement.removeAttribute('data-motion')
  })

  test('系统要求减少动效时 → L0（即使设备够强）', async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
    saveMotionMode('auto')
    const tier = await resolveAndApplyMotionTier({ probe: false })
    expect(tier).toBe('L0')
    expect(document.documentElement.getAttribute('data-motion')).toBe('L0')
  })

  test('用户手动锁定的档位优先于系统偏好（信任来自可控）', async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
    saveMotionMode('L2')
    const tier = await resolveAndApplyMotionTier({ probe: false })
    expect(tier).toBe('L2')
  })
})
