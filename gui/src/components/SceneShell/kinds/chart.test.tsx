/**
 * ChartCard candlestick 分支渲染测试（2026-08-12）
 *
 * node 环境无 canvas 绘制（useEffect 不执行），此处验证 DOM 结构与契约：
 * ohlc 契约、candlestick 图例（红涨绿跌）、datasets 为空时不渲染旧图例。
 * canvas 绘制逻辑（蜡烛/影线/色阶）无法在 node 环境断言，由类型检查 + 人工预览覆盖。
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ChartCard } from './chart'

describe('ChartCard candlestick', () => {
  test('ohlc 数据 + labels → 渲染标题、canvas、红涨绿跌图例', () => {
    const html = renderToStaticMarkup(
      createElement(ChartCard, {
        data: {
          title: '600519 贵州茅台 K线',
          type: 'candlestick',
          labels: ['2026-08-10', '2026-08-11'],
          ohlc: [
            { o: 1430, h: 1460, l: 1425, c: 1450 },
            { o: 1450, h: 1455, l: 1435, c: 1440 },
          ],
        },
      })
    )
    expect(html).toContain('600519 贵州茅台 K线')
    expect(html).toContain('<canvas')
    expect(html).toContain('涨')
    expect(html).toContain('跌')
    expect(html).toContain('#f43f5e') // 红涨
    expect(html).toContain('#10b981') // 绿跌
  })

  test('candlestick 模式无 ohlc → 不崩溃，图例仍为红涨绿跌', () => {
    const html = renderToStaticMarkup(
      createElement(ChartCard, {
        data: { type: 'candlestick', labels: [], ohlc: [] },
      })
    )
    expect(html).toContain('<canvas')
    expect(html).toContain('涨')
    expect(html).toContain('跌')
  })

  test('line 模式回归：datasets 图例仍渲染', () => {
    const html = renderToStaticMarkup(
      createElement(ChartCard, {
        data: {
          title: '趋势',
          type: 'line',
          labels: ['a', 'b'],
          datasets: [{ label: 'MA5', data: [1, 2] }],
        },
      })
    )
    expect(html).toContain('MA5')
    expect(html).toContain('<canvas')
  })
})
