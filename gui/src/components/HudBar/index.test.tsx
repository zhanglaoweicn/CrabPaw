/**
 * HudBar 组件回归（2026-09-30，P1-3）
 *
 * 断言重点是**渲染出来的四种状态可被区分**，以及"失败绝不显示 0"这条产品红线
 * （显示口径本身在 lib/hud-metric.test.ts 已覆盖，这里验证组件真的按它渲染）。
 */
import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { HudBar } from './index'

const NOW = Date.now()

/** 健康的简报载荷 */
const okPayload = {
  generatedAt: NOW - 30_000,
  snapshot: { revenue: { month: 571000, prevMonth: 500000 }, risks: { receivableOverdue: 6, totalReceivable: 373500 } },
  receivables: { count: 6, amount: 373500 },
  contracts: { count: 1 },
  sources: { snapshot: { ok: true }, receivables: { ok: true }, contracts: { ok: true } },
}

describe('取数与渲染', () => {
  test('正常数据 → 显示指标名、数字、风险点、新鲜度', async () => {
    render(<HudBar fetcher={async () => okPayload} polling={false} />)
    await waitFor(() => expect(screen.getByText('逾期应收')).toBeTruthy())
    expect(screen.getByText('6')).toBeTruthy()
    expect(screen.getByText(/6 笔逾期/)).toBeTruthy()
    expect(screen.getByText(/刚刚更新|分钟前/)).toBeTruthy()
  })

  test('首帧尚无数据 → 显示占位而不是 0（不给假数）', () => {
    // fetcher 永不 resolve，模拟首帧
    render(<HudBar fetcher={() => new Promise(() => {})} polling={false} />)
    expect(screen.getByText('···')).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
  })

  test('取数抛错 → failed 态显示 — 与错误原因，绝不显示 0', async () => {
    render(<HudBar fetcher={async () => { throw new Error('business.db 不存在') }} polling={false} />)
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
    expect(screen.queryByText('0')).toBeNull()
    // 未传 onExpand → 静态状态区（不是假按钮），状态样式与 tooltip 仍要正确
    const el = screen.getByRole('status')
    expect(el.className).toContain('hud-bar--failed')
    expect(el.getAttribute('title')).toContain('business.db 不存在')
  })

  test('未导入数据 → 显示"未导入"，不是 0', async () => {
    render(<HudBar fetcher={async () => ({ sources: { receivables: { ok: true } } })} polling={false} />)
    await waitFor(() => expect(screen.getByText('未导入')).toBeTruthy())
    expect(screen.queryByText('0')).toBeNull()
  })

  test('源失败但载荷带数字 → 仍按 failed 渲染（不当成新数据）', async () => {
    render(<HudBar
      fetcher={async () => ({ ...okPayload, sources: { ...okPayload.sources, receivables: { ok: false, detail: 'db missing' } } })}
      polling={false}
    />)
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
    expect(screen.queryByText('6')).toBeNull()
  })

  test('陈旧数据 → 数字照显示 + 沙漏（旧数比无数有用）', async () => {
    const stale = { ...okPayload, generatedAt: NOW - 48 * 3600_000 }
    render(<HudBar fetcher={async () => stale} polling={false} />)
    await waitFor(() => expect(screen.getByText('6')).toBeTruthy())
    expect(screen.getByText('⌛')).toBeTruthy()
    expect(screen.getByRole('status').className).toContain('hud-bar--stale')
  })
})

describe('指标切换', () => {
  test('本月营收按金额量级化并带环比方向', async () => {
    render(<HudBar metric="monthRevenue" fetcher={async () => okPayload} polling={false} />)
    await waitFor(() => expect(screen.getByText('本月营收')).toBeTruthy())
    expect(screen.getByText('57.1万')).toBeTruthy()
    expect(screen.getByText('▲7.1万')).toBeTruthy()
  })

  test('临期合同显示份数与单位', async () => {
    render(<HudBar metric="contractsExpiring" fetcher={async () => okPayload} polling={false} />)
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy())
    expect(screen.getByText('临期合同')).toBeTruthy()
  })
})

describe('交互与可访问性', () => {
  test('onExpand 存在时是可点按钮，点击回调', async () => {
    const onExpand = vi.fn()
    render(<HudBar fetcher={async () => okPayload} polling={false} onExpand={onExpand} />)
    await waitFor(() => expect(screen.getByRole('button')).toBeTruthy())
    fireEvent.click(screen.getByRole('button'))
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  test('无 onExpand 时是静态状态区（不做假按钮）', async () => {
    render(<HudBar fetcher={async () => okPayload} polling={false} />)
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('aria-label 含指标与数字（读屏与自动化可用）', async () => {
    render(<HudBar fetcher={async () => okPayload} polling={false} onExpand={() => {}} />)
    await waitFor(() => {
      const el = screen.getByRole('button')
      expect(el.getAttribute('aria-label')).toContain('逾期应收')
      expect(el.getAttribute('aria-label')).toContain('6')
    })
  })
})

describe('出处入口（P2「从哪来」）', () => {
  test('传 onShowProvenance 时出现"从哪来"按钮并回调', async () => {
    const onShow = vi.fn()
    render(<HudBar fetcher={async () => okPayload} polling={false} onShowProvenance={onShow} />)
    await waitFor(() => expect(screen.getByText('从哪来')).toBeTruthy())
    fireEvent.click(screen.getByText('从哪来'))
    expect(onShow).toHaveBeenCalledTimes(1)
  })

  test('不传则不显示出处入口（不假装有这个能力）', async () => {
    render(<HudBar fetcher={async () => okPayload} polling={false} />)
    await waitFor(() => expect(screen.getByText('逾期应收')).toBeTruthy())
    expect(screen.queryByText('从哪来')).toBeNull()
  })

  test('取数失败时出处入口仍可用（此时最需要核对来源）', async () => {
    const onShow = vi.fn()
    render(<HudBar fetcher={async () => { throw new Error('db down') }} polling={false} onShowProvenance={onShow} />)
    await waitFor(() => expect(screen.getByText('—')).toBeTruthy())
    expect(screen.getByText('从哪来')).toBeTruthy()
    fireEvent.click(screen.getByText('从哪来'))
    expect(onShow).toHaveBeenCalledTimes(1)
  })
})

describe('轮询', () => {
  test('polling=false 只取一次（不打扰、不耗电）', async () => {
    const fetcher = vi.fn(async () => okPayload)
    render(<HudBar fetcher={fetcher} polling={false} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await new Promise(r => setTimeout(r, 60))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('polling=true 按间隔重复取数', async () => {
    const fetcher = vi.fn(async () => okPayload)
    render(<HudBar fetcher={fetcher} polling pollMs={20} />)
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 1000 })
  })

  test('卸载后不再取数（不泄漏定时器）', async () => {
    const fetcher = vi.fn(async () => okPayload)
    const { unmount } = render(<HudBar fetcher={fetcher} polling pollMs={20} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalled())
    unmount()
    const calls = fetcher.mock.calls.length
    await new Promise(r => setTimeout(r, 80))
    expect(fetcher.mock.calls.length).toBe(calls)
  })
})
