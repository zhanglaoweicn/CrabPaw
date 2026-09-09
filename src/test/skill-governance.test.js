/**
 * SP2 技能治理三修测试（P0 优化轮）。
 *
 * 三修对应断言：
 *  T1/T2 —— stock-analyst 悬空引用全仓对齐：路由分类列表每项必须 resolve 到
 *           registry 载荷（历史 6 P0 复盘结论：悬空 ID 被 category 分支静默跳过=纸面接线）。
 *  T3     —— minQuality 执行点：config.skills.minQuality (0..1) 过滤推荐;
 *           0=不过滤（默认行为不变，回归锁）。
 *  T4     —— skill-market GitHub 结果 securityReviewed 诚实化：下载前未经审查,
 *           不得冒充（内置目录随仓库分发置 true 保留, 见 skill-market.js 内注释）。
 *  T5     —— flow-generator 拼写/悬空清扫：excel---xlsx→excel-xlsx, 无裸 stock-analyst。
 *
 * 测试形态披露：registry 载荷真实加载（skillSystem.load({force:true}),
 * 与 bilibili-knowledge.test.js 同姿势）; market 测纯映射函数
 * _mapGitHubItemToResult（从 _searchClawHubFromGitHub 抽出, 无网络依赖）。
 */
const { SkillRouter, TASK_CATEGORIES } = require('../core/skill-router');
const skillSystem = require('../core/skill-system');
const flowGen = require('../core/flow-generator');

const STOCK_QUERY = '帮我分析一下股票行情';

function loadRegistry() {
  return skillSystem.load({ force: true });
}

describe('SP2 技能治理三修', () => {
  test('T1 股票意图路由：前 3 含 stock-analyst-enhanced 且 registry 载荷存在', () => {
    const reg = loadRegistry();
    // registry 载荷本身存在（悬空引用的对照物）
    expect(reg['stock-analyst-enhanced']).toBeTruthy();

    const router = new SkillRouter();
    router.setSkillRegistry(reg);
    const cls = router.classifyTask(STOCK_QUERY);
    expect(cls.category).toBe('DATA_ANALYSIS');
    expect(cls.skillHint).toBe('stock-analyst-enhanced');

    const recs = router.getRecommendedSkills(STOCK_QUERY);
    expect(recs.length).toBeGreaterThan(0);
    // 实测现状: top-1 为 financial-analyst(0.77, 有执行器), enhanced 因无执行器
    // 0.15 降权居第二(0.1425)——按「前 3 含 enhanced」断言, top-1 是谁不锁。
    expect(recs.slice(0, 3).map((r) => r.name)).toContain('stock-analyst-enhanced');
  });

  test('T2 DATA_ANALYSIS 分类列表每项 resolve 到 registry 载荷（无悬空 ID）', () => {
    const reg = loadRegistry();
    const list = TASK_CATEGORIES.DATA_ANALYSIS.skills;
    expect(list.length).toBeGreaterThan(0);
    for (const skillName of list) {
      expect(reg[skillName]).toBeTruthy(); // 'stock-analyst' 悬空 → 红
    }
  });

  test('T3 minQuality 执行点：过滤低于阈值的推荐, 0=默认不过滤', () => {
    const reg = loadRegistry();

    // 默认（不传 config → minQuality 0）: enhanced 在列（回归锁——0 不改变行为）
    const def = new SkillRouter();
    def.setSkillRegistry(reg);
    const defRecs = def.getRecommendedSkills(STOCK_QUERY);
    expect(defRecs.map((r) => r.name)).toContain('stock-analyst-enhanced');

    // minQuality 0.4: enhanced 实得分 0.1425(0.95*0.15 无执行器降权) → 被滤掉;
    // 且剩余每项 score >= 0.4（执行点性质断言）
    const gated = new SkillRouter({ minQuality: 0.4 });
    gated.setSkillRegistry(reg);
    const gatedRecs = gated.getRecommendedSkills(STOCK_QUERY);
    expect(gatedRecs.map((r) => r.name)).not.toContain('stock-analyst-enhanced');
    for (const r of gatedRecs) {
      expect(r.score == null || r.score >= 0.4).toBe(true);
    }

    // minQuality 1.5: 全滤空
    const strict = new SkillRouter({ minQuality: 1.5 });
    strict.setSkillRegistry(reg);
    expect(strict.getRecommendedSkills(STOCK_QUERY).length).toBe(0);
  });

  test('T4 market GitHub 映射：securityReviewed 恒 false（下载前未审查不冒充）', () => {
    // 纯函数（_searchClawHubFromGitHub 抽出）——实现后导出, 当前缺失即红
    const { _mapGitHubItemToResult } = require('../core/skill-market');
    const mapped = _mapGitHubItemToResult(
      {
        name: 'hot-stock-helper',
        full_name: 'someone/hot-stock-helper',
        description: 'x',
        owner: { login: 'someone' },
        stargazers_count: 10, // stars>5 曾触发 securityReviewed:true 造假
        topics: ['stock-skill'],
        html_url: 'https://github.com/someone/hot-stock-helper',
        updated_at: '2026-08-01T00:00:00Z',
      },
      'stock-skill'
    );
    expect(mapped.securityReviewed).toBe(false);
    expect(mapped.stars).toBe(10); // 其余映射不受影响

    const zeroStars = _mapGitHubItemToResult(
      { name: 'x', full_name: 'a/x', owner: { login: 'a' }, stargazers_count: 0, topics: [], html_url: 'u', updated_at: 'd' },
      'x'
    );
    expect(zeroStars.securityReviewed).toBe(false);
  });

  test('T5 flow-generator 拼写/悬空清扫：无 excel---xlsx、无裸 stock-analyst', () => {
    const json = JSON.stringify([
      flowGen.WORKFLOW_TEMPLATES,
      flowGen.SKILL_PATTERNS,
      flowGen.SKILL_SEQUENCE_HINTS,
    ]);
    expect(json).not.toContain('excel---xlsx');
    expect(json).toContain('excel-xlsx');
    // '"stock-analyst"'（带闭引号）只匹配精确键/值, 不误伤 stock-analyst-enhanced
    expect(json).not.toContain('"stock-analyst"');
    expect(json).toContain('stock-analyst-enhanced');
  });
});
