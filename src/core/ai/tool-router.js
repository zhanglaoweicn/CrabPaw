'use strict';

/**
 * tool-router.js — 按需工具路由器
 *
 * 设计理念 (参考设计 按需工具注入):
 * - 不每轮把所有 80+ 工具全塞给模型
 * - 根据用户消息意图 + 上下文状态 + 工具链历史，挑选本轮需要的工具集
 * - 节省 prompt token，减少误调用，让工具选择更贴近意图
 *
 * 入口:
 * selectToolsForContext({ message, channel, isTick, activeTask, recallState, toolLog })
 * → { tools: ToolEntry[], reason: string, intent: string, confidence: number }
 *
 * CrabPaw 走 ToolRegistry（已有 toolset 分类），所以这里是"按意图选 toolset"而非"按意图选 tool"
 */

const { detectMessageIntent: _detectMessageIntent, INTENT_PATTERNS: _INTENT_PATTERNS } = require('./intents');

// ---------------------------------------------------------------------------
// Intent → toolset 映射（核心规则）
// ---------------------------------------------------------------------------
// 每个 intent 对应一个"必选 + 可选"工具集
// 必选：intent 命中时无条件加载
// 可选：根据上下文（是否需要写入、是否 tick 等）加载

const INTENT_TOOLSETS = {
 // ── 通用聊天 ──
 // 2026-08-04: optional 补 file/document——"生成一份报告"等无关键词匹配的
 // 请求落入 general,此前无文件工具 → LLM 无法执行(空计划/胡说)
 // 2026-08-19 复现修复: optional 的 'panel' 换 'web'——「推送热门消息」等无关键词
 // 资讯请求落 general 后 panel 集加载 → ShowHotspot 对 LLM 可见 → DeepSeek 自选
 // 弹 UI 卡片(用户两次反馈)。弹卡工具只留显式意图(news/scene/stock 等 required
 // 含 panel 者); 通用请求用 WebSearch 文本回答, 不弹面板。
 // 2026-08-20 DeepTutor 精华落地: optional 补 'knowledge'——KbSearch/KbList 是
 // 纯文本工具(无 panel), "之前分析的合同里金额是多少"等不带'知识库'词的问题
 // 落 general 时 LLM 也能检索知识库, 不重蹈弹卡教训。
 general: {
 required: ['interaction', 'agent'],
 optional: ['memory', 'skills', 'web', 'system', 'file', 'document', 'knowledge'],
 keywords: [],
 },
 greeting: {
 required: ['interaction', 'agent'],
 optional: ['memory', 'web'],
 keywords: ['你好', 'hello', 'hi', '早上好', '晚上好', '在吗'],
 },

 // ── 文件/代码 ──
 coding: {
 required: ['file', 'system', 'interaction'],
 optional: ['document', 'filesystem', 'agent', 'skills', 'harness', 'bash'],
 keywords: ['代码', '编程', '写一个', '写个', '实现', '函数', '类', 'code', 'function', 'class', 'debug', '调试', '重构', 'refactor', 'bug', 'fix'],
 },
 file_operation: {
 required: ['file', 'desktop', 'interaction'],
 optional: ['filesystem', 'document', 'system'],
 // 2026-08-18 P0-3 修复: 删除裸'打开'——"打开百度网页"此前命中 file_operation
 // 被路由到 file 工具集(只有文件工具,LLM 无浏览器/桌面工具可用)。
 // '打开文件'仍会被'文件'命中; 'open the file' 有 open+file 双命中仍落此意图。
 keywords: ['文件', '保存', '创建', '删除', '复制', '移动', 'file', 'open', 'save', 'delete', 'rename', '重命名'],
 },
 archive: {
 required: ['filesystem', 'file'],
 optional: ['system'],
 keywords: ['解压', '压缩', 'zip', 'rar', 'tar', '7z', 'archive'],
 },

 // ── 信息查询 ──
 // 2026-08-18 实机修复: 台风独立意图——此前台风问题落 weather 集（keywords 含"台风"）
 // → 模型调 TyphoonQuery 发 'typhoon' 窗口内小卡。台风命中 1/3=0.43 > weather 0.19 →
 // 注入 panel 集（含 ShowTyphoon），台风问题走 typhoon-panel 大面板（与"打开台风"一致）。
 typhoon: {
 required: ['panel'],
 // 2026-08-25 防分支: optional 原含 'web'——TyphoonQuery(web 集)随意图注入后,
 // 模型倾向先调数据工具而非面板工具(00:22 实机「最近有台风吗」→ 不弹台风卡、
 // 顺带补调 ShowWeather)。台风面板数据由 ShowTyphoon handler 自取, 无需暴露数据工具。
 optional: ['memory', 'system'],
 keywords: ['台风', '飓风', 'typhoon'],
 },
 weather: {
 required: ['web', 'panel'],
 optional: ['memory', 'system'],
 keywords: ['天气', 'weather', '温度', 'temperature', '下雨', '晴天', 'forecast', '预报'],
 // 2026-08-18 P0-3: 打开场景补强——"打开天气(面板)"裸'打开'会被 open_app(0.3)
 // 抢走, pairs 让本意图 3 命中 0.633 压回。
 pairs: [['打开', '天气'], ['打开', '天气预报']],
 },
 news: {
 required: ['trending', 'web', 'panel'],
 optional: ['memory'],
 // 2026-08-19 用户反馈「推荐热门资讯」弹热点卡片: 资讯语义词(新闻/news/头条)
 // 从 news 移入 web_search——「最新AI新闻」「今天有什么头条」应走搜索纯文本回答,
 // 不再命中 panel 集弹卡。news 只留明确榜单语义(热点/热搜/榜单/排行/trending)。
 keywords: ['热点', '热搜', 'trending', '榜单', '排行'],
 // 2026-08-18 P0-3: "打开热点"同因补强(3 命中 0.675 > open_app 0.3)。
 pairs: [['打开', '热点'], ['打开', '热搜'], ['看', '热点']],
 },
 // 2026-08-15: 股票意图——'打开股票'此前命中 file_operation('打开'关键词),
 // 面板工具被裁 → LLM 无 ShowStock 可用。显式意图路由到 panel 工具集。
 // 2026-08-19 发行审计 W4: optional 补 'stock'——持仓/自选工具(stock-holdings-tools,
 // toolset 'stock')此前不在任何意图, "查我的持仓"可见 ShowStock 面板却无持仓查询工具。
 stock: {
 required: ['panel', 'web'],
 optional: ['memory', 'stock'],
 keywords: ['股票', '行情', '股价', '大盘', '持仓', 'stock', 'A股'],
 // 2026-08-18 P0-3: "打开股票(面板)"此前会被 open_app 裸'打开'(0.3)抢走,
 // pairs 让本意图 3 命中 0.729 压回, 与任务预期"'打开股票'由 stock 意图命中"一致。
 pairs: [['打开', '股票'], ['看', '股票'], ['看看', '股票'], ['看下', '股票']],
 },
 web_search: {
 required: ['web', 'browser'],
 optional: ['memory'],
 // 2026-08-18 P0-3 修复: 删除'查询'/'帮我查'——"用数据库查询一下营收"此前落
 // web 工具集(LLM 只有 WebSearch/WebFetch,无 DatabaseQuery)。查询类请求
 // 改由 data_query 意图接管; web_search 只留搜索语义关键词。
 // 2026-08-19 搜索体验修复: 加'资讯'——"推荐最近的AI资讯"此前不命中任何意图,
 // 落 general 后 LLM 自选 ShowHotspot 弹 UI 热点面板卡片(用户明确反感搜索弹卡)。
 // '资讯'入 web_search(required 无 panel) → ShowHotspot/HotSearch 不可见 → 纯文本回答。
 // 2026-08-19 第二轮: 加'新闻'/'news'/'头条'(从 news 意图移入)——"最新AI新闻"等
 // 资讯查询此前命中 news→panel 集→LLM 选 ShowHotspot 弹卡; 现走搜索纯文本。
 keywords: ['搜索', '搜一下', 'search', 'google', '百度一下', '资讯', '新闻', 'news', '头条'],
 },
 // 2026-08-18 P0-3: 数据查询意图——数据库/数据导入工具集。'查询'等词从
 // web_search 移入此处, 数据库相关查询路由到 DatabaseQuery 而非 WebSearch。
 // 2026-09-06 实机: 纯技术词路由不到经营问题——"应收账款情况怎么样/这个月
 // 营收多少"落 general(0.5), data 工具集不注入 → 模型只能 DocRead 翻旧文件。
 // 补经营数据语义关键词（都是明确业务数据词, 与天气/股票/资讯意图无碰撞）。
 data_query: {
 required: ['data'],
 optional: ['web', 'memory', 'system'],
 keywords: ['数据库', '数据查询', '查询', 'sql', 'query', '查一下数据', '表结构',
   '应收', '欠款', '回款', '坏账', '账期', '逾期',
   '营收', '销售额', '营业额', '利润', '毛利', '经营数据', '经营情况', '经营分析', '对账',
   '库存', '进货', '采购额', '合同金额'],
 },
 // 2026-08-20 DeepTutor 精华落地: 知识库查询意图——此前知识库只有写入链路,
 // hybrid-retrieval 无生产调用方。KbSearch/KbList(toolset 'knowledge')只在此
 // 意图 + general optional 可见; required 无 'web'(知识库检索不触发网络搜索)
 // 也无 'panel'(沿用弹卡守卫教训: 文本回答, 不弹 UI 卡片)。
 kb_query: {
 required: ['knowledge', 'interaction'],
 optional: ['memory'],
 keywords: ['知识库', '知识库里', '知识库中', '之前分析', '分析过的', '文档分析', 'kb', '知识库搜索'],
 pairs: [['之前', '分析'], ['分析过', '文档']],
 },
 // 2026-08-19 发行审计 W4: optional 补 'network'——HttpRequest(toolset 'network')
 // 此前不在任何意图, "调用某个 HTTP API/接口" 语境下无工具可用。
 fetch_url: {
 required: ['web', 'browser'],
 optional: ['document', 'network'],
 keywords: ['这个网页', '打开这个', '看这个', '抓取', 'fetch', 'crawl', '访问这个'],
 },
 // 2026-08-18 P0-3: 打开应用/界面意图——'打开'此前在 file_operation 关键词里,
 // "打开百度"被误路由到 file 工具集。裸'打开'单命中 1/5+0.1=0.3, 与单命中
 // 意图平局时靠 pairs 补强(打开+软件/应用/百度/程序=3 命中 0.9)压过;
 // 特定面板意图(股票/天气/热点/面板/台风)各自带 pairs 或高命中分, 互不冲突。
 // 计分平局规则: score > bestScore 严格大于, Object.entries 按插入序, 先插入者胜;
 // 本意图置于 fetch_url 之后, "打开这个网页"(fetch_url 双命中 0.486)不受影响。
 // 2026-08-19 发行审计 W5: optional 补 'scene'——SceneSet/SceneClear 此前仅 video_play
 // 意图可见, "关闭股票面板/打开日程卡片"(stock/open_app 意图)下无场景工具可调。
 open_app: {
 required: ['ui', 'browser', 'desktop', 'file'],
 optional: ['web', 'memory', 'scene'],
 keywords: ['打开', '启动', 'open', 'launch', '运行'],
 pairs: [['打开', '软件'], ['打开', '应用'], ['打开', '百度'], ['打开', '程序'], ['启动', '软件'], ['启动', '应用']],
 },

 // ── 日程/任务 ──
 // 2026-08-15: 车票意图——'查动车票'此前落 general, TrainQuery(travel 工具集)
 // 被裁 → LLM 硬拼 HttpRequest 打 12306 被反爬。显式路由到 travel 工具集。
 travel: {
 required: ['travel'],
 optional: ['web', 'memory', 'interaction'],
 keywords: ['车票', '动车', '高铁', '火车票', '车次', '余票', '列车', '12306'],
 },
 // 2026-08-19 发行审计 W4: 补 'calendar' 工具集——CreateCalendarEvent(toolset 'calendar')
 // 此前不在任何意图 required/optional, LLM 文本路径永远不可见(active∩routed 交集过滤)。
 schedule: {
 required: ['platform', 'interaction'],
 optional: ['memory', 'desktop', 'calendar'],
 keywords: ['日程', '日历', '今天', '会议', '提醒', 'schedule', 'calendar', 'meeting', 'reminder'],
 },
 // 2026-08-18: 会议记录意图——「开始记录/记录一下」此前被 task('开始') 或 open_app 抢走,
 // panel 工具集被裁 → meeting_mode 对 LLM 不可见 → 纪要卡片无法触发。
 // 验算: 「开始记录」= 记录(1)+开始·记录 pair(2) = 3 命中 → 3/7+0.3 = 0.729 >
 // task「开始」1/8+0.1=0.225; 「打开会议记录」0.729 > open_app 0.3; 「开始做饭」
 // 无 '记录' → 不命中, 不误伤。可选 memory/skills 兜底「帮我记录一下某知识点」。
 meeting_record: {
 required: ['panel', 'interaction'],
 optional: ['memory', 'skills'],
 keywords: ['记录', '录音', '纪要', '转写', '会议记录', '记一下', 'record'],
 pairs: [['开始', '记录'], ['记录', '一下'], ['结束', '记录'], ['停止', '记录'], ['打开', '记录'], ['开始', '录音'], ['结束', '录音'], ['停止', '录音']],
 },
 task: {
 required: ['workflow', 'interaction'],
 optional: ['agent', 'memory', 'skills'],
 keywords: ['任务', 'todo', '代办', 'task', 'start', '开始', '计划', 'plan'],
 },
 // 2026-08-19 发行审计 W4: required 补 'reminder'——SetReminder/ListReminders/
 // RemoveReminder(toolset 'reminder') 此前不在任何意图, 意图即设提醒却无工具可见。
 set_reminder: {
 required: ['interaction', 'platform', 'reminder'],
 optional: ['memory'],
 keywords: ['提醒我', '提醒', '倒计时', 'remind', 'reminder', '定时'],
 },

 // ── 媒体 ──
 image_gen: {
 required: ['media', 'multimodal'],
 optional: ['panel'],
 keywords: ['画', '生成图', '画一张', '配图', 'image', 'picture', 'illustration', '海报', '头像'],
 },
 video_gen: {
 required: ['media'],
 optional: ['multimodal', 'panel'],
 // 2026-09-07: 补口语短语——"做个crabpaw产品宣传片视频"实测 0 命中(旧表只有
 // '生成视频/短视频/video'), video_gen 未参与竞选; 裸'视频'让创作类短语可命中,
 // 播放类请求仍由 video_play pairs(播放+视频 2 命中)压过。
 keywords: ['生成视频', '视频生成', '宣传片', '宣传视频', '产品视频', '视频广告', '做视频', '拍视频', '视频', '动画', 'animate', 'video'],
 },
 // 2026-08-16: 视频播放意图——修复"播放海南旅游的视频"误判 music(裸'播放'命中)
 // → scene 工具集缺失 → SceneMedia 不可见 → LLM 无应用内播放工具 → 打开外部浏览器。
 // 连续关键词('播放视频')匹配不上中间夹内容的短语, 故新增 pairs 复合词:
 // 两词同现视为 2 次命中, 压过 music 的 1 次; 不带'视频/电影'的音乐请求不命中。
 video_play: {
 required: ['media', 'web', 'scene'],
 optional: ['panel'],
 keywords: ['播放视频', '看视频', '放视频', '视频播放', '看个视频', '放个视频', '电影', '影片', '影视', '大片', '短片'],
 pairs: [['播放', '视频'], ['播放', '电影'], ['看', '视频'], ['看', '电影'], ['放', '视频'], ['放', '电影'], ['打开', '视频']],
 },
 music: {
 required: ['media'],
 optional: ['panel', 'web'],
 // 2026-08-15: 补裸'播放/来一首'等——实测'播放 铁血丹心'无关键词命中落
 // general(media 工具集被裁, Music 不可用 → 3 连败降级回复)。
 // 2026-08-16: '播放X视频/电影'由 video_play(pairs) 更高分抢走, music 只留纯音乐。
 keywords: ['播放音乐', '听歌', '放歌', 'music', 'play', 'song', '歌曲', '播放', '放一下', '来一首', '唱首歌'],
 },

 // ── 多模态 ──
 image_analysis: {
 required: ['multimodal', 'vision'],
 optional: ['memory'],
 keywords: ['这张图', '图片里', '看图', '识别', 'analyze', 'describe', '看照片'],
 },

 // ── 渠道（多渠道调度）──
 lark_msg: {
 required: ['lark', 'platform'],
 optional: ['interaction'],
 keywords: ['飞书', '发到飞书', 'lark', 'feishu'],
 },
 wecom_msg: {
 required: ['wecom', 'platform'],
 optional: ['interaction'],
 keywords: ['企业微信', '发到企微', 'wecom'],
 },
 email: {
 required: ['email'],
 optional: ['interaction', 'platform'],
 keywords: ['邮件', 'email', 'mail', '发邮件', '回邮件'],
 },

 // ── 记忆/知识 ──
 memory_query: {
 required: ['memory'],
 optional: ['skills'],
 // 2026-08-18 P0-3: 补'记忆'——"看看我的记忆"此前无关键词命中落 general
 // (general optional 含 memory, 工具仍可见), 补词后显式路由到 memory 工具集。
 keywords: ['记得', '回忆', '上次', '之前', 'remember', 'recall', '历史', '我跟你说过', '记忆'],
 },
 knowledge: {
 required: ['memory', 'skills'],
 optional: ['web'],
 keywords: ['知识', '原理', '为什么', '怎么理解', 'knowledge', 'why', 'how'],
 },

 // ── 工具/技能/Agent ──
 tool_self: {
 required: ['harness', 'skills'],
 optional: ['agent', 'memory'],
 keywords: ['添加工具', '写工具', 'tool factory', 'create skill', '写个技能'],
 },
 subagent: {
 required: ['agent'],
 optional: ['skills', 'memory'],
 keywords: ['子任务', 'subagent', '并行', '并发', '让claude', '让codex', 'delegate'],
 },

 // ── 语音/陪伴 ──
 // 2026-08-04: optional 扩充 file/document/skills——语音用户同样会要求
 // "生成一份报告/写个文件",仅语音工具会让 LLM 无工具可执行(空计划/胡说)
 voice: {
 required: ['voice'],
 optional: ['interaction', 'file', 'document', 'memory', 'skills'],
 keywords: ['说', '读', '朗读', '念', 'speak', 'tts', 'voice'],
 },

 // ── 场景/面板/视觉 ──
 scene: {
 required: ['panel', 'interaction'],
 optional: ['media', 'agent'],
 keywords: ['展示', '打开面板', '显示', 'scene', 'card', '卡片'],
 // 2026-08-18 P0-3: "打开面板"关键词 1 命中 0.267 < open_app 裸'打开' 0.3,
 // pairs 补强到 3 命中 0.8 压回。
 pairs: [['打开', '面板']],
 },
};

