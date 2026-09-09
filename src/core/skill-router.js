

// eslint-disable-next-line no-unused-vars
const { GLOBAL_SKILLS_DIR, SKILLS_DIR } = require('./config');
const { getSkillLifecycleManager } = require('./skill-lifecycle');
const { executeSkillAdvanced: executeSkill } = require('./skills');
const { getCompositionGraph } = require('./skill/skill-composition-graph');
const { getCompositionDiscoveryEngine } = require('./skill/composition-discovery-engine');
const { getSkillChainTemplates } = require('./skill/skill-chain-templates');

const TASK_CATEGORIES = {
  DATA_ANALYSIS: {
    name: 'data_analysis',
    keywords: ['分析', '统计', '数据', '图表', '报表', 'analysis', 'data', 'chart', 'statistics'],
    skills: ['stock-analyst-enhanced', 'financial-analyst']
  },
  DOCUMENT_PROCESSING: {
    name: 'document_processing',
    keywords: ['文档', 'PDF', 'Word', 'Excel', 'PPT', 'PowerPoint', '演示文稿', '幻灯片', 'pptx', 'docx', 'xlsx', '公文', '转换', '生成', '汇报', '电子表格', '工作簿', 'pdf转word', 'pdf转excel', 'pdf转ppt', '格式转换', 'document', 'pdf', 'excel', 'pptx', 'docx', 'powerpoint', 'presentation', 'word', 'xlsx', 'spreadsheet', 'workbook', 'convert'],
    skills: ['pdf-generator', 'summarize-pro', 'powerpoint-pptx', 'word-docx', 'excel-xlsx', 'pdf-to-word-docx']
  },
  RESEARCH: {
    name: 'research',
    keywords: ['研究', '搜索', '查找', '调研', 'research', 'search', 'find', 'investigate'],
    skills: ['multi-search-engine']
  },
  CODE_DEVELOPMENT: {
    name: 'code_development',
    keywords: ['代码', '开发', '编程', '调试', 'code', 'develop', 'programming', 'debug'],
    skills: ['prompt-engineering-expert', 'workflow-designer']
  },
  SYSTEM_OPERATIONS: {
    name: 'system_operations',
    keywords: ['系统', '监控', '健康', '检查', 'system', 'monitor', 'health', 'check'],
    skills: ['healthcheck', 'system-info']
  },
  INFORMATION_QUERY: {
    name: 'information_query',
    keywords: ['查询', '天气', '信息', 'query', 'weather', 'info'],
    skills: ['weather']
  },
  MEMORY_MANAGEMENT: {
    name: 'memory_management',
    keywords: ['记忆', '存储', '回忆', 'memory', 'store', 'recall'],
    skills: []
  },
  AI_ASSISTANCE: {
    name: 'ai_assistance',
    keywords: ['AI', '智能', '助手', '改进', 'AI', 'assistant', 'improve'],
    skills: ['self-improving-agent', 'agent-team-orchestration']
  },
  WRITING: {
    name: 'writing',
    keywords: ['写作', '润色', '人性化', 'humanize', 'de-AI', '去AI味', '改写', '写作风格', 'writing', 'rewrite', 'polish'],
    skills: ['humanizer', 'prompt-engineering-expert']
  },
  DESIGN: {
    name: 'design',
    keywords: ['设计', 'UI', '界面', '落地页', '看板', 'dashboard', 'landing', '前端设计', '配色', '主题', 'design', 'frontend', 'layout', 'theme'],
    skills: ['frontend-design']
  },
  MARKETING: {
    name: 'marketing',
    keywords: ['营销', '推广', '增长', 'SEO', '转化', 'CRO', '广告', '文案', '定价', '发布', '私域', '种草', '市场研究', '竞品分析', 'TAM', 'SAM', 'SOM', '客户验证', '写文章', '写笔记', '写稿', '小红书', '知乎', '公众号', '抖音脚本', '内容创作', '写作', '文章', 'marketing', 'growth', 'seo', 'cro', 'copywriting', 'launch', 'pricing', 'market-research', 'competitor', 'validation', 'content-writing'],
    // 2026-09-06: 候选池补营销部技能包核心项——此前仅 'marketing'，包内
    // article-writer/content-planner/promo-planner 永不进候选池，专家偏置无从生效
    skills: ['marketing', 'article-writer', 'content-planner', 'promo-planner']
  },
  FILE_MANAGEMENT: {
    name: 'file-management',
    keywords: ['文件管理', '整理文件', '批量重命名', '去重', '重复文件', '文件分类', '目录同步', '文件同步', '清理文件', 'file', 'organize', 'deduplicate', 'rename', 'sync'],
    skills: ['file-manager']
  },
  // 2026-09-07: Remotion 代码驱动视频生成（无 executor 知识技能——
  // 类目路径仅对激活专家技能包放行，通用路径靠 INTENT_PATTERNS skillHint 接线）
  // 2026-09-07 晚: 加入 hyperframes-video（HTML 模板/给已有视频加字幕覆层）
  VIDEO_CREATION: {
    name: 'video_creation',
    keywords: ['做视频', '生成视频', '制作视频', '视频', '短片', '短视频', '动画', '片头', '片尾', '宣传片', '视频简报', '渲染视频', 'motion graphics', 'remotion', 'hyperframes', 'video'],
    skills: ['remotion-video', 'hyperframes-video']
  },
  DESKTOP_AUTOMATION: {
    name: 'desktop-automation',
    keywords: ['桌面自动化', 'UI自动化', '鼠标控制', '键盘控制', '窗口管理', '桌面操作', '点击', '截图', 'desktop', 'ui-automation', 'mouse', 'keyboard', 'window'],
    skills: ['windows-ui-automation']
  },
  WECHAT_SEARCH: {
    name: 'wechat-search',
    keywords: ['公众号搜索', '微信文章', '公众号文章', '微信搜索', 'wechat', '公众号', '微信'],
    skills: ['wechat-article-search']
  },
  // 2026-08-20: B站站点知识包（bilibili-knowledge，纯知识无 executor）。
  // 注意：category 分支对无 executor 技能不生效（见 getRecommendedSkills L547-551），
  // 本类关键词只提供分类语义；真正接线在 INTENT_PATTERNS 的 skillHint 分支。
  BILIBILI: {
    name: 'bilibili',
    keywords: ['b站', '哔哩', 'bilibili', 'up主', '弹幕', '投币', '三连', 'bv号', 'av号'],
    skills: ['bilibili-knowledge']
  },
  BROWSER_AUTOMATION: {
    name: 'browser-automation',
    keywords: ['浏览器自动化', '网页操作', '网页截图', '表单填写', '浏览器', 'browser-use', '网页爬取', 'Cookie管理', '云浏览器', 'browser', 'web-automation', 'scrape', 'crawl'],
    skills: ['browser-use']
  },
  META: {
    name: 'meta',
    keywords: ['创建技能', '新建技能', '技能开发', '技能打包', '技能验证', '技能创建', 'skill-creator', 'make skill', 'create skill', 'build skill'],
    skills: ['skill-creator']
  }
};

