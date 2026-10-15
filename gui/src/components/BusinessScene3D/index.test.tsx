/**
 * BusinessScene3D 组件回归（2026-09-30，P2）
 *
 * jsdom 里没有 WebGL，所以本用例跑的是**真实的降级路径**：
 *   · 三维渲染不可用时必须保留二维视图（同源数据，信息不丢），而不是白屏
 *   · L0 档**根本不该去挂 WebGL**（省电 + 避开老机器驱动问题）
 *   · 空数据给空态文案，不画空场景
 *
 * 业务口径（分桶/纵深/发光/集中度）在 lib/business-scene.test.ts 已覆盖 25 例，
 * 这里只验证组件按它渲染。
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BusinessScene3D } from './index'
import type { AgingItem } from '../../lib/business-scene'

/** 覆盖全部四个账龄段（断言"段不丢"必须先让四段都有数据） */
const ITEMS: AgingItem[] = [
  { customer: '云杉科技', amount: 19500, overdueDays: 20 },   // 0-30
  { customer: '华辰机械', amount: 128000, overdueDays: 45 },  // 31-60
  { customer: '启明教育', amount: 42000, overdueDays: 77 },   // 61-90
  { customer: '恒信物流', amount: 32000, overdueDays: 123 },  // 90+
]

/** 只覆盖两段（用于验证空桶不画） */
const TWO_BUCKETS: AgingItem[] = [
  { customer: '华辰机械', amount: 128000, overdueDays: 45 },
  { customer: '恒信物流', amount: 32000, overdueDays: 123 },
]

const setTier = (t: string) => {
  localStorage.setItem('crabpaw_motion_mode', t)
  document.documentElement.setAttribute('data-motion', t)
}

describe('二维降级：三维不可用时信息不丢', () => {
  beforeEach(() => { setTier('L1') })
  afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-motion') })

  test('WebGL 不可用 → 显示二维视图与原因，且保留全部账龄段', async () => {
    render(<BusinessScene3D items={ITEMS} />)
    // jsdom 无 WebGL：会加载 three 后创建上下文失败，落到二维
    await waitFor(() => {
      expect(screen.getByText(/三维渲染不可用/)).toBeTruthy()
    }, { timeout: 5000 })
    // 四个账龄段一个都不少（数据覆盖全四段）
    expect(screen.getByText('0-30 天')).toBeTruthy()
    expect(screen.getByText('31-60 天')).toBeTruthy()
    expect(screen.getByText('61-90 天')).toBeTruthy()
    expect(screen.getByText('90 天以上')).toBeTruthy()
    // 文案要说明"数据完全相同"，否则老板会怀疑降级后少了东西
    expect(screen.getByText(/数据完全相同/)).toBeTruthy()
  })

  test('二维视图标出 data-reason（便于排查是降级还是渲染失败）', async () => {
    render(<BusinessScene3D items={ITEMS} />)
    await waitFor(() => expect(screen.getByText(/三维渲染不可用/)).toBeTruthy(), { timeout: 5000 })
    const flat = document.querySelector('.bs3d__flat')
    expect(flat?.getAttribute('data-reason')).toBe('render-error')
  })

  test('空账龄段不画（只画有数据的段，不误导为"这段没有逾期"）', async () => {
    render(<BusinessScene3D items={TWO_BUCKETS} />)
    await waitFor(() => expect(screen.getByText('31-60 天')).toBeTruthy(), { timeout: 5000 })
    expect(screen.queryByText('0-30 天')).toBeNull()
    expect(screen.queryByText('61-90 天')).toBeNull()
  })
})

describe('L0 档：根本不挂 WebGL', () => {
  afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-motion') })

  test('L0 → 直接二维，不报"渲染不可用"（因为压根没试）', async () => {
    setTier('L0')
    render(<BusinessScene3D items={ITEMS} />)
    await waitFor(() => expect(screen.getByText('31-60 天')).toBeTruthy())
    // 没有错误提示 —— 这是"按档位降级"，不是"失败"
    expect(screen.queryByText(/三维渲染不可用/)).toBeNull()
    expect(document.querySelector('.bs3d__flat')?.getAttribute('data-reason')).toBe('tier-L0')
  })
})