// 永远保留的"基础"工具集（不依赖意图）
// 2026-08-04: 补 file/document——文件操作是能力底座,任何意图(greeting/voice/weather…)
// 都可能需要生成/读取文件。此前仅按意图注入,greeting 等窄意图无文件工具
// → LLM 无法执行 → 空计划/胡说。现已验证 voice/general 亦受益。
const ALWAYS_INCLUDED = ['interaction', 'agent', 'file', 'document', 'planning'];
// 2026-09-03(Plan 实体): 'planning' 加入基础集——PlanCreate/PlanUpdate 无副作用
// (riskLevel low), 且"查天气+查台风+生成简报"这类跨意图多步任务恰恰是计划工具
// 的主场景; 若按意图注入, 路由收窄到 weather/typhoon 工具集时模型永远看不到
// 计划工具 → 执行计划卡永不出现。

// 危险操作只在显式开启时注入
const DANGEROUS_TOOLSETS = ['system', 'filesystem', 'bash', 'desktop'];

// Tick 模式：排除危险工具，只保留只读 + 元工具
const TICK_MODE_TOOLSETS = ['interaction', 'agent', 'memory', 'skills', 'panel'];

// Recall 模式：注入记忆相关工具
const RECALL_MODE_TOOLSETS = ['memory', 'skills', 'agent'];