const INTENT_PATTERNS = [
  {
    pattern: /(?:分析|统计).*(?:数据|报表|图表)/i,
    category: 'DATA_ANALYSIS',
    confidence: 0.9
  },
  {
    pattern: /(?:生成|创建).*(?:PDF|文档|报告)/i,
    category: 'DOCUMENT_PROCESSING',
    confidence: 0.85
  },
  {
    pattern: /(?:PPT|PowerPoint|演示文稿|幻灯片|pptx|汇报材料|演示文档)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'powerpoint-pptx',
    confidence: 0.95
  },
  {
    pattern: /(?:制作|生成|创建|编辑).*(?:PPT|演示|幻灯片|汇报|演讲稿)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'powerpoint-pptx',
    confidence: 0.9
  },
  {
    pattern: /(?:生成|创建|导出|制作).*(?:PPT|演示文稿|幻灯片|\.pptx|汇报PPT|演讲PPT)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'pptx-generator',
    confidence: 0.92
  },
  {
    pattern: /(?:导出|保存|生成).*(?:为|成|到).*(?:PPT|\.pptx|演示文稿|PowerPoint)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'pptx-generator',
    confidence: 0.9
  },
  {
    pattern: /(?:Word|DOCX|docx|\.docx|Word文档|公文|红头文件|文档编辑|文档排版)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'word-docx',
    confidence: 0.95
  },
  {
    pattern: /(?:编辑|修改|创建|生成|排版).*(?:Word|文档|公文|合同|协议|报告|纪要)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'word-docx',
    confidence: 0.9
  },
  {
    pattern: /(?:Excel|XLSX|xlsx|\.xlsx|电子表格|工作簿|工作表)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'excel-xlsx',
    confidence: 0.95
  },
  {
    pattern: /(?:编辑|修改|创建|生成|处理).*(?:Excel|表格|工作簿|电子表格|报表|数据表)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'excel-xlsx',
    confidence: 0.9
  },
  {
    pattern: /(?:生成|创建|导出|制作).*(?:Excel|电子表格|工作簿|\.xlsx|表格文件|数据表|报表文件)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'excel-generator',
    confidence: 0.92
  },
  {
    pattern: /(?:导出|保存|生成).*(?:为|成|到).*(?:Excel|\.xlsx|电子表格)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'excel-generator',
    confidence: 0.9
  },
  {
    pattern: /(?:pdf转word|pdf转docx|pdf.*转.*word|pdf.*to.*word|pdf.*转换|格式转换|pdf转excel|pdf转ppt|pdf转html|pdf转markdown|pdf转图片|图片转word)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'pdf-to-word-docx',
    confidence: 0.95
  },
  {
    pattern: /(?:转换|转成|导出|提取).*(?:pdf|PDF).*(?:word|excel|ppt|html|markdown|图片|文本|docx|xlsx|pptx)/i,
    category: 'DOCUMENT_PROCESSING',
    skillHint: 'pdf-to-word-docx',
    confidence: 0.9
  },
  {
    pattern: /(?:研究|调研|深度).*(?:主题|话题|问题)/i,
    category: 'RESEARCH',
    confidence: 0.9
  },
  {
    pattern: /(?:写|生成|创建).*(?:代码|程序|脚本)/i,
    category: 'CODE_DEVELOPMENT',
    confidence: 0.85
  },
  {
    pattern: /(?:创建技能|新建技能|技能开发|技能打包|技能验证|skill-creator|创建.*技能|开发.*技能)/i,
    category: 'META',
    skillHint: 'skill-creator',
    confidence: 0.95
  },
  {
    pattern: /(?:制作|开发|创建).*(?:技能|skill|插件)/i,
    category: 'META',
    skillHint: 'skill-creator',
    confidence: 0.9
  },
  {
    pattern: /(?:检查|监控|查看).*(?:系统|健康|状态)/i,
    category: 'SYSTEM_OPERATIONS',
    confidence: 0.85
  },
  {
    pattern: /(?:查询|获取|查看).*(?:天气|信息|数据)/i,
    category: 'INFORMATION_QUERY',
    confidence: 0.8
  },
  {
    pattern: /(?:记住|存储|回忆).*(?:信息|内容|事项)/i,
    category: 'MEMORY_MANAGEMENT',
    confidence: 0.85
  },
  {
    pattern: /(?:分析|研究|深度).*(?:股票|金融|投资)/i,
    category: 'DATA_ANALYSIS',
    skillHint: 'stock-analyst-enhanced',
    confidence: 0.95
  },
  {
    pattern: /(?:财务|会计|审计).*(?:分析|报表)/i,
    category: 'DATA_ANALYSIS',
    skillHint: 'financial-analyst',
    confidence: 0.95
  },
  {
    pattern: /(?:人性化|humanize|de-AI|去AI味|去AI化).*(?:文本|文章|内容|写作|text)/i,
    category: 'WRITING',
    skillHint: 'humanizer',
    confidence: 0.95
  },
  {
    pattern: /(?:润色|改写|优化).*(?:文本|文章|内容|写作|文案)/i,
    category: 'WRITING',
    skillHint: 'humanizer',
    confidence: 0.9
  },
  {
    pattern: /(?:检测|评分|分析).*(?:AI|ai).*(?:痕迹|特征|模式|写作)/i,
    category: 'WRITING',
    skillHint: 'humanizer',
    confidence: 0.95
  },
  {
    pattern: /(?:设计|制作|创建|生成).*(?:UI|界面|落地页|看板|dashboard|landing page|页面)/i,
    category: 'DESIGN',
    skillHint: 'frontend-design',
    confidence: 0.9
  },
  {
    pattern: /(?:前端|配色|主题|布局|线框|wireframe).*(?:设计|方案|模板|风格)/i,
    category: 'DESIGN',
    skillHint: 'frontend-design',
    confidence: 0.9
  },
  {
    pattern: /(?:营销|推广|增长|获客|拉新|留存|转化率|CRO|SEO|文案|定价|发布策略)/i,
    category: 'MARKETING',
    skillHint: 'marketing',
    confidence: 0.9
  },
  {
    pattern: /(?:私域|种草|小红书|抖音|微信.*营销|社群|裂变|巨量|朋友圈广告)/i,
    category: 'MARKETING',
    skillHint: 'marketing',
    confidence: 0.95
  },
  {
    pattern: /(?:市场研究|竞品分析|TAM|SAM|SOM|市场规模|客户验证|Mom.?Test|市场进入|值不值得)/i,
    category: 'MARKETING',
    skillHint: 'marketing',
    confidence: 0.9
  },
  {
    pattern: /(?:写文章|写笔记|写稿|写.*小红书|写.*知乎|写.*公众号|抖音脚本|内容创作|生成.*内容|draft.*post|generate.*content)/i,
    category: 'MARKETING',
    skillHint: 'marketing',
    confidence: 0.9
  },
  {
    pattern: /(?:给|帮.*给?|为).{0,12}视频.{0,6}(?:加|配|添).{0,6}(?:字幕|标题|覆层|贴纸|水印)|视频包装|视频后期/i,
    category: 'VIDEO_CREATION',
    skillHint: 'hyperframes-video',
    confidence: 0.93
  },
  {
    pattern: /(?:做|制作|生成|创建|渲染).*(?:视频|短片|动画|片头|片尾|宣传片|短视频)/i,
    category: 'VIDEO_CREATION',
    skillHint: 'remotion-video',
    confidence: 0.9
  },
  {
    pattern: /(?:数据视频|视频简报|动画图?表|开场动画|字幕视频|motion graphics|remotion|hyperframes)/i,
    category: 'VIDEO_CREATION',
    skillHint: 'remotion-video',
    confidence: 0.95
  },
  {
    pattern: /(?:整理文件|批量重命名|重复文件|去重|文件分类|目录同步|文件同步|清理文件|文件管理)/i,
    category: 'FILE_MANAGEMENT',
    skillHint: 'file-manager',
    confidence: 0.9
  },
  {
    pattern: /(?:桌面自动化|UI自动化|鼠标控制|键盘控制|窗口管理|点击.*按钮|自动.*输入|窗口截图|桌面操作)/i,
    category: 'DESKTOP_AUTOMATION',
    skillHint: 'windows-ui-automation',
    confidence: 0.9
  },
  {
    pattern: /(?:公众号搜索|微信文章|公众号文章|微信.*搜索|搜.*公众号)/i,
    category: 'WECHAT_SEARCH',
    skillHint: 'wechat-article-search',
    confidence: 0.95
  },
  {
    pattern: /(?:浏览器自动化|browser-use|网页操作|网页截图|表单.*填写|网页.*爬取|Cookie.*管理|云浏览器)/i,
    category: 'BROWSER_AUTOMATION',
    skillHint: 'browser-use',
    confidence: 0.95
  },
  {
    pattern: /(?:打开|访问|浏览|截图|抓取|提取).*(?:网页|网站|页面|URL|链接)/i,
    category: 'BROWSER_AUTOMATION',
    skillHint: 'browser-use',
    confidence: 0.85
  },
  // 2026-08-20: B站站点知识包接线。bilibili-knowledge 无 executor，
  // 只有 skillHint 分支（L510-535）无条件 push；前 3 条与 TASK_CATEGORIES.BILIBILI
  // 共同构成触发面，第 4 条处理"B站+热门/分区"组合意图（裸"热门/排行榜"归 hot-now 域）。
  {
    pattern: /(?:b站|哔哩|bilibili)/i,
    category: 'BILIBILI',
    skillHint: 'bilibili-knowledge',
    confidence: 0.95
  },
  {
    pattern: /BV1[0-9A-Za-z]{7,9}/i,
    category: 'BILIBILI',
    skillHint: 'bilibili-knowledge',
    confidence: 0.95
  },
  {
    pattern: /(?:^|[^a-z0-9])av\d{4,}/i,
    category: 'BILIBILI',
    skillHint: 'bilibili-knowledge',
    confidence: 0.95
  },
  {
    pattern: /(?:b站|哔哩|bilibili).*(?:热门|排行|榜单|分区|频道)/i,
    category: 'BILIBILI',
    skillHint: 'bilibili-knowledge',
    confidence: 0.9
  }];