describe('业务信息按映射层渲染', () => {
  beforeEach(() => { setTier('L0') })   // 用二维路径断言数据（三维在 jsdom 里跑不了）
  afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-motion') })

  test('结论文案含最老账龄段与集中客户占比', async () => {
    render(<BusinessScene3D items={ITEMS} />)
    await waitFor(() => expect(screen.getByText(/最老一段是90 天以上/)).toBeTruthy())
    expect(screen.getByText(/华辰机械占/)).toBeTruthy()
  })

  test('金额按量级展示（万）', async () => {
    render(<BusinessScene3D items={ITEMS} />)
    await waitFor(() => expect(screen.getByText('12.8万')).toBeTruthy())
  })

  test('占比显示为百分比且合计合理', async () => {
    render(<BusinessScene3D items={ITEMS} />)
    await waitFor(() => expect(screen.getAllByText(/^\d+%$/).length).toBeGreaterThan(0))
  })

  test('告警段带 is-alarm 类（视觉强调有落点）', async () => {
    render(<BusinessScene3D items={[{ customer: 'A', amount: 900000, overdueDays: 45 }]} />)
    await waitFor(() => expect(document.querySelector('.bs3d__row.is-alarm')).toBeTruthy())
  })

  test('图例说明三个视觉维度（否则三维图就是装饰）', async () => {
    render(<BusinessScene3D items={ITEMS} />)
    await waitFor(() => expect(screen.getByText(/纵深 = 账龄/)).toBeTruthy())
    expect(screen.getByText(/体积 = 金额/)).toBeTruthy()
    expect(screen.getByText(/发光 = 该看程度/)).toBeTruthy()
  })
})

describe('空态与集中度预警', () => {
  // 注意：档位必须在**挂载前**设置——组件挂载时读一次档位并决定是否挂 WebGL，
  // 挂载后再 setTier 只会触发一次无意义的重渲染（初版即踩此坑）。
  beforeEach(() => { setTier('L0') })
  afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-motion') })

  test('无账目 → 空态文案，不画空场景', async () => {
    const { container } = render(<BusinessScene3D items={[]} />)
    await waitFor(() => expect(container.querySelector('.bs3d__empty')).toBeTruthy())
    // 空态块与摘要会显示同一句话（刻意同源），因此按元素查而不是按文案查
    expect(container.querySelector('.bs3d__empty')!.textContent).toContain('没有逾期账目')
    expect(container.querySelector('.bs3d__row')).toBeNull()
    expect(container.querySelector('.bs3d__flat')).toBeNull()
    // 空数据不该画三维画布，也不该有图例（图例是对图元的说明）
    expect(container.querySelector('.bs3d__canvas')).toBeNull()
    expect(container.querySelector('.bs3d__legend')).toBeNull()
  })

  test('集中度偏高 → 明确提示（不粉饰）', async () => {
    const { container } = render(<BusinessScene3D items={[
      { customer: '华辰机械', amount: 900000, overdueDays: 45 },
      { customer: 'B', amount: 100000, overdueDays: 20 },
    ]} />)
    await waitFor(() => expect(container.querySelector('.bs3d__alarm')).toBeTruthy())
    expect(container.querySelector('.bs3d__alarm')!.textContent).toContain('华辰机械')
    expect(container.querySelector('.bs3d__alarm')!.textContent).toContain('90%')
    // 摘要里也要有结论（同一份 sceneSummary，不两处各写一套）
    expect(container.querySelector('.bs3d__summary')!.textContent).toContain('集中度偏高')
  })
})

describe('交互', () => {
  beforeEach(() => { setTier('L0') })
  afterEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-motion') })

  test('onClose 存在时有关闭按钮并回调', async () => {
    const onClose = vi.fn()
    render(<BusinessScene3D items={ITEMS} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('关闭')).toBeTruthy())
    screen.getByText('关闭').click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('二维路径不显示"导出图片"（没有画布可导）', async () => {
    render(<BusinessScene3D items={ITEMS} />)
    await waitFor(() => expect(screen.getByText('31-60 天')).toBeTruthy())
    expect(screen.queryByText('导出图片')).toBeNull()
  })

  test('perCustomer 按客户细分（标签带客户名）', async () => {
    render(<BusinessScene3D items={TWO_BUCKETS} perCustomer />)
    await waitFor(() => expect(screen.getByText(/华辰机械 · 31-60 天/)).toBeTruthy())
    expect(screen.getByText(/恒信物流 · 90 天以上/)).toBeTruthy()
  })
})