// ---------------------------------------------------------------------------
// 工具路由核心
// ---------------------------------------------------------------------------

/**
 * 根据上下文选择本轮注入的工具列表
 *
 * @param {object} ctx
 * @param {string} ctx.message - 用户消息
 * @param {string} [ctx.channel='cli'] - 渠道
 * @param {boolean} [ctx.isTick=false] - 是否 Tick 心跳
 * @param {boolean} [ctx.hasActiveTask=false] - 是否有活跃任务
 * @param {boolean} [ctx.recallState=false] - 是否在 recall 模式
 * @param {string[]} [ctx.recentTools=[]] - 最近调用的工具名（用于连续性）
 * @param {boolean} [ctx.dangerousEnabled=true] - 是否允许危险操作
 * @param {object} [ctx.toolSystem] - 工具注册表（{ getByToolset, getAll, get }）
 * @param {object} [ctx.toolsetManager] - 工具集管理器（可选）
 * @returns {{ tools: object[], intent: string, confidence: number, reason: string, toolsets: string[] }}
 */
function selectToolsForContext(ctx) {
 const {
 message = '',
 channel = 'cli',
 isTick = false,
 hasActiveTask = false,
 recallState = false,
 recentTools = [],
 dangerousEnabled = true,
 toolSystem,
 toolsetManager,
 } = ctx;

 // ── 1. 检测意图 ──
 // 本地实现：先扫描消息，匹配后计算 score（命中关键词数 / 总数）
 let detectedIntent = 'general';
 let confidence = 0.5;
 try {
 // 2026-08-04 修复:剥离系统提示后缀——语音模式在消息末尾追加
 // [系统提示：…你的回复将被 TTS 朗读…]，其中"朗读"命中 voice 意图关键词
 // → 语音消息全部误判 voice 意图 → 只注入语音工具(无 Write/文件)
 // → LLM 无法执行生成 → 空计划"[]"/"报告已生成"式胡说。
 // 意图检测只基于真实用户消息。
 // 2026-09-07 强化: [系统提示...] 注记块可能内含 ']'(专家激活后缀把整段人设
 // 拼进消息, 人设文本自带方括号)——旧单正则剥到第一个 ']' 即截断, 残余人设
 // 关键词(打开/运行/启动)污染意图分类(宣传片实测 open_app(0.95) 误压 video_gen)。
 // 改为首 '[系统提示' 到末 ']' 整块剥除, 中间内容不再泄漏进意图检测。
 let cleanMessage = String(message || '');
 const sysNoteStart = cleanMessage.indexOf('[系统提示');
 if (sysNoteStart >= 0) {
   const sysNoteEnd = cleanMessage.lastIndexOf(']');
   if (sysNoteEnd > sysNoteStart) {
     cleanMessage = cleanMessage.slice(0, sysNoteStart) + cleanMessage.slice(sysNoteEnd + 1);
   }
 }
 cleanMessage = cleanMessage.replace(/\[系统提示[^\]]*\]/g, '');
 const lower = cleanMessage.toLowerCase();
 let bestScore = 0;
 for (const [intentName, mapping] of Object.entries(INTENT_TOOLSETS)) {
 if (!mapping.keywords || mapping.keywords.length === 0) continue;
 let hits = 0;
 for (const kw of mapping.keywords) {
 if (lower.includes(String(kw).toLowerCase())) hits += 1;
 }
 // 2026-08-16: pairs 复合词——两词同现视为 2 次命中。连续关键词匹配不上
 // '播放海南旅游的视频'这类中间夹内容的短语, 复合词让意图可命中且压过单词意图。
 if (mapping.pairs && mapping.pairs.length > 0) {
 for (const pair of mapping.pairs) {
 if (pair.every(w => lower.includes(String(w).toLowerCase()))) hits += 2;
 }
 }
 if (hits === 0) continue;
 const score = hits / mapping.keywords.length + hits * 0.1;
 if (score > bestScore) {
 bestScore = score;
 detectedIntent = intentName;
 confidence = Math.min(0.95, 0.4 + score);
 }
 }
 } catch (e) {

   /* intent detection failed, fall back to general */

   console.warn('[tool-router.js] 空 catch 补日志:', e && e.message);
 }

 // ── 2. 选 toolset 集 ──
 const selectedToolsets = new Set(ALWAYS_INCLUDED);

 // 2a. Tick 模式：限制到只读工具集
 if (isTick) {
 for (const ts of TICK_MODE_TOOLSETS) selectedToolsets.add(ts);
 } else {
 // 2b. 按意图加载
 const mapping = INTENT_TOOLSETS[detectedIntent];
 if (mapping) {
 for (const ts of mapping.required) selectedToolsets.add(ts);
 // 可选 toolset 始终加载（保持行为兼容），未来可改为按上下文条件加载
 for (const ts of (mapping.optional || [])) selectedToolsets.add(ts);
 } else {
 // 未识别意图：加载通用
 for (const ts of INTENT_TOOLSETS.general.optional || []) selectedToolsets.add(ts);
 }
 }

 // 2b+. MCP 动态工具集注入——用户配置并发现的 MCP 服务器工具默认对 LLM 可见
 // （2026-08-21 AIGoHotel 实测: 意图交集筛选从不含 mcp-* 动态集, 配置的 MCP
 //   工具即使注册成功 LLM 也完全看不到; 与 8-16 视频播放四连环同款交集滤除）
 if (!isTick) {
   try {
     const { getToolsetManager } = require('../toolset-manager');
     const tsm = getToolsetManager();
     for (const ts of tsm.listToolsets().filter(t => t.type === 'mcp')) {
       selectedToolsets.add(ts.name);
     }
   } catch (e) {
     console.warn('[tool-router.js] MCP 工具集注入失败:', e && e.message);
   }
 }

 // 2c. 召回模式：叠加记忆工具
 if (recallState) {
 for (const ts of RECALL_MODE_TOOLSETS) selectedToolsets.add(ts);
 }

 // 2d. 有活跃任务：叠加 workflow + skills
 if (hasActiveTask) {
 selectedToolsets.add('workflow');
 selectedToolsets.add('skills');
 }

 // 2e. 危险工具过滤
 if (!dangerousEnabled) {
 for (const ts of DANGEROUS_TOOLSETS) selectedToolsets.delete(ts);
 }

 // 2f. 平台筛选（lark/wecom 工具仅在对应渠道开启）
 // 2026-08-18 P0-3 修复: 此前为 no-op——lark/wecom 渠道的"帮我写报告/查天气"
 // 落 general/weather 意图, 选集里没有 'lark'/'wecom' toolset → LarkSendText/
 // WeComSendText 被交集过滤滤掉, 渠道原生工具永远不可见。按渠道注入本渠道工具集。
 if (channel === 'lark') {
 selectedToolsets.add('lark');
 } else if (channel === 'wecom') {
 selectedToolsets.add('wecom');
 }

 // ── 3. 收集 toolset 内所有工具 ──
 let tools = [];
 if (toolSystem) {
 for (const ts of selectedToolsets) {
 try {
 const tsTools = toolSystem.getByToolset ? toolSystem.getByToolset(ts) : [];
 tools = tools.concat(tsTools);
 } catch (e) {

   /* toolset not registered, skip */

   console.warn('[tool-router.js] 空 catch 补日志:', e && e.message);
 }
 }
 // 去重
 const seen = new Set();
 tools = tools.filter(t => {
 if (!t || !t.name || seen.has(t.name)) return false;
 seen.add(t.name);
 return true;
 });
 } else if (toolsetManager) {
 // 通过 toolsetManager 收集
 try {
 const toolNames = toolsetManager.getActiveToolNames();
 const allToolMap = (toolsetManager.getAllTools && toolsetManager.getAllTools()) || {};
 tools = toolNames.map(n => allToolMap[n]).filter(Boolean);
 } catch {
 tools = [];
 }
 }

 // ── 3.5 UI 弹卡守卫 ──
 // 2026-08-19 用户反馈「推荐热门资讯」仍弹热点卡片: 本意图 web_search 无 panel 集,
 // 但 recentTools/find_tool 连续性把 ShowHotspot 无条件注回工具集 → LLM 看到即弹卡。
 // 修复: 连续性注入时, panel/scene/trending 工具仅当当前意图已加载对应集才放行。
 // trending(hot_search) 虽为纯文本, 但泄漏后 LLM 会选它输出无排版热搜文本
 // (E2E 实锤) → 同样改变回答形态, 一并拦截。
 // 名单从 toolSystem 动态收集(三集全部成员), 不手写防漂移。
 const uiSurfaceToolsetOf = (() => {
   const map = new Map();
   if (!toolSystem) return map;
   for (const ts of ['panel', 'scene', 'trending']) {
     try {
       const arr = toolSystem.getByToolset ? toolSystem.getByToolset(ts) : [];
       // 同收原名字+小写——registry 会规范化 PascalCase, 但调用方传入的
       // recentTools 可能是任意大小写变体(实测 'hot_search' vs 'HotSearch' 失配漏拦)。
       for (const t of arr) {
         if (t && t.name) { map.set(t.name, ts); map.set(String(t.name).toLowerCase(), ts); }
       }
     } catch { /* toolset not registered, skip */ }
   }
   return map;
 })();
 const isUiSurfaceLeak = (tName) => {
   const ts = uiSurfaceToolsetOf.get(tName) || uiSurfaceToolsetOf.get(String(tName).toLowerCase());
   return ts ? !selectedToolsets.has(ts) : false;
 };

 // ── 4. 工具链连续性：保留最近调用过的工具（即便不在当前 toolset）──
 if (recentTools && recentTools.length > 0 && toolSystem) {
 const existingNames = new Set(tools.map(t => t.name));
 for (const tName of recentTools.slice(-5)) {
 if (existingNames.has(tName) || isUiSurfaceLeak(tName)) continue;
 if (toolSystem.get) {
 const t = toolSystem.get(tName);
 if (t) tools.push(t);
 }
 }
 }

 // ── 4b. find_tool 发现集：把最近通过 FindTool 找到的工具一并注入 ──
 try {
 const { getRecentFoundTools } = require('../../tools/find-tool');
 const found = getRecentFoundTools();
 if (found && found.length > 0 && toolSystem) {
 const existingNames = new Set(tools.map(t => t.name));
 for (const tName of found) {
 if (existingNames.has(tName) || isUiSurfaceLeak(tName)) continue;
 if (toolSystem.get) {
 const t = toolSystem.get(tName);
 if (t) tools.push(t);
 }
 }
 }
 } catch (e) {
   /* find-tool not loaded yet */
   console.warn('[tool-router.js] 空 catch 补日志:', e && e.message);
 }

 return {
 tools,
 intent: detectedIntent,
 confidence,
 reason: `intent=${detectedIntent}(${confidence.toFixed(2)}), toolsets=[${[...selectedToolsets].join(',')}]`,
 toolsets: [...selectedToolsets],
 };
}

// ---------------------------------------------------------------------------
// 暴露注册表（用于诊断 + 后续扩展）
// ---------------------------------------------------------------------------
function listIntents() {
 return Object.keys(INTENT_TOOLSETS);
}

function getIntentMapping(intent) {
 return INTENT_TOOLSETS[intent] || null;
}

function registerIntent(intent, mapping) {
 if (!intent || !mapping || !Array.isArray(mapping.required)) {
 throw new Error('registerIntent: invalid params');
 }
 INTENT_TOOLSETS[intent] = mapping;
}

module.exports = {
 selectToolsForContext,
 listIntents,
 getIntentMapping,
 registerIntent,
 INTENT_TOOLSETS,
 ALWAYS_INCLUDED,
 DANGEROUS_TOOLSETS,
};