class SkillRouter {
  constructor(config = {}) {
    this.config = config;
    this.skillRegistry = null;
    this.lifecycleManager = getSkillLifecycleManager();
    this.usageHistory = new Map();
    this.skillScores = new Map();
    this.lastUpdate = 0;
    this.updateInterval = config.updateInterval || 60000;

    // SP2: 推荐质量门槛——config.skills.minQuality (0..1 成功率派生乘数, 0=不过滤)。
    // 构造时注入(现有 config 姿势); globalSkillRouter 未传 config → 默认 0, 行为不变。
    this._minQuality = config.minQuality ?? 0;

    // 组合式技能发现系统
    this._compositionGraph = null;
    this._discoveryEngine = null;
    this._chainTemplates = null;
    this._compositionInitialized = false;

    // hasExecutor 缓存
    this._noExecutorCache = null;
  }

  /**
   * 初始化组合发现系统
   * 在 skillRegistry 设置后调用
   */
  initializeCompositionSystem() {
    if (this._compositionInitialized) return;

    try {
      this._compositionGraph = getCompositionGraph();
      this._compositionGraph.initialize();

      this._discoveryEngine = getCompositionDiscoveryEngine();
      this._discoveryEngine.initialize({ graph: this._compositionGraph });

      this._chainTemplates = getSkillChainTemplates();
      this._chainTemplates.initialize();

      this._compositionInitialized = true;
      console.log('[SkillRouter] 组合发现系统初始化完成');
    } catch (err) {
      console.error('[SkillRouter] 组合发现系统初始化失败:', err.message);
    }
  }

