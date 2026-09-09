/**
 * Browser Data Sources Manager
 *
 * 管理浏览器数据源配置：CRUD、持久化、触发词匹配、system-prompt 上下文生成。
 * 数据源存储在 data/data-sources.json，用户配置覆盖预设。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_SOURCES_PATH = path.join(__dirname, '..', '..', 'data', 'data-sources.json');

let _instance = null;

function getBrowserDataSourceManager() {
  if (!_instance) {
    _instance = new BrowserDataSourceManager();
  }
  return _instance;
}

class BrowserDataSourceManager {
  constructor(filePath) {
    this._filePath = filePath || DATA_SOURCES_PATH;
    this._sources = new Map();
    this._loaded = false;
  }

  /**
   * 加载数据源（预设 + 用户覆盖）
   */
  load() {
    try {
      if (!fs.existsSync(this._filePath)) {
        console.log('[browser-data-sources] 数据源文件不存在，将使用空列表');
        this._loaded = true;
        return;
      }
      const raw = fs.readFileSync(this._filePath, 'utf-8');
      const data = JSON.parse(raw);
      const sources = data.sources || [];

      this._sources.clear();
      for (const src of sources) {
        if (src.id) {
          this._sources.set(src.id, this._normalizeSource(src));
        }
      }
      this._loaded = true;
      console.log(`[browser-data-sources] 加载了 ${this._sources.size} 个数据源 (v${data.version || '?'})`);
    } catch (e) {
      console.error('[browser-data-sources] 加载数据源失败:', e.message);
      this._loaded = true;
    }
  }

  /**
   * 持久化到磁盘
   */
  save() {
    try {
      const dir = path.dirname(this._filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        sources: Array.from(this._sources.values()),
      };
      fs.writeFileSync(this._filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[browser-data-sources] 保存了 ${this._sources.size} 个数据源`);
    } catch (e) {
      console.error('[browser-data-sources] 保存数据源失败:', e.message);
      throw e;
    }
  }

  /**
   * 列出所有数据源（可按类型过滤）
   */
  list(filter = {}) {
    this._ensureLoaded();
    let sources = Array.from(this._sources.values());

    if (filter.type) {
      sources = sources.filter(s => s.type === filter.type);
    }
    if (filter.category) {
      sources = sources.filter(s => s.category === filter.category);
    }
    if (filter.enabled !== undefined) {
      sources = sources.filter(s => s.enabled === filter.enabled);
    }

    return sources;
  }

  /**
   * 按分类分组列出
   */
  listByCategory() {
    this._ensureLoaded();
    const groups = {};
    for (const src of this._sources.values()) {
      const cat = src.category || '其他';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(src);
    }
    return groups;
  }

  /**
   * 获取单个数据源
   */
  get(id) {
    this._ensureLoaded();
    return this._sources.get(id) || null;
  }

  /**
   * 创建数据源
   */
  create(config) {
    this._ensureLoaded();
    const id = config.id || `ds_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    if (this._sources.has(id)) {
      throw new Error(`数据源 "${id}" 已存在`);
    }

    const validation = this.validate(config);
    if (!validation.valid) {
      throw new Error(`数据源配置无效: ${validation.errors.join('; ')}`);
    }

    const source = this._normalizeSource({ ...config, id });
    this._sources.set(id, source);
    this.save();
    return source;
  }

  /**
   * 更新数据源
   */
  update(id, config) {
    this._ensureLoaded();
    const existing = this._sources.get(id);
    if (!existing) {
      throw new Error(`数据源 "${id}" 不存在`);
    }

    const merged = { ...existing, ...config, id };
    const validation = this.validate(merged);
    if (!validation.valid) {
      throw new Error(`数据源配置无效: ${validation.errors.join('; ')}`);
    }

    const source = this._normalizeSource(merged);
    this._sources.set(id, source);
    this.save();
    return source;
  }

  /**
   * 删除数据源
   */
  delete(id) {
    this._ensureLoaded();
    if (!this._sources.has(id)) {
      throw new Error(`数据源 "${id}" 不存在`);
    }
    this._sources.delete(id);
    this.save();
    return true;
  }

  /**
   * 启用/禁用
   */
  toggle(id, enabled) {
    this._ensureLoaded();
    const existing = this._sources.get(id);
    if (!existing) {
      throw new Error(`数据源 "${id}" 不存在`);
    }
    existing.enabled = enabled !== undefined ? enabled : !existing.enabled;
    this.save();
    return existing;
  }

  /**
   * 根据用户消息匹配数据源触发词
   * 返回匹配的数据源列表，按触发词匹配度排序
   */
  matchByTrigger(userMessage) {
    this._ensureLoaded();
    if (!userMessage || typeof userMessage !== 'string') return [];

    const msg = userMessage.toLowerCase();
    const matches = [];

    for (const src of this._sources.values()) {
      if (!src.enabled) continue;
      const keywords = src.triggerKeywords || [];
      const matchedKeywords = [];

      for (const kw of keywords) {
        if (msg.includes(kw.toLowerCase())) {
          matchedKeywords.push(kw);
        }
      }

      if (matchedKeywords.length > 0) {
        matches.push({
          source: src,
          matchedKeywords,
          score: matchedKeywords.length,
        });
      }
    }

    // 按匹配分数降序排列
    matches.sort((a, b) => b.score - a.score);
    return matches;
  }

  /**
   * 生成 system-prompt 上下文注入内容
   * 用于让智能体知道有哪些数据源可用
   */
  buildSystemPromptContext() {
    this._ensureLoaded();
    const enabledSources = this.list({ enabled: true });

    if (enabledSources.length === 0) return [];

    const lines = [];

    // 按分类分组
    const byCategory = {};
    for (const src of enabledSources) {
      const cat = src.category || '其他';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(src);
    }

    lines.push('');
    lines.push('## 浏览器数据源');
    lines.push('你已配置以下浏览器数据源的搜索能力。当用户的问题匹配触发词时，应使用 BrowserControl 工具访问对应网站搜索并提取数据。');
    lines.push('');

    for (const [category, sources] of Object.entries(byCategory)) {
      lines.push(`### ${category}`);
      for (const src of sources) {
        const triggers = (src.triggerKeywords || []).slice(0, 6).join('、');
        lines.push(`- **${src.name}** (\`${src.id}\`): ${src.description || src.type}`);
        lines.push(`  搜索URL: ${src.searchUrl}`);
        lines.push(`  提取模式: ${src.extractMode}${src.loginRequired ? ' | 需登录(' + src.loginMethod + ')' : ''}`);
        lines.push(`  触发词: ${triggers}`);
        lines.push(`  对话中使用方法: 用户提到"${triggers}"时，用 BrowserControl 导航到搜索URL(替换 {query} 为用户查询词)，然后截图+screenshot+vision提取数据。`);
        lines.push('');
      }
    }

    lines.push('**数据源使用原则:**');
    lines.push('1. 优先使用专用数据源而非通用 WebSearch');
    lines.push('2. 电商类数据源：先截图 → vision提取 → 表格汇总 → 给出推荐');
    lines.push('3. 学术类数据源：多源搜索 → 去重 → AI总结 → 结构化输出');
    lines.push('4. 社交媒体数据源：注意反爬 → StealthManager → 控制频率');
    lines.push('5. 热榜类数据源：一次提取 → 缓存60秒 → 避免频繁刷新');
    lines.push('');

    return lines;
  }

  /**
   * 根据用户消息生成路由决策指令
   *
   * 与 buildSystemPromptContext() 不同，此方法针对当前消息生成强指令，
   * 明确告诉 AI 应该用哪个工具、不应该用哪个工具。
   *
   * 路由规则：
   *   - ecommerce/social_media → BrowserControl (用数据源URL)
   *   - news (热榜类, 如 weibo_hot/zhihu_hot/baidu_hot) → BrowserControl
   *   - academic → BrowserControl（有专用搜索URL 的） 或 WebSearch+WebExtract（通用学术搜索）
   *   - tech/recruitment/real_estate → BrowserControl
   *   - 无匹配 → 不注入指令，让 AI 自行用 WebSearch
   */
  buildRoutingDirective(userMessage, opts = {}) {
    this._ensureLoaded();
    const matches = this.matchByTrigger(userMessage);

    // 无数据源匹配 → 沟通型，不注入路由指令
    if (matches.length === 0) {
      return [];
    }

    // 排除明显是沟通型的查询（即使触发了数据源关键词）
    if (this._isConversationalQuery(userMessage)) {
      return [];
    }

    const lines = [];
    const bestMatch = matches[0]; // 最高分匹配
    const ds = bestMatch.source;
    const channel = opts.channel || 'gui';
    const isRemote = channel === 'wecom' || channel === 'feishu' || channel === 'lark';

    // 🔑 模式判断：数据源匹配 → 任务型；无匹配 → 沟通型
    // 任务型：显示阶段进度、工具调用、小结
    // 沟通型：只显示对话气泡，无过程


    // 检查 BrowserControl/Playwright 是否实际可用
    const browserReady = this._checkBrowserReady();

    lines.push('');
    lines.push(`## ⚠️ 当前消息模式：🔧 任务型 (${ds.category})`);
    lines.push(`数据源匹配: **${ds.name}** (匹配度: ${bestMatch.score})，触发词: ${bestMatch.matchedKeywords.join(', ')}`);
    lines.push('');
    lines.push('**任务型交互规则（与普通沟通型不同）：**');
    lines.push('- ✅ 显示阶段进度：💭分析 → 🔍搜索/浏览 → ✨整理 → 📋小结');
    lines.push('- ✅ 工具调用可展开查看，但默认折叠');
        lines.push('- ❌ 不要只说一句话就结束（那是沟通型的做法）');

    if (!browserReady) {
      // Playwright 不可用 — 降级为 WebSearch + WebFetch
      lines.push('');
      lines.push(`**⚠️ BrowserControl 不可用（Playwright 浏览器未安装），降级为 WebSearch + WebFetch**`);
      lines.push(`不要调用 BrowserControl！改用以下方案：`);
      lines.push(`1. WebSearch(query="${userMessage}") — 搜索商品/资讯`);
      lines.push(`2. WebFetch(url=搜索结果中的链接) — 获取详情`);
      lines.push(`3. WebExtract(urls=[...]) — 批量提取正文`);
      lines.push(`4. AI 汇总分析 → 表格输出`);
      lines.push(`5. 明确告知用户："浏览器自动化暂不可用（需安装 Chromium），以下是 WebSearch 搜索结果"`);
      lines.push('');
      return lines;
    }

    const { type } = ds;

    if (type === 'ecommerce') {
      const needsLogin = ds.loginRequired;

      if (needsLogin) {
        if (isRemote) {
          // ── 远程渠道（企微/飞书）：用户不在电脑前，无法交互浏览器 ──
          lines.push('');
          lines.push(`**🔴 ${ds.name} 需要登录 — 当前为远程渠道(${channel})，用户不在电脑前**`);
          lines.push('');
          lines.push(`方案A（推荐）：检查 persistent profile 是否已有登录态`);
          lines.push(`  BrowserControl(action="status", profile="persistent") — 检查已保存的浏览器状态`);
          lines.push(`  如果 persistent profile 已登录 → 直接使用它搜索`);
          lines.push(`  如果未登录 → 方案B`);
          lines.push('');
          lines.push(`方案B：二维码扫码登录（用户可通过手机完成）`);
          lines.push(`  1. BrowserControl(action="start", profile="persistent")`);
          lines.push(`  2. BrowserControl(action="navigate", url="${ds.name === '1688 商品搜索' ? 'https://login.1688.com' : ds.searchUrl}")`);
          lines.push(`  3. BrowserControl(action="screenshot") — 截取登录页（含二维码）`);
          lines.push(`  4. 将截图发送给用户："请用${ds.name === '1688 商品搜索' ? '1688' : ds.name}APP扫描二维码登录"`);
          lines.push(`  5. BrowserControl(action="waitForLogin", profileName="persistent", timeout=120000)`);
          lines.push(`  6. 登录成功后搜索商品，提取数据，汇总回复`);
          lines.push('');
          lines.push(`方案C：告知用户先用桌面端登录一次`);
          lines.push(`  如果以上都失败，回复："${ds.name}需要登录才能查看价格。请在电脑上打开CrabPaw桌面端，登录${ds.name}一次，之后就可以通过企微/飞书远程找品了。"`);
        } else {
          // ── 桌面GUI渠道：用户可以直接操作浏览器窗口 ──
          lines.push('');
          lines.push(`**🔴 ${ds.name} 需要登录 — 使用 waitForLogin 让用户完成一次性登录**`);
          lines.push(`${ds.name} 需要登录才能搜索。直接用 waitForLogin：浏览器会自动打开登录页，用户登录一次即可。`);
          lines.push(`登录状态会保存到 persistent profile，下次自动复用，无需重复登录。`);
          lines.push('');
          lines.push(`操作步骤:`);
          lines.push(`1. BrowserControl(action="start", profile="persistent")`);
          lines.push(`2. BrowserControl(action="navigate", url="${ds.searchUrl.replace('{query}', '{用户查询词}')}")`);
          lines.push(`3. 如果被重定向到登录页 → BrowserControl(action="waitForLogin", profileName="persistent", timeout=120000)`);
          lines.push(`4. 登录成功后搜索 → 截图 → vision提取 → 表格汇总`);
          lines.push(`5. 提示："登录状态已保存，下次直接搜索无需再登录"`);
        }
      } else {
        // ── 不需要登录的电商站点：普通 BrowserControl ──
        lines.push('');
        lines.push(`**🔴 必须使用 BrowserControl（不要用 WebSearch）**`);
        lines.push(`电商商品搜索需要从 ${ds.name} 提取结构化数据（价格/销量/店铺），WebSearch 无法做到。`);
        lines.push(`操作步骤:`);
        lines.push(`1. BrowserControl(action="start") — 启动浏览器`);
        lines.push(`2. BrowserControl(action="navigate", url="${ds.searchUrl.replace('{query}', '{用户查询词}')}")`);
        lines.push(`3. BrowserControl(action="screenshot") — 截取搜索结果`);
        lines.push(`4. BrowserControl(action="vision", prompt="${(ds.visionPrompt || '提取商品列表').substring(0, 100)}...")`);
        lines.push(`5. 汇总为表格回复，给出推荐建议`);
      }
    } else if (type === 'social_media' || ds.id === 'douyin' || ds.id === 'weibo' || ds.id === 'bilibili' || ds.id === 'xiaohongshu') {
      lines.push('');
      lines.push(`**🔴 必须使用 BrowserControl（不要用 WebSearch）**`);
      lines.push(`自媒体平台内容需要浏览器渲染和视觉提取，WebSearch 无法获取。`);
      lines.push(`操作步骤:`);
      lines.push(`1. BrowserControl(action="start") — 启动浏览器（建议启用隐身模式）`);
      lines.push(`2. BrowserControl(action="navigate", url="${(ds.hotspotUrl || ds.searchUrl).replace('{query}', '{用户查询词}')}")`);
      lines.push(`3. BrowserControl(action="screenshot") — 截取内容`);
      lines.push(`4. BrowserControl(action="vision", prompt="提取页面内容...")`);
      lines.push(`5. 注意反爬：使用 BrowserControl(action="stealth_toggle") 开启隐身`);
      lines.push(`6. 控制请求频率，每次请求间隔 ${ds.cooldown}ms`);
    } else if (ds.id === 'weibo_hot' || ds.id === 'zhihu_hot' || ds.id === 'baidu_hot' || ds.extractMode === 'api') {
      lines.push('');
      lines.push(`**🟡 使用 WebFetch（API 接口，不需要浏览器）**`);
      lines.push(`热榜/API 类数据源可以直接通过 HTTP 获取：`);
      if (ds.hotspotUrl) {
        lines.push(`- WebFetch(url="${ds.hotspotUrl}") — 获取热榜JSON数据`);
      } else if (ds.searchUrl && !ds.searchUrl.includes('{query}')) {
        lines.push(`- WebFetch(url="${ds.searchUrl}") — 获取最新数据`);
      }
      lines.push(`- WebSearch(query="当前用户查询") — 作为补充搜索`);
    } else if (type === 'academic') {
      lines.push('');
      lines.push(`**🟡 优先 BrowserControl，WebSearch 作补充**`);
      if (ds.extractMode === 'api') {
        lines.push(`此数据源支持 API: WebFetch(url="${ds.searchUrl.replace('{query}', '{查询词}')}")`);
      } else {
        lines.push(`1. BrowserControl → navigate → screenshot → vision 提取结构化论文数据`);
      }
      lines.push(`2. 同时用 WebSearch 搜索补充来源`);
      lines.push(`3. 去重后做 AI 综合分析`);
    } else {
      // tech, recruitment, real_estate, travel, local_service, news(非热榜)
      lines.push('');
      lines.push(`**🟡 使用 BrowserControl 进行结构化提取**`);
      lines.push(`通用网站搜索: 先 BrowserControl navigate+snapshot+screenshot，再用 vision 提取结构化数据。`);
      lines.push(`如果页面是 JS 重度渲染的，WebSearch 无法获取有效内容。`);
    }

    // 如果有多个匹配，列出备选
    if (matches.length > 1) {
      lines.push('');
      lines.push('备选数据源:');
      for (const m of matches.slice(1, 4)) {
        lines.push(`- ${m.source.name} (匹配度: ${m.score}, 触发词: ${m.matchedKeywords.slice(0, 3).join(', ')})`);
      }
    }

    lines.push('');
    lines.push('**⚠️ 路由规则:**');
    if (ds.loginRequired) {
      lines.push(`- **${ds.name} 需要登录** → 优先 CDP 连接用户已登录 Chrome（不要启动新浏览器！）`);
      lines.push('- CDP 失败则用 waitForLogin 等待手动登录');
      lines.push('- 都失败则回退 WebSearch，并明确告诉用户原因');
    } else {
      lines.push('- **BrowserControl 优先**，禁止用 WebSearch 替代结构化数据提取');
    }
    lines.push('- 电商/自媒体/视频平台 → **必须 BrowserControl**，禁止 WebSearch 替代');
    lines.push('- 热榜/API接口 → WebFetch 优先');
    lines.push('- 学术 → BrowserControl + WebSearch 双路并行');
    lines.push('- URL 中的 {query} → 务必替换为用户实际查询词');
    lines.push('- 遇到登录墙 → 不要反复重试，一次失败就回退并告知用户');
    lines.push('');
    lines.push(`**📱 外部渠道推送规则（wecom/feishu）:**`);
    lines.push('- 推送到企微/飞书时：只推送最终回复内容，不推送"正在执行""⏳""🔧"等过程信息');
    lines.push('- 在收到第一个 chunk 之前：只发 "…" 或不做任何推送');
    lines.push('- 工具执行过程完全隐藏在桌面端GUI，外部渠道只看到最终结果');
    lines.push('');

    return lines;
  }

  /**
   * 验证数据源配置
   */
  validate(config) {
    const errors = [];

    if (!config.name || typeof config.name !== 'string') {
      errors.push('name 是必填字段');
    }
    if (!config.type || typeof config.type !== 'string') {
      errors.push('type 是必填字段');
    }
    if (config.searchUrl && typeof config.searchUrl !== 'string') {
      errors.push('searchUrl 必须是字符串');
    }
    if (!['vision', 'paginate', 'scroll', 'api', 'search'].includes(config.extractMode)) {
      errors.push('extractMode 必须是 vision/paginate/scroll/api/search 之一');
    }
    if (config.maxPages && (typeof config.maxPages !== 'number' || config.maxPages < 1 || config.maxPages > 20)) {
      errors.push('maxPages 必须在 1-20 之间');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * 标准化数据源对象
   */
  _normalizeSource(src) {
    return {
      id: src.id || '',
      name: src.name || '',
      type: src.type || 'web',
      category: src.category || '其他',
      enabled: src.enabled !== undefined ? src.enabled : true,
      searchUrl: src.searchUrl || '',
      hotspotUrl: src.hotspotUrl || '',
      extractMode: src.extractMode || 'vision',
      visionPrompt: src.visionPrompt || '',
      loginRequired: src.loginRequired || false,
      loginMethod: src.loginMethod || 'none',
      triggerKeywords: src.triggerKeywords || [],
      description: src.description || '',
      icon: src.icon || 'globe',
      maxPages: src.maxPages || 3,
      cooldown: src.cooldown || 3000,
      pagination: src.pagination || null,
      fields: src.fields || [],
      postProcess: src.postProcess || null,
      refreshInterval: src.refreshInterval || 0,
      createdAt: src.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * 获取已启用数据源的统计概览
   */
  getStats() {
    this._ensureLoaded();
    const all = Array.from(this._sources.values());
    const enabled = all.filter(s => s.enabled);
    const byType = {};
    for (const s of enabled) {
      byType[s.type] = (byType[s.type] || 0) + 1;
    }
    return {
      total: all.length,
      enabled: enabled.length,
      disabled: all.length - enabled.length,
      byType,
    };
  }

  _ensureLoaded() {
    if (!this._loaded) {
      this.load();
    }
  }

  /**
   * 检查 Playwright 浏览器是否可用
   * 返回 false 时，路由应降级为 WebSearch + WebFetch
   */
  /**
   * 判断是否为纯沟通型查询（即使触发了数据源关键词也不应按任务处理）
   */
  _isConversationalQuery(msg) {
    const conversationalPatterns = [
      /天气|下雨|下雪|温度|气温|几度/,           // 天气
      /你好|哈[喽啰]|早上好|晚上好|再见|谢谢/,      // 寒暄
      /什么是|什么叫|是什么意思|如何理解|解释一下/,  // 概念解释
      /我(想|要|能|可以).{0,3}(问|请教|咨询)/,     // 提问句式
      /怎么样.{0,5}(才|能|可以|算)/,               // 寻求建议（非找品）
      /为什么|什么原因|怎么回事/,                    // 原因询问
    ];
    return conversationalPatterns.some(p => p.test(msg));
  }

  _checkBrowserReady() {
    try {
      require.resolve('playwright-core');
      const { isAnyBrowserAvailable } = require('./browser-control');
      return isAnyBrowserAvailable();
    } catch (e) {
      return false;
    }
  }
}

module.exports = { BrowserDataSourceManager, getBrowserDataSourceManager };
