/**
 * StocksCard 信号徽标 + 评分点测试（2026-08-12）
 *
 * 使用 renderToStaticMarkup 结构断言（项目先例：document.test.tsx，node 环境无 jsdom）。
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import StocksCard, { type StockItem } from './stocks'

function render(items: Array<Partial<StockItem>>) {
  return renderToStaticMarkup(createElement(StocksCard, { data: { kind: 'stocks', items: items as StockItem[] } }))
}

describe('StocksCard 信号徽标语义着色', () => {
  test('命中多头词（金叉）→ 偏多绿徽标', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, signal: 'MACD 金叉' }])
    expect(html).toContain('偏多')
    expect(html).toContain('#10b981')
  })

  test('命中空头词（死叉）→ 偏空红徽标', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, signal: '均线死叉' }])
    expect(html).toContain('偏空')
    expect(html).toContain('#f43f5e')
  })

  test('其他文本 → 中性灰蓝徽标', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, signal: '震荡整理' }])
    expect(html).toContain('中性')
    expect(html).toContain('#94a3b8')
  })

  test('多空词并存 → 多空交织黄徽标', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, signal: '金叉后注意卖出信号' }])
    expect(html).toContain('多空交织')
    expect(html).toContain('#f59e0b')
  })
})

describe('StocksCard 评分点（-1..1 → 0-100 归一化 + 色阶）', () => {
  test('score 0.42（后端 -1..1）→ 71 分绿色评分点', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, score: 0.42 }])
    expect(html).toContain('71 分')
    expect(html).toContain('#10b981')
  })

  test('score 字符串 "0.42"（后端 toFixed 序列化为字符串）同样归一化', () => {
    // 运行时 JSON 里 score 是字符串，类型上为 number，此处模拟真实报文形状
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, score: '0.42' as unknown as number }])
    expect(html).toContain('71 分')
  })

  test('score -0.5 → 25 分红色评分点', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, score: -0.5 }])
    expect(html).toContain('25 分')
    expect(html).toContain('#f43f5e')
  })

  test('score 0 → 50 分黄色评分点', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450, score: 0 }])
    expect(html).toContain('50 分')
    expect(html).toContain('#f59e0b')
  })

  test('无 score → 不渲染评分行', () => {
    const html = render([{ code: '600519', name: '贵州茅台', price: 1450 }])
    expect(html).not.toContain('分')
  })
})

describe('StocksCard 保留既有展示', () => {
  test('空态文案保留', () => {
    const html = render([])
    expect(html).toContain('暂无持仓/自选数据')
  })

  test('价格/涨跌/盈亏与免责声明保留', () => {
    const html = render([
      { code: '600519', name: '贵州茅台', price: 1450, changePct: 2.1, shares: 100, cost: 1200 },
    ])
    expect(html).toContain('1450')
    expect(html).toContain('+2.1%')
    expect(html).toContain('+25000')
    expect(html).toContain('数据仅供参考')
  })
})