  setSkillRegistry(registry) {
    this.skillRegistry = registry;
    this.updateSkillScores();
    this.initializeCompositionSystem();
  }

  /**
   * R17: 判断技能是否有可执行入口(executor.js/analyzer.js/summarizer.js/index.js)。
   * 知识库型技能(仅 SKILL.md,如 marketing)无 executor,executeSkillAdvanced 会报
   * "No executor found" → 技能卡黑箱无结果。推荐时过滤这类技能。
   *
   * 判定优先级：
   * 1. fs 检查 baseDir 下 executor 文件（最快）
   * 2. manifest.json 的 noExecutor 名单（缓存）
   * 默认返回 true（兼容未知技能）
   */
  _skillHasExecutor(skill) {
    const skillName = (skill && (skill.name || skill.skillName || '')) || ''
    // 优先 fs 检查
    if (skill && skill.baseDir) {
      try {
        const fs = require('fs')
        const path = require('path')
        const baseDir = skill.baseDir
        return ['executor.js', 'analyzer.js', 'summarizer.js', 'index.js']
          .some(f => fs.existsSync(path.join(baseDir, f)))
      } catch (e) {
        console.warn('[skill-router] executor 检查失败:', e.message)
        // 降级到 manifest 检查
      }
    }
    // 降级：manifest noExecutor 名单
    try {
      const noExec = this._getNoExecutorList()
      if (noExec.has(skillName)) return false
    } catch (e) { console.warn('[skill-router] noExecutor 名单读取失败:', e.message || e); }
    return true // 默认保守放行
  }

