/**
 * ProvenancePanel 组件回归（2026-09-30，P2）
 *
 * 呈现口径在 lib/provenance.test.ts 已覆盖，这里验证**组件真的按它渲染**，
 * 特别是"取不到数时不显示空链路"——空链路会被老板读成"没有来源"。
 */
import { describe, test, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ProvenancePanel } from './index'
import type { ProvenanceData } from '../../lib/provenance'

const OK: ProvenanceData = {
  ok: true,
  metric: 'revenue',
  label: '营收',
  view: 'v_sales',
  triedViews: ['v_sales'],
  rows: 14,
  nulls: { date: 0, customer: 0 },
  sources: [
    {
      table: 'sales_flow', rows: 14, sourceFile: 'D:/data/销售明细-1月.csv',
      importedAt: new Date(2026, 8, 6, 13, 50).getTime(), fileHash: 'abc', rowCount: 14, superseded: false,
    },
  ],
  notes: [],
}

describe('正常链路', () => {
  test('渲染链路三节点 + 事实行', async () => {
    render(<ProvenancePanel metric="revenue" fetcher={async () => OK} />)
    await waitFor(() => expect(screen.getByText('sales_flow')).toBeTruthy())
    expect(screen.getByText('v_sales')).toBeTruthy()
    expect(screen.getByText('营收')).toBeTruthy()
    expect(screen.getByText('参与行数')).toBeTruthy()
    expect(screen.getByText('14')).toBeTruthy()
    expect(screen.getByText(/销售明细-1月\.csv/)).toBeTruthy()
  })

  test('标题含"数据出处"与指标标签（老板一眼知道这是什么）', async () => {
    render(<ProvenancePanel metric="revenue" fetcher={async () => OK} />)
    await waitFor(() => expect(screen.getByText(/数据出处 · 营收/)).toBeTruthy())
  })

  test('后端 notes（对账差异）原样显示', async () => {
    render(<ProvenancePanel
      metric="contract"
      fetcher={async () => ({ ...OK, label: '合同', notes: ['contracts: 注册表列名在真实表中不存在——到期日期（已从视图定义剔除）'] })}
    />)
    await waitFor(() => expect(screen.getByText(/到期日期/)).toBeTruthy())
  })
})

describe('取不到数：只说原因，不给空链路', () => {
  test('ok=false → 显示原因与提示，且不渲染任何链路节点', async () => {
    render(<ProvenancePanel
      metric="contract"
      fetcher={async () => ({
        ok: false, metric: 'contract', label: '合同', view: 'v_contract', triedViews: ['v_contract'],
        rows: null, nulls: {}, sources: [], notes: ['视图存在但查询失败——这不是"没有数据"，是取数失败'],
        unavailableReason: '视图查询失败：no such column: "到期日期"',
      })}
    />)
    await waitFor(() => expect(screen.getByText(/取不到这条链路/)).toBeTruthy())
    expect(screen.getByText(/no such column/)).toBeTruthy()
    expect(screen.getByText(/不是"没有数据"，是取数失败/)).toBeTruthy()
    // 关键：不得出现任何节点（空链路会被读成"没有来源"）
    expect(screen.queryByText('v_contract')).toBeNull()
    expect(screen.queryByText('参与行数')).toBeNull()
  })

  test('取数抛错（网络层）→ 同样只报原因，不白屏', async () => {
    render(<ProvenancePanel metric="revenue" fetcher={async () => { throw new Error('Failed to fetch') }} />)
    await waitFor(() => expect(screen.getByText(/取不到这条链路/)).toBeTruthy())
    expect(screen.getByText(/Failed to fetch/)).toBeTruthy()
  })
})

describe('交互与加载态', () => {
  test('加载中显示"正在核对来源…"（不空白）', () => {
    render(<ProvenancePanel metric="revenue" fetcher={() => new Promise(() => {})} />)
    expect(screen.getByText(/正在核对来源/)).toBeTruthy()
  })

  test('onClose 存在时有关闭按钮并回调', async () => {
    const onClose = vi.fn()
    render(<ProvenancePanel metric="revenue" fetcher={async () => OK} onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('关闭')).toBeTruthy())
    screen.getByText('关闭').click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('未传 onClose 则不显示关闭按钮（由外层控制）', async () => {
    render(<ProvenancePanel metric="revenue" fetcher={async () => OK} />)
    await waitFor(() => expect(screen.getByText('sales_flow')).toBeTruthy())
    expect(screen.queryByText('关闭')).toBeNull()
  })

  test('onShow3D 存在时出现"看账龄结构"入口并回调（与三维视图共位切换）', async () => {
    const onShow3D = vi.fn()
    render(<ProvenancePanel metric="revenue" fetcher={async () => OK} onShow3D={onShow3D} />)
    await waitFor(() => expect(screen.getByText('看账龄结构')).toBeTruthy())
    screen.getByText('看账龄结构').click()
    expect(onShow3D).toHaveBeenCalledTimes(1)
  })

  test('未传 onShow3D 则不显示该入口（不假装有这个能力）', async () => {
    render(<ProvenancePanel metric="revenue" fetcher={async () => OK} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('sales_flow')).toBeTruthy())
    expect(screen.queryByText('看账龄结构')).toBeNull()
  })

  test('metric 变化会重新取数（换指标即换链路）', async () => {
    const fetcher = vi.fn(async () => OK)
    const { rerender } = render(<ProvenancePanel metric="revenue" fetcher={fetcher} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('revenue'))
    rerender(<ProvenancePanel metric="receivable" fetcher={fetcher} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('receivable'))
  })
})

describe('空值展示不误导', () => {
  test('空值未知显示 —（不是 0）', async () => {
    render(<ProvenancePanel metric="revenue" fetcher={async () => ({ ...OK, nulls: { date: null } })} />)
    await waitFor(() => expect(screen.getByText(/date —/)).toBeTruthy())
  })

  test('参与行数为 null 显示 —（不是 0）', async () => {
    render(<ProvenancePanel metric="revenue" fetcher={async () => ({ ...OK, rows: null })} />)
    await waitFor(() => expect(screen.getByText('参与行数')).toBeTruthy())
    expect(screen.getByText('—')).toBeTruthy()
  })
})
