/** @jest-environment jsdom */
/**
 * StockPanel — 分析化组件测试（2026-08-16）
 * mock api 层；断言收藏条渲染/评级徽章/买卖点/规则摘要标注。
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { StockPanel } from './index'
import * as api from '../../lib/api'
import * as sceneClient from '../../lib/scene-client'

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
  // 2026-08-21 P4: insights.tsx openInsightUrl 调用 isElectron——不 mock 会 TypeError
  isElectron: vi.fn(() => false),
}))
vi.mock('../../lib/scene-client', () => ({
  useSceneClient: vi.fn(),
}))
vi.mock('../../lib/ui-command-registry', () => ({
  registerCommandHost: vi.fn(() => () => {}),
}))
// SideSheet 模块引入 ./styles.css——vitest 无 CSS 转换，virtual mock 拦截
// styles.css: vitest 默认 css:false 自动空对象，无需 mock

const surface = {
  id: 'stock-panel', kind: 'stock-panel', intent: 'inform',
  data: {
    items: [{
      code: '600519', name: '贵州茅台', price: 1500, change: 10, changePct: 0.67,
      analysis: {
        momentum: { rsi: '55.2', rsiStatus: '中性', ma5: '1490', ma10: '1470', ma20: '1450', trendStatus: '多头排列' },
        supportResistance: { support: ['1450', '1400'], resistance: ['1600', '1680'], currentPrice: '1500' },
        overallScore: { finalScore: 62 },
      },
      interpret: {
        policy: '安防政策解读（基于公开认知，非实时政策）', market: '市场面', technical: '技术面',
        verdict: { rating: '关注', buyPoint: 1450, sellPoint: 1600, position: '30', riskNote: '注意回调', summary: '综合摘要' },
        source: 'llm', disclaimer: '不构成投资建议',
      },
    }],
    kline: { labels: ['07-01', '07-02'], ohlc: [{ o: 100, h: 102, l: 99, c: 101 }], period: 'day' },
    index: null, updatedAt: '2026-08-16T10:00:00.000Z', disclaimer: '仅供参考', failed: [],
  },
}

beforeAll(() => {
  // jsdom 无 canvas 2d 实现——ChartCard 已有 getContext null 守卫, 这里 stub
  // 掉虚拟控制台的 "Not implemented: getContext" 报错噪声（测试路径不变）
  HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as any
})

beforeEach(() => {
  vi.clearAllMocks()
  ;(sceneClient.useSceneClient as any).mockReturnValue(surface)
  ;(api.apiGet as any).mockResolvedValue({
    success: true,
    data: { list: [{ code: '600519', name: '贵州茅台', addedAt: 1 }], total: 1 },
  })
  ;(api.apiDelete as any).mockResolvedValue({ success: true })
})

describe('StockPanel 分析化', () => {
  test('收藏条渲染当前股票 chip', async () => {
    render(<StockPanel />)
    // 行情行 + 收藏 chip 都会渲染股票名——findAllByText 收敛多匹配
    const nameEls = await screen.findAllByText('贵州茅台')
    expect(nameEls.length).toBeGreaterThanOrEqual(1)
    // 移除收藏 → 走 apiDelete（非 apiGet 伪 DELETE）
    fireEvent.click(screen.getByRole('button', { name: '取消收藏贵州茅台' }))
    expect(api.apiDelete).toHaveBeenCalledWith('/panels/stock/watchlist?code=600519')
  })

  test('评级徽章 + 买卖点 + 仓位', async () => {
    render(<StockPanel />)
    expect(await screen.findByText('关注')).toBeTruthy()
    expect(screen.getByText('1450')).toBeTruthy()   // 买入点
    expect(screen.getByText('1600')).toBeTruthy()   // 卖出点
    expect(screen.getByText('30%')).toBeTruthy()    // 仓位
  })

  test('K线 markLines 传递（买入点绿/卖出点红）', async () => {
    render(<StockPanel />)
    // ChartCard 为 canvas（jsdom 无 2d context）——只验证契约可传入不崩
    // title 文本带 📊 前缀, 用正则匹配
    expect(await screen.findByText(/贵州茅台（600519）K线/)).toBeTruthy()
  })

  test('fallback 解读 → 显示"规则摘要"标注', async () => {
    const fb = JSON.parse(JSON.stringify(surface))
    fb.data.items[0].interpret.source = 'fallback'
    fb.data.items[0].interpret.disclaimer = 'AI 解读暂不可用，以下为量化规则结果。'
    ;(sceneClient.useSceneClient as any).mockReturnValue(fb)
    render(<StockPanel />)
    expect(await screen.findByText('规则摘要')).toBeTruthy()
  })

  test('收藏 chip 切换 → 单股查询串（select: 前缀，后端仅单股附深度分析）', async () => {
    render(<StockPanel />)
    // chip 按钮 title="切换分析 贵州茅台"（收藏条随 watchlist 异步拉取后渲染）
    fireEvent.click(await screen.findByTitle('切换分析 贵州茅台'))
    const stockCalls = (api.apiGet as any).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((u: string) => u.startsWith('/panels/stock?'))
    expect(stockCalls).toHaveLength(1)
    expect(stockCalls[0]).toContain('queries=600519')
    // 单股——多股查询走轻量路径（stock.js:115 仅 1 股附 analysis），
    // 若含逗号则两只股均无深度分析且刷新也无法恢复
    expect(stockCalls[0]).not.toContain(',')
  })
})

// ============ 2026-08-21 P4: 卡片搜索增强三块 ============
const enrichedSurface = (over: Record<string, unknown>) => ({
  id: 'stock-panel', kind: 'stock-panel', intent: 'inform',
  data: {
    ...surface.data,
    news: [
      { title: '茅台业绩超预期', url: 'http://news-a', source: '新闻', time: '2026-08-21 10:00:00', sentiment: 'pos' },
      { title: '茅台遭减持', url: 'http://news-b', source: '新闻', time: '2026-08-20 10:00:00', sentiment: 'neg' },
      { title: '股东大会召开', url: 'http://news-c', source: '公告', time: '2026-08-19 10:00:00', sentiment: 'neu' },
      { title: '无标记新闻', url: null, source: '股吧', time: '2026-08-18 10:00:00', sentiment: null },
      { title: '第5条新闻', url: 'http://news-e', source: '新闻', time: null, sentiment: null },
      { title: '第6条新闻', url: 'http://news-f', source: '新闻', time: null, sentiment: null },
    ],
    events: [
      { type: '回购', date: '2026-08-01', detail: '回购 1 亿', direction: 'pos', url: 'http://ann-a' },
      { type: '财报披露', date: '2026-06-30', detail: 'EPS: 35.57', direction: 'neu', url: null },
      { type: '高管减持', date: '2026-07-15', detail: '减持 10 万股', direction: 'neg', url: 'http://ann-c' },
    ],
    fundamentalsSummary: {
      company: { businessModel: '高附加值型', pricing: '强定价权', moat: '品牌护城河', management: '优秀', overallScore: 0.8, summary: '品牌壁垒深厚' },
      industry: { name: '白酒', prosperity: '景气', supplyDemand: '供不应求', lifecycle: '成熟期', summary: '白酒景气' },
      metrics: [{ name: 'PE估值', value: '28.50', status: '合理' }],
      score: 0.6,
      summary: '综合摘要文本',
    },
    ...over,
  },
})

describe('StockPanel 搜索增强三块（2026-08-21 P4）', () => {
  beforeEach(() => {
    ;(sceneClient.useSceneClient as any).mockReturnValue(enrichedSurface({}))
  })

  test('相关资讯默认展开：只显前 5 条 + 展开全部按钮', async () => {
    render(<StockPanel />)
    expect(await screen.findByText('相关资讯')).toBeTruthy()
    expect(screen.getByText('茅台业绩超预期')).toBeTruthy()
    // 6 条只渲染 5 条
    expect(screen.queryByText('第6条新闻')).toBeNull()
    expect(screen.getByText('展开全部 6 条')).toBeTruthy()
  })

  test('展开全部 → 显示第 6 条 + 收起', async () => {
    render(<StockPanel />)
    fireEvent.click(await screen.findByText('展开全部 6 条'))
    expect(screen.getByText('第6条新闻')).toBeTruthy()
    expect(screen.getByText('收起')).toBeTruthy()
  })

  test('基本面摘要默认折叠 → 点击展开 chip 与 summary', async () => {
    render(<StockPanel />)
    // 折叠时不渲染内容
    expect(screen.queryByText('品牌壁垒深厚')).toBeNull()
    fireEvent.click(await screen.findByText('基本面摘要'))
    expect(screen.getByText('模式 高附加值型')).toBeTruthy()
    expect(screen.getByText('护城河 品牌护城河')).toBeTruthy()
    expect(screen.getByText('行业 白酒')).toBeTruthy()
    expect(screen.getByText('28.50（合理）')).toBeTruthy()
    expect(screen.getByText('综合摘要文本')).toBeTruthy()
  })

  test('事件时间线默认折叠 → 点击展开：direction 三色 dot + 事件 emoji', async () => {
    render(<StockPanel />)
    expect(screen.queryByText('回购 1 亿')).toBeNull()
    fireEvent.click(await screen.findByText('事件时间线'))
    expect(screen.getByText('回购 1 亿')).toBeTruthy()
    expect(screen.getByText('EPS: 35.57')).toBeTruthy()
    expect(screen.getByText('减持 10 万股')).toBeTruthy()
    // emoji 映射：回购 💰 / 财报披露 📊 / 高管减持 📉
    expect(screen.getByText('💰')).toBeTruthy()
    expect(screen.getByText('📊')).toBeTruthy()
    expect(screen.getByText('📉')).toBeTruthy()
    // direction 三色 dot
    expect(document.querySelector('.stock-events-dot--pos')).toBeTruthy()
    expect(document.querySelector('.stock-events-dot--neg')).toBeTruthy()
    expect(document.querySelector('.stock-events-dot--neu')).toBeTruthy()
  })

  test('sentiment 三角：仅 pos 红▲ / neg 绿▼ 渲染', async () => {
    render(<StockPanel />)
    expect(await screen.findByTitle('利好')).toBeTruthy()
    expect(screen.getByTitle('利空')).toBeTruthy()
    // neu/null 无标记
    expect(document.querySelectorAll('.stock-sentiment')).toHaveLength(2)
  })

  test('url:null 行不可点（不调 openExternal/window.open）', async () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null as unknown as Window)
    render(<StockPanel />)
    const row = (await screen.findByText('无标记新闻')).closest('.stock-news-item') as HTMLElement
    expect(row.className).not.toContain('is-link')
    fireEvent.click(row)
    expect(spy).not.toHaveBeenCalled()
    // 可点行点击 → window.open（jsdom 无 electronAPI → 兜底分支）
    fireEvent.click(screen.getByText('茅台业绩超预期'))
    expect(spy).toHaveBeenCalledWith('http://news-a', '_blank', 'noopener,noreferrer')
    spy.mockRestore()
  })

  test('news=null → 资讯/基本面/时间线三块头均不渲染', async () => {
    ;(sceneClient.useSceneClient as any).mockReturnValue(enrichedSurface({ news: null, events: null, fundamentalsSummary: null }))
    render(<StockPanel />)
    expect(await screen.findByText('股票行情')).toBeTruthy()
    expect(screen.queryByText('相关资讯')).toBeNull()
    expect(screen.queryByText('基本面摘要')).toBeNull()
    expect(screen.queryByText('事件时间线')).toBeNull()
    // 行情主体不受影响（AnalysisGrid 技术面卡仍在）
    expect(screen.getByText('📐 技术面')).toBeTruthy()
  })
})
