/**
 * doc-content-parser.test.ts — 2026-08-23 载体感知视图内容解析器单测
 */
import { parseSlides, parseTables } from './doc-content-parser'

describe('parseSlides PPT 页面轨道', () => {
  test('按 # 标题拆页，每页提取要点', () => {
    const md = [
      '# 智能体行业报告',
      '',
      '本报告覆盖市场规模、竞争格局与发展趋势。',
      '',
      '## 市场规模',
      '- 2026 年全球智能体市场 2800 亿',
      '- 年复合增长率 42%',
      '',
      '## 竞争格局',
      '- 国内厂商梯队分化明显',
    ].join('\n')
    const pages = parseSlides(md)
    expect(pages).toHaveLength(3)
    expect(pages[0].title).toBe('智能体行业报告')
    expect(pages[0].points).toContain('本报告覆盖市场规模、竞争格局与发展趋势。')
    expect(pages[1].title).toBe('市场规模')
    expect(pages[1].points).toHaveLength(2)
    expect(pages[2].points).toHaveLength(1)
  })

  test('无标题内容并入首页', () => {
    const pages = parseSlides('开头一句话\n\n- 要点一')
    expect(pages).toHaveLength(1)
    expect(pages[0].title).toBe('首页')
    expect(pages[0].points).toContain('要点一')
  })

  test('代码块围栏/分隔线不进要点', () => {
    const pages = parseSlides('# 页\n\n```\nconst a = 1\n```\n\n---\n\n- 真要点')
    expect(pages).toHaveLength(1)
    expect(pages[0].points).not.toContain('```')
    expect(pages[0].points).not.toContain('---')
    expect(pages[0].points).toContain('真要点')
  })

  test('空输入 → 空数组', () => {
    expect(parseSlides('')).toEqual([])
    expect(parseSlides('   \n\n  ')).toEqual([])
  })
})

describe('parseTables EXCEL 表格矩阵', () => {
  test('Gfm 表格 → 列头 + 行数据', () => {
    const md = [
      '| 城市 | 成交额(亿) | 同比 |',
      '|------|-----------|------|',
      '| 上海 | 812.5     | +18% |',
      '| 北京 | 654.2     | +9%  |',
    ].join('\n')
    const tables = parseTables(md)
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(['城市', '成交额(亿)', '同比'])
    expect(tables[0].rows).toHaveLength(2)
    expect(tables[0].rows[0]).toEqual(['上海', '812.5', '+18%'])
  })

  test('多个表格全部提取', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n\n| x |\n|---|\n| y |'
    const tables = parseTables(md)
    expect(tables).toHaveLength(2)
    expect(tables[1].headers).toEqual(['x'])
    expect(tables[1].rows).toEqual([['y']])
  })

  test('无表格 → 空数组', () => {
    expect(parseTables('# 纯文本\n\n正文内容')).toEqual([])
    expect(parseTables('')).toEqual([])
  })

  test('文本装饰的竖线行（非表格）不误判', () => {
    // 分隔行必须在第二行且含 ---；纯文本中的 | 装饰不应解析
    expect(parseTables('| 装饰 | 文本 |\n| 第二行 |')).toEqual([])
  })
})
