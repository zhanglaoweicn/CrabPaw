const { describe, expect, it } = require('@jest/globals')
const experts = require('../core/experts')

// EX-1(2026-08-28): 内置专家 4→11。名单与 src/core/experts/index.js BUILTIN_EXPERTS 同步。
const BUILTIN_IDS = ['boss_cockpit', 'finance_advisor', 'sales_director', 'hr_manager', 'planning_consultant', 'market_consultant', 'brand_consultant', 'legal_counsel', 'tax_consultant', 'marketing_consultant', 'financing_advisor']
const NEW_IDS = ['planning_consultant', 'market_consultant', 'brand_consultant', 'legal_counsel', 'tax_consultant', 'marketing_consultant', 'financing_advisor']

describe('老板向专家（2026-08-21 重构；2026-08-28 EX-1 扩至 11 位）', () => {
  it('内置专家恰为 11 位老板专家', () => {
    const builtins = experts.getAllExperts().filter(e => e.builtin === true)
    expect(builtins.map(e => e.id).sort()).toEqual([...BUILTIN_IDS].sort())
  })

  it('老板专家均带 voiceStyle/dataScope/routingKeywords', () => {
    for (const e of experts.getAllExperts().filter(x => x.builtin)) {
      expect(e.voiceStyle.trim().length).toBeGreaterThan(0)
      expect(typeof e.dataScope).toBe('object')
      expect(e.routingKeywords.length).toBeGreaterThan(3)
    }
  })

  it('getCategories 返回经营域分类', () => {
    const cats = experts.getCategories()
    const labels = Object.fromEntries(cats.map(c => [c.id, c.label]))
    expect(labels.strategy).toBe('经营分析')
    expect(labels.finance).toBe('财务')
    expect(labels.sales).toBe('销售')
    expect(labels.hr).toBe('人事')
    expect(labels.marketing).toBe('市场')
    expect(labels.legal).toBe('法务')
    expect(labels.custom).toBe('自定义')
  })

  // 2026-08-27 审计 E3: 分类并集爆炸(自定义专家带任意 category → 268 项)已修。
  // 2026-08-28 EX-1: 分类 5→7(新增 marketing/legal)。固守: 恰为 7 个规范分类。
  it('getCategories 恰为 7 个规范分类(不并从专家 category 并集)', () => {
    const cats = experts.getCategories()
    expect(cats.map(c => c.id)).toEqual(['strategy', 'finance', 'sales', 'hr', 'marketing', 'legal', 'custom'])
    // 读出口归一化: 所有专家对外 category 均落规范集合(非规范按 custom 计)
    const all = experts.getAllExperts()
    for (const e of all) {
      expect(['strategy', 'finance', 'sales', 'hr', 'marketing', 'legal', 'custom']).toContain(e.category)
    }
  })

  it('getExpertDataSources: 无数据源时返回 null', () => {
    expect(experts.getExpertDataSources('hr_manager')).toBeNull()
  })

  it('getExpertDataSources: 返回 string（有数据源）或 null（无数据源），类型稳定', () => {
    // 依赖真实数据目录中的 db-connections 档案状态与业务注册表——不做具体值断言
    const ds = experts.getExpertDataSources('finance_advisor')
    expect(ds === null || typeof ds === 'string').toBe(true)
    expect(experts.getExpertDataSources('hr_manager')).toBeNull()
  })
})

describe('EX-1 七位新增专家（2026-08-28）', () => {
  it('7 新增字段齐全、builtin 且协作链为 [own, boss_cockpit]', () => {
    for (const id of NEW_IDS) {
      const e = experts.getExpert(id)
      expect(e).not.toBeNull()
      expect(e.builtin).toBe(true)
      for (const f of ['name', 'title', 'description', 'icon', 'tags', 'capabilities', 'routingKeywords', 'voiceStyle', 'systemPrompt']) {
        const v = e[f]
        const nonEmpty = Array.isArray(v) ? v.length > 0 : String(v || "").trim().length > 0
        expect(nonEmpty).toBe(true)
      }
      expect(e.collaborationChain).toEqual([id, 'boss_cockpit'])
      expect(e.routingKeywords.length).toBeGreaterThan(3)
    }
  })

  it('7 新增分类落位符合蓝图(strategy/finance/marketing/legal)——2026-09-04 部门化重组: category 由 department 派生', () => {
    expect(experts.getExpert('planning_consultant').category).toBe('strategy')
    expect(experts.getExpert('tax_consultant').category).toBe('finance')
    // 部门化: 投融资入编战略投资部, category 随 department 派生为 strategy(原 finance)
    expect(experts.getExpert('financing_advisor').category).toBe('strategy')
    expect(experts.getExpert('financing_advisor').department).toBe('strategy_invest')
    expect(experts.getExpert('market_consultant').category).toBe('marketing')
    expect(experts.getExpert('brand_consultant').category).toBe('marketing')
    expect(experts.getExpert('marketing_consultant').category).toBe('marketing')
    expect(experts.getExpert('legal_counsel').category).toBe('legal')
  })

  it('dataScope 按蓝图: 企划/税务/投融资带 businessData, 其余为 {}', () => {
    for (const id of ['planning_consultant', 'tax_consultant', 'financing_advisor']) {
      expect(experts.getExpert(id).dataScope).toEqual({ businessData: true })
    }
    for (const id of ['market_consultant', 'brand_consultant', 'legal_counsel', 'marketing_consultant']) {
      expect(experts.getExpert(id).dataScope).toEqual({})
    }
  })
})

describe('EX-1 prompt 四段结构化与边界铁律（2026-08-28）', () => {
  it('11 位内置专家 prompt 四段(①②③④)有序、120-350 字、含「追问」「不得」', () => {
    for (const id of BUILTIN_IDS) {
      const p = experts.getExpert(id).systemPrompt
      expect(p).toMatch(/①.*②.*③.*④/)
      expect(p.length).toBeGreaterThanOrEqual(120)
      expect(p.length).toBeLessThanOrEqual(350)
      expect(p).toContain('追问')
      expect(p).toContain('不得')
    }
  })

  it('businessData 专家 prompt 含「不编造」(数字诚信铁律)', () => {
    for (const id of BUILTIN_IDS) {
      const e = experts.getExpert(id)
      if (e.dataScope && e.dataScope.businessData) {
        expect(e.systemPrompt).toContain('不编造')
      }
    }
  })

  it('法务/税务/投融资 prompt 含专业复核兜底(非正式意见铁律)', () => {
    expect(experts.getExpert('legal_counsel').systemPrompt).toContain('执业')
    expect(experts.getExpert('legal_counsel').systemPrompt).toContain('复核')
    expect(experts.getExpert('tax_consultant').systemPrompt).toContain('复核')
    expect(experts.getExpert('financing_advisor').systemPrompt).toContain('复核')
  })

  it('路由词抽查: 品牌/融资/合同命中对应新专家', () => {
    expect(experts.routeMessage('帮我看看品牌定位').map(r => r.expertId)).toContain('brand_consultant')
    expect(experts.routeMessage('公司融资估值怎么做').map(r => r.expertId)).toContain('financing_advisor')
    expect(experts.routeMessage('签合同有什么风险').map(r => r.expertId)).toContain('legal_counsel')
  })
})