  /** 延迟加载 manifest noExecutor 名单 */
  _getNoExecutorList() {
    if (!this._noExecutorCache) {
      this._noExecutorCache = new Set()
      try {
        const fs = require('fs')
        const path = require('path')
        const manifestPath = path.join(__dirname, '..', '..', 'skills', 'manifest.json')
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
          if (Array.isArray(manifest.noExecutor)) {
            manifest.noExecutor.forEach(n => this._noExecutorCache.add(n))
          }
        }
      } catch (e) {
        console.warn('[skill-router] 加载 manifest noExecutor 名单失败:', e.message)
      }
    }
    return this._noExecutorCache
  }

  updateSkillScores() {
    if (!this.skillRegistry) return;

    const now = Date.now();
    if (now - this.lastUpdate < this.updateInterval) return;
    this.lastUpdate = now;

    // eslint-disable-next-line no-unused-vars
    for (const [skillName, skill] of Object.entries(this.skillRegistry)) {
      const detail = this.lifecycleManager.getSkillDetail(skillName);
      
      if (detail) {
        const score = this.calculateSkillScore(detail);
        this.skillScores.set(skillName, score);
      }
    }
  }

  calculateSkillScore(detail) {
    const usageCount = detail.usageCount || 0;
    const successCount = detail.successCount || 0;
    const qualityScore = detail.qualityScore || 0;
    
    const successRate = usageCount > 0 ? successCount / usageCount : 0.5;
    const usageBonus = Math.min(usageCount / 100, 0.2);
    const qualityBonus = qualityScore * 0.3;
    
    return Math.min(1, successRate * 0.5 + usageBonus + qualityBonus);
  }

  classifyTask(userInput) {
    const input = userInput.toLowerCase();
    const results = [];

    for (const { pattern, category, skillHint, confidence } of INTENT_PATTERNS) {
      if (pattern.test(input)) {
        results.push({
          category,
          skillHint,
          confidence,
          matched: true
        });
      }
    }

    for (const [key, category] of Object.entries(TASK_CATEGORIES)) {
      const keywordMatches = category.keywords.filter(kw => 
        input.includes(kw.toLowerCase())
      );
      
      if (keywordMatches.length > 0) {
        results.push({
          category: key,
          confidence: keywordMatches.length / category.keywords.length * 0.7,
          matchedKeywords: keywordMatches
        });
      }
    }

    // R15: 写作意图优先于搜索意图——"写一篇公众号文章"含"写"(写作动词)命中
    // MARKETING(写文章 0.9)与 WECHAT_SEARCH(公众号 0.95),纯按置信度取搜索 → 误判。
    // 输入含写作动词(写/生成/创作/制作/撰写)时,把写作相关类提到最前。
    const hasWriteIntent = /(写|生成|创作|制作|撰写|起草|拟).*(文章|文案|推文|稿|内容|帖|公众号)/.test(input);
    if (hasWriteIntent) {
      results.sort((a, b) => {
        const aWrite = a.category === 'MARKETING' || a.category === 'WRITING' ? 1 : 0;
        const bWrite = b.category === 'MARKETING' || b.category === 'WRITING' ? 1 : 0;
        if (aWrite !== bWrite) return bWrite - aWrite;
        return b.confidence - a.confidence;
      });
    } else {
      results.sort((a, b) => b.confidence - a.confidence);
    }

    return results.length > 0 ? results[0] : { category: null, confidence: 0 };
  }

  getRecommendedSkills(userInput, options = {}) {
    const { maxResults = 5, minScore = 0.3 } = options;

    const classification = this.classifyTask(userInput);
    const recommendations = [];

    // 2026-09-06: 激活专家的技能包集合——类目循环里包内无执行器知识技能放行
    // （岗位随带 SKILL.md 专业知识包，可注入 LLM），非包内维持硬跳过
    let expertPackSet = null;
    try {
      const { getActiveExpertSkills } = require('./expert-context');
      const pack = options.userId ? getActiveExpertSkills(options.userId) : null;
      if (pack && pack.length > 0) expertPackSet = new Set(pack);
    } catch { /* 专家上下文不可用 → 维持旧行为 */ }

    // 获取质量惩罚因子
    let qualityPenalties = {};
    try {
      const { getQualityTracker } = require('./skill/skill-quality-tracker');
      const tracker = getQualityTracker();
      if (tracker._initialized) {
        qualityPenalties = tracker.getAllPenalties();
      }
    } catch (e) {
      console.warn('[skill-router] Failed to get quality penalties:', e.message);
    }

    if (classification.skillHint) {
      const skill = this.skillRegistry?.[classification.skillHint];
      // R18: 不按 executor 过滤——marketing 等知识库型技能无 executor 但正确,
      // 推荐后由 R18 注入 SKILL.md 知识给 LLM 直接产出。executor 过滤会滤掉
      // 正确的写作/分析技能,误推其他技能。
      // ── Task 3: hasExecutor 降权（不硬剔除），无执行器时软警告 ──
      const hasExec = skill ? this._skillHasExecutor(skill) : true
      if (skill) {
        const penalty = qualityPenalties[classification.skillHint] ?? 1.0;
        const execPenalty = hasExec ? 1.0 : 0.15; // 无 executor 大幅降权
        recommendations.push({
          name: classification.skillHint,
          score: classification.confidence * penalty * execPenalty,
          rawScore: classification.confidence,
          penalty,
          reason: hasExec
            ? '直接匹配用户意图'
            : '直接匹配用户意图（⚠ 该技能仅有 SKILL.md 无执行器，LLM 可直接用知识输出）',
          category: classification.category,
          hasExecutor: hasExec,
        });
        if (!hasExec) {
          console.warn(`[skill-router] ⚠ 技能 "${classification.skillHint}" 匹配意图但无执行器，降权推荐；LLM 可用 SKILL.md 知识直接输出`)
        }
      }
    }

    if (classification.category) {
      const categoryConfig = TASK_CATEGORIES[classification.category];
      if (categoryConfig && categoryConfig.skills) {
        for (const skillName of categoryConfig.skills) {
          if (recommendations.find(r => r.name === skillName)) continue;

          const skill = this.skillRegistry?.[skillName];
          if (!skill) continue;

          // ── Task 3: hasExecutor 降权 —— 无执行器技能不进入推荐 ──
          // 2026-09-06: 放行例外——激活专家技能包内的知识技能(SKILL.md)不跳过,
          // 软降权 ×0.6 进候选池（专家偏置 ×1.3 可再抬），否则部门技能包永远
          // 进不了候选池、岗位偏置形同虚设（实测：写文章只推 marketing 单技能）。
          const hasExec = this._skillHasExecutor(skill)
          if (!hasExec && !(expertPackSet && expertPackSet.has(skillName))) {
            console.warn(`[skill-router] ⚠ 技能 "${skillName}" 无执行器，跳过推荐（LLM 仍可显式调用）`)
            continue
          }

          const usageScore = this.skillScores.get(skillName) || 0.5;
          const penalty = qualityPenalties[skillName] ?? 1.0;
          const finalScore = (classification.confidence * 0.6 + usageScore * 0.4) * penalty * (hasExec ? 1.0 : 0.6);

          if (finalScore >= minScore) {
            recommendations.push({
              name: skillName,
              score: finalScore,
              rawScore: classification.confidence * 0.6 + usageScore * 0.4,
              penalty,
              reason: `分类匹配: ${categoryConfig.name}`,
              category: classification.category,
              hasExecutor: hasExec,
            });
          }
        }
      }
    }

    // 动态扩展：从 CapabilityRegistry 查找分类相关的导入/自生成技能
    try {
      const { getCapabilityRegistry } = require('../taskflow/skill-capability-registry');
      const registry = getCapabilityRegistry();
      const catName = (classification.category || '').toLowerCase();
      for (const skillName of registry.getSkillNames()) {
        if (recommendations.find(r => r.name === skillName)) continue;
        const skill = this.skillRegistry?.[skillName];
        if (!skill) continue;
        const skillCat = (skill.metadata?.crabpaw?.category || skill.metadata?.openclaw?.category || '').toLowerCase();
        if (skillCat !== catName && !skillCat.includes(catName) && !catName.includes(skillCat)) continue;
        // Task 3: hasExecutor 降权
        if (!this._skillHasExecutor(skill)) {
          console.warn(`[skill-router] ⚠ 动态技能 "${skillName}" 无执行器，跳过推荐`)
          continue
        }
        const usageScore = this.skillScores.get(skillName) || 0.5;
        const penalty = qualityPenalties[skillName] ?? 1.0;
        const finalScore = (classification.confidence * 0.5 + usageScore * 0.5) * penalty;
        if (finalScore >= minScore) {
          recommendations.push({ name: skillName, score: finalScore, rawScore: finalScore, penalty, reason: 'CapabilityRegistry 动态匹配', category: classification.category, dynamic: true, hasExecutor: true });
        }
      }
    } catch (e) { console.warn('[skill-router] Failed to match capabilities:', e.message); }

    recommendations.sort((a, b) => b.score - a.score);

    // 增强推荐：加入技能组合推荐
    if (this._compositionInitialized && this._discoveryEngine) {
      try {
        const compositionRecs = this._discoveryEngine.recommendComposition(userInput, { maxResults: 2 });
        for (const comp of compositionRecs) {
          recommendations.push({
            name: comp.skills.join(' → '),
            score: comp.score,
            rawScore: comp.score,
            penalty: 1.0,
            reason: comp.reason,
            isComposition: true,
            compositionSkills: comp.skills,
            compositionType: comp.type,
          });
        }
        recommendations.sort((a, b) => b.score - a.score);
      } catch (e) {
        console.warn('[skill-router] Composition recommendation failed:', e.message);
      }
    }

    // 增强推荐：加入技能链模板匹配
    if (this._compositionInitialized && this._chainTemplates) {
      try {
        const templateMatches = this._chainTemplates.matchInput(userInput);
        for (const match of templateMatches.slice(0, 2)) {
          recommendations.push({
            name: match.template.name,
            score: match.matchScore,
            rawScore: match.matchScore,
            penalty: 1.0,
            reason: `匹配技能链模板「${match.template.name}」`,
            isChainTemplate: true,
            templateId: match.template.id,
            templateSteps: match.template.steps.map(s => s.skill),
          });
        }
        recommendations.sort((a, b) => b.score - a.score);
      } catch (e) {
        console.warn('[skill-router] Chain template matching failed:', e.message);
      }
    }
    
    // SP2 治理: minQuality 执行点——排序链完成后统一过滤(0=不过滤, 默认行为不变)。
    const minQuality = this._minQuality ?? 0;
    let filtered = recommendations.filter((s) => s.score == null || s.score >= minQuality);

    // P3(2026-09-04 部门化): 技能面偏置——激活专家的 allowedSkills 加权(×1.3),
    // 非本岗位技能降权(×0.3)但不剔除(技能是知识包, 硬剔除伤害大于收益)。
    // options.userId 由调用方传入(ai.js injectSkillGuidance 链)。
    if (options.userId && filtered.length > 0) {
      try {
        const { getActiveExpertSkills } = require('./expert-context');
        const allowed = getActiveExpertSkills(options.userId);
        if (allowed && allowed.length > 0) {
          const allowedSet = new Set(allowed);
          for (const r of filtered) {
            if (r.score == null) continue;
            r.expertBias = allowedSet.has(r.name) ? 1.3 : 0.3;
            r.score = r.score * r.expertBias;
          }
          filtered.sort((a, b) => (b.score || 0) - (a.score || 0));
        }
      } catch (e) { console.warn('[skill-router] 技能面偏置失败(跳过):', e.message); }
    }

    return filtered.slice(0, maxResults);
  }

  /**
   * 技能面偏置纯函数（2026-09-04 P3, 供 eval 直测）——本岗位技能 ×1.3, 其余 ×0.3。
   * @param {Array<{name:string,score:number}>} recommendations
   * @param {string[]} allowedSkills
   */
  static applyExpertSkillBias(recommendations, allowedSkills) {
    const allowedSet = new Set(allowedSkills || []);
    for (const r of recommendations || []) {
      if (r.score == null) continue;
      r.expertBias = allowedSet.has(r.name) ? 1.3 : 0.3;
      r.score = r.score * r.expertBias;
    }
    return (recommendations || []).sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  // eslint-disable-next-line no-unused-vars
  async route(userInput, context = {}) {
    const recommendations = this.getRecommendedSkills(userInput, { maxResults: 3 });

    if (recommendations.length === 0) {
      return {
        success: false,
        error: 'No suitable skill found',
        recommendations: []
      };
    }

    const bestMatch = recommendations[0];
    
    return {
      success: true,
      skill: bestMatch.name,
      score: bestMatch.score,
      reason: bestMatch.reason,
      alternatives: recommendations.slice(1),
      classification: this.classifyTask(userInput)
    };
  }

  /**
   * @deprecated 2026-08-18: 全仓零调用者(活路径是 route()/getRecommendedSkills()——
   * ai.js injectSkillGuidance 用 getRecommendedSkills 注入推荐)。保留以防接线,
   * 长期无调用者则专门轮次移除。已修复内部 getSkillRecommender 未 await 缺陷。
   */
  async executeWithRouting(userInput, context = {}) {
    const routeResult = await this.route(userInput, context);
    
    if (!routeResult.success) {
      return routeResult;
    }

    const skillName = routeResult.skill;
    
    try {
      const result = await executeSkill(skillName, { input: userInput }, context);

      this.recordUsage(skillName, result.success);

      // Record to recommender for user-level pattern tracking
      try {
        // 2026-08-18 P0: getSkillRecommender 是 async 工厂(内部 await init()),此前未 await
        // → 拿到 Promise 实例,recordSkillUsage?.(...) 可选链短路静默 no-op,推荐器 usageStats 恒 0。
        // 改为 await 后调用。
        const { getSkillRecommender } = require('./skill-recommender');
        getSkillRecommender().then((recommender) => {
          recommender.recordSkillUsage?.(skillName, context.userId, { message: userInput, sessionId: context.sessionId });
        }).catch((e) => { console.warn('[skill-router] Recommender recording failed:', e.message); });
      } catch (e) { console.warn('[skill-router] Recommender recording failed:', e.message); }

      // 记录到组合图谱
      if (this._compositionInitialized && this._compositionGraph && context.sessionId) {
        try {
          this._compositionGraph.recordExecution(context.sessionId, skillName, result.success);
        } catch (e) {
          console.warn('[skill-router] Failed to record composition graph execution:', e.message);
        }
      }
      
      return {
        ...result,
        routedTo: skillName,
        routeScore: routeResult.score
      };
    } catch (e) {
      this.recordUsage(skillName, false);

      // 记录失败到组合图谱
      if (this._compositionInitialized && this._compositionGraph && context.sessionId) {
        try {
          this._compositionGraph.recordExecution(context.sessionId, skillName, false);
        } catch (e) {
          console.warn('[skill-router] Failed to record failed execution in composition graph:', e.message);
        }
      }
      
      return {
        success: false,
        error: e.message,
        routedTo: skillName
      };
    }
  }

  recordUsage(skillName, success) {
    const key = skillName;
    const current = this.usageHistory.get(key) || { count: 0, success: 0 };
    
    current.count++;
    if (success) current.success++;
    
    this.usageHistory.set(key, current);
  }

  getUsageStats() {
    const stats = {};
    
    for (const [skill, data] of this.usageHistory) {
      stats[skill] = {
        ...data,
        successRate: data.count > 0 ? data.success / data.count : 0
      };
    }
    
    return stats;
  }

  explainRouting(userInput) {
    const classification = this.classifyTask(userInput);
    const recommendations = this.getRecommendedSkills(userInput);

    return {
      input: userInput,
      classification: {
        category: classification.category,
        confidence: classification.confidence,
        matchedKeywords: classification.matchedKeywords
      },
      recommendations: recommendations.map(r => ({
        skill: r.name,
        score: r.score,
        reason: r.reason
      })),
      explanation: this.generateExplanation(classification, recommendations)
    };
  }

  generateExplanation(classification, recommendations) {
    if (!classification.category) {
      return '无法确定任务类型，建议手动选择技能。';
    }

    const category = TASK_CATEGORIES[classification.category];
    const categoryName = category?.name || classification.category;
    
    let explanation = `识别任务类型为「${categoryName}」，置信度 ${(classification.confidence * 100).toFixed(0)}%。`;
    
    if (recommendations.length > 0) {
      explanation += ` 推荐使用「${recommendations[0].name}」技能`;
      if (recommendations.length > 1) {
        explanation += `，备选方案: ${recommendations.slice(1).map(r => r.name).join('、')}`;
      }
    }

    return explanation;
  }
}

