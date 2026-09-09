// 专家分类标签（2026-08-21 与后端 src/core/experts getCategories 对齐：
// strategy=经营分析、finance=财务、sales=销售、hr=人事、marketing=市场、legal=法务、custom=自定义；
// 2026-08-28 EX-1 分类 5→7 同步新增 marketing/legal）
export const CATEGORY_LABELS: Record<string, string> = {
  strategy: '经营分析',
  finance: '财务',
  sales: '销售',
  hr: '人事',
  marketing: '市场',
  legal: '法务',
  custom: '自定义',
}
