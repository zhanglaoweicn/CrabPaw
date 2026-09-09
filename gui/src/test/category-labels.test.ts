import { CATEGORY_LABELS } from '../components/ExpertsPanel/category-labels'

describe('专家分类标签（2026-08-21 审计 P1-1 同步；2026-08-28 EX-1 扩至 7 类）', () => {
  it('恰含 7 个经营域分类，label 与后端 getCategories 一致', () => {
    expect(CATEGORY_LABELS).toEqual({
      strategy: '经营分析',
      finance: '财务',
      sales: '销售',
      hr: '人事',
      marketing: '市场',
      legal: '法务',
      custom: '自定义',
    })
  })
  it('不含旧开发域分类（development/analysis/creative/academic/life）', () => {
    for (const old of ['development', 'analysis', 'creative', 'academic', 'life']) {
      expect(CATEGORY_LABELS[old]).toBeUndefined()
    }
  })
})