// ── 对话阶段感知自动触发（参考 Superpowers 自动触发模式） ──────────
// Superpowers 的核心创新：技能根据对话阶段自动激活，而非手动调用
// 阶段：exploration → planning → implementation → verification → completion
const CONVERSATION_PHASES = {
  EXPLORATION: {
    name: 'exploration',
    description: '需求探索阶段',
    triggers: [
      /(?:我想|帮我|能不能|如何|怎么|需要|想要|希望|能不能).*(?:做|实现|开发|创建|设计|构建|添加|修改)/i,
      /(?:新功能|新特性|新需求|feature|需求|requirement)/i,
      /(?:帮我|请|能不能).*(?:分析|研究|调研|了解|看看)/i,
    ],
    autoSkillHint: 'brainstorming',
    prompt: '[阶段提示] 当前处于需求探索阶段。在开始编码前，先理解用户真正想要什么，确认需求范围和边界。',
  },
  PLANNING: {
    name: 'planning',
    description: '方案规划阶段',
    triggers: [
      /(?:方案|计划|规划|设计|架构|步骤|流程|plan|design|architecture)/i,
      /(?:怎么实现|如何实现|实现方案|技术方案|实现路径)/i,
      /(?:先做什么|从哪里开始|分几步|拆分|拆解)/i,
    ],
    autoSkillHint: 'writing-plans',
    prompt: '[阶段提示] 当前处于方案规划阶段。将工作拆分为具体的小任务，每个任务包含明确的文件路径和验证步骤。',
  },
  IMPLEMENTATION: {
    name: 'implementation',
    description: '编码实现阶段',
    triggers: [
      /(?:开始实现|开始编码|写代码|实现这个|编码|implement|code)/i,
      /(?:按计划|按照方案|执行|开始做)/i,
    ],
    autoSkillHint: 'test-driven-development',
    prompt: '[阶段提示] 当前处于编码实现阶段。遵循 TDD 流程：先写测试（RED），再写最小实现（GREEN），最后重构（REFACTOR）。',
  },
  DEBUGGING: {
    name: 'debugging',
    description: '调试排错阶段',
    triggers: [
      /(?:报错|错误|bug|异常|失败|崩溃|error|exception|fail|crash)/i,
      /(?:不工作|不生效|不对|有问题|出问题|无法运行)/i,
      /(?:调试|排查|定位|debug|troubleshoot|investigate)/i,
    ],
    autoSkillHint: 'systematic-debugging',
    prompt: '[阶段提示] 当前处于调试排错阶段。遵循系统化调试：复现→定位根因→修复→验证。',
  },
  VERIFICATION: {
    name: 'verification',
    description: '验证审查阶段',
    triggers: [
      /(?:检查|审查|review|验证|测试|确认|check|verify|test)/i,
      /(?:代码审查|code review|质量检查|有没有问题)/i,
    ],
    autoSkillHint: 'requesting-code-review',
    prompt: '[阶段提示] 当前处于验证审查阶段。对照计划审查实现，确保规格一致性和代码质量。',
  },
  COMPLETION: {
    name: 'completion',
    description: '收尾完成阶段',
    triggers: [
      /(?:完成|收尾|合并|提交|部署|finish|merge|deploy|commit)/i,
      /(?:清理|整理|总结|done|complete)/i,
    ],
    autoSkillHint: null,
    prompt: '[阶段提示] 当前处于收尾完成阶段。验证所有测试通过，整理代码，准备合并。',
  },
};

