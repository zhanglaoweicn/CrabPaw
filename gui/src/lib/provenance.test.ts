/**
 * provenance.test.ts — 出处链前端呈现口径（2026-09-30，P2）
 *
 * 链路是给老板"判断这数可不可信"用的，所以重点不在排版而在**不误导**：
 *   · 未登记来源 → 写"未登记"，不猜文件名
 *   · 空值未知（null）→ "—"，不是 0（0 是"没有空值"这个结论）
 *   · 已退役来源仍出现在视图里 → 必须标警告（视图未重建）
 *   · ok:false → 只说原因，不给空链路（空链路会被读成"没有来源"）
 *   · 对账差异（后端 notes）→ 原样透出，绝不吞掉
 */
import { describe, test, expect } from 'vitest'
import {
  buildProvenanceView,
  formatImportedAt,
  shortFileName,
  formatNullCount,
  type ProvenanceData,
} from './provenance'

const FULL: ProvenanceData = {
  ok: true,
  metric: 'revenue',
  label: '营收',
  view: 'v_sales',
  triedViews: ['v_sales', 'v_revenue'],
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
  test('节点顺序：来源 → 视图 → 指标', () => {
    const v = buildProvenanceView(FULL)
    expect(v.ok).toBe(true)
    expect(v.nodes.map(n => n.kind)).toEqual(['source', 'view', 'metric'])
    expect(v.nodes[0].title).toBe('sales_flow')
    expect(v.nodes[1].title).toBe('v_sales')
    expect(v.nodes[2].title).toBe('营收')
  })

  test('来源节点带出文件名/导入时间/参与行数（可核验三件套）', () => {
    const v = buildProvenanceView(FULL)
    const sub = v.nodes[0].subtitle!
    expect(sub).toContain('14 行参与')
    expect(sub).toContain('销售明细-1月.csv')
    expect(sub).toContain('09-06')
  })

  test('事实行含参与行数 / 空值 / 来源数', () => {
    const v = buildProvenanceView(FULL)
    const byKey = Object.fromEntries(v.facts.map(f => [f.key, f.text]))
    expect(byKey['参与行数']).toBe('14')
    expect(byKey['空值']).toBe('date 0 / customer 0')
    expect(byKey['来源数']).toBe('1')
  })

  test('多个来源并排（异构表合并的场景）', () => {
    const v = buildProvenanceView({
      ...FULL,
      sources: [
        { ...FULL.sources[0], table: 'sales_a', rows: 10 },
        { ...FULL.sources[0], table: 'sales_b', rows: 4, sourceFile: null, importedAt: null },
      ],
    })
    expect(v.nodes.filter(n => n.kind === 'source')).toHaveLength(2)
    expect(v.facts.find(f => f.key === '来源数')!.text).toBe('2')
  })
})

describe('不误导：缺失与异常', () => {
  test('未登记来源 → 明写"未登记"，不猜文件名与时间', () => {
    const v = buildProvenanceView({
      ...FULL,
      sources: [{ ...FULL.sources[0], sourceFile: null, importedAt: null }],
    })
    const sub = v.nodes[0].subtitle!
    expect(sub).toContain('来源文件未登记')
    expect(sub).not.toContain('.csv')
    expect(sub).not.toContain('导入')
  })

  test('空值未知（null）→ "—"，不是 0', () => {
    const v = buildProvenanceView({ ...FULL, nulls: { date: null, customer: 2 } })
    expect(v.facts.find(f => f.key === '空值')!.text).toBe('date — / customer 2')
  })

  test('已退役来源仍出现在视图 → 节点标不可信 + 后端 notes 透出', () => {
    const v = buildProvenanceView({
      ...FULL,
      sources: [{ ...FULL.sources[0], superseded: true }],
      notes: ['来源表 sales_flow 已被取代但仍出现在视图中，建议重建视图'],
    })
    expect(v.nodes[0].trustworthy).toBe(false)
    expect(v.nodes[0].subtitle).toContain('已被取代')
    expect(v.warnings.join('')).toContain('重建视图')
  })

  test('对账差异（后端 notes）原样透出，绝不吞掉', () => {
    const v = buildProvenanceView({
      ...FULL,
      notes: ['contracts: 注册表列名在真实表中不存在——到期日期（已从视图定义剔除）'],
    })
    expect(v.warnings).toHaveLength(1)
    expect(v.warnings[0]).toContain('到期日期')
  })

  test('参与行数为 null → 显示 —（不是 0）', () => {
    const v = buildProvenanceView({ ...FULL, rows: null })
    expect(v.facts.find(f => f.key === '参与行数')!.text).toBe('—')
    expect(v.nodes.find(n => n.kind === 'view')!.subtitle).toContain('—')
  })

  test('零来源但有视图 → 不假造来源节点', () => {
    const v = buildProvenanceView({ ...FULL, sources: [], rows: 0 })
    expect(v.nodes.filter(n => n.kind === 'source')).toHaveLength(0)
    expect(v.facts.find(f => f.key === '来源数')!.text).toBe('0')
  })
})

describe('不可用：只说原因，不给空链路', () => {
  test('ok=false → nodes 为空 + 带原因（空链路会被读成"没有来源"）', () => {
    const v = buildProvenanceView({
      ok: false, metric: 'contract', label: '合同', view: 'v_contract', triedViews: ['v_contract'],
      rows: null, nulls: {}, sources: [], notes: ['视图存在但查询失败——这不是"没有数据"，是取数失败'],
      unavailableReason: '视图查询失败：no such column: "到期日期"',
    })
    expect(v.ok).toBe(false)
    expect(v.nodes).toEqual([])
    expect(v.unavailableReason).toContain('no such column')
    expect(v.warnings.join('')).toContain('取数失败')
  })

  test('ok=false 但无原因 → 给通用文案（不显示空白）', () => {
    const v = buildProvenanceView({
      ok: false, metric: 'x', label: 'X', view: null, triedViews: [], rows: null, nulls: {}, sources: [], notes: [],
    })
    expect(v.unavailableReason).toBe('取数失败')
  })

  test('数据为 null/undefined → 不抛，给"尚未取到"', () => {
    expect(buildProvenanceView(null).ok).toBe(false)
    expect(buildProvenanceView(undefined).unavailableReason).toContain('尚未取到')
  })
})

describe('格式化工具', () => {
  test('导入时间到分钟且本地时区', () => {
    const ts = new Date(2026, 8, 6, 13, 50).getTime()
    expect(formatImportedAt(ts)).toBe('09-06 13:50')
  })
  test('无效时间 → null（不编造 1970）', () => {
    expect(formatImportedAt(null)).toBeNull()
    expect(formatImportedAt(Number.NaN)).toBeNull()
  })
  test('文件名只取末段（不暴露完整路径）', () => {
    expect(shortFileName('D:/data/销售明细-1月.csv')).toBe('销售明细-1月.csv')
    expect(shortFileName('C:\\a\\b\\c.xlsx')).toBe('c.xlsx')
    expect(shortFileName(null)).toBeNull()
  })
  test('空值数未知 → —', () => {
    expect(formatNullCount(null)).toBe('—')
    expect(formatNullCount(0)).toBe('0')
  })
})