/**
 * 检测当前对话阶段（参考 Superpowers 的上下文感知触发）
 * @param {string} userInput - 用户输入
 * @param {object} context - 对话上下文（历史消息、已用技能等）
 * @returns {{ phase: string, autoSkillHint: string|null, prompt: string, confidence: number }}
 */
function detectConversationPhase(userInput, context = {}) {
  const input = userInput.toLowerCase();
  const results = [];

  // eslint-disable-next-line no-unused-vars
  for (const [key, phase] of Object.entries(CONVERSATION_PHASES)) {
    let matchCount = 0;
    for (const pattern of phase.triggers) {
      if (pattern.test(input)) matchCount++;
    }
    if (matchCount > 0) {
      results.push({
        phase: phase.name,
        autoSkillHint: phase.autoSkillHint,
        prompt: phase.prompt,
        confidence: matchCount / phase.triggers.length,
      });
    }
  }

  // 上下文增强：如果最近使用了某个阶段的技能，推测下一阶段
  if (context.recentSkills && context.recentSkills.length > 0) {
    const lastSkill = context.recentSkills[context.recentSkills.length - 1];
    const phaseTransitions = {
      'brainstorming': 'planning',
      'writing-plans': 'implementation',
      'test-driven-development': 'verification',
      'systematic-debugging': 'verification',
      'requesting-code-review': 'completion',
    };
    const nextPhase = phaseTransitions[lastSkill];
    if (nextPhase && CONVERSATION_PHASES[nextPhase.toUpperCase()]) {
      const phaseConfig = CONVERSATION_PHASES[nextPhase.toUpperCase()];
      // 如果已有直接匹配，降低转移权重；否则作为推断
      const existingIdx = results.findIndex(r => r.phase === phaseConfig.name);
      if (existingIdx >= 0) {
        results[existingIdx].confidence = Math.min(1, results[existingIdx].confidence + 0.2);
      } else {
        results.push({
          phase: phaseConfig.name,
          autoSkillHint: phaseConfig.autoSkillHint,
          prompt: phaseConfig.prompt,
          confidence: 0.4, // 推断置信度较低
        });
      }
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results.length > 0 ? results[0] : { phase: 'unknown', autoSkillHint: null, prompt: '', confidence: 0 };
}

const globalSkillRouter = new SkillRouter();

function initializeRouter(skillRegistry) {
  globalSkillRouter.setSkillRegistry(skillRegistry);
}

module.exports = {
  SkillRouter,
  globalSkillRouter,
  initializeRouter,
  TASK_CATEGORIES,
  INTENT_PATTERNS,
  CONVERSATION_PHASES,
  detectConversationPhase
};
